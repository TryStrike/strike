//! `/api/balance/{bet,deposit,win,withdraw}` — the house-ledger mutations.
//!
//! Ports `app/api/balance/{bet,deposit,win,withdraw}/route.ts`. This is the thin
//! HTTP transport `strike_core::ledger` was written for: guard the session, read
//! the body, and let the core module decide validation order, amount maths and
//! the exact JSON bodies. What lives here is the I/O —
//!   * SQL reads that reproduce the PostgREST `select/in/eq` calls the TS made,
//!   * `db::call_rpc` with the *same named parameters* the TS passed, and
//!   * the on-chain calls (`verify_deposit`, the treasury fee transfer, EIP-191
//!     recovery) that the TS reached through `ethers`.
//!
//! The four ledger functions this family drives:
//!   * `place_bet_locked` — bet: the bet_lock row plus `deduct_balance_for_bet`,
//!     inside one transaction,
//!   * `settle_bet_payout` — win: payout lock, bet claim, `credit_balance_for_payout`,
//!   * `update_balance_for_deposit` — deposit, once the tx hash is claimed,
//!   * withdraw writes `withdrawal_requests` only: the balance is debited later,
//!     by the admin accept route, through `update_balance_for_withdrawal`.
//!
//! Order is the specification. Every route runs its checks in the TS source
//! order, including the quirks that decide *which* 400 a caller gets, so a
//! request refused before now is refused before then.

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::Value;

use strike_core::address;
use strike_core::bets::{self, iso_ms, now_ms};
use strike_core::config::config;
use strike_core::crypto;
use strike_core::db::{self, rpc_object};
use strike_core::error::ApiError;
use strike_core::eth::{self, DepositFailure};
use strike_core::ledger;

use crate::bans::is_globally_banned;
use crate::http::require_balance_session;
use crate::routes::bets::{column_type, Binds};
use crate::sql;

/// The currency string the client literally sent, before normalisation:
/// `const { currency = 'USDC' } = body` — the destructuring default only
/// applies when the member is absent. The insufficient-balance 400
/// interpolates this raw spelling, not the uppercased one.
fn raw_currency(body: &Value) -> String {
    match body.get("currency") {
        None | Some(Value::Null) => "USDC".to_string(),
        Some(Value::String(s)) => s.clone(),
        // Unreachable: withdraw_head already crashes the request on a
        // non-string, non-null currency, exactly like `currency.toUpperCase()`.
        Some(_) => "USDC".to_string(),
    }
}

/// `DEFAULT_TTL_SECONDS` in `lib/balance/settlementToken.ts`. The bet route calls
/// `createSettlementToken(payload)` without a TTL, so the payout window is five
/// minutes (floored at 60s inside `crypto`).
const SETTLEMENT_TTL_SECONDS: i64 = 5 * 60;

/// `process.env.NODE_ENV === 'test'`. The TS routes use it to skip the
/// settlement-token and signed-intent requirements for their test suites; a
/// served process is never in that mode, so the bypass is permanently off here.
const ALLOW_TEST_BYPASS: bool = false;

pub fn routes() -> Router {
    Router::new()
        .route("/api/balance/bet", post(bet))
        .route("/api/balance/deposit", post(deposit))
        .route("/api/balance/win", post(win))
        .route("/api/balance/withdraw", post(withdraw))
}

// ---------------------------------------------------------------------------
// Transport plumbing
// ---------------------------------------------------------------------------

/// `NextResponse.json(body, { status })` for a `ledger::Rejection`.
fn reject(rejection: ledger::Rejection) -> Response {
    let (status, body) = rejection;
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, axum::Json(body)).into_response()
}

/// The two steps every route runs first, in the TS order: the balance-session
/// guard, then `await request.json()`. Both failures land in the route's `try`,
/// so a malformed body — and a `null` one, which the TS throws on the moment it
/// destructures it — answers the generic 500 rather than a parse error.
fn parse_body(headers: &HeaderMap, raw: &Bytes) -> Result<Value, Response> {
    require_balance_session(headers).map_err(|err| err.into_response())?;
    let body: Value = serde_json::from_slice(raw).map_err(|err| {
        tracing::error!("[balance] malformed request body: {err}");
        reject(ledger::route_crash())
    })?;
    if body.is_null() {
        return Err(reject(ledger::route_crash()));
    }
    Ok(body)
}

/// `bet_success_body`'s `remainingBalance`: `toNumber(result.new_balance)`, which
/// is JS `null` for anything non-finite or absent.
fn new_balance_value(result: &Value) -> Value {
    bets::js_num(ledger::to_number_opt(result.get("new_balance")).unwrap_or(f64::NAN))
}

/// Adds `CAST($n AS text)` binds for one address-variant list and returns the
/// comma-joined placeholders. An empty list renders `NULL`, so `IN (NULL)`
/// matches nothing instead of failing to parse — the rule `sql::in_list` uses.
fn bind_variants(binds: &mut Binds, variants: &[String]) -> String {
    let items: Vec<String> = variants
        .iter()
        .map(|variant| binds.push_static("text", Value::String(variant.clone())))
        .collect();
    if items.is_empty() {
        return "NULL".to_string();
    }
    items.join(", ")
}

