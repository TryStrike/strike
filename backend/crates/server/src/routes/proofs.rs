//! Public settlement proofs for the app: `/api/proofs/bet/{id}` and
//! `/api/proofs/epochs`. No session: everything here is committed on Arc anyway.

use std::collections::HashMap;

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use strike_core::db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::proofs;

const DEFAULT_EPOCHS: u32 = 10;
const MAX_EPOCHS: u32 = 50;

pub fn routes() -> Router {
    Router::new()
        .route("/api/proofs/bet/{id}", get(bet))
        .route("/api/proofs/epochs", get(epochs))
}

async fn bet(Path(raw): Path<String>) -> ApiResult<Response> {
    let bet_id = raw.trim();
    if !crate::routes::bets::bet_id::bet_id_ok(bet_id) {
        return Err(ApiError::bad_request("invalid_bet_id"));
    }
    proofs::bet_proof(db::db().await?, bet_id)
        .await?
        .map(|body| Json(body).into_response())
        .ok_or_else(|| ApiError::json(StatusCode::NOT_FOUND, "unknown_bet"))
}

async fn epochs(Query(params): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let limit = match params.get("limit") {
        None => DEFAULT_EPOCHS,
        Some(raw) => raw
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=MAX_EPOCHS).contains(n))
            .ok_or_else(|| ApiError::bad_request("invalid_limit"))?,
    };
    let body = proofs::recent_epochs(db::db().await?, limit).await?;
    Ok(Json(body).into_response())
}
