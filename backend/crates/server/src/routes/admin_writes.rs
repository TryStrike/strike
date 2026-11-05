//! Admin MUTATION routes — the POST/DELETE half of `app/api/admin/*`.
//!
//! Ports, with the guards in the original order:
//!   * `POST   /api/admin/access-codes`               (generate codes)
//!   * `POST   /api/admin/banned-wallets`             (add a ban)
//!   * `DELETE /api/admin/banned-wallets`             (remove a ban)
//!   * `POST   /api/admin/unban-wallet`               (unban + wipe + audit)
//!   * `POST   /api/admin/users/status`               (freeze/ban/activate)
//!   * `POST   /api/admin/withdrawal-requests/{id}/accept`
//!   * `POST   /api/admin/withdrawal-requests/{id}/reject`
//!
//! The GET halves are read routes owned by the read-porting agent. The TS
//! `currencies`, `danger-zone` and `users` routes export no mutators at all
//! (`app/api/admin/currencies/route.ts` etc. are GET-only), so no POST/PUT/
//! DELETE is registered for them here — exactly what Next.js exposes.
//!
//! The pure validation/amount/aggregation logic lives in
//! `strike_core::admin_writes` / `strike_core::admin_writes_extra`; this module
//! is transport, SQL with typed binds (`crate::sql`), and the exact JSON error
//! bodies the TS routes produced.
//!
//! One deliberate hardening runs throughout: every string the TS echoed from a
//! thrown error passes through `admin_writes::sanitize_error_text` first, so a
//! pg/reqwest internal becomes the route's own fallback string instead of a
//! connection-string leak. Operator-authored messages — short, single-line
//! strings like "Insufficient house balance for acceptance" — pass through
//! byte-identical, so the client-visible shape is unchanged for every failure
//! the TS could actually produce.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::Path;
use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{json, Map, Value};

use strike_core::admin_writes::{
    ban_reason, combined_tx_hash, js_number_string, parse_request_id, plan_payout,
    respond_supabase_error, sanitize_error_text, verify_withdrawal_intent, wipe_audit_rows,
};
use strike_core::admin_writes_extra::{access_code_count, generate_access_codes};
use strike_core::address::{canonical, search_variants};
use strike_core::bets::{
    is_truthy, iso_ms, now_ms, number_coerce, to_number, value_to_string,
};
use strike_core::config::{config, USDC_DECIMALS};
use strike_core::db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::eth::{parse_units, Treasury};

use crate::bans::is_globally_banned;
use crate::http;
use crate::sql;

/// Columns the access-codes route selects after inserting, in TS order.
const ACCESS_CODE_COLUMNS: &str = "id, code, is_used, wallet_address, used_at, created_at";

/// Columns the accept/reject routes select explicitly ("to avoid exposing
/// sensitive future columns"); the lists differ per route, as in the TS.
const ACCEPT_REQUEST_COLUMNS: &str = "id, user_address, currency, amount, net_amount, fee_amount, \
    requested_at, status, decided_by, tx_hash, signature, signed_at, created_at";
const REJECT_REQUEST_COLUMNS: &str = "id, user_address, currency, amount, net_amount, fee_amount, \
    requested_at, status, decided_by, tx_hash, created_at";

/// The production-only service-role gate of the banned-wallets family
/// (`requireServiceRoleInProduction`). The TS `isSupabaseServiceRoleConfigured`
/// is literally `Boolean(process.env.DATABASE_URL?.trim())`, so the Rust
/// equivalent is a missing `DATABASE_URL` in a production deployment. The body
/// text stays byte-identical because the browser bundle is unchanged.
const SERVICE_ROLE_MISSING: &str = "SUPABASE_SERVICE_KEY is not set on this server. In Vercel: Settings → Environment Variables → add SUPABASE_SERVICE_KEY (Supabase Dashboard → Project Settings → API → service_role secret). Redeploy.";

pub fn routes() -> Router {
    Router::new()
        .route("/api/admin/access-codes", post(access_codes_generate))
        .route("/api/admin/banned-wallets", post(ban_add).delete(ban_remove))
        .route("/api/admin/unban-wallet", post(unban_wallet))
        .route("/api/admin/users/status", post(user_status))
        .route(
            "/api/admin/withdrawal-requests/{id}/accept",
            post(accept_withdrawal),
        )
        .route(
            "/api/admin/withdrawal-requests/{id}/reject",
            post(reject_withdrawal),
        )
}

