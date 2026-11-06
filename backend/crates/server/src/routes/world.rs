//! `/api/world/*`: the World ID callback that turns a validated approval into
//! a YOLO session, and the attempt read behind the agent panel's chip. The
//! callback always lands back on `/agent`, and never logs the code or token.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, PoisonError};

use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::Value;

use strike_core::agent;
use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::crypto::{self, AGENT_COOKIE};
use strike_core::db::{self, Db};
use strike_core::error::ApiError;
use strike_core::world::{self, Attempt, WORLD_COOKIE};

use crate::agent as live;
use crate::http::{self, Cookie};
use crate::routes::agent::{started, AGENTS_NOT_CONFIGURED};

pub fn routes() -> Router {
    Router::new()
        .route("/api/world/callback", get(callback))
        .route("/api/world/attempts/{id}", get(attempt))
}

fn back(attempt: &str, cookies: &[Cookie]) -> Response {
    http::redirect_with_cookies(&format!("/agent?world={attempt}"), cookies)
}

async fn callback(
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let database = db::db().await?;
    let found = match query.get("state") {
        Some(state) => world::attempt_by_state(database, state).await?,
        None => None,
    };
    let Some(attempt) = found else {
        return Ok(back("unknown", &[]));
    };
    if attempt.status != "pending" {
        return Ok(back(&attempt.id, &[]));
    }
    let now = now_ms();
    match decide(database, &headers, &query, &attempt, now).await? {
        Ok(cookie) => Ok(back(
            &attempt.id,
            &[cookie, http::cleared_cookie(WORLD_COOKIE, "Lax")],
        )),
        Err(Some((status, reason))) => {
            tracing::info!("[world] attempt {} {status}: {reason}", attempt.id);
            if world::deny(database, &attempt.id, status, &reason, now).await? {
                end_paused(database, &attempt, status).await;
            }
            Ok(back(&attempt.id, &[]))
        }
        Err(None) => Ok(back(&attempt.id, &[])),
    }
}

/// A paused agent whose human said no, or whose checkpoint another human
/// answered, stops. A failed or expired check leaves it waiting out its pause.
async fn end_paused(database: &Db, attempt: &Attempt, status: &str) {
    if attempt.kind != world::CHECKPOINT || !matches!(status, "denied" | "mismatch") {
        return;
    }
    if let Some(session_id) = &attempt.session_id {
        live::stop(database, session_id, agent::HUMAN_CHECK_DENIED).await;
    }
}

/// Attempts whose code is out at World. A duplicate callback (a reload, a
/// double redirect) leaves the first to finish instead of spending the code
/// and recording its `invalid_grant` over the approval.
// ponytail: per process, a claim column on world_attempts if the API ever runs twice.
static REDEEMING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

struct Redeeming(String);

impl Redeeming {
    fn take(id: &str) -> Option<Self> {
        let mut set = REDEEMING.lock().unwrap_or_else(PoisonError::into_inner);
        set.insert(id.to_string()).then(|| Self(id.to_string()))
    }
}

impl Drop for Redeeming {
    fn drop(&mut self) {
        REDEEMING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// The agent cookie on approval. `Err(Some)` is an outcome to record,
/// `Err(None)` one the session write already recorded.
async fn decide(
    database: &Db,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    attempt: &Attempt,
    now: i64,
) -> Result<Result<Cookie, Option<(&'static str, String)>>, ApiError> {
    let fail = |reason: &str| Ok(Err(Some(("failed", reason.to_string()))));
    let browser = http::cookie(headers, WORLD_COOKIE).map(|secret| world::browser_hash(&secret));
    if browser.as_deref() != Some(attempt.browser.as_str()) {
        return fail(world::OTHER_BROWSER);
    }
    let Ok(client) = world::configured() else {
        return fail(world::NOT_CONFIGURED);
    };
    if !config().is_settlement_signing_configured() {
        return fail(AGENTS_NOT_CONFIGURED);
    }
    if query.get("iss") != Some(&client.issuer) {
        return fail(world::WRONG_ISSUER);
    }
    let terms = agent::parse_start(&attempt.message).ok();
    if let Some(error) = query.get("error") {
        return Ok(Err(Some(world::error_outcome(
            error,
            terms.as_ref().map(|t| t.budget),
        ))));
    }
    if attempt.expires_at_ms <= now {
        return Ok(Err(Some(("expired", world::EXPIRED.to_string()))));
    }
    let terms = if attempt.kind == world::CHECKPOINT {
        None
    } else {
        let Some(terms) = terms else {
            return fail("Start message no longer parses");
        };
        if let Err((_, body)) = agent::check_start(&terms, now) {
            return fail(body["error"].as_str().unwrap_or("Start refused"));
        }
        Some(terms)
    };
    let Some(code) = query.get("code") else {
        return fail("World ID could not finish: no code");
    };
    let Some(_redeeming) = Redeeming::take(&attempt.id) else {
        return Ok(Err(None));
    };
    let grant = match world::redeem(code, attempt, now).await {
        Ok(grant) => grant,
        Err(failure) => return Ok(Err(Some(("failed", failure.reason())))),
    };
    let Some(terms) = terms else {
        match world::resume(database, grant, now_ms()).await? {
            Ok(session_id) => live::resume(&session_id),
            Err(status) => end_paused(database, attempt, status).await,
        }
        return Ok(Err(None));
    };
    match agent::create_session(database, terms, now, Some(grant)).await? {
        Ok(session) => Ok(Ok(started(session)?)),
        Err(_) => Ok(Err(None)),
    }
}

/// Readable by the browser that started the attempt, or by the agent cookie
/// of the session it created. Anything else is a 404.
async fn attempt(Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let secret = http::cookie(&headers, WORLD_COOKIE);
    let session = crypto::verify_agent_token(http::cookie(&headers, AGENT_COOKIE).as_deref())
        .map(|claims| claims.session_id);
    world::attempt_for(
        db::db().await?,
        &id,
        secret.as_deref(),
        session.as_deref(),
        now_ms(),
    )
    .await?
    .map(|attempt| Json(attempt.to_json()))
    .ok_or_else(|| ApiError::json(axum::http::StatusCode::NOT_FOUND, "No such human check"))
}
