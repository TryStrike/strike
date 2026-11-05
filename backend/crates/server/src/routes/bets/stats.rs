//! `GET /api/bets/stats` — `app/api/bets/stats/route.ts`.
//!
//! Same first-party guard as history, same canonicalised wallet predicate; the
//! aggregation is pure (`strike_core::bets::aggregate_wallet_stats`) and the
//! browser never receives the raw rows.

use std::collections::HashMap;

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};

use strike_core::bets::{
    aggregate_wallet_stats, is_evm_address, now_ms, parse_stats_window,
    stats_window_start_iso, STATS_MAX_ROWS,
};
use strike_core::error::ApiError;

use crate::http::{json_status, require_balance_session};
use crate::sql;

use super::{column_type, Binds};

/// `canonicalHouseUserAddress` for the response's `wallet` field.
fn canonical(value: &str) -> String {
    strike_core::address::canonical(value)
}

const SELECT_FIELDS: &str = "id, wallet_address, asset, amount, payout, won, resolved_at, created_at";

pub fn routes() -> Router {
    Router::new().route("/api/bets/stats", get(handle))
}

async fn handle(headers: HeaderMap, Query(raw): Query<HashMap<String, String>>) -> Response {
    if let Err(err) = require_balance_session(&headers) {
        return err.into_response();
    }

    // Validation order mirrors the route: the window is rejected before the
    // wallet, so `?window=bogus` answers the window message even with no wallet.
    let window = match parse_stats_window(raw.get("window").map(String::as_str)) {
        Ok(window) => window,
        Err(()) => {
            return error_json(&"Invalid window parameter (use 7d, 30d or all)")
        }
    };

    let Some(wallet) = raw.get("wallet") else {
        return error_json(&"Missing wallet parameter");
    };
    if !is_evm_address(wallet.trim()) {
        tracing::warn!("[bets/stats] rejected malformed wallet param");
        return error_json(&"Invalid wallet parameter");
    }
    let address = canonical(wallet.trim());

    match run(&address, &window).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn run(address: &str, window: &str) -> Result<Value, ApiError> {
    let now = now_ms();
    let since = stats_window_start_iso(window, now);

    let mut binds = Binds::new();
    let mut clauses: Vec<String> = Vec::new();
    clauses.push(format!(
        "wallet_address = {}",
        binds.push(column_type("bet_history", "wallet_address").await?, Value::String(address.to_string()))
    ));
    if let Some(since) = &since {
        clauses.push(format!(
            "created_at >= {}",
            binds.push(column_type("bet_history", "created_at").await?, Value::String(since.clone()))
        ));
    }
    let where_sql = format!("WHERE {}", clauses.join(" AND "));
    let limit_ph = binds.push_static("bigint", Value::String(STATS_MAX_ROWS.to_string()));

    // `ORDER BY resolved_at DESC LIMIT 5000` — the same cap the aggregate uses
    // to decide `truncated`, so a full page never over- or under-states it.
    let statement = format!(
        "SELECT {SELECT_FIELDS} FROM bet_history {where_sql} ORDER BY resolved_at DESC LIMIT {limit_ph}"
    );
    let rows = sql::fetch(&statement, &binds.refs()).await.map_err(|err| {
        tracing::error!("[bets/stats] query failed {err}");
        ApiError::internal("Failed to compute stats")
    })?;

    let stats = aggregate_wallet_stats(&rows, window, now, Some(STATS_MAX_ROWS));

    let mut body = Map::new();
    body.insert("wallet".into(), Value::String(address.to_string()));
    body.insert("window".into(), Value::String(window.to_string()));
    body.insert("stats".into(), stats);
    Ok(Value::Object(body))
}

fn error_json(message: &str) -> Response {
    json_status(
        StatusCode::BAD_REQUEST,
        Value::Object(Map::from_iter([("error".to_string(), Value::String(message.to_string()))])),
    )
}