// ---------------------------------------------------------------------------
// Shared response plumbing
// ---------------------------------------------------------------------------

/// `NextResponse.json({ error: msg }, { status })` for this family.
fn error(status: StatusCode, msg: impl AsRef<str>) -> Response {
    http::json_status(status, json!({ "error": msg.as_ref() }))
}

/// The route-family catch-all: the TS echoes `err.message` (or a fixed
/// fallback) with status 500 for anything thrown inside `try`. The raw text is
/// sanitized first; the fallback doubles as the TS's own catch fallback.
fn catch_500(err: &ApiError, fallback: &str) -> Response {
    let safe = sanitize_error_text(&err.to_string(), fallback);
    error(StatusCode::INTERNAL_SERVER_ERROR, safe)
}

/// The access-codes / banned-wallets catch: `appendSupabaseServiceKeyHint`
/// around the echoed message, 500.
fn hinted_catch_500(err_text: &str, fallback: &str) -> Response {
    let safe = sanitize_error_text(err_text, fallback);
    let body = strike_core::admin_writes::append_service_key_hint(&safe);
    error(StatusCode::INTERNAL_SERVER_ERROR, body)
}

/// The banned-wallets statement-error responder: missing-table 503 with the
/// migration nudge, otherwise a sanitized 500 (`respondSupabaseError`).
fn supabase_statement_error(err_text: &str, fallback: &str) -> Response {
    let (status, body) = respond_supabase_error(err_text, fallback);
    http::json_status(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        body,
    )
}

/// `id, code, …` row fields default to JSON null, like PostgREST columns.
fn row_field<'a>(row: &'a Value, key: &str) -> &'a Value {
    row.get(key).unwrap_or(&Value::Null)
}

/// `("text", &Value)` bind refs over owned string values.
fn text_binds(values: &[Value]) -> Vec<(&str, &Value)> {
    values.iter().map(|v| ("text", v)).collect()
}

// ---------------------------------------------------------------------------
// POST /api/admin/access-codes
// ---------------------------------------------------------------------------

async fn access_codes_generate(headers: HeaderMap, raw: Bytes) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    match generate_codes_run(&raw).await {
        Ok(response) => response,
        // Statement failures land on the same hinted 500 the TS catch emits.
        Err(err) => hinted_catch_500(&err.to_string(), "Internal server error"),
    }
}

async fn generate_codes_run(raw: &Bytes) -> ApiResult<Response> {
    // `let body: { count?: number } = {}; try { body = await request.json() }
    // catch { body = {} }`: malformed JSON is not an error here, it just means
    // "count was not given". A parsed non-object body has `.count === undefined`
    // in JS, which is what `Value::get` on a non-object also yields.
    let body: Value = serde_json::from_slice(raw).unwrap_or(Value::Null);
    let count = access_code_count(&body);
    let codes = generate_access_codes(count);

    let owned: Vec<Value> = codes.iter().map(|c| Value::String(c.clone())).collect();
    let binds = text_binds(&owned);
    let values: Vec<String> = (1..=codes.len()).map(|i| format!("CAST(${i} AS text)")).collect();
    let rows = sql::fetch(
        &format!(
            "INSERT INTO access_codes (code) VALUES {} RETURNING {ACCESS_CODE_COLUMNS}",
            values.join(", ")
        ),
        &binds,
    )
    .await?;

    Ok(axum::Json(json!({ "codes": rows })).into_response())
}

// ---------------------------------------------------------------------------
// POST /api/admin/banned-wallets
// ---------------------------------------------------------------------------

/// `requireServiceRoleInProduction()`: runs after the admin deny, in TS order.
fn service_role_gate() -> Option<Response> {
    if config().production && config().database_url.is_none() {
        return Some(error(StatusCode::SERVICE_UNAVAILABLE, SERVICE_ROLE_MISSING));
    }
    None
}

async fn ban_add(headers: HeaderMap, raw: Bytes) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    if let Some(block) = service_role_gate() {
        return block;
    }
    match serde_json::from_slice::<Value>(&raw) {
        Err(err) => hinted_catch_500(&err.to_string(), "Failed to add ban"),
        Ok(body) => match ban_add_run(body).await {
            Ok(response) => response,
            Err(text) => supabase_statement_error(&text, "Failed to add ban"),
        },
    }
}

