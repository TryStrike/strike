use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, PoisonError};

use crate::http::Query;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use strike_core::address;
use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::db;
use strike_core::error::{status_of, ApiError, ApiResult};
use strike_core::world::{self, Attempt, Failure, WORLD_COOKIE};

use crate::http::{self, require_wallet_session, Cookie, JsonBody};

pub fn routes() -> Router {
    Router::new()
        .route("/api/world/config", get(world_config))
        .route("/api/world/human", get(human))
        .route("/api/world/human/start", post(start))
        .route("/api/world/attempts/{id}", get(attempt))
        .route("/api/world/attempts/{id}/proof", post(proof))
}

async fn world_config() -> Json<Value> {
    let cfg = config();
    let limits = &cfg.world_limits;
    let app = cfg.world_idkit.as_ref();
    Json(json!({
        "enabled": app.is_some(),
        "devBypass": world::dev_bypass(),
        "appId": app.map(|a| &a.app_id),
        "environment": app.map(|a| &a.environment),
        "action": cfg.world_action,
        "tiers": {
            "selfie": { "openCap": limits.selfie.open_cap, "dailyLoss": limits.selfie.daily_loss },
            "orb": { "openCap": limits.orb.open_cap, "dailyLoss": limits.orb.daily_loss },
        },
        "cooloffMin": limits.cooloff_min,
        "stepup": {
            "withdrawOver": limits.stepup_withdraw_over,
            "proposalOver": limits.stepup_proposal_over,
        },
        "agentPass": {
            "enabled": strike_core::agentpass::enabled(),
        },
    }))
}

fn wallet_param(raw: Option<&str>) -> ApiResult<String> {
    raw.filter(|w| address::is_address(w))
        .map(address::canonical)
        .ok_or_else(|| {
            ApiError::coded("invalid_body", "A wallet address is required")
                .with("field", json!("wallet"))
        })
}

#[derive(Deserialize)]
struct HumanQuery {
    wallet: Option<String>,
}

async fn human(headers: HeaderMap, Query(query): Query<HumanQuery>) -> ApiResult<Json<Value>> {
    let wallet = wallet_param(query.wallet.as_deref())?;
    require_wallet_session(&headers, &wallet)?;
    Ok(Json(
        world::human_status(db::db().await?, &wallet, now_ms()).await?,
    ))
}

async fn start(headers: HeaderMap, JsonBody(body): JsonBody<Value>) -> ApiResult<Response> {
    let wallet = wallet_param(body["userAddress"].as_str())?;
    require_wallet_session(&headers, &wallet)?;
    if world::dev_bypass() {
        return Err(ApiError::coded(
            "dev_bypass",
            "Human checks are off on this dev server, every wallet counts as verified",
        ));
    }
    let orb = match body.get("tier") {
        None | Some(Value::Null) => false,
        Some(tier) if tier == "orb" => true,
        Some(_) => {
            return Err(
                ApiError::coded("invalid_body", "tier must be \"orb\" or absent")
                    .with("field", json!("tier")),
            )
        }
    };
    let challenge = world::begin_human(db::db().await?, &wallet, orb, now_ms()).await?;
    Ok(http::json_with_cookie(
        challenge.to_json(),
        Cookie {
            name: WORLD_COOKIE,
            value: challenge.browser_secret,
            max_age: world::ATTEMPT_TTL_MS / 1_000,
            same_site: "Lax",
            http_only: true,
        },
    ))
}

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

async fn decide(
    body: &Value,
    attempt: &Attempt,
) -> ApiResult<Result<(), Option<(&'static str, String)>>> {
    let fail = |reason: String| Ok(Err(Some(("failed", reason))));
    let app = match world::idkit() {
        Ok(app) => app,
        Err(_) => return fail(world::NOT_CONFIGURED.to_string()),
    };
    if let Some(error) = body.get("error") {
        return Ok(Err(Some(world::idkit_error_outcome(
            error.as_str().unwrap_or("generic_error"),
        ))));
    }
    if attempt.expires_at_ms <= now_ms() {
        return Ok(Err(Some(("expired", world::EXPIRED.to_string()))));
    }
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
    match world::finish_human(db::db().await?, grant, now_ms()).await? {
        Ok(_) => Ok(Ok(())),
        Err(_) => Ok(Err(None)),
    }
}

fn attempt_code(attempt: &Attempt) -> Option<&'static str> {
    let reason = attempt.reason.as_deref().unwrap_or_default();
    Some(match attempt.status.as_str() {
        "approved" => return None,
        "pending" => "attempt_pending",
        "expired" => "attempt_expired",
        "mismatch" => "human_mismatch",
        "denied" if reason == world::BANNED_HUMAN => "banned",
        "denied" => "attempt_denied",
        "failed" if reason == world::UNAVAILABLE => "world_unavailable",
        "failed" if reason == world::NOT_CONFIGURED => "world_unconfigured",
        _ => "attempt_failed",
    })
}

fn attempt_response(attempt: &Attempt, cookies: &[Cookie]) -> Response {
    let mut body = attempt.to_json();
    let status = match attempt_code(attempt) {
        None => StatusCode::OK,
        Some(code) => {
            body["code"] = json!(code);
            body["error"] = json!(attempt
                .reason
                .as_deref()
                .unwrap_or("Human check not finished"));
            if status_of(code) >= 500 {
                body["retryable"] = json!(true);
            }
            StatusCode::from_u16(status_of(code)).unwrap_or(StatusCode::BAD_REQUEST)
        }
    };
    let mut response = http::json_with_cookies(body, cookies);
    *response.status_mut() = status;
    response
}

async fn proof(Path(id): Path<String>, headers: HeaderMap, raw: Bytes) -> ApiResult<Response> {
    let body: Value = serde_json::from_slice(&raw)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| {
            ApiError::coded("invalid_body", "Body must be the IDKit result or { error }")
        })?;
    let database = db::db().await?;
    let secret = http::cookie(&headers, WORLD_COOKIE);
    let found = world::attempt_for(database, &id, secret.as_deref(), now_ms()).await?;
    let attempt = found.ok_or_else(no_attempt)?;
    if attempt.status == "pending" {
        if let Err(Some((status, reason))) = decide(&body, &attempt).await? {
            tracing::info!("[world] attempt {} {status}: {reason}", attempt.id);
            world::deny(database, &attempt.id, status, &reason, now_ms()).await?;
        }
    }
    let settled = world::attempt_for(database, &id, secret.as_deref(), now_ms())
        .await?
        .ok_or_else(no_attempt)?;
    let cookies = match settled.status.as_str() {
        "pending" => vec![],
        _ => vec![http::cleared_cookie(WORLD_COOKIE, "Lax")],
    };
    Ok(attempt_response(&settled, &cookies))
}

fn no_attempt() -> ApiError {
    ApiError::coded("not_found", "No such human check")
}

async fn attempt(Path(id): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let secret = http::cookie(&headers, WORLD_COOKIE);
    let attempt = world::attempt_for(db::db().await?, &id, secret.as_deref(), now_ms())
        .await?
        .ok_or_else(no_attempt)?;
    Ok(Json(attempt.to_json()).into_response())
}
