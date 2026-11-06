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

use axum::http::HeaderMap;
use strike_core::address;
use strike_core::crypto::{
    balance_session_message, balance_session_wallet, mint_balance_session, BALANCE_SESSION_COOKIE,
    MAX_CLOCK_SKEW_MS, MAX_INTENT_AGE_MS,
};
use strike_core::error::{ApiError, ApiResult};
use strike_core::eth::verify_personal_signature;
use strike_core::ledger;

use crate::bans::is_globally_banned;
use crate::http::{cookie, json_with_cookie, Cookie};
use crate::sql;

pub fn routes() -> Router {
    Router::new()
        .route(
            "/api/balance/session",
            post(mint_session).get(session_wallet),
        )
        .route("/api/balance/{address}", get(read_balance))
}

/// `POST /api/balance/session` — the wallet signs `balance_session_message` and
/// gets an HttpOnly cookie bound to it. With no secret configured nothing is
/// minted, so development keeps working; the mutation guard refuses requests.
async fn mint_session(Json(body): Json<Value>) -> ApiResult<axum::response::Response> {
    let address = body["address"].as_str().unwrap_or_default();
    let issued_at = body["issuedAt"].as_i64().unwrap_or_default();
    let signature = body["signature"].as_str().unwrap_or_default();
    if !address::is_address(address) {
        return Err(ApiError::bad_request("A wallet address is required"));
    }
    let age = chrono::Utc::now().timestamp_millis() - issued_at;
    if !(-MAX_CLOCK_SKEW_MS..=MAX_INTENT_AGE_MS).contains(&age) {
        return Err(ApiError::bad_request(
            "Sign-in message is stale, sign again",
        ));
    }
    if !verify_personal_signature(
        address,
        &balance_session_message(address, issued_at),
        signature,
    )
    .await?
    {
        return Err(ApiError::unauthorized(
            "Sign-in signature is not from this wallet",
        ));
    }
    let wallet = address::canonical(address);
    let ok = Value::Object(Map::from_iter([
        ("ok".to_string(), Value::Bool(true)),
        ("wallet".to_string(), Value::String(wallet.clone())),
    ]));
    let Some(value) = mint_balance_session(&wallet) else {
        return Ok(Json(ok).into_response());
    };
    Ok(json_with_cookie(
        ok,
        Cookie {
            name: BALANCE_SESSION_COOKIE,
            value,
            max_age: 60 * 60 * 12,
            same_site: "lax",
            http_only: true,
        },
    ))
}

/// `GET /api/balance/session` — which wallet this browser is signed in as, so the
/// app asks for a signature only when it has to.
async fn session_wallet(headers: HeaderMap) -> Json<Value> {
    let wallet = balance_session_wallet(cookie(&headers, BALANCE_SESSION_COOKIE).as_deref());
    Json(serde_json::json!({ "wallet": wallet }))
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
    let currency = query
        .currency
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "USDC".to_string());

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

    let rows = sql::fetch(&statement, &bind_refs).await.map_err(|err| {
        tracing::error!("balance read failed: {err}");
        ApiError::unavailable("Service temporarily unavailable. Please try again.")
    })?;

    if rows.is_empty() {
        return Ok(Json(Value::Object(Map::from_iter([
            ("balance".to_string(), Value::Number(0.into())),
            ("updatedAt".to_string(), Value::Null),
            ("tier".to_string(), Value::String("free".to_string())),
            (
                "globallyBanned".to_string(),
                Value::Bool(is_globally_banned(&address_param).await),
            ),
        ]))));
    }

    // Legacy duplicate rows sum in exact base units: this number is what the
    // player sees as their money, so an unreadable row fails rather than
    // quietly lowering it. Rows are ordered newest-first above.
    let null = Value::Null;
    let balances = rows.iter().map(|row| row.get("balance").unwrap_or(&null));
    let Some(total_base) = ledger::sum_amounts_to_base_units(balances, ledger::USDC_DECIMALS)
    else {
        tracing::error!("Balance rows contain an unparseable amount: {rows:?}");
        return Err(ApiError::unavailable(
            "Service temporarily unavailable. Please try again.",
        ));
    };
    let total = ledger::base_units_to_number(total_base, ledger::USDC_DECIMALS);
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
        (
            "globallyBanned".to_string(),
            Value::Bool(is_globally_banned(&address_param).await),
        ),
    ]))))
}