async fn ban_add_run(body: Value) -> Result<Response, String> {
    // `typeof body.walletAddress === 'string' ? trim : ''` — a non-string is
    // silently the empty string, which then 400s as "required".
    let wallet_address = http::body_str(&body, "walletAddress").unwrap_or_default().to_string();
    if wallet_address.is_empty() {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            "walletAddress is required",
        ));
    }
    let reason = ban_reason(body.get("reason"));
    let key = Value::String(canonical(&wallet_address));
    let reason = Value::String(reason);

    // `.upsert({ wallet_address, reason }, { onConflict: 'wallet_address' })
    // .select().single()` — the conflict update touches only `reason`, because
    // that is the only other payload column the TS sent.
    let rows = sql::fetch(
        "INSERT INTO banned_wallets (wallet_address, reason) \
         VALUES (CAST($1 AS text), CAST($2 AS text)) \
         ON CONFLICT (wallet_address) DO UPDATE SET reason = EXCLUDED.reason \
         RETURNING *",
        &[("text", &key), ("text", &reason)],
    )
    .await
    .map_err(|err| err.to_string())?;

    // `single()` with zero rows is a PostgREST error, not a null body; the
    // upsert always returns its row, so this only fires on a trigger that
    // swallowed it — which the TS answered through the same responder.
    match rows.into_iter().next() {
        Some(ban) => Ok(axum::Json(json!({ "success": true, "ban": ban })).into_response()),
        None => Err("banned_wallets: upsert returned no rows".to_string()),
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/banned-wallets
// ---------------------------------------------------------------------------

async fn ban_remove(headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    if let Some(block) = service_role_gate() {
        return block;
    }
    // `searchParams.get('walletAddress') || ''`, then trim.
    let wallet_address = query
        .get("walletAddress")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if wallet_address.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "walletAddress query param is required",
        );
    }
    let key = Value::String(canonical(&wallet_address));
    match sql::execute(
        "DELETE FROM banned_wallets WHERE wallet_address = CAST($1 AS text)",
        &[("text", &key)],
    )
    .await
    {
        // `.delete().eq(...)` reports no row-count error: zero rows deleted is
        // still `{ success: true }`, so a wrong spelling simply no-ops.
        Ok(_) => axum::Json(json!({ "success": true })).into_response(),
        Err(err) => supabase_statement_error(&err.to_string(), "Failed to remove ban"),
    }
}

// ---------------------------------------------------------------------------
// POST /api/admin/unban-wallet
// ---------------------------------------------------------------------------

async fn unban_wallet(headers: HeaderMap, raw: Bytes) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    match unban_run(&raw).await {
        Ok(response) => response,
        Err(err) => catch_500(&err, "Unexpected error"),
    }
}

