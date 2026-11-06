//! `/api/referral` — a wallet's own referral record, its referred friends, and
//! the public leaderboard.
//!
//! Every decision that changes what the
//! response *says* (code minting, address truncation, demo-row exclusion,
//! qualification arithmetic, referrer resolution) is pure logic in
//! `strike_core::referral`; this module owns HTTP and the SQL statements.
//!
//!   GET  /api/referral?leaderboard=1        public top 20, never a referral code
//!   GET  /api/referral?friends=1&address=   first-party referees + qualification
//!   GET  /api/referral?address=             first-party own code + count
//!   POST /api/referral                      first-party create-or-load + attribution
//!
//! The gate order is the TS's: the board answers before any auth, and both the
//! friends list and the single-wallet lookup sit behind
//! `assertBalanceApiAuthorized`, so a visitor cannot enumerate someone else's
//! `referral_code` or `referred_by`.
//!
//! Money honesty is unchanged: a referee is `qualified` only once the bet ledger
//! holds a real-money bet for them, so `demo-…` bet ids and `0xDEMO…` wallets are
//! dropped by the same predicates the leaderboard and bet history use.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::Query;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::Value;

use strike_core::address::{canonical, search_variants};
use strike_core::bets::value_to_string;
use strike_core::db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::referral::{
    bet_scan_keys, bumped_referral_count, clean_referral_code, count_qualified, friends_json,
    friends_response, friends_totals, is_referral_address, leaderboard_json, real_bet_signals,
    referral_code, register_response, resolve_referrer_target, should_attempt_bind,
    single_referral_json, split_demo_rows, RealBetSignal, BET_SCAN_CAP, FRIENDS_PAGE_CAP,
    LEADERBOARD_SCAN_CAP, MAX_ROWS_PER_QUERY,
};

use crate::http::{json_truthy, require_balance_session, require_wallet_session};
use crate::sql;

/// `.slice(0, 20)` in the TS: the scan reads `LEADERBOARD_SCAN_CAP` rows so the
/// demo exclusion cannot starve the visible board.
const VISIBLE_LEADERBOARD_ROWS: usize = 20;

pub fn routes() -> Router {
    Router::new().route("/api/referral", get(get_handler).post(post_handler))
}

// ── GET ───────────────────────────────────────────────────────────────────────

async fn get_handler(
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    // The leaderboard is public: addresses are already truncated there, and no
    // code or `referred_by` ever leaves it, so it needs no session.
    if flag_set(&params, "leaderboard") {
        return respond(leaderboard().await);
    }

    // Everything below is first-party only, and only for the signed-in wallet.
    let address = params
        .get("address")
        .map(String::as_str)
        .unwrap_or_default();
    if let Err(err) = require_wallet_session(&headers, address) {
        return err.into_response();
    }

    if flag_set(&params, "friends") {
        return respond(friends(&params).await);
    }
    respond(single(&params).await)
}

