//! Public settlement proofs: `/api/proofs/epoch/{n}` for the Chainlink CRE
//! workflow, `/api/proofs/bet/{id}` and `/api/proofs/epochs` for the app. No
//! session: everything here is committed on Arc anyway.

use std::collections::HashMap;

use axum::extract::{Path, Query};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use strike_core::db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::proofs::{self, EpochRead, MAX_EPOCH};

const DEFAULT_EPOCHS: u32 = 10;
const MAX_EPOCHS: u32 = 50;

pub fn routes() -> Router {
    Router::new()
        .route("/api/proofs/epoch/{n}", get(epoch))
        .route("/api/proofs/bet/{id}", get(bet))
        .route("/api/proofs/epochs", get(epochs))
}

async fn epoch(Path(raw): Path<String>) -> ApiResult<Response> {
    let n = raw
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= MAX_EPOCH)
        .ok_or_else(|| ApiError::bad_request("invalid_epoch"))?;
    match proofs::epoch_json(db::db().await?, n).await? {
        EpochRead::Ready(body) => {
            let mut response = Json(body).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
            Ok(response)
        }
        EpochRead::Open => Err(ApiError::conflict("epoch_open")),
        EpochRead::Empty => Err(ApiError::json(StatusCode::NOT_FOUND, "epoch_empty")),
        EpochRead::TooLarge(count) => Err(ApiError::json(
            StatusCode::PAYLOAD_TOO_LARGE,
            "epoch_too_large",
        )
        .with("count", count.into())),
    }
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
