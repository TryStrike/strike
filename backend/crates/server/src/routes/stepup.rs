use axum::extract::Path;
use axum::http::header::WWW_AUTHENTICATE;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use strike_core::agentpass::{self, Stepup, ORB};
use strike_core::bets::now_ms;
use strike_core::crypto::{self, AGENT_COOKIE};
use strike_core::db;
use strike_core::error::ApiError;
use strike_core::ledger::Rejection;

use crate::http;

pub fn routes() -> Router {
    Router::new()
        .route("/api/stepups/{id}", get(read))
        .route("/api/stepups/{id}/cancel", post(cancel))
}

pub fn reply((status, body): Rejection) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (code, Json(body.clone())).into_response();
    if body["code"] == "step_up_required" {
        let challenge =
            format!("Bearer error=\"insufficient_user_authentication\", acr_values=\"{ORB}\"");
        if let Ok(value) = HeaderValue::from_str(&challenge) {
            response.headers_mut().insert(WWW_AUTHENTICATE, value);
        }
    }
    if let Some(wait) = body["retryAfter"].as_i64() {
        response
            .headers_mut()
            .insert("retry-after", HeaderValue::from(wait));
    }
    response
}

pub fn stepup_id(body: &Value) -> Option<String> {
    body.get("stepupId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .map(str::to_string)
}

fn owns(headers: &HeaderMap, stepup: &Stepup) -> bool {
    let agent = crypto::verify_agent_token(http::cookie(headers, AGENT_COOKIE).as_deref());
    agent.is_some_and(|claims| claims.wallet == stepup.wallet)
        || http::require_wallet_session(headers, &stepup.wallet).is_ok()
}

fn not_found() -> ApiError {
    ApiError::json(StatusCode::NOT_FOUND, "No such approval").with("code", "not_found".into())
}

async fn mine(headers: &HeaderMap, id: &str) -> Result<Stepup, ApiError> {
    agentpass::get(db::db().await?, id, now_ms())
        .await?
        .filter(|stepup| owns(headers, stepup))
        .ok_or_else(not_found)
}

async fn read(Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    Ok(Json(mine(&headers, &id).await?.to_json()))
}

async fn cancel(Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    mine(&headers, &id).await?;
    agentpass::cancel(db::db().await?, &id, "You cancelled")
        .await?
        .map(|stepup| Json(stepup.to_json()))
        .ok_or_else(not_found)
}
