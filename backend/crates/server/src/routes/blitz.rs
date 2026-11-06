//! Blitz and the market state the chart reads: `/api/market/state`,
//! `/api/blitz/enter` and `/api/blitz/pass`. The rules live in `strike_core::blitz`.

use axum::body::Bytes;
use axum::extract::Query;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;

use strike_core::address;
use strike_core::bets::now_ms;
use strike_core::blitz;
use strike_core::crypto::{self, BALANCE_SESSION_COOKIE};
use strike_core::db;
use strike_core::error::ApiError;
use strike_core::ledger::{self, coded_body, Rejection};
use strike_core::ticks;

use crate::bans::is_globally_banned;
use crate::http::{cookie, require_balance_session, require_wallet_session};
use crate::routes::balance_mutations::balance_rows;

pub fn routes() -> Router {
    Router::new()
        .route("/api/market/state", get(market_state))
        .route("/api/blitz/enter", post(enter))
        .route("/api/blitz/pass", get(pass))
}

async fn market_state() -> Response {
    let body = blitz::market_state(ticks::buffer(), now_ms());
    ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

#[derive(Deserialize)]
struct PassQuery {
    wallet: String,
}

async fn pass(Query(query): Query<PassQuery>) -> Response {
    let found = async {
        let database = db::db().await?;
        blitz::pass_status(database, &query.wallet, now_ms()).await
    };
    match found.await {
        Ok(body) => ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response(),
        Err(err) => err.into_response(),
    }
}

fn reject((status, body): Rejection) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(body)).into_response()
}

async fn enter(headers: HeaderMap, raw: Bytes) -> Response {
    if let Err(err) = require_balance_session(&headers) {
        return err.into_response();
    }
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return reject((422, coded_body("invalid_body", "Invalid request body")));
    };
    let session =
        crypto::balance_session_wallet(cookie(&headers, BALANCE_SESSION_COOKIE).as_deref());
    // The internal bearer has no cookie, so it names the wallet in the body.
    let wallet = session
        .or_else(|| body["userAddress"].as_str().map(str::to_string))
        .unwrap_or_default();
    if let Err(err) = require_wallet_session(&headers, &wallet) {
        return err.into_response();
    }
    match enter_run(&wallet, body["currency"].as_str().unwrap_or_default()).await {
        Ok(body) => Json(body).into_response(),
        Err(rejection) => reject(rejection),
    }
}

pub(crate) async fn enter_run(wallet: &str, currency: &str) -> Result<Value, Rejection> {
    let currency = currency.trim().to_uppercase();
    if !matches!(currency.as_str(), "USDC" | "EURC") || !address::is_address(wallet) {
        return Err((
            400,
            coded_body("invalid_body", "Blitz takes a wallet and USDC or EURC"),
        ));
    }
    if is_globally_banned(wallet).await {
        return Err(ledger::banned_rejection());
    }
    let unavailable = |err: ApiError| {
        tracing::error!("[blitz] enter failed: {err}");
        (503, ledger::error_body("Service unavailable"))
    };
    let database = db::db().await.map_err(unavailable)?;
    let rows = balance_rows(&address::search_variants(wallet), &currency).await;
    // A wallet already holding the pass owes nothing, so an empty row is not refused here.
    let ledger_key = match ledger::bet_choose_row(&rows, 1.0, &currency) {
        ledger::BetRows::Ledger(key) => key,
        ledger::BetRows::Reject(_) => rows
            .first()
            .and_then(|row| row["user_address"].as_str())
            .unwrap_or_default()
            .to_string(),
    };
    blitz::enter(database, wallet, &ledger_key, &currency, now_ms())
        .await
        .map_err(unavailable)?
}
