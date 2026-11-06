//! `/api/arkiv/bets/{id}/seal`: where a bet stands on Arkiv. The browser reads
//! the entity from Arkiv itself, so this answers only with its key and block.
//!
//! `POST /api/arkiv/key`: a wallet delegates one browser key to write its own bets
//! on Arkiv. We check the wallet's signature and send the key its gas, once.

use std::time::Duration;

use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use strike_core::address;
use strike_core::arkiv;
use strike_core::db::now_us;
use strike_core::error::{ApiError, ApiResult};
use strike_core::eth::verify_personal_signature;

use crate::http::require_balance_session;

const SEAL_WAIT: Duration = Duration::from_secs(25);

pub fn routes() -> Router {
    Router::new()
        .route("/api/arkiv/bets/{id}/seal", get(seal))
        .route("/api/arkiv/key", post(register_key))
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

/// A delegation may not outlive this.
const MAX_KEY_LIFETIME_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Funded keys per wallet per day: enough for a few browsers, not a gas faucet.
const KEYS_PER_DAY: i64 = 3;

async fn register_key(Json(body): Json<serde_json::Value>) -> Response {
    let answer: ApiResult<_> = async {
        let wallet = body["wallet"].as_str().unwrap_or_default();
        let key = body["key"].as_str().unwrap_or_default();
        let expires = body["expiresAt"].as_i64().unwrap_or_default();
        let signature = body["signature"].as_str().unwrap_or_default();
        if !address::is_address(wallet) || !address::is_address(key) {
            return Err(ApiError::bad_request("wallet and key must be addresses"));
        }
        let now_ms = now_us() / 1000;
        if expires <= now_ms || expires > now_ms + MAX_KEY_LIFETIME_MS {
            return Err(ApiError::bad_request(
                "delegation must expire within 7 days",
            ));
        }
        let message = arkiv::delegation_message(wallet, key, expires);
        if !verify_personal_signature(wallet, &message, signature).await? {
            return Err(ApiError::unauthorized(
                "delegation is not signed by this wallet",
            ));
        }
        let wallet = address::canonical(wallet);
        let key = key.to_lowercase();
        let arkiv = arkiv::shared()?;

        let (known, recent) = arkiv::key_status(&key, &wallet).await?;
        if let Some(tx) = known {
            return Ok(json!({ "key": key, "fundTx": tx, "fresh": false }));
        }
        if recent >= KEYS_PER_DAY {
            return Err(ApiError::json(
                StatusCode::TOO_MANY_REQUESTS,
                "This wallet already set up 3 keys today",
            ));
        }
        let tx = arkiv.fund_key(&key).await?;
        arkiv::record_key(&key, &wallet, expires, &tx).await?;
        tracing::info!("[arkiv] funded browser key {key} in {tx}");
        Ok(json!({ "key": key, "fundTx": tx, "fresh": true }))
    }
    .await;
    match answer {
        Ok(body) => Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}