async fn unban_run(raw: &Bytes) -> ApiResult<Response> {
    // Destructured in the TS (`const { walletAddress } = await request.json()`),
    // so malformed JSON throws into the catch: `e.message ?? 'Unexpected error'`.
    let body: Value = serde_json::from_slice(raw)?;

    // `if (!walletAddress || typeof walletAddress !== 'string')` — unlike the
    // stringified routes, a number does NOT pass here.
    let Some(address) = body.get("walletAddress").and_then(Value::as_str) else {
        return Ok(error(StatusCode::BAD_REQUEST, "walletAddress is required"));
    };
    if address.is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "walletAddress is required"));
    }

    let trimmed = address.trim();
    let key = canonical(trimmed);
    let variants = search_variants(trimmed);

    // 1. Remove from banned_wallets. This is the only failure the route
    // reports verbatim: `Failed to remove ban: ${banErr.message}`, 500.
    let bind_key = Value::String(key.clone());
    if let Err(err) = sql::execute(
        "DELETE FROM banned_wallets WHERE wallet_address = CAST($1 AS text)",
        &[("text", &bind_key)],
    )
    .await
    {
        let text = err.to_string();
        let detail = sanitize_error_text(&text, "");
        let message = if detail.is_empty() {
            "Failed to remove ban".to_string()
        } else {
            format!("Failed to remove ban: {detail}")
        };
        return Ok(error(StatusCode::INTERNAL_SERVER_ERROR, message));
    }

    // 2. Read the balances to wipe, for the audit log. The TS ignores the
    // error slot (`const { data } = …`): a failed read is "no rows to log".
    let owned: Vec<Value> = variants.iter().map(|v| Value::String(v.clone())).collect();
    let bind_refs = text_binds(&owned);
    let current_balances = if bind_refs.is_empty() {
        Vec::new()
    } else {
        let statement = format!(
            "SELECT user_address, currency, balance FROM user_balances \
             WHERE user_address IN ({})",
            sql::in_list(1, "text", bind_refs.len())
        );
        sql::fetch(&statement, &bind_refs)
            .await
            .unwrap_or_else(|err| {
                tracing::warn!("[unban-wallet] balance read failed: {err}");
                Vec::new()
            })
    };

    // 3. Zero the balance and restore `status = 'active'` for every currency
    // row. A failure here is logged, not returned: the ban is already gone and
    // the TS chose not to fail the whole request.
    if !bind_refs.is_empty() {
        let zero = Value::from(0);
        let active = Value::String("active".to_string());
        let balance_ph = bind_refs.len() + 1;
        let statement = format!(
            "UPDATE user_balances SET balance = CAST(${balance_ph} AS numeric), status = CAST(${} AS text) \
             WHERE user_address IN ({})",
            balance_ph + 1,
            sql::in_list(1, "text", bind_refs.len())
        );
        let mut ordered: Vec<(&str, &Value)> = bind_refs.clone();
        ordered.push(("numeric", &zero));
        ordered.push(("text", &active));
        if let Err(err) = sql::execute(&statement, &ordered).await {
            tracing::error!("[unban-wallet] balance zero failed (non-blocking): {err}");
        }
    }

    // 4. One `admin_balance_wipe` audit row per currency whose balance was
    // actually positive; insert failures are `console.warn` only.
    let wipe_entries = wipe_audit_rows(&current_balances, &key);
    if !wipe_entries.is_empty() {
        let mut binds: Vec<(&str, &Value)> = Vec::with_capacity(wipe_entries.len() * 5);
        let mut tuples: Vec<String> = Vec::with_capacity(wipe_entries.len());
        for entry in &wipe_entries {
            let n = binds.len() + 1;
            tuples.push(format!(
                "(CAST(${n} AS text), CAST(${} AS text), CAST(${} AS text), CAST(${} AS numeric), CAST(${} AS text))",
                n + 1,
                n + 2,
                n + 3,
                n + 4
            ));
            binds.push(("text", row_field(entry, "user_address")));
            binds.push(("text", row_field(entry, "currency")));
            binds.push(("text", row_field(entry, "operation_type")));
            binds.push(("numeric", row_field(entry, "amount")));
            binds.push(("text", row_field(entry, "transaction_hash")));
        }
        let statement = format!(
            "INSERT INTO balance_audit_log (user_address, currency, operation_type, amount, transaction_hash) VALUES {}",
            tuples.join(", ")
        );
        if let Err(err) = sql::execute(&statement, &binds).await {
            tracing::warn!("[unban-wallet] audit log insert failed: {err}");
        }
    }

    Ok(axum::Json(json!({ "success": true })).into_response())
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/status
// ---------------------------------------------------------------------------

const USER_STATUSES: [&str; 3] = ["active", "frozen", "banned"];

async fn user_status(headers: HeaderMap, raw: Bytes) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    match user_status_run(&raw).await {
        Ok(response) => response,
        Err(err) => catch_500(&err, "Internal error"),
    }
}

