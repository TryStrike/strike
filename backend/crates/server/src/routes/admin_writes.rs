//! Admin mutation routes: bans, user status, and withdrawal accept/reject.
//! Validation and amount logic lives in `strike_core::admin_writes`. Every echoed
//! error passes through `sanitize_error_text`, so a driver internal becomes the
//! route's fallback string.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::Path;
use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Map, Value};

use strike_core::address::{canonical, search_variants};
use strike_core::admin_writes::{
    aggregate_withdrawal_stats, ban_reason, danger_zone_json, frequency_review_candidates,
    frequency_user_json, js_number_string, parse_request_id, plan_payout, reconciliation_note,
    sanitize_error_text, scans_json, sort_frequency_users, stale_intent_message,
    suspicious_user_json, verify_withdrawal_intent, wallet_address_too_long, win_streak_hits,
    wipe_audit_rows, within_accept_window, AUDIT_SCAN_CAP, BET_SCAN_CAP, PENDING_SCAN_CAP,
    SCAN_PAGE,
};
use strike_core::bets::{is_truthy, iso_ms, now_ms, number_coerce, to_number, value_to_string};
use strike_core::config::{config, USDC_DECIMALS};
use strike_core::db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::eth::{self, parse_units, PayError, Transfer, Treasury};
use strike_core::ledger::{exact_amount, floor_to_token};
use strike_core::withdrawals::{self, Claim};
use rust_decimal::Decimal;

use crate::bans::is_globally_banned;
use crate::http;
use crate::sql;

/// Columns the accept/reject routes select explicitly ("to avoid exposing
/// sensitive future columns"); the lists differ per route, as in the TS.
const ACCEPT_REQUEST_COLUMNS: &str = "id, user_address, currency, amount, net_amount, fee_amount, \
    requested_at, status, decided_by, tx_hash, signature, signed_at, created_at";
const REJECT_REQUEST_COLUMNS: &str = "id, user_address, currency, amount, net_amount, fee_amount, \
    requested_at, status, decided_by, tx_hash, created_at";

pub fn routes() -> Router {
    Router::new()
        .route("/api/admin/danger-zone", get(danger_zone))
        .route(
            "/api/admin/banned-wallets",
            post(ban_add).delete(ban_remove),
        )
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

/// Sanitized `{ error }` 500 for the banned-wallets routes.
fn admin_500(err_text: &str, fallback: &str) -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        sanitize_error_text(err_text, fallback),
    )
}

/// A missing row field reads as JSON null.
fn row_field<'a>(row: &'a Value, key: &str) -> &'a Value {
    row.get(key).unwrap_or(&Value::Null)
}

/// `("text", &Value)` bind refs over owned string values.
fn text_binds(values: &[Value]) -> Vec<(&str, &Value)> {
    values.iter().map(|v| ("text", v)).collect()
}

// ---------------------------------------------------------------------------
// POST /api/admin/banned-wallets
// ---------------------------------------------------------------------------

async fn ban_add(headers: HeaderMap, raw: Bytes) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    match serde_json::from_slice::<Value>(&raw) {
        Err(_) => error(StatusCode::BAD_REQUEST, "Invalid JSON body."),
        Ok(body) => match ban_add_run(body).await {
            Ok(response) => response,
            Err(text) => admin_500(&text, "Failed to add ban"),
        },
    }
}