fn respond(result: ApiResult<Value>) -> Response {
    match result {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

/// `searchParams.get(key) === '1'` — an exact string test, not a truthiness one.
fn flag_set(params: &HashMap<String, String>, key: &str) -> bool {
    params.get(key).map(String::as_str) == Some("1")
}

/// `searchParams.get('address')?.trim()`, then `if (!address)`: an empty or
/// whitespace-only value is "not supplied", not a lookup that matches nothing.
fn query_address(params: &HashMap<String, String>) -> Option<String> {
    let trimmed = params.get("address").map(|raw| raw.trim().to_string())?;
    (!trimmed.is_empty()).then_some(trimmed)
}

async fn leaderboard() -> ApiResult<Value> {
    let scan = Value::from(LEADERBOARD_SCAN_CAP);
    let statement = "SELECT user_address, referral_count FROM user_referrals \
         ORDER BY referral_count DESC LIMIT CAST($1 AS int8)";
    let rows = db::fetch(statement, &[("int8", &scan)])
        .await
        .map_err(|err| {
            tracing::error!("[referral] leaderboard query failed {err}");
            ApiError::internal("Failed to load leaderboard")
        })?;
    Ok(leaderboard_json(&rows, VISIBLE_LEADERBOARD_ROWS))
}

/// Who joined via this wallet's code, and which of them have actually traded.
///
/// `joined` is the DB's exact count for the relationship (demo rows subtracted);
/// `qualified` / `pending` always describe THIS page of referees, never a slice
/// of the whole network.
async fn friends(params: &HashMap<String, String>) -> ApiResult<Value> {
    let address = query_address(params).ok_or_else(|| ApiError::bad_request("address required"))?;
    let variants = text_values(&search_variants(&address));
    let bind_refs = text_refs(&variants);
    let where_clause = format!(
        "referred_by IN ({})",
        sql::in_list(1, "text", bind_refs.len())
    );

    // `{ count: 'exact' }` counted every matching row, the page only carried one
    // window of them, so the two numbers are read by separate statements.
    let count_sql = format!("SELECT COUNT(*) AS count FROM user_referrals WHERE {where_clause}");
    let db_count = db::fetch_scalar(&count_sql, &bind_refs)
        .await
        .map_err(friends_failure)?;

    let page_cap = Value::from(FRIENDS_PAGE_CAP);
    let limit_ph = bind_refs.len() + 1;
    let rows_sql = format!(
        "SELECT user_address, created_at FROM user_referrals WHERE {where_clause} \
         ORDER BY created_at DESC LIMIT CAST(${limit_ph} AS int8)"
    );
    let mut row_binds = bind_refs.clone();
    row_binds.push(("int8", &page_cap));
    let rows = db::fetch(&rows_sql, &row_binds)
        .await
        .map_err(friends_failure)?;

    // Play-money wallets are not nodes: they never traded real money.
    let (page_rows, demo_rows_dropped) = split_demo_rows(&rows);
    let (signals, scanned) = bet_signals(&referee_addresses(&page_rows)).await;

    let friends = friends_json(&page_rows, &signals);
    let totals = friends_totals(
        db_count.as_i64(),
        demo_rows_dropped,
        page_rows.len(),
        count_qualified(&friends),
        scanned,
    );
    Ok(friends_response(friends, totals))
}

fn friends_failure(err: ApiError) -> ApiError {
    tracing::error!("[referral] friends query failed {err}");
    ApiError::internal("Failed to load referrals")
}

/// The `user_address` of each page row, which is what the scan is asked about.
/// `user_address` is the primary key, so a row without one cannot exist; the
/// fallback keeps the function total rather than panicking.
fn referee_addresses(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|row| {
            row.get("user_address")
                .map(value_to_string)
                .unwrap_or_default()
        })
        .collect()
}

/// `realBetSignals()`: which of these referees have placed a real-money bet, and
/// when they first did.
///
/// A failed scan is not an error — the TS logged it and kept every friend
/// `pending` with `scanned: 0`, which is what `qualifiedExact` then reports.
async fn bet_signals(referees: &[String]) -> (Vec<(String, RealBetSignal)>, usize) {
    let keys = bet_scan_keys(referees);
    if keys.is_empty() {
        return (Vec::new(), 0);
    }

    let wallet_binds = text_values(&keys);
    let bind_refs = text_refs(&wallet_binds);
    let limit_ph = bind_refs.len() + 1;
    // `.limit(BET_SCAN_CAP)` passed through the query builder, which clamps any
    // LIMIT to `MAX_ROWS_PER_QUERY` rows. Keeping that ceiling here is what makes
    // `scanned` (and therefore `qualifiedExact`) mean the same as it did in the
    // TS: the bounded scan can never report that it filled its own cap.
    let limit = Value::from(BET_SCAN_CAP.min(MAX_ROWS_PER_QUERY));
    let statement = format!(
        "SELECT id, wallet_address, created_at FROM bet_history \
         WHERE wallet_address IN ({}) \
         ORDER BY created_at ASC LIMIT CAST(${limit_ph} AS int8)",
        sql::in_list(1, "text", bind_refs.len())
    );
    let mut binds = bind_refs.clone();
    binds.push(("int8", &limit));

    match db::fetch(&statement, &binds).await {
        Ok(rows) => real_bet_signals(&rows),
        Err(err) => {
            tracing::error!("[referral] qualification query failed {err}");
            (Vec::new(), 0)
        }
    }
}

/// The wallet's own record: `{ referral: {code, count, referred_by} | null }`.
async fn single(params: &HashMap<String, String>) -> ApiResult<Value> {
    let address = query_address(params).ok_or_else(|| ApiError::bad_request("address required"))?;
    let row = find_by_variants(&address).await.map_err(|err| {
        tracing::error!("[referral] wallet lookup failed {err}");
        ApiError::internal("Failed to fetch referral data")
    })?;
    Ok(single_referral_json(row.as_ref()))
}

/// The four columns the row is read with, under any spelling the wallet was
/// stored as. Used by the single-wallet GET and by the POST's create-or-load.
async fn find_by_variants(address: &str) -> ApiResult<Option<Value>> {
    let variants = text_values(&search_variants(address));
    let bind_refs = text_refs(&variants);
    let limit_ph = bind_refs.len() + 1;
    let one = Value::from(1i64);
    let statement = format!(
        "SELECT referral_code, referral_count, referred_by, user_address FROM user_referrals \
         WHERE user_address IN ({}) LIMIT CAST(${limit_ph} AS int8)",
        sql::in_list(1, "text", bind_refs.len())
    );
    let mut binds = bind_refs.clone();
    binds.push(("int8", &one));
    db::fetch_one(&statement, &binds).await
}

// ── POST ──────────────────────────────────────────────────────────────────────

async fn post_handler(headers: HeaderMap, raw: Bytes) -> Response {
    // The guard runs before the body is parsed, like the TS route.
    if let Err(err) = require_balance_session(&headers) {
        return err.into_response();
    }

    // A malformed body throws inside the route's try and lands on the same
    // generic failure message the catch returns.
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(body) => body,
        Err(err) => {
            tracing::error!("[referral] POST request failed {err}");
            return ApiError::internal("Failed to register referral").into_response();
        }
    };

    if let Err(err) = require_wallet_session(&headers, body["address"].as_str().unwrap_or_default())
    {
        return err.into_response();
    }
    match register(&body).await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn register(body: &Value) -> ApiResult<Value> {
    // `if (!address)` is a truthiness test on the JSON value, so a truthy
    // non-string reaches the regex as its `String()` spelling rather than being
    // refused as "not a string".
    let raw_address = body.get("address");
    if !json_truthy(raw_address) {
        return Err(ApiError::bad_request("address required"));
    }
    let address = value_to_string(raw_address.unwrap_or(&Value::Null))
        .trim()
        .to_string();
    if !is_referral_address(&address) {
        return Err(ApiError::bad_request("Invalid address"));
    }
    let addr_key = canonical(&address);

    // The referrer is resolved from the code here, on the server — the client
    // never gets to name its own referrer.
    let referrer = resolve_referrer(body.get("referredByCode"), &addr_key).await;

    // Create-or-load, atomically. `user_referrals.user_address` is the primary
    // key, so a concurrent request (StrictMode double-post, two tabs) loses the
    // race with a unique violation instead of writing a second row or clobbering
    // the code that was just minted.
    for _attempt in 0..2 {
        let code = referral_code(&addr_key);
        let key_bind = Value::String(addr_key.clone());
        let code_bind = Value::String(code);
        let referred_bind = referrer.clone().map(Value::String).unwrap_or(Value::Null);
        let count_bind = Value::from(0i64);

        let inserted = db::fetch_one(
            "INSERT INTO user_referrals \
             (user_address, referral_code, referred_by, referral_count) \
             VALUES (CAST($1 AS text), CAST($2 AS text), CAST($3 AS text), CAST($4 AS integer)) \
             RETURNING referral_code, referral_count",
            &[
                ("text", &key_bind),
                ("text", &code_bind),
                ("text", &referred_bind),
                ("integer", &count_bind),
            ],
        )
        .await;

        match inserted {
            Ok(Some(row)) => {
                if let Some(referrer) = &referrer {
                    increment_referrer(referrer).await;
                }
                return Ok(register_response(
                    field(&row, "referral_code"),
                    field(&row, "referral_count"),
                ));
            }
            // `.single()` over an insert that produced no row is an error whose
            // code is not a unique violation: the TS breaks out and answers 500.
            Ok(None) => break,
            Err(err) if is_unique_violation(&err) => {
                let Some(existing) = find_by_variants(&address).await.ok().flatten() else {
                    // Either our own fresh code collided, or the read failed:
                    // both mean "mint another and retry" within the two attempts.
                    continue;
                };

                // Late attribution: a record created before the visitor clicked a
                // /?ref= link has no referrer and would never get one, because
                // every later call takes this early-return path. Bind it exactly
                // once — the `referred_by IS NULL` guard makes both the bind and
                // the counter increment unrepeatable.
                if should_attempt_bind(referrer.as_deref(), Some(&existing)) {
                    if let Some(referrer) = &referrer {
                        if bind_referrer(&existing, referrer).await.unwrap_or(0) > 0 {
                            increment_referrer(referrer).await;
                            return Ok(register_response(
                                field(&existing, "referral_code"),
                                bumped_referral_count(&existing),
                            ));
                        }
                    }
                }

                return Ok(register_response(
                    field(&existing, "referral_code"),
                    field(&existing, "referral_count"),
                ));
            }
            Err(err) => {
                tracing::error!("[referral] insert failed {err}");
                break;
            }
        }
    }

    Err(ApiError::internal("Failed to register referral"))
}

/// `resolveReferrer()`: the code's owner, or `None` for "no referrer". An empty
/// or non-string code, an unknown code, and a code that points back at this
/// wallet all resolve to nothing, and a failed read is treated the same way
/// (the TS ignored the error and saw no row).
async fn resolve_referrer(raw_code: Option<&Value>, self_key: &str) -> Option<String> {
    let code = clean_referral_code(raw_code)?;
    let code_bind = Value::String(code);
    let one = Value::from(1i64);
    let row = db::fetch_one(
        "SELECT user_address FROM user_referrals \
         WHERE referral_code = CAST($1 AS text) LIMIT CAST($2 AS int8)",
        &[("text", &code_bind), ("int8", &one)],
    )
    .await
    .map_err(|err| tracing::error!("[referral] referrer lookup failed {err}"))
    .ok()?;
    resolve_referrer_target(raw_code, self_key, row.as_ref()?.get("user_address"))
}

/// The `UPDATE … .eq('user_address', …).is('referred_by', null)` the TS reads
/// back as `bound.length > 0`: rows affected is the same fact.
async fn bind_referrer(existing: &Value, referrer: &str) -> ApiResult<u64> {
    let referrer_bind = Value::String(referrer.to_string());
    // The exact stored spelling, so the primary key matches.
    let address_bind = field(existing, "user_address");
    db::execute(
        "UPDATE user_referrals SET referred_by = CAST($1 AS text) \
         WHERE user_address = CAST($2 AS text) AND referred_by IS NULL",
        &[("text", &referrer_bind), ("text", &address_bind)],
    )
    .await
}

/// The referrer's counter, moved by the ledger function rather than by a client.
/// A failure here is logged, not surfaced: the referral row is already written,
/// and the TS fired the RPC without checking it.
async fn increment_referrer(referrer: &str) {
    let address = Value::String(referrer.to_string());
    if let Err(err) = db::call_rpc(
        "increment_referral_count",
        &[("referrer_address", &address)],
    )
    .await
    {
        tracing::error!("[referral] increment_referral_count failed {err}");
    }
}

// ── Shared transport helpers ──────────────────────────────────────────────────

/// Owned text binds for one `IN (CAST($n AS text), …)` list, in order. The
/// values must outlive `text_refs`, which borrows them.
fn text_values(values: &[String]) -> Vec<Value> {
    values
        .iter()
        .map(|value| Value::String(value.clone()))
        .collect()
}

/// The `(postgres type, value)` pairs `db::fetch` takes, one text bind per value.
fn text_refs(values: &[Value]) -> Vec<(&str, &Value)> {
    values.iter().map(|value| ("text", value)).collect()
}

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// Postgres `23505`, out of the transport's error type: the one failure that is
/// retried rather than reported.
fn is_unique_violation(err: &ApiError) -> bool {
    matches!(err, ApiError::Db(db_err) if db::is_unique_violation(db_err))
}
