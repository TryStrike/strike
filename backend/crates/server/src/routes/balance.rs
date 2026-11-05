//! `/api/balance/*` — the house-ledger family.
//!
//! Session minting and balance reads are here; the mutation routes
//! (bet/deposit/win/withdraw) follow the same guard and RPC conventions.

use axum::extract::{Path, Query};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value};

use strike_core::address;
use strike_core::crypto::{mint_balance_session, BALANCE_SESSION_COOKIE};
use strike_core::error::{ApiError, ApiResult};

use crate::bans::is_globally_banned;
use crate::http::{json_with_cookie, Cookie};
use crate::sql;

pub fn routes() -> Router {
    Router::new()
        .route("/api/balance/session", post(mint_session))
        .route("/api/balance/{address}", get(read_balance))
}

/// `POST /api/balance/session` — mints the HttpOnly gate cookie. With no secret
/// configured the TS mints nothing and answers `{ok:true}` without a cookie, so
/// development keeps working; the mutation guard is what refuses requests.
async fn mint_session() -> ApiResult<axum::response::Response> {
    let body = Value::Object(Map::from_iter([("ok".to_string(), Value::Bool(true))]));
    let Some(value) = mint_balance_session() else {
        return Ok(Json(body).into_response());
    };
    Ok(json_with_cookie(
        body,
        Cookie {
            name: BALANCE_SESSION_COOKIE,
            value,
            max_age: 60 * 60 * 12,
            same_site: "lax",
            http_only: true,
        },
    ))
}

#[derive(Deserialize)]
struct BalanceQuery {
    currency: Option<String>,
}

/// `GET /api/balance/[address]` — sums legacy duplicate rows, reports the tier
/// of the canonical row, and never fails for an unknown wallet (balance 0).
async fn read_balance(
    Path(address_param): Path<String>,
    Query(query): Query<BalanceQuery>,
) -> ApiResult<Json<Value>> {
    let currency = query.currency.filter(|c| !c.is_empty()).unwrap_or_else(|| "USDC".to_string());

    if !address::is_address(&address_param) {
        return Err(ApiError::bad_request(
            "Invalid wallet address format (an Arc address is required)",
        ));
    }

    let variants = address::search_variants(&address_param);
    // $1 is the currency, $2.. the address variants.
    let placeholders = sql::in_list(2, "text", variants.len());
    // `NULLS LAST`: the TS route chose its newest row with
    // `new Date(r.updated_at) > new Date(best.updated_at)`, and `new Date(null)`
    // is the epoch - a row with no `updated_at` can never be the latest one
    // unless every row is missing it. Plain `DESC` puts NULLs first in
    // Postgres, which would have answered `updatedAt: null`.
    let statement = format!(
        "SELECT balance, updated_at, user_address, user_tier \
         FROM user_balances \
         WHERE user_address IN ({placeholders}) AND currency = CAST($1 AS text) \
         ORDER BY updated_at DESC NULLS LAST"
    );
    let mut binds: Vec<(&str, Value)> = Vec::with_capacity(variants.len() + 1);
    binds.push(("text", Value::String(currency.clone())));
    for variant in &variants {
        binds.push(("text", Value::String(variant.clone())));
    }
    let bind_refs: Vec<(&str, &Value)> = binds.iter().map(|(t, v)| (*t, v)).collect();

    let rows = sql::fetch(&statement, &bind_refs)
        .await
        .map_err(|err| {
            tracing::error!("balance read failed: {err}");
            ApiError::unavailable("Service temporarily unavailable. Please try again.")
        })?;

    if rows.is_empty() {
        return Ok(Json(Value::Object(Map::from_iter([
            ("balance".to_string(), Value::Number(0.into())),
            ("updatedAt".to_string(), Value::Null),
            ("tier".to_string(), Value::String("free".to_string())),
            ("globallyBanned".to_string(), Value::Bool(is_globally_banned(&address_param).await)),
        ]))));
    }

    // Sum in f64 exactly as the TS reduce did, and take the newest row for the
    // timestamp: rows are ordered newest-first above.
    let total: f64 = rows
        .iter()
        .filter_map(|row| row.get("balance").and_then(Value::as_f64))
        .sum();
    let latest_updated = rows
        .first()
        .and_then(|row| row.get("updated_at"))
        .cloned()
        .unwrap_or(Value::Null);

    let user_key = address::canonical(&address_param);
    let tier_source = rows
        .iter()
        .find(|row| row.get("user_address").and_then(Value::as_str) == Some(user_key.as_str()))
        .unwrap_or(&rows[0]);
    let tier = tier_source
        .get("user_tier")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .unwrap_or("free")
        .to_string();

    Ok(Json(Value::Object(Map::from_iter([
        ("balance".to_string(), serde_json::json!(total)),
        ("updatedAt".to_string(), latest_updated),
        ("tier".to_string(), Value::String(tier)),
        ("globallyBanned".to_string(), Value::Bool(is_globally_banned(&address_param).await)),
    ]))))
}