/// `SELECT balance, status, user_address FROM user_balances` over every legacy
/// spelling of one wallet in one currency: the
/// `.in('user_address', variants).eq('currency', c)` the bet and withdraw routes
/// both issued.
async fn balance_rows(variants: &[String], currency: &str) -> Vec<Value> {
    let mut binds = Binds::new();
    let in_list = bind_variants(&mut binds, variants);
    let currency_bind = binds.push_static("text", Value::String(currency.to_string()));
    let statement = format!(
        "SELECT balance, status, user_address FROM user_balances \
          WHERE user_address IN ({in_list}) AND currency = {currency_bind}"
    );
    sql::fetch(&statement, &binds.refs()).await.unwrap_or_default()
}

/// The `verifier.reason` spelling from `lib/balance/verifyArcDepositTx.ts`. The
/// Rust `DepositFailure` carries the message but not the machine-readable code,
/// and the deposit body echoes the code back so the caller can branch on it.
fn failure_reason(failure: &DepositFailure) -> &'static str {
    match failure {
        DepositFailure::RpcError => "rpc_error",
        DepositFailure::ConfigMissing => "config_missing",
        DepositFailure::TxNotFound => "tx_not_found",
        DepositFailure::InsufficientConfirmations => "insufficient_confirmations",
        DepositFailure::TxReverted => "tx_reverted",
        DepositFailure::AmountMismatch => "amount_mismatch",
        DepositFailure::SenderMismatch => "sender_mismatch",
    }
}