async fn ban_add_run(body: Value) -> Result<Response, String> {
    // `typeof body.walletAddress === 'string' ? trim : ''` — a non-string is
    // silently the empty string, which then 400s as "required".
    let wallet_address = http::body_str(&body, "walletAddress")
        .unwrap_or_default()
        .to_string();
    if wallet_address.is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "walletAddress is required"));
    }
    if wallet_address_too_long(&wallet_address) {
        return Ok(error(StatusCode::BAD_REQUEST, "walletAddress is too long"));
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

    // The upsert always returns its row, so this only fires on a trigger that
    // swallowed it.
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
    if wallet_address_too_long(&wallet_address) {
        return error(StatusCode::BAD_REQUEST, "walletAddress is too long");
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
        Err(err) => admin_500(&err.to_string(), "Failed to remove ban"),
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
    let Ok(body) = serde_json::from_slice::<Value>(raw) else {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid JSON body."));
    };

    // A number does NOT pass here, and neither does a blank string.
    let trimmed = body
        .get("walletAddress")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if trimmed.is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "walletAddress is required"));
    }
    if wallet_address_too_long(trimmed) {
        return Ok(error(StatusCode::BAD_REQUEST, "walletAddress is too long"));
    }

    let key = canonical(trimmed);
    let variants = search_variants(trimmed);
    if variants.is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid wallet address"));
    }

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
    let Ok(body) = serde_json::from_slice::<Value>(raw) else {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid JSON body."));
    };

    let address = body
        .get("userAddress")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if address.trim().is_empty() {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            "Missing userAddress or status",
        ));
    }
    if wallet_address_too_long(address.trim()) {
        return Ok(error(StatusCode::BAD_REQUEST, "userAddress is too long"));
    }
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status.is_empty() {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            "Missing userAddress or status",
        ));
    }
    if !USER_STATUSES.contains(&status) {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid status"));
    }

    let variants = search_variants(address);
    if variants.is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid wallet address"));
    }
    let owned: Vec<Value> = variants.iter().map(|v| Value::String(v.clone())).collect();
    let bind_refs = text_binds(&owned);
    let status_bind = Value::String(status.to_string());
    let statement = format!(
        "UPDATE user_balances SET status = CAST($1 AS text) WHERE user_address IN ({})",
        sql::in_list(2, "text", bind_refs.len())
    );
    let mut all: Vec<(&str, &Value)> = vec![("text", &status_bind)];
    all.extend(bind_refs);
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
    // Its own task: a client hanging up, or a proxy timing out, must not stop a
    // payout before its hash is recorded. The hold makes shutdown wait for it.
    let hold = eth::hold_payout();
    let run = tokio::spawn(async move {
        let _hold = hold;
        accept_run(id).await
    });
    match run.await {
        Ok(Ok(response)) => response,
        // The outer catch: `err.message || 'Failed to accept withdrawal
        // request'`, always 500 — including anything the chain layer threw.
        Ok(Err(err)) => catch_500(&err, "Failed to accept withdrawal request"),
        Err(panic) => {
            tracing::error!("[withdrawal/accept] id={id} task failed: {panic}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to accept withdrawal request",
            )
        }
    }
}