async fn user_status_run(raw: &Bytes) -> ApiResult<Response> {
    let body: Value = serde_json::from_slice(raw)?;

    // `if (!userAddress || !status)` — JS truthiness on the raw fields, so
    // `""` and `0` are "missing", not "invalid".
    if !is_truthy(body.get("userAddress")) || !is_truthy(body.get("status")) {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            "Missing userAddress or status",
        ));
    }
    // `!['active','frozen','banned'].includes(status)` — a non-string never
    // equals a member, so it 400s as "Invalid status".
    let Some(status) = body.get("status").and_then(Value::as_str) else {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid status"));
    };
    if !USER_STATUSES.contains(&status) {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid status"));
    }
    // `walletAddressSearchVariants(userAddress)` calls `raw.trim()`, which
    // throws a TypeError for a non-string; the route's catch turns that into
    // a 500, which is what this crash-shape mapping preserves.
    let Some(address) = body.get("userAddress").and_then(Value::as_str) else {
        return Err(ApiError::Other("userAddress.trim is not a function".to_string()));
    };

    let variants = search_variants(address);
    let owned: Vec<Value> = variants.iter().map(|v| Value::String(v.clone())).collect();
    let bind_refs = text_binds(&owned);
    let status_bind = Value::String(status.to_string());
    let statement = format!(
        "UPDATE user_balances SET status = CAST($1 AS text) WHERE user_address IN ({})",
        sql::in_list(2, "text", bind_refs.len())
    );
    let mut all: Vec<(&str, &Value)> = vec![("text", &status_bind)];
    all.extend(bind_refs);
    // An empty variant list renders `IN (NULL)` — zero rows, still a success,
    // exactly like the TS `.in(col, [])` against PostgREST.
    sql::execute(&statement, &all)
        .await
        .map_err(|err| ApiError::Other(err.to_string()))?;

    Ok(axum::Json(json!({ "success": true, "status": status })).into_response())
}

// ---------------------------------------------------------------------------
// POST /api/admin/withdrawal-requests/{id}/accept
// ---------------------------------------------------------------------------

async fn accept_withdrawal(headers: HeaderMap, Path(id): Path<String>) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    // The digits-only id guard: `Number('1.5')` is finite in the TS and then
    // dies in the query; the core parser 400s the same inputs before any SQL.
    let Some(id) = parse_request_id(Some(&id)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid request id");
    };
    match accept_run(id).await {
        Ok(response) => response,
        // The outer catch: `err.message || 'Failed to accept withdrawal
        // request'`, always 500 — including anything the chain layer threw.
        Err(err) => catch_500(&err, "Failed to accept withdrawal request"),
    }
}

