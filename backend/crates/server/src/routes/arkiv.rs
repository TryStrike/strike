//! `/api/arkiv/bets/{id}/seal`: where a bet stands on Arkiv. The browser reads
//! the entity from Arkiv itself, so this answers only with its key and block.

use std::time::Duration;

use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use strike_core::arkiv;
use strike_core::error::{ApiError, ApiResult};

use crate::http::require_balance_session;

const SEAL_WAIT: Duration = Duration::from_secs(25);

pub fn routes() -> Router {
    Router::new().route("/api/arkiv/bets/{id}/seal", get(seal))
}

async fn seal(headers: HeaderMap, Path(bet_id): Path<String>) -> Response {
    let answer: ApiResult<_> = async {
        require_balance_session(&headers)?;
        arkiv::shared()?;
        let seal = arkiv::wait_for_seal(bet_id.trim(), SEAL_WAIT)
            .await?
            .ok_or_else(|| ApiError::json(StatusCode::NOT_FOUND, "Unknown bet"))?;
        Ok(json!({
            "sealed": seal.key.is_some(),
            "settled": seal.settled_at_us.is_some(),
            "key": seal.key,
            "block": seal.block,
        }))
    }
    .await;
    match answer {
        Ok(body) => Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}