async fn accept_run(id: i64) -> ApiResult<Response> {
    let id_bind = Value::from(id);
    // The TS answers a missing request with a returned 404 (not a throw), so
    // the outer catch's 500 never sees it.
    let Some(req) = sql::fetch_one(
        &format!(
            "SELECT {ACCEPT_REQUEST_COLUMNS} FROM withdrawal_requests \
             WHERE id = CAST($1 AS int8) LIMIT 1"
        ),
        &[("int8", &id_bind)],
    )
    .await?
    else {
        return Ok(error(StatusCode::NOT_FOUND, "Request not found"));
    };

    if row_field(&req, "status").as_str() != Some("pending") {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            format!(
                "Cannot accept request in status: {}",
                value_to_string(row_field(&req, "status"))
            ),
        ));
    }

    // `String(req.user_address).trim()` etc. — the TS stringifies before every
    // use, so a null column becomes the literal "null" rather than a crash.
    let user_address = value_to_string(row_field(&req, "user_address"))
        .trim()
        .to_string();
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
    // A signature in the queue is a standing instruction to move money, so an
    // old captured intent must stop being payable.
    if !signed_at.is_finite() || !within_accept_window(now_ms(), signed_at as i64) {
        return Ok(error(StatusCode::BAD_REQUEST, stale_intent_message()));
    }
    let signature = value_to_string(row_field(&req, "signature"));
    if !verify_withdrawal_intent(
        &user_address,
        amount,
        &normalized_currency,
        signed_at,
        &signature,
    ) {
        return Ok(error(
            StatusCode::UNAUTHORIZED,
            "Invalid withdrawal signature",
        ));
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

    // Everything that can refuse without money moving runs first: past the debit
    // a failure can only be parked. A stored `fee_amount` of 0 (Number(null) === 0
    // is finite!) overrides the computed fee, like the TS `Number.isFinite` gate.
    let fee_from_request = number_coerce(row_field(&req, "fee_amount")).and_then(exact_amount);
    let Some(gross) = exact_amount(amount) else {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid withdrawal amount"));
    };
    let (_, net_amount) = match plan_payout(&currency, gross, fee_from_request) {
        Ok(plan) => plan,
        Err(message) => return Ok(error(StatusCode::BAD_REQUEST, message)),
    };
    let treasury = match Treasury::from_config() {
        Ok(treasury) => treasury,
        Err(err) => {
            tracing::error!("[withdrawal/accept] treasury unavailable: {err}");
            return Ok(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Treasury is not configured.",
            ));
        }
    };
    let net_base = match base_units(net_amount) {
        Ok(net) => net,
        Err(err) => return Ok(error(StatusCode::BAD_REQUEST, err.to_string())),
    };
    // The fee stays in the treasury: only the net amount leaves, tagged with the request id.
    let transfers = vec![Transfer {
        to: user_address.clone(),
        amount: net_base,
        reference: eth::reference(id as u64),
    }];

    // One turn of the treasury queue: reads, then claim and debit in one commit,
    // then the broadcasts. Exactly one concurrent accept gets `Debited`, and only
    // with the balance to cover it.
    let database = db::db().await?;
    let currency_for_claim = currency.clone();
    let claim = move || async move {
        match withdrawals::claim_and_debit(
            database,
            id,
            db_address,
            js_number_string(amount),
            currency_for_claim,
        )
        .await
        {
            Ok(Claim::Debited { new_balance }) => Ok(new_balance),
            Ok(Claim::NotPending) => Err(error(
                StatusCode::CONFLICT,
                "Request is no longer pending — it was already claimed by another accept call.",
            )),
            Ok(Claim::Refused(reason)) if reason == "Insufficient balance" => Err(error(
                StatusCode::BAD_REQUEST,
                "Insufficient house balance for acceptance",
            )),
            Ok(Claim::Refused(reason)) => Err(error(StatusCode::FORBIDDEN, reason)),
            Err(err) => {
                tracing::error!("[withdrawal/accept] claim failed: {err}");
                Err(error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to claim withdrawal request",
                ))
            }
        }
    };

    // Past the debit the only exits are "recorded as paid" and "parked": a failure
    // never re-credits and is never retried, because the transfer's outcome may
    // be unknown.
    let (new_balance, sent) = match treasury.pay(transfers, claim).await {
        Ok(paid) => paid,
        Err(PayError::Preflight(err)) => {
            tracing::error!("[withdrawal/accept] id={id} treasury read failed: {err}");
            return Ok(error(
                StatusCode::BAD_GATEWAY,
                "Treasury check failed — nothing was debited, the request is still pending.",
            ));
        }
        Err(PayError::Refused(response)) => return Ok(response),
        Err(PayError::Send { sent, error: err }) => {
            let hashes: Vec<&str> = sent.iter().map(|s| s.hash.as_str()).collect();
            mark_needs_reconciliation(id, &format!("chain_payout_error:sent={hashes:?}: {err}"))
                .await;
            return Ok(payout_parked());
        }
    };

    let hashes: Vec<&str> = sent.iter().map(|s| s.hash.as_str()).collect();
    let mut failure = None;
    for transfer in &sent {
        // Every one, so each releases its share of the treasury balance.
        if let Err(err) = treasury.confirm(transfer).await {
            failure.get_or_insert(err);
        }
    }
    if let Some(err) = failure {
        mark_needs_reconciliation(id, &format!("chain_payout_error:sent={hashes:?}: {err}")).await;
        return Ok(payout_parked());
    }
    let combined = hashes[0].to_string();

    let finalize_failure = match withdrawals::finalize(db::db().await?, id, combined, None).await {
        Ok(true) => None,
        Ok(false) => Some("row no longer accepted".to_string()),
        Err(err) => Some(err.to_string()),
    };
    if let Some(reason) = finalize_failure {
        mark_needs_reconciliation(id, &format!("tx_hash_writeback_failed:{reason}")).await;
        return Ok(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Payout succeeded but the request could not be finalized — check the ledger.",
        ));
    }

    let mut body = Map::new();
    body.insert("success".to_string(), Value::Bool(true));
    body.insert("newBalance".to_string(), new_balance);
    Ok(axum::Json(Value::Object(body)).into_response())
}