async fn accept_run(id: i64) -> ApiResult<Response> {
    let id_bind = Value::from(id);
    let req = sql::fetch_one(
        &format!(
            "SELECT {ACCEPT_REQUEST_COLUMNS} FROM withdrawal_requests \
             WHERE id = CAST($1 AS int8) LIMIT 1"
        ),
        &[("int8", &id_bind)],
    )
    .await?
    .ok_or_else(|| ApiError::json(StatusCode::NOT_FOUND, "Request not found"))?;

    if row_field(&req, "status").as_str() != Some("pending") {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            format!("Cannot accept request in status: {}", value_to_string(row_field(&req, "status"))),
        ));
    }

    // `String(req.user_address).trim()` etc. — the TS stringifies before every
    // use, so a null column becomes the literal "null" rather than a crash.
    let user_address = value_to_string(row_field(&req, "user_address")).trim().to_string();
    let currency = value_to_string(row_field(&req, "currency"));
    let amount = number_coerce(row_field(&req, "amount")).unwrap_or(f64::NAN);
    let normalized_currency = currency.to_uppercase();

    // The global ban list blocks approval even when user_balances.status is
    // still "active" (only banned_wallets was updated).
    if is_globally_banned(&user_address).await {
        return Ok(error(
            StatusCode::FORBIDDEN,
            "This wallet is on the global ban list. Reject the withdrawal; treasury payout is not allowed.",
        ));
    }

    // Re-verify the signed intent. Every settled asset lives on Arc, an EVM
    // chain, so the signature is always required.
    if !is_truthy(req.get("signature")) || !is_truthy(req.get("signed_at")) {
        return Ok(error(
            StatusCode::UNAUTHORIZED,
            "Missing signed withdrawal authorization",
        ));
    }
    let signed_at = number_coerce(row_field(&req, "signed_at")).unwrap_or(f64::NAN);
    let signature = value_to_string(row_field(&req, "signature"));
    if !verify_withdrawal_intent(&user_address, amount, &normalized_currency, signed_at, &signature)
    {
        return Ok(error(StatusCode::UNAUTHORIZED, "Invalid withdrawal signature"));
    }

    // Balance rows. The TS folds the query error and the empty result into the
    // same 404 (`if (userError || !balRows?.length)`).
    let variants = search_variants(&user_address);
    let mut owned: Vec<Value> = variants.iter().map(|v| Value::String(v.clone())).collect();
    owned.push(Value::String(currency.clone()));
    let bind_refs = text_binds(&owned);
    let currency_ph = bind_refs.len();
    let statement = format!(
        "SELECT balance, status, user_address FROM user_balances \
         WHERE user_address IN ({}) AND currency = CAST(${currency_ph} AS text)",
        sql::in_list(1, "text", bind_refs.len() - 1)
    );
    let bal_rows = match sql::fetch(&statement, &bind_refs).await {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => return Ok(error(StatusCode::NOT_FOUND, "User record not found")),
        Err(err) => {
            tracing::error!("[accept] balance read failed: {err}");
            return Ok(error(StatusCode::NOT_FOUND, "User record not found"));
        }
    };

    // Per-row status gate, in row order like the TS `for (const row of …)`.
    for row in &bal_rows {
        match row_field(row, "status").as_str() {
            Some("frozen") => {
                return Ok(error(
                    StatusCode::FORBIDDEN,
                    "Account is frozen. Withdrawals are disabled.",
                ))
            }
            Some("banned") => return Ok(error(StatusCode::FORBIDDEN, "Account is banned.")),
            _ => {}
        }
    }

    // `[...balRows].sort((a, b) => Number(b.balance) - Number(a.balance))`,
    // then the first row that can cover the request.
    let mut sorted = bal_rows.clone();
    sorted.sort_by(|a, b| {
        let ba = to_number(row_field(a, "balance"));
        let bb = to_number(row_field(b, "balance"));
        bb.partial_cmp(&ba).unwrap_or(std::cmp::Ordering::Equal)
    });
    let Some(user_row) = sorted
        .iter()
        .find(|row| to_number(row_field(row, "balance")) >= amount)
    else {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            "Insufficient house balance for acceptance",
        ));
    };
    // `p_user_address: dbAddress` uses the row's own stored spelling, so the
    // ledger keys on the exact row that was funded.
    let db_address = row_field(user_row, "user_address").clone();

    // Chain payouts: fee first (skipped when zero/unconfigured), then the net
    // to the player. A stored `fee_amount` of 0 (Number(null) === 0 is finite!)
    // overrides the computed fee, exactly like the TS `Number.isFinite` gate.
    let fee_from_request = number_coerce(row_field(&req, "fee_amount")).filter(|f| f.is_finite());
    let (fee_amount, net_amount) = plan_payout(&currency, amount, fee_from_request)
        .map_err(ApiError::Other)?;
    let (combined, fee_tx_hash) = execute_treasury_withdrawal(&user_address, fee_amount, net_amount)
        .await?;

    // Deduct the house balance + write the withdrawal audit, in one function.
    let amount_bind = Value::String(js_number_string(amount));
    let hash_bind = Value::String(combined.clone());
    let upd = match db::call_rpc(
        "update_balance_for_withdrawal",
        &[
            ("p_user_address", &db_address),
            ("p_withdrawal_amount", &amount_bind),
            ("p_currency", &Value::String(currency.clone())),
            ("p_transaction_hash", &hash_bind),
        ],
    )
    .await
    {
        Ok(value) => value,
        Err(err) => {
            // The TS treats this one statement's failure specially: `{ error:
            // updError.message || 'Balance update failed' }`, 500, instead of
            // the route's generic catch fallback.
            let text = err.to_string();
            let safe = sanitize_error_text(&text, "");
            return Ok(if safe.is_empty() {
                error(StatusCode::INTERNAL_SERVER_ERROR, "Balance update failed")
            } else {
                error(StatusCode::INTERNAL_SERVER_ERROR, safe)
            });
        }
    };
    // `updData?.new_balance` only reads an object row; a scalar/array result
    // behaves like `undefined` in the TS and the key simply disappears.
    let upd_map = match upd {
        Value::Object(map) => Some(map),
        _ => None,
    };

    // Mark the request accepted. `decided_at: new Date().toISOString()`.
    let accepted = Value::String("accepted".to_string());
    let decided_at = Value::String(iso_ms(now_ms()));
    let decided_by = Value::String("admin".to_string());
    let tx_hash = Value::String(combined.clone());
    let fee_tx = fee_tx_hash.clone().map(Value::String).unwrap_or(Value::Null);
    let id_bind = Value::from(id);
    sql::execute(
        "UPDATE withdrawal_requests SET status = CAST($1 AS text), \
             decided_at = CAST($2 AS timestamp with time zone), decided_by = CAST($3 AS text), \
             tx_hash = CAST($4 AS text), fee_tx_hash = CAST($5 AS text) \
         WHERE id = CAST($6 AS int8)",
        &[
            ("text", &accepted),
            ("timestamp with time zone", &decided_at),
            ("text", &decided_by),
            ("text", &tx_hash),
            ("text", &fee_tx),
            ("int8", &id_bind),
        ],
    )
    .await?;

    // `{ success: true, newBalance: updData?.new_balance }` — an undefined
    // `newBalance` key is dropped by JSON.stringify, so only include it when
    // the function actually returned an object carrying it.
    let mut body = Map::new();
    body.insert("success".to_string(), Value::Bool(true));
    if let Some(new_balance) = upd_map.as_ref().and_then(|map| map.get("new_balance")) {
        body.insert("newBalance".to_string(), new_balance.clone());
    }
    Ok(axum::Json(Value::Object(body)).into_response())
}