/// The confirmation count the TS verifier attached to the retryable response. It
/// only ever accompanies `insufficient_confirmations`, whose message is
/// `Deposit has {n}/{MIN} confirmations`, so the count is read back from it.
fn confirmations_from_message(message: &str) -> Option<u64> {
    let start = message.char_indices().find(|(_, c)| c.is_ascii_digit())?.0;
    let digits: String = message[start..].chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// `crypto.randomUUID().replace(/-/g,'').slice(0,12)` — the entropy the bet id is
/// built from.
fn uuid_hex12() -> String {
    let simple = uuid::Uuid::new_v4().simple().to_string();
    simple[..12].to_string()
}

/// `createSettlementToken`. The TS throws when the secret is missing and the
/// route's outer `catch` answers the generic 500; the bet route checks the
/// configuration first, so this arm is the belt-and-braces path.
fn mint_settlement(
    bet_id: &str,
    user_address: &str,
    currency: &str,
    max_payout: f64,
) -> Result<String, ledger::Rejection> {
    crypto::create_settlement_token(bet_id, user_address, currency, max_payout, SETTLEMENT_TTL_SECONDS)
        .map_err(|err| {
            tracing::error!("[bet] settlement signing failed: {err}");
            ledger::route_crash()
        })
}

/// `error.message` from a Postgres failure — what the TS matched the `strike_*`
/// exception names against.
fn database_error_message(err: &ApiError) -> String {
    match err {
        ApiError::Db(db_err) => db_err
            .as_database_error()
            .map(|db_err| db_err.message().to_string())
            .unwrap_or_else(|| db_err.to_string()),
        other => other.to_string(),
    }
}

/// `tierOf(user_balances.user_address = key)`: the `.single()` the TS wrapped in
/// a try/catch. A missing row (a new wallet), a failed lookup or an unlisted
/// spelling is the `free` tier.
///
/// NOTE: the TS selected the column `tier`, which `user_balances` does not have —
/// it is `user_tier` (001_complete_schema.sql), and every other route reads that
/// name. So the TS lookup always failed into its `free` default. The real column
/// is read here: identical fee today, because nothing has ever written a tier
/// other than `free`.
async fn tier_for(user_key: &str) -> ledger::Tier {
    let bind = Value::String(user_key.to_string());
    let row = sql::fetch_one(
        "SELECT user_tier FROM user_balances WHERE user_address = CAST($1 AS text) LIMIT 1",
        &[("text", &bind)],
    )
    .await;
    match row {
        Ok(Some(row)) => ledger::resolve_tier(row.get("user_tier")),
        Ok(None) => ledger::Tier::Free,
        Err(err) => {
            tracing::warn!("[balance] tier lookup failed, defaulting to free: {err}");
            ledger::Tier::Free
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/balance/bet  <-  app/api/balance/bet/route.ts
// ---------------------------------------------------------------------------

async fn bet(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match bet_run(&body).await {
        Ok(body) => Json(body).into_response(),
        Err(rejection) => reject(rejection),
    }
}

async fn bet_run(body: &Value) -> Result<Value, ledger::Rejection> {
    // `isBalanceSettlementSigningConfigured()`. Rust has the one `production`
    // flag, so "not production" is the development branch: a caller with NODE_ENV
    // unset gets the developer-facing hint where the TS gave the public one.
    if !config().is_settlement_signing_configured() {
        tracing::error!("[bet] BALANCE_SETTLEMENT_SECRET is not set — bets cannot be signed");
        return Err(ledger::bet_signing_unavailable(!config().production));
    }

    let head = ledger::bet_head(body)?;
    let user_address = head.user_address.as_str().unwrap_or_default();
    if is_globally_banned(user_address).await {
        return Err(ledger::banned_rejection());
    }
    let plan = ledger::bet_tail(head, body)?;

    // Match GET /api/balance/[address]: one wallet can hold legacy rows under a
    // different address spelling (e.g. EVM casing).
    let variants = address::search_variants(user_address);
    let mut binds = Binds::new();
    let in_list = bind_variants(&mut binds, &variants);
    let currency_bind = binds.push_static("text", Value::String(plan.currency.clone()));
    let statement = format!(
        "SELECT user_address, balance, status FROM user_balances \
          WHERE user_address IN ({in_list}) AND currency = {currency_bind}"
    );
    let rows = sql::fetch(&statement, &binds.refs()).await.map_err(|err| {
        tracing::error!("[bet] balance lookup failed: {err}");
        (503, ledger::error_body("Service unavailable"))
    })?;

    let ledger_user_key = match ledger::bet_choose_row(&rows, plan.amount, &plan.currency) {
        ledger::BetRows::Ledger(key) => key,
        ledger::BetRows::Reject(rejection) => return Err(rejection),
    };

    // ── Idempotency: prefer the client betRequestId, fall back to a derived one ──
    // Client keys are `crypto.randomUUID()` strings; anything else is refused
    // rather than persisted into a unique index.
    let client_request_id = ledger::sanitize_bet_request_id(body.get("betRequestId"));
    if bets::is_truthy(body.get("betRequestId")) && client_request_id.is_none() {
        tracing::warn!("[bet] rejected malformed betRequestId, deriving a server key");
    }
    let bet_request_id = client_request_id
        .unwrap_or_else(|| ledger::derived_bet_request_id(body.get("roundId"), &plan.user_key, now_ms()));

    let bet_id = ledger::build_bet_id(now_ms(), &uuid_hex12());
    let multiplier = body.get("multiplier").and_then(ledger::number_of).unwrap_or(0.0);
    // `Number((betAmount * multiplier).toFixed(8))`; a non-finite product is the
    // TS RangeError, which the outer catch answers as 500.
    let max_payout = ledger::bet_max_payout(plan.amount, multiplier).ok_or_else(ledger::route_crash)?;
    // Signed before the deduction so it can be persisted with the lock row and
    // replayed verbatim when the same request arrives twice.
    let settlement_token = mint_settlement(&bet_id, &ledger_user_key, &plan.currency, max_payout)?;
    // Click-time round end: epoch ms or an ISO string, `null` when neither.
    let end_time = ledger::bet_end_time(body.get("endTime"))?;
    let end_time_value = end_time.map(Value::String).unwrap_or(Value::Null);

    // ── Lock-first, single-transaction bet placement ─────────────────────────
    // place_bet_locked inserts the bet_lock row (unique on idempotency_key),
    // deducts through the FOR UPDATE RPC, then stamps the lock row with the
    // payout ceiling and settlement token. A duplicate request deducts nothing.
    let result = db::call_rpc(
        "place_bet_locked",
        &[
            ("p_user_address", &Value::String(ledger_user_key.clone())),
            ("p_bet_amount", &plan.bet_amount),
            ("p_currency", &Value::String(plan.currency.clone())),
            ("p_idempotency_key", &Value::String(bet_request_id.clone())),
            ("p_bet_id", &Value::String(bet_id.clone())),
            ("p_max_payout", &Value::from(max_payout)),
            ("p_end_time", &end_time_value),
            ("p_settlement_token", &Value::String(settlement_token.clone())),
        ],
    )
    .await
    .map_err(|err| {
        tracing::error!("[bet] place_bet_locked failed: {err}");
        (503, ledger::error_body("Service unavailable"))
    })?;

    match ledger::bet_rpc_decision(&result, &ledger_user_key, &plan.currency) {
        // Never deduct twice. Replay the original response when the first attempt
        // got far enough to sign one.
        ledger::BetRpcDecision::ReplayMint(mint) => {
            tracing::warn!("[bet] duplicate request replayed: {bet_request_id}");
            // Re-sign so a retried request still has a settlement window; the bet
            // row can only be claimed once, so this cannot double-pay.
            let token = mint_settlement(&mint.bet_id, &mint.user_address, &mint.currency, mint.max_payout)?;
            Ok(ledger::bet_success_body(
                new_balance_value(&result),
                &mint.bet_id,
                &token,
                true,
            ))
        }
        ledger::BetRpcDecision::ReplayStored { bet_id, token, .. } => {
            tracing::warn!("[bet] duplicate request replayed with the stored token: {bet_request_id}");
            Ok(ledger::bet_success_body(
                new_balance_value(&result),
                &bet_id,
                &token,
                true,
            ))
        }
        ledger::BetRpcDecision::Conflict { body: error } => {
            tracing::warn!("[bet] duplicate request without a settlement token: {bet_request_id}");
            Err((409, error))
        }
        // Fail closed on anything that is not an explicit, well-formed success: an
        // ambiguous lock/deduction outcome must never mint a payout token.
        ledger::BetRpcDecision::FailClosed { status, body: error } => {
            tracing::error!(
                "[bet] bet not placed (fail closed): {}",
                error.get("error").and_then(|v| v.as_str()).unwrap_or("malformed RPC result")
            );
            Err((status, error))
        }
        ledger::BetRpcDecision::Success { new_balance, bet_id, token } => Ok(ledger::bet_success_body(
            bets::js_num(new_balance),
            &bet_id,
            &token,
            false,
        )),
    }
}

// ---------------------------------------------------------------------------
// POST /api/balance/deposit  <-  app/api/balance/deposit/route.ts
// ---------------------------------------------------------------------------

async fn deposit(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match deposit_run(&body).await {
        Ok(body) => Json(body).into_response(),
        Err(rejection) => reject(rejection),
    }
}

async fn deposit_run(body: &Value) -> Result<Value, ledger::Rejection> {
    let head = ledger::deposit_head(body)?;
    let user_address = head.user_address.as_str().unwrap_or_default();

    if !address::is_address(user_address) {
        return Err((
            400,
            ledger::error_body("Invalid wallet address format (an Arc address is required)"),
        ));
    }
    if is_globally_banned(user_address).await {
        return Err(ledger::banned_rejection());
    }
    // `String(currency ?? '').toUpperCase()` plus the supported-asset gate.
    let currency = ledger::deposit_currency(body, head.amount)?;

    // Look up the user's tier from the DB instead of trusting the client.
    let deposit_user_key = address::canonical(user_address);
    let tier = tier_for(&deposit_user_key).await;

    let (fee_amount, net_deposit_amount) = ledger::deposit_net(head.amount, tier);
    if !(net_deposit_amount > 0.0) {
        return Err(ledger::deposit_net_rejection(ledger::fee_percent_label(tier)));
    }

    // Verify the transfer on-chain before crediting. The requirement is the
    // claimed amount in base units rounded UP, so the ledger can never credit
    // more than demonstrably reached the treasury.
    let tx_hash = ledger::js_to_string(head.tx_hash);
    let verification = match eth::verify_deposit(
        &tx_hash,
        user_address,
        &ledger::deposit_required_amount_string(head.amount),
        ledger::USDC_DECIMALS,
    )
    .await {
        Ok(verification) => verification,
        Err((failure, message)) => {
            let reason = failure_reason(&failure);
            if failure.retryable() {
                // A node that could not be reached must not be answered as an
                // invalid deposit: the caller has a real transaction and will
                // retry with the same hash.
                tracing::warn!("[deposit] on-chain verification pending, retryable: {reason}");
                let confirmations = if matches!(failure, DepositFailure::InsufficientConfirmations) {
                    confirmations_from_message(&message)
                } else {
                    None
                };
                return Err(ledger::deposit_pending_body(reason, confirmations));
            }
            // Terminal: no retry will make this hash creditable.
            tracing::warn!("[deposit] deposit rejected on-chain: {reason} {message}");
            return Err(ledger::deposit_terminal(reason, &message));
        }
    };

    // ── Idempotency inside the crediting path ────────────────────────────────
    // Claim the raw tx hash first. The primary key (and the unique index on
    // balance_audit_log.transaction_hash) is what stops a replay — a preceding
    // SELECT would still race. Anything other than a duplicate conflict fails
    // closed.
    let mut locks = Binds::new();
    let mut placeholders = Vec::new();
    for (name, value) in [
        ("transaction_hash", Value::String(tx_hash.clone())),
        ("user_address", Value::String(deposit_user_key.clone())),
        ("currency", Value::String(currency.clone())),
        ("amount", Value::from(net_deposit_amount)),
    ] {
        let ty = column_type("deposit_locks", name).await.map_err(|err| {
            tracing::error!("[deposit] deposit lock column unavailable: {err}");
            ledger::deposit_unavailable()
        })?;
        placeholders.push(locks.push(ty, value));
    }
    let statement = format!(
        "INSERT INTO deposit_locks (\"transaction_hash\", \"user_address\", \"currency\", \"amount\") \
         VALUES ({})",
        placeholders.join(", ")
    );
    if let Err(err) = sql::execute(&statement, &locks.refs()).await {
        if matches!(&err, ApiError::Db(db_err) if db::is_unique_violation(db_err)) {
            tracing::warn!("[deposit] duplicate credit blocked for txHash={tx_hash}");
            return Err(ledger::deposit_duplicate_body());
        }
        tracing::error!("[deposit] deposit lock insert failed (fail closed): {err}");
        return Err(ledger::deposit_unavailable());
    }

    // From here a tx hash is burned: every exit either credits it or releases it.
    // Tiered platform/protocol fee — move the fee portion from the treasury to
    // the dedicated collector wallet. A failure here must NOT block the user's
    // deposit, so it is logged and the deposit proceeds without a fee tx.
    let fee_tx = collect_platform_fee(&currency, fee_amount).await;
    let combined_tx_hash = ledger::combined_tx_hash(&Value::String(tx_hash.clone()), fee_tx.as_deref());

    // Credit only into the address the on-chain Transfer was attributed to.
    let user_key = address::canonical(if verification.payer_address.is_empty() {
        user_address
    } else {
        verification.payer_address.as_str()
    });

    // Call update_balance_for_deposit stored procedure.
    let rpc = db::call_rpc(
        "update_balance_for_deposit",
        &[
            ("p_user_address", &Value::String(user_key.clone())),
            ("p_deposit_amount", &Value::from(net_deposit_amount)),
            ("p_currency", &Value::String(currency.clone())),
            ("p_transaction_hash", &Value::String(combined_tx_hash.clone())),
        ],
    )
    .await;

    let result = match rpc {
        Err(err) => {
            tracing::error!("Database error in deposit: {err}");
            // The lock is released here, so retrying the same hash stays safe:
            // the credit either landed (the lock would still be held) or did not.
            release_deposit_lock(&tx_hash, "database error").await;
            return Err(ledger::deposit_unavailable());
        }
        // Parse the JSON result from the stored procedure.
        Ok(value) => rpc_object(value),
    };

    // Check if the procedure reported an error.
    if !db::rpc_success(&result) {
        let message = result
            .get("error")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or("Deposit failed")
            .to_string();
        // The RPC swallows exceptions; a unique violation on the audit hash means
        // the money is already on the ledger. Keep the lock and answer 409.
        if ledger::is_audit_duplicate(&message) {
            tracing::warn!("[deposit] audit hash already recorded for txHash={tx_hash}");
            return Err(ledger::deposit_duplicate_body());
        }
        release_deposit_lock(&tx_hash, &message).await;
        return Err((400, ledger::error_body(&message)));
    }

    // Log the platform fee so the admin dashboard can track per-wallet fee
    // totals. Non-blocking — a fee logging failure must never break the deposit.
    if fee_amount > 0.0 {
        if let Err(err) = log_platform_fee(&user_key, &currency, fee_amount, &combined_tx_hash).await {
            tracing::warn!("[deposit] fee log failed (non-blocking): {err}");
        }
    }

    // The receipt may only show server-side facts: what landed, what was taken as
    // fee, and when the ledger credited it. Never the client's own recomputation.
    Ok(ledger::deposit_success_body(
        ledger::parse_float_of(result.get("new_balance")),
        fee_amount,
        net_deposit_amount,
        &iso_ms(now_ms()),
    ))
}

/// `collectPlatformFeeFromTreasury`: the treasury -> collector-wallet transfer for
/// `fee_amount`. `None` is the TS `null` (no fee, no configured wallet, or a
/// transfer that threw) and never blocks the deposit.
async fn collect_platform_fee(currency: &str, fee_amount: f64) -> Option<String> {
    if !(fee_amount > 0.0) {
        return None;
    }
    // `getPlatformFeeWalletAddress`: only USDC has a collector wallet. Every
    // failure below is logged and swallowed: the fee is the platform's cut, and
    // losing it must never cost a player their deposit.
    let fee_wallet = if currency == "USDC" {
        config().platform_fee_wallet.clone()
    } else {
        None
    };
    let Some(fee_wallet) = fee_wallet else {
        tracing::warn!("[platformFee] Fee wallet not configured for {currency}. Skipping fee collection.");
        return None;
    };

    // `ethers.parseUnits(String(feeAmount), 6)`: a notation ethers rejects is the
    // throw the TS caught.
    let treasury = match eth::Treasury::from_config() {
        Ok(treasury) => treasury,
        Err(err) => {
            tracing::error!("[deposit] Fee collection failed (non-blocking): {err}");
            return None;
        }
    };
    let value = match eth::parse_units(&fee_amount.to_string(), ledger::USDC_DECIMALS) {
        Ok(value) => value,
        Err(err) => {
            tracing::error!("[deposit] Fee collection failed (non-blocking): {err}");
            return None;
        }
    };
    match treasury.withdraw_token_to(&fee_wallet, value).await {
        Ok(hash) => Some(hash),
        Err(err) => {
            tracing::error!("[deposit] Fee collection failed (non-blocking): {err}");
            None
        }
    }
}

/// The `operation_type='platform_fee'` audit row. Its hash is derived from the
/// deposit's combined hash, so a replayed deposit cannot add a second fee entry.
async fn log_platform_fee(
    user_key: &str,
    currency: &str,
    fee_amount: f64,
    combined_tx_hash: &str,
) -> Result<(), ApiError> {
    let mut binds = Binds::new();
    let mut names = Vec::new();
    let mut placeholders = Vec::new();
    for (name, value) in [
        ("user_address", Value::String(user_key.to_string())),
        ("currency", Value::String(currency.to_string())),
        ("operation_type", Value::String("platform_fee".to_string())),
        ("amount", Value::from(fee_amount)),
        (
            "transaction_hash",
            Value::String(format!("fee:deposit:{combined_tx_hash}")),
        ),
    ] {
        let ty = column_type("balance_audit_log", name).await?;
        names.push(format!("\"{name}\""));
        placeholders.push(binds.push(ty, value));
    }
    let statement = format!(
        "INSERT INTO balance_audit_log ({}) VALUES ({})",
        names.join(", "),
        placeholders.join(", ")
    );
    sql::execute(&statement, &binds.refs()).await.map(|_| ())
}

/// `releaseDepositLock`: frees a tx hash whose credit never landed, so the player
/// can retry the same deposit. A failure to release is only logged: retries stay
/// rejected until the row is cleaned up, which is the side that cannot double-pay.
async fn release_deposit_lock(tx_hash: &str, reason: &str) {
    let bind = Value::String(tx_hash.to_string());
    if let Err(err) = sql::execute(
        "DELETE FROM deposit_locks WHERE transaction_hash = CAST($1 AS text)",
        &[("text", &bind)],
    )
    .await
    {
        tracing::error!(
            "[deposit] could not release deposit lock for {tx_hash} ({reason}) — \
             deposit retries will be rejected until this row is cleaned up: {err}"
        );
    }
}

// ---------------------------------------------------------------------------
// POST /api/balance/win  <-  app/api/balance/win/route.ts
// ---------------------------------------------------------------------------

async fn win(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match win_run(&body).await {
        Ok(body) => Json(body).into_response(),
        Err(rejection) => reject(rejection),
    }
}

async fn win_run(body: &Value) -> Result<Value, ledger::Rejection> {
    let request = ledger::win_head(body, ALLOW_TEST_BYPASS)?;
    let user_address = request.user_address;

    if !address::is_address(user_address) {
        return Err((400, ledger::error_body("Invalid wallet address format")));
    }

    // The win amount is validated *before* the ban probe in the TS, while
    // `win_after_ban` bundles it with the currency gate that belongs after it.
    // This inline gate reproduces the order; `win_after_ban` repeats the same
    // check below and cannot disagree with it.
    let win_amount = ledger::number_of(request.win_amount);
    let is_real_number = matches!(request.win_amount, Value::Number(_));
    if !win_amount.map(|amount| amount > 0.0 && amount.is_finite()).unwrap_or(false) || !is_real_number
    {
        return Err((400, ledger::error_body("Win amount must be greater than zero")));
    }

    if is_globally_banned(user_address).await {
        return Err(ledger::banned_rejection());
    }

    let user_key = address::canonical(user_address);
    let currency = ledger::win_after_ban(&request)?;
    let win_amount_value = win_amount.unwrap_or(0.0);

    // The payout is guarded by the HMAC settlement token the bet route signed:
    // bet id, address, currency and the payout ceiling, all read from the payload.
    if bets::is_truthy(Some(&request.settlement_token)) {
        let Some(token) = request.settlement_token.as_str() else {
            // `token.split('.')` on a non-string throws in the TS, and the outer
            // catch answers the generic 500.
            return Err(ledger::route_crash());
        };
        let payload = crypto::verify_settlement_token(Some(token));
        if payload.is_none() {
            return Err((401, ledger::error_body("Invalid settlement token")));
        }
        if let Some(rejection) = ledger::win_token_failure(
            payload.as_ref(),
            request.bet_id,
            &user_key,
            &currency,
            win_amount_value,
        ) {
            return Err(rejection);
        }
    }

    // ── Atomic payout: lock row + bet claim + credit in one transaction ──
    // Nothing here reads-then-writes: a concurrent retry loses on either the
    // unique payout_lock index or the consumed_at UPDATE, and credits nothing.
    let result = match db::call_rpc(
        "settle_bet_payout",
        &[
            ("p_bet_id", request.bet_id),
            ("p_user_address", &Value::String(user_key.clone())),
            ("p_payout_amount", request.win_amount),
            ("p_currency", &Value::String(currency.clone())),
        ],
    )
    .await
    {
        Err(err) => {
            // An aborted call carries the PL/pgSQL exception text; the three
            // `strike_*` exceptions are the ledger refusing this payout by name.
            let message = database_error_message(&err);
            if let Some(rejection) = ledger::win_map_settle_error(&message) {
                tracing::error!("[balance/win] payout refused: {message}");
                return Err(rejection);
            }
            tracing::error!("[balance/win] database error while settling payout: {err}");
            return Err(ledger::win_unavailable());
        }
        Ok(result) => result,
    };

    let bet_id = bets::value_to_string(request.bet_id);
    match ledger::win_rpc_decision(&result, &bet_id, win_amount_value) {
        // The first attempt credited this bet — a retry (or a concurrent
        // duplicate POST) is the same end state for the player. Answer 200 with
        // duplicate: true so clients treat it as success and refresh the balance,
        // never as an error they would "retry" again.
        ledger::WinRpcDecision::Duplicate(body) => {
            tracing::warn!("[balance/win] duplicate payout acknowledged as success for betId={bet_id}");
            Ok(body)
        }
        ledger::WinRpcDecision::FailClosed { status, body: error } => {
            tracing::error!(
                "[balance/win] payout not credited (fail closed): {}",
                error.get("error").and_then(|v| v.as_str()).unwrap_or("malformed RPC result")
            );
            Err((status, error))
        }
        ledger::WinRpcDecision::Success(body) => Ok(body),
    }
}

// ---------------------------------------------------------------------------
// POST /api/balance/withdraw  <-  app/api/balance/withdraw/route.ts
// ---------------------------------------------------------------------------

async fn withdraw(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match withdraw_run(&body).await {
        Ok(body) => Json(body).into_response(),
        Err(rejection) => reject(rejection),
    }
}

async fn withdraw_run(body: &Value) -> Result<Value, ledger::Rejection> {
    let head = ledger::withdraw_head(body)?;
    let user_address_value = head.user_address;
    let user_address = user_address_value.as_str().unwrap_or_default();

    if !address::is_address(user_address) {
        return Err((400, ledger::error_body("Invalid wallet address format")));
    }
    if is_globally_banned(user_address).await {
        return Err(ledger::banned_rejection());
    }
    if !(head.amount_num > 0.0) {
        return Err(ledger::withdraw_positive());
    }

    // Require a signed withdrawal intent.
    let signature = body.get("signature");
    let signed_at = body.get("signedAt");
    if !ALLOW_TEST_BYPASS {
        if !bets::is_truthy(signature) || !bets::is_truthy(signed_at) {
            return Err(ledger::withdraw_missing_authorization());
        }
        // A `signedAt` that is not a number is JS `NaN`, and every comparison
        // against NaN is false: expired.
        let signed_at_ms = signed_at.and_then(ledger::number_of).filter(|value| value.is_finite());
        match signed_at_ms {
            Some(ms) if crypto::is_authorization_fresh(ms as i64) => {}
            _ => return Err(ledger::withdraw_expired()),
        }

        // The client signs the Arc USDC ledger currency verbatim: the raw address
        // spelling, `amount.toFixed(8)`, the upper-cased currency, the raw
        // signedAt. A non-numeric amount has no `.toFixed` -> the generic 500.
        let message = ledger::withdraw_intent_message(
            user_address_value,
            head.amount,
            &head.currency,
            signed_at.unwrap_or(&Value::Null),
        )?;
        let signature_text = signature.and_then(Value::as_str);
        // `ethers.verifyMessage` throws on a signature it cannot parse, and the
        // outer catch answers the generic 500.
        let recovered = match signature_text.and_then(|sig| eth::recover_personal_signer(&message, sig)) {
            Some(recovered) => recovered,
            None => return Err(ledger::route_crash()),
        };
        if address::canonical(&recovered) != address::canonical(user_address) {
            return Err(ledger::withdraw_signature_mismatch());
        }
    }

    let variants = address::search_variants(user_address);
    // The insufficient-balance message interpolates the currency the client sent,
    // *not* the normalised one — a TS quirk the response text depends on.
    let raw_currency = raw_currency(body);

    // 1. Get house balance and status and validate (merge legacy EVM casing rows).
    // A failed lookup answers the same 404 the TS produced for "no rows".
    let rows = balance_rows(&variants, &head.currency).await;
    let (db_address, balance) =
        match ledger::withdraw_choose_row(&rows, head.amount_num, &raw_currency) {
            ledger::WithdrawRows::Ledger(address, balance) => (address, balance),
            ledger::WithdrawRows::Reject(rejection) => return Err(rejection),
        };

    // ── Signed-intent replay ─────────────────────────────────────────────────
    // The signature is a unique nonce for one (address, amount, signedAt). If a
    // row already exists for it, this POST is a retry of a request the player
    // already made (double-click, refresh-then-resend, flaky network after the
    // row landed), so replay the original instead of queueing a second payout.
    if bets::is_truthy(signature) {
        let existing = withdrawal_by_signature(signature.and_then(Value::as_str).unwrap_or_default()).await;
        if let Some(existing) = existing {
            tracing::warn!(
                "[withdraw] replaying existing withdrawal request {} for a repeated signature",
                existing.get("id").map(ledger::js_to_string).unwrap_or_default()
            );
            return Ok(ledger::withdraw_replay_body(&existing, &balance));
        }
    }

    // ── Withdrawal cap: max payout = total_deposited × 1.08 ──
    // Ledger totals accumulate in exact base units (6 decimals). A row the
    // converter cannot read makes the whole comparison fail closed.
    let deposits = audit_amounts(&variants, &head.currency, "deposit").await;
    let withdrawn = audit_amounts(&variants, &head.currency, "withdrawal").await;
    let pending = pending_request_amounts(&variants, &head.currency).await;
    ledger::withdraw_cap_check(head.amount, &deposits, &withdrawn, &pending, &head.currency)?;

    // Count ALL completed + pending withdrawals for this wallet. Completed ones
    // are tracked in balance_audit_log (operation_type='withdrawal'), pending ones
    // in withdrawal_requests with status='pending'. Intentionally across ALL
    // currencies/chains — abuse detection is global.
    let withdrawal_count =
        audit_withdrawal_count(&variants).await + pending_withdrawal_count(&variants).await;
    let is_exempt = ledger::frequency_review_exempt(user_address, &config().withdrawal_frequency_exempt);
    let triggers_frequency_review = ledger::frequency_review_triggered(is_exempt, withdrawal_count);

    // 2. Resolve user tier from DB — never trust a client-supplied value.
    let tier = tier_for(&db_address).await;
    let (fee_amount, net_withdraw_amount) = ledger::withdraw_net(head.amount_num, tier);
    if !(net_withdraw_amount > 0.0) {
        return Err(ledger::withdraw_net_rejection(ledger::fee_percent_label(tier)));
    }

    let request_id = insert_withdrawal_request(WithdrawalInsert {
        user_address: address::canonical(user_address),
        currency: head.currency.clone(),
        amount: head.amount.clone(),
        fee_amount,
        net_amount: net_withdraw_amount,
        signature: signature.cloned().unwrap_or(Value::Null),
        signed_at: signed_at.cloned().unwrap_or(Value::Null),
        decided_by: if triggers_frequency_review {
            // Stamp the reason so the dashboard can distinguish security/manual
            // review cases from an ordinary queue entry.
            Value::String(ledger::frequency_review_stamp(withdrawal_count))
        } else {
            Value::Null
        },
    })
    .await?;

    // The ledger has only queued the payout — the money moves when an admin accept
    // route re-verifies the intent and pays. Never report more than that.
    Ok(ledger::withdraw_success_body(
        request_id,
        &balance,
        fee_amount,
        net_withdraw_amount,
        &iso_ms(now_ms()),
        triggers_frequency_review,
        withdrawal_count,
    ))
}

/// `withdrawal_requests` rows already carrying this exact signature. A failed
/// lookup means "no existing row": the TS read `replayRows?.[0]` and moved on.
async fn withdrawal_by_signature(signature: &str) -> Option<Value> {
    let bind = Value::String(signature.to_string());
    sql::fetch_one(
        "SELECT id, status, amount, fee_amount, net_amount FROM withdrawal_requests \
          WHERE signature = CAST($1 AS text) LIMIT 1",
        &[("text", &bind)],
    )
    .await
    .inspect_err(|err| tracing::warn!("[withdraw] signature replay lookup failed: {err}"))
    .ok()
    .flatten()
}

/// One `SELECT amount` for the cap inputs. The TS `Promise.all` kept going when a
/// query errored (`data ?? []`), so an error contributes nothing to the totals
/// rather than refusing the withdrawal.
async fn audit_amounts(variants: &[String], currency: &str, operation: &str) -> Vec<Value> {
    let mut binds = Binds::new();
    let operation_bind = binds.push_static("text", Value::String(operation.to_string()));
    let currency_bind = binds.push_static("text", Value::String(currency.to_string()));
    let in_list = bind_variants(&mut binds, variants);
    let statement = format!(
        "SELECT amount FROM balance_audit_log \
          WHERE operation_type = {operation_bind} AND currency = {currency_bind} \
            AND user_address IN ({in_list})"
    );
    fetch_or_empty(&statement, &binds).await
}

/// The pending/approved request amounts the cap also counts. `approved` is not a
/// status the queue can hold (the CHECK allows pending/accepted/rejected), so it
/// matches nothing — kept because the TS asked for it.
async fn pending_request_amounts(variants: &[String], currency: &str) -> Vec<Value> {
    let mut binds = Binds::new();
    let currency_bind = binds.push_static("text", Value::String(currency.to_string()));
    let pending = binds.push_static("text", Value::String("pending".to_string()));
    let approved = binds.push_static("text", Value::String("approved".to_string()));
    let in_list = bind_variants(&mut binds, variants);
    let statement = format!(
        "SELECT amount FROM withdrawal_requests \
          WHERE currency = {currency_bind} AND status IN ({pending}, {approved}) \
            AND user_address IN ({in_list})"
    );
    fetch_or_empty(&statement, &binds).await
}

async fn fetch_or_empty(statement: &str, binds: &Binds) -> Vec<Value> {
    sql::fetch(statement, &binds.refs())
        .await
        .unwrap_or_else(|err| {
            tracing::warn!("[withdraw] cap input query failed: {err}");
            Vec::new()
        })
}

/// `select('id', { count: 'exact', head: true })`: the count alone, with the same
/// "an error is zero" tolerance the TS had.
async fn audit_withdrawal_count(variants: &[String]) -> i64 {
    let mut binds = Binds::new();
    let operation_bind = binds.push_static("text", Value::String("withdrawal".to_string()));
    let in_list = bind_variants(&mut binds, variants);
    let statement = format!(
        "SELECT count(*) FROM balance_audit_log \
          WHERE operation_type = {operation_bind} AND user_address IN ({in_list})"
    );
    count_or_zero(&statement, &binds).await
}

async fn pending_withdrawal_count(variants: &[String]) -> i64 {
    let mut binds = Binds::new();
    let status_bind = binds.push_static("text", Value::String("pending".to_string()));
    let in_list = bind_variants(&mut binds, variants);
    let statement = format!(
        "SELECT count(*) FROM withdrawal_requests \
          WHERE status = {status_bind} AND user_address IN ({in_list})"
    );
    count_or_zero(&statement, &binds).await
}

async fn count_or_zero(statement: &str, binds: &Binds) -> i64 {
    let scalar = sql::fetch_scalar(statement, &binds.refs())
        .await
        .unwrap_or(Value::Null);
    scalar.as_i64().unwrap_or(0)
}

struct WithdrawalInsert {
    user_address: String,
    currency: String,
    amount: Value,
    fee_amount: f64,
    net_amount: f64,
    signature: Value,
    signed_at: Value,
    decided_by: Value,
}

/// The `withdrawal_requests` insert with `.select('*').single()`: the queue row is
/// created and its id is what the response reports. Only `id` is read back — every
/// other field in the response was computed server-side above.
async fn insert_withdrawal_request(
    request: WithdrawalInsert,
) -> Result<Value, ledger::Rejection> {
    // `signature: authorizationSignature || null`, `signed_at: signedAt || null`.
    let or_null = |value: Value| if bets::is_truthy(Some(&value)) { value } else { Value::Null };

    let values: [(&str, Value); 9] = [
        ("user_address", Value::String(request.user_address)),
        ("currency", Value::String(request.currency)),
        ("amount", request.amount),
        ("fee_amount", Value::from(request.fee_amount)),
        ("net_amount", Value::from(request.net_amount)),
        ("signature", or_null(request.signature)),
        ("signed_at", or_null(request.signed_at)),
        ("status", Value::String("pending".to_string())),
        ("decided_by", request.decided_by),
    ];

    let mut binds = Binds::new();
    let mut names = Vec::new();
    let mut placeholders = Vec::new();
    for (name, value) in values {
        let ty = column_type("withdrawal_requests", name).await.map_err(|err| {
            tracing::error!("[withdraw] unknown withdrawal_requests column {name}: {err}");
            ledger::withdraw_insert_failed()
        })?;
        names.push(format!("\"{name}\""));
        placeholders.push(binds.push(ty, value));
    }

    let statement = format!(
        "INSERT INTO withdrawal_requests ({}) VALUES ({}) RETURNING id",
        names.join(", "),
        placeholders.join(", ")
    );
    let row = sql::fetch_one(&statement, &binds.refs())
        .await
        .map_err(|err| {
            tracing::error!("[withdraw] failed to create withdrawal request: {err}");
            ledger::withdraw_insert_failed()
        })?
        .ok_or_else(ledger::withdraw_insert_failed)?;
    Ok(row.get("id").cloned().unwrap_or(Value::Null))
}