/// `markNeedsReconciliation`: once a row is claimed, a failure is no longer a
/// plain 500. Funds may have left the treasury, so park it where no second
/// admin can pay it again, and shout in the logs.
async fn mark_needs_reconciliation(id: i64, reason: &str) {
    let note = reconciliation_note(reason);
    tracing::error!("[withdrawal/accept] id={id} {note}");
    let parked = match db::db().await {
        Ok(database) => withdrawals::park(database, id, note).await,
        Err(err) => Err(err),
    };
    // Left `accepted` with no tx hash, which is equally unpayable.
    if !matches!(parked, Ok(true)) {
        tracing::error!("[withdrawal/accept] id={id} could not be parked: {parked:?}");
    }
}

fn base_units(amount: Decimal) -> ApiResult<u128> {
    parse_units(&floor_to_token(amount).to_string(), USDC_DECIMALS)
}

fn payout_parked() -> Response {
    error(
        StatusCode::BAD_GATEWAY,
        "Treasury payout failed — request parked for reconciliation.",
    )
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
    let Some(req) = sql::fetch_one(
        &format!(
            "SELECT {REJECT_REQUEST_COLUMNS} FROM withdrawal_requests \
             WHERE id = CAST($1 AS int8) LIMIT 1"
        ),
        &[("int8", &id_bind)],
    )
    .await?
    else {
        return Ok(error(StatusCode::NOT_FOUND, "Request not found"));
    };

    if row_field(&req, "status").as_str() != Some("pending") {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            format!(
                "Cannot reject request in status: {}",
                value_to_string(row_field(&req, "status"))
            ),
        ));
    }

    // Conditional: a reject racing a concurrent accept must never overwrite
    // the paid state and destroy the payout audit trail.
    let decided_at = Value::String(iso_ms(now_ms()));
    let updated = sql::fetch(
        "UPDATE withdrawal_requests SET status = 'rejected', \
             decided_at = CAST($1 AS timestamp with time zone), decided_by = 'admin' \
         WHERE id = CAST($2 AS int8) AND status = 'pending' RETURNING id",
        &[
            ("timestamp with time zone", &decided_at),
            ("int8", &id_bind),
        ],
    )
    .await?;
    if updated.is_empty() {
        return Ok(error(
            StatusCode::CONFLICT,
            "Request is no longer pending — it was accepted or rejected by another action.",
        ));
    }

    Ok(axum::Json(json!({ "success": true })).into_response())
}

// ---------------------------------------------------------------------------
// GET /api/admin/danger-zone — bounded scans + the core detection engine
// ---------------------------------------------------------------------------

/// `scanPages()`: page a bounded read 1000 rows at a time and report whether
/// the hard cap was reached, so the dashboard can warn about under-reporting
/// instead of silently truncating.
async fn scan_pages(
    columns: &str,
    table: &str,
    where_sql: &str,
    fixed_binds: &[(&str, &Value)],
    order_col: &str,
    cap: i64,
) -> ApiResult<(Vec<Value>, bool)> {
    let mut rows: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut from = 0i64;
    loop {
        let page_bind = Value::from(SCAN_PAGE);
        let offset_bind = Value::from(from);
        let mut binds: Vec<(&str, &Value)> = fixed_binds.to_vec();
        binds.push(("int8", &page_bind));
        binds.push(("int8", &offset_bind));
        let statement = format!(
            "SELECT {columns} FROM {table} {where_sql} \
             ORDER BY {order_col} DESC LIMIT CAST(${} AS int8) OFFSET CAST(${} AS int8)",
            fixed_binds.len() + 1,
            fixed_binds.len() + 2
        );
        let chunk = sql::fetch(&statement, &binds).await?;
        let read = chunk.len() as i64;
        rows.extend(chunk);
        if read < SCAN_PAGE {
            break;
        }
        from += SCAN_PAGE;
        if from >= cap {
            truncated = rows.len() as i64 >= cap;
            break;
        }
    }
    Ok((rows, truncated))
}

