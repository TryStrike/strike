//! `POST /api/bets/save` — `app/api/bets/save/route.ts`.
//!
//! Authorised upsert of one play-money bet into `bet_history`. Every field is
//! coerced with the same defaults the TS route applied (`asset || 'BNB'`,
//! `parseFloat(multiplier) || 1.9`, …), the wallet is canonicalised, and the
//! row is keyed on `id` (`ON CONFLICT (id) DO UPDATE`).
//!
//! A real bet's row belongs to settlement. Any id outside the `demo-` namespace,
//! which every reader of real money filters out, is acknowledged and not written,
//! so a client can neither overwrite a result nor invent one.

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{Map, Value};

use strike_core::address::is_address;
use strike_core::bets::{
    canonical_address, is_demo_bet_row, is_truthy, iso_ms, now_ms, save_float, save_float_or,
    save_string_or_default, value_to_string,
};
use strike_core::error::ApiError;

use crate::http::require_balance_session;
use crate::sql;

use super::{column_type, Binds};

/// The columns the TS upsert writes, in body order; `id` is the conflict target.
const COLUMNS: [&str; 13] = [
    "id",
    "wallet_address",
    "asset",
    "direction",
    "amount",
    "multiplier",
    "strike_price",
    "end_price",
    "payout",
    "won",
    "mode",
    "network",
    "resolved_at",
];

pub fn routes() -> Router {
    Router::new().route("/api/bets/save", post(handle))
}

async fn handle(headers: HeaderMap, raw: Bytes) -> Response {
    // Guard runs before the body is read, but a malformed JSON body then throws
    // inside the route's try and lands on `Internal server error`.
    if let Err(err) = require_balance_session(&headers) {
        return err.into_response();
    }

    let body: Value = match serde_json::from_slice(&raw) {
        Ok(body) => body,
        Err(err) => {
            tracing::error!("Error saving bet: {err}");
            return error_response(500, "Internal server error");
        }
    };

    if !is_truthy(body.get("id")) || !is_truthy(body.get("walletAddress")) {
        return error_response(400, "Missing required fields");
    }
    // `bet_history` feeds admin totals and leaderboards, so only a real wallet
    // gets a row. The TS threw on a non-string here and stored any other text.
    let wallet = body.get("walletAddress").and_then(Value::as_str);
    if !wallet.is_some_and(|w| is_address(w.trim())) {
        return error_response(400, "Invalid walletAddress");
    }

    let id = body.get("id").cloned().unwrap_or(Value::Null);
    if !is_demo_bet_row(&Value::Object(Map::from_iter([("id".to_string(), id)]))) {
        return axum::Json(success()).into_response();
    }

    match run(&body).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn run(body: &Value) -> Result<Value, ApiError> {
    let values: [(&str, Value); 13] = [
        (
            "id",
            Value::String(value_to_string(body.get("id").unwrap_or(&Value::Null))),
        ),
        (
            "wallet_address",
            Value::String(canonical_address(&value_to_string(
                body.get("walletAddress").unwrap_or(&Value::Null),
            ))),
        ),
        (
            "asset",
            Value::String(save_string_or_default(body, "asset", "BNB")),
        ),
        (
            "direction",
            Value::String(save_string_or_default(body, "direction", "UP")),
        ),
        ("amount", Value::from(save_float(body, "amount"))),
        (
            "multiplier",
            Value::from(save_float_or(body, "multiplier", 1.9)),
        ),
        ("strike_price", Value::from(save_float(body, "strikePrice"))),
        ("end_price", Value::from(save_float(body, "endPrice"))),
        ("payout", Value::from(save_float(body, "payout"))),
        ("won", Value::Bool(is_truthy(body.get("won")))),
        (
            "mode",
            Value::String(save_string_or_default(body, "mode", "strike")),
        ),
        (
            "network",
            Value::String(save_string_or_default(body, "network", "USDC")),
        ),
        ("resolved_at", Value::String(iso_ms(now_ms()))),
    ];

    // Build the column list and `$n` placeholders, typing every bind with the
    // column's catalog type (re-validated inside `column_type`).
    let mut binds = Binds::new();
    let mut cols: Vec<String> = Vec::new();
    let mut placeholders: Vec<String> = Vec::new();
    for (name, value) in values {
        // The TS route had no schema step: every read/write failure, including
        // an unexpected column, surfaced as its `Failed to save bet` 500.
        let ty = column_type("bet_history", name).await.map_err(|err| {
            tracing::error!("Supabase bet save error: {err}");
            ApiError::internal("Failed to save bet")
        })?;
        placeholders.push(binds.push(ty, value));
        cols.push(format!("\"{name}\""));
    }

    let updates: Vec<String> = COLUMNS
        .iter()
        .filter(|c| **c != "id")
        .map(|c| format!("\"{c}\" = EXCLUDED.\"{c}\""))
        .collect();

    let statement = format!(
        "INSERT INTO bet_history ({}) VALUES ({}) ON CONFLICT (\"id\") DO UPDATE SET {}",
        cols.join(", "),
        placeholders.join(", "),
        updates.join(", "),
    );

    sql::execute(&statement, &binds.refs())
        .await
        .map_err(|err| {
            tracing::error!("Supabase bet save error: {err}");
            ApiError::internal("Failed to save bet")
        })?;

    Ok(success())
}

fn success() -> Value {
    Value::Object(Map::from_iter([("success".to_string(), Value::Bool(true))]))
}

fn error_response(status: u16, message: &str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = Value::Object(Map::from_iter([(
        "error".to_string(),
        Value::String(message.to_string()),
    )]));
    (code, axum::Json(body)).into_response()
}