/// `executeTreasuryWithdrawal`'s chain half, in the TS order: the fee transfer
/// first (`collectPlatformFeeFromTreasury`: `!feeAmount || feeAmount <= 0`
/// skips — NaN included — and an unconfigured fee wallet warns and skips),
/// then the net payout. Every failure surfaces as a throw for the outer 500
/// catch, so statuses here deliberately collapse to the message.
async fn execute_treasury_withdrawal(
    to: &str,
    fee_amount: f64,
    net_amount: f64,
) -> ApiResult<(String, Option<String>)> {
    let mut fee_tx_hash: Option<String> = None;
    let mut treasury: Option<Treasury> = None;

    if fee_amount > 0.0 {
        // The fee collector exists only for USDC (already gated by
        // `plan_payout`) and only when configured.
        if let Some(fee_wallet) = config()
            .platform_fee_wallet
            .as_deref()
            .filter(|w| !w.trim().is_empty())
        {
            let t = Treasury::from_config()?;
            let fee_base = parse_units(&js_number_string(fee_amount), USDC_DECIMALS)?;
            fee_tx_hash = Some(t.withdraw_token_to(fee_wallet, fee_base).await?);
            treasury = Some(t);
        } else {
            tracing::warn!(
                "[platformFee] Fee wallet not configured for USDC. Skipping fee collection."
            );
        }
    }

    let t = match treasury {
        Some(t) => t,
        None => Treasury::from_config()?,
    };
    let net_base = parse_units(&js_number_string(net_amount), USDC_DECIMALS)?;
    let withdraw_tx_hash = t.withdraw_token_to(to, net_base).await?;
    Ok((combined_tx_hash(fee_tx_hash.as_deref(), &withdraw_tx_hash), fee_tx_hash))
}

// ---------------------------------------------------------------------------
// POST /api/admin/withdrawal-requests/{id}/reject
// ---------------------------------------------------------------------------

async fn reject_withdrawal(headers: HeaderMap, Path(id): Path<String>) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    let Some(id) = parse_request_id(Some(&id)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid request id");
    };
    match reject_run(id).await {
        Ok(response) => response,
        Err(err) => catch_500(&err, "Failed to reject withdrawal request"),
    }
}

async fn reject_run(id: i64) -> ApiResult<Response> {
    let id_bind = Value::from(id);
    let req = sql::fetch_one(
        &format!(
            "SELECT {REJECT_REQUEST_COLUMNS} FROM withdrawal_requests \
             WHERE id = CAST($1 AS int8) LIMIT 1"
        ),
        &[("int8", &id_bind)],
    )
    .await?
    .ok_or_else(|| ApiError::json(StatusCode::NOT_FOUND, "Request not found"))?;

    if row_field(&req, "status").as_str() != Some("pending") {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            format!("Cannot reject request in status: {}", value_to_string(row_field(&req, "status"))),
        ));
    }

    let rejected = Value::String("rejected".to_string());
    let decided_at = Value::String(iso_ms(now_ms()));
    let decided_by = Value::String("admin".to_string());
    let id_bind = Value::from(id);
    sql::execute(
        "UPDATE withdrawal_requests SET status = CAST($1 AS text), \
             decided_at = CAST($2 AS timestamp with time zone), decided_by = CAST($3 AS text) \
         WHERE id = CAST($4 AS int8)",
        &[
            ("text", &rejected),
            ("timestamp with time zone", &decided_at),
            ("text", &decided_by),
            ("int8", &id_bind),
        ],
    )
    .await?;

    Ok(axum::Json(json!({ "success": true })).into_response())
}
