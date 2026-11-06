//! `/api/world/*`: the IDKit proof post that turns a verified human into a
//! YOLO session, and the attempt read behind the agent panel's chip. Nothing
//! here logs a proof or nullifier.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, PoisonError};

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use strike_core::agent;
use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::crypto::{self, AGENT_COOKIE};
use strike_core::db::{self, Db};
use strike_core::error::ApiError;
use strike_core::world::{self, Attempt, Failure, HumanGrant, WORLD_COOKIE};

use crate::agent as live;
use crate::http::{self, Cookie};
use crate::routes::agent::{start_session, AGENTS_NOT_CONFIGURED};

pub fn routes() -> Router {
    Router::new()
        .route("/api/world/attempts/{id}", get(attempt))
        .route("/api/world/attempts/{id}/proof", post(proof))
}

/// The agent cookie on approval. `Err(Some)` is an outcome to record,
/// `Err(None)` one the session write already recorded.
type Outcome = Result<Result<Cookie, Option<(&'static str, String)>>, ApiError>;

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

/// Attempts whose proof is out at World. A duplicate post (a reload, a double
/// tap) leaves the first to finish instead of verifying the proof twice.
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

/// The terms a still live start attempt would create, `None` for a checkpoint.
fn live_terms(
    attempt: &Attempt,
    terms: Option<agent::StartTerms>,
    now: i64,
) -> Result<Option<agent::StartTerms>, (&'static str, String)> {
    let fail = |reason: &str| Err(("failed", reason.to_string()));
    if attempt.expires_at_ms <= now {
        return Err(("expired", world::EXPIRED.to_string()));
    }
    if attempt.kind == world::CHECKPOINT {
        return Ok(None);
    }
    let Some(terms) = terms else {
        return fail("Start message no longer parses");
    };
    if let Err((_, body)) = agent::check_start(&terms, now) {
        return fail(body["error"].as_str().unwrap_or("Start refused"));
    }
    Ok(Some(terms))
}

/// Spends a verified human on its attempt: resumes the paused agent, or
/// starts the session the terms describe.
async fn finish(
    database: &'static Db,
    attempt: &Attempt,
    terms: Option<agent::StartTerms>,
    grant: HumanGrant,
) -> Outcome {
    let Some(terms) = terms else {
        match world::resume(database, grant, now_ms()).await? {
            Ok(session_id) => live::resume(&session_id),
            Err(status) => end_paused(database, attempt, status).await,
        }
        return Ok(Err(None));
    };
    match start_session(database, terms, now_ms(), Some(grant)).await? {
        Ok((_, cookie)) => Ok(Ok(cookie)),
        Err(_) => Ok(Err(None)),
    }
}

/// The IDKit widget's result, or `{ "error": code }`, for the attempt this
/// browser started. Answers the attempt as it ends up.
async fn proof(
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Response, ApiError> {
    let body: Value = serde_json::from_slice(&raw)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| ApiError::bad_request("Body must be the IDKit result or { error }"))?;
    let database = db::db().await?;
    let secret = http::cookie(&headers, WORLD_COOKIE);
    let now = now_ms();
    let found = world::attempt_for(database, &id, secret.as_deref(), None, now).await?;
    let attempt = found.ok_or_else(no_attempt)?;
    let mut cookies = vec![];
    if attempt.status == "pending" {
        match decide_proof(database, &body, &attempt, now).await? {
            Ok(cookie) => cookies = vec![cookie, http::cleared_cookie(WORLD_COOKIE, "Lax")],
            Err(Some((status, reason))) => {
                tracing::info!("[world] attempt {} {status}: {reason}", attempt.id);
                if world::deny(database, &attempt.id, status, &reason, now).await? {
                    end_paused(database, &attempt, status).await;
                }
            }
            Err(None) => {}
        }
    }
    let settled = world::attempt_for(database, &id, secret.as_deref(), None, now_ms())
        .await?
        .ok_or_else(no_attempt)?;
    Ok(http::json_with_cookies(settled.to_json(), &cookies))
}

async fn decide_proof(database: &'static Db, body: &Value, attempt: &Attempt, now: i64) -> Outcome {
    let fail = |reason: String| Ok(Err(Some(("failed", reason))));
    let Ok(app) = world::idkit() else {
        return fail(world::NOT_CONFIGURED.to_string());
    };
    if !config().is_settlement_signing_configured() {
        return fail(AGENTS_NOT_CONFIGURED.to_string());
    }
    let terms = agent::parse_start(&attempt.message).ok();
    if let Some(error) = body.get("error") {
        return Ok(Err(Some(world::idkit_error_outcome(
            error.as_str().unwrap_or("generic_error"),
            terms.as_ref().map(|t| t.budget),
        ))));
    }
    let terms = match live_terms(attempt, terms, now) {
        Ok(terms) => terms,
        Err(outcome) => return Ok(Err(Some(outcome))),
    };
    if let Err(field) = world::check_proof(body, app, attempt) {
        return fail(Failure::Invalid(field).reason());
    }
    let Some(_redeeming) = Redeeming::take(&attempt.id) else {
        return Ok(Err(None));
    };
    let grant = match world::verify_proof(app, body, attempt).await {
        Ok(grant) => grant,
        Err(failure) => return fail(failure.reason()),
    };
    finish(database, attempt, terms, grant).await
}

fn no_attempt() -> ApiError {
    ApiError::json(StatusCode::NOT_FOUND, "No such human check")
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
    .ok_or_else(no_attempt)
}