fn number_or_zero(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

async fn danger_zone_run() -> ApiResult<Response> {
    // 1. Win-streak detection over the (non-demo) bet scan.
    let (bet_rows, bets_truncated) = scan_pages(
        "id, wallet_address, won, created_at",
        "bet_history",
        "",
        &[],
        "created_at",
        BET_SCAN_CAP,
    )
    .await?;
    let mut suspicious: Vec<Value> = Vec::new();
    for (address, max_streak, latest) in win_streak_hits(&bet_rows) {
        let key = Value::String(address);
        // The TS looks up the *stored* spelling verbatim; a failed lookup logs
        // and continues, an empty result contributes nothing.
        match sql::fetch(
            "SELECT id, user_address, currency, balance, status, user_tier, updated_at, created_at \
             FROM user_balances WHERE user_address = CAST($1 AS text)",
            &[("text", &key)],
        )
        .await
        {
            Ok(rows) => {
                if let Some(row) = rows.first() {
                    suspicious.push(suspicious_user_json(row, max_streak, latest));
                }
            }
            Err(err) => tracing::error!("[admin/danger-zone] user_balances lookup failed: {err}"),
        }
    }

    // 2. High-frequency withdrawal detection over the audit + pending scans.
    let withdrawal = Value::String("withdrawal".to_string());
    let (audit_rows, audit_truncated) = scan_pages(
        "user_address, currency, amount, created_at",
        "balance_audit_log",
        "WHERE operation_type = CAST($1 AS text)",
        &[("text", &withdrawal)],
        "created_at",
        AUDIT_SCAN_CAP,
    )
    .await?;
    let pending = Value::String("pending".to_string());
    let (pending_rows, pending_truncated) = scan_pages(
        "user_address, currency, amount, decided_by, requested_at, id, signed_at",
        "withdrawal_requests",
        "WHERE status = CAST($1 AS text)",
        &[("text", &pending)],
        "requested_at",
        PENDING_SCAN_CAP,
    )
    .await?;

    let candidates = frequency_review_candidates(
        aggregate_withdrawal_stats(&audit_rows, &pending_rows),
        &config().withdrawal_frequency_exempt,
    );
    let mut users: Vec<Value> = Vec::new();
    for stats in &candidates {
        let variants: Vec<Value> = search_variants(&stats.user_address)
            .into_iter()
            .map(Value::String)
            .collect();
        let variant_refs: Vec<(&str, &Value)> = variants.iter().map(|v| ("text", v)).collect();
        // The TS ignores failures on both enrichment reads (data becomes null
        // and `?? []` turns that into an empty list).
        let deposit_op = Value::String("deposit".to_string());
        let mut deposit_binds: Vec<(&str, &Value)> = vec![("text", &deposit_op)];
        deposit_binds.extend(variant_refs.iter().copied());
        let deposits = sql::fetch(
            &format!(
                "SELECT amount, currency FROM balance_audit_log \
                 WHERE operation_type = CAST($1 AS text) AND user_address IN ({})",
                sql::in_list(2, "text", variant_refs.len())
            ),
            &deposit_binds,
        )
        .await
        .unwrap_or_default();
        let balances = sql::fetch(
            &format!(
                "SELECT currency, balance FROM user_balances WHERE user_address IN ({})",
                sql::in_list(1, "text", variant_refs.len())
            ),
            &variant_refs,
        )
        .await
        .unwrap_or_default();
        let total_deposited = deposits
            .iter()
            .map(|r| number_or_zero(r.get("amount")))
            .sum();
        let total_available = balances
            .iter()
            .map(|r| number_or_zero(r.get("balance")))
            .sum();
        users.push(frequency_user_json(stats, total_deposited, total_available));
    }

    let scans = scans_json(bets_truncated, audit_truncated, pending_truncated);
    Ok(axum::Json(danger_zone_json(
        suspicious,
        sort_frequency_users(users),
        scans,
    ))
    .into_response())
}

async fn danger_zone(headers: HeaderMap) -> Response {
    if let Err(deny) = http::require_admin(&headers) {
        return deny.into_response();
    }
    match danger_zone_run().await {
        Ok(response) => response,
        Err(err) => {
            tracing::error!("[admin/danger-zone] {err}");
            catch_500(&err, "Failed to load danger zone")
        }
    }
}
