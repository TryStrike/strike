#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::result_large_err)]

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::Value;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use strike_core::address;
use strike_core::agentpass::{self, Action};
use strike_core::bets::{self, iso_ms, now_ms};
use strike_core::blitz;
use strike_core::config::config;
use strike_core::crypto;
use strike_core::db::{self, rpc_object};
use strike_core::error::ApiError;
use strike_core::eth::{self, DepositFailure};
use strike_core::ledger;
use strike_core::settlement::{self, Settled};
use strike_core::ticks;
use strike_core::withdrawals;

use crate::bans::is_globally_banned;
use crate::http::{require_balance_session, require_wallet_session};
use crate::routes::bets::{column_type, Binds};
use crate::routes::stepup::{reply, stepup_id};
use crate::sql;

fn raw_currency(body: &Value) -> String {
    match body.get("currency") {
        None | Some(Value::Null) => "USDC".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => "USDC".to_string(),
    }
}

const SETTLEMENT_TTL_SECONDS: i64 = settlement::MAX_ROUND_MS / 1000 + 5 * 60;

const ALLOW_TEST_BYPASS: bool = false;

pub fn routes() -> Router {
    Router::new()
        .route("/api/balance/bet", post(bet))
        .route("/api/balance/deposit", post(deposit))
        .route("/api/balance/win", post(win))
        .route("/api/balance/withdraw", post(withdraw))
}

fn reject(rejection: ledger::Rejection) -> Response {
    let (status, body) = rejection;
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, axum::Json(body)).into_response()
}

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

fn new_balance_value(result: &Value) -> Value {
    bets::js_num(ledger::to_number_opt(result.get("new_balance")).unwrap_or(f64::NAN))
}

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

pub(crate) async fn balance_rows(variants: &[String], currency: &str) -> Vec<Value> {
    let mut binds = Binds::new();
    let in_list = bind_variants(&mut binds, variants);
    let currency_bind = binds.push_static("text", Value::String(currency.to_string()));
    let statement = format!(
        "SELECT balance, status, user_address FROM user_balances \
          WHERE user_address IN ({in_list}) AND currency = {currency_bind}"
    );
    sql::fetch(&statement, &binds.refs())
        .await
        .unwrap_or_default()
}

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

fn confirmations_from_message(message: &str) -> Option<u64> {
    let start = message.char_indices().find(|(_, c)| c.is_ascii_digit())?.0;
    let digits: String = message[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn uuid_hex12() -> String {
    let simple = uuid::Uuid::new_v4().simple().to_string();
    simple[..12].to_string()
}

fn mint_settlement(
    bet_id: &str,
    user_address: &str,
    currency: &str,
    max_payout: f64,
) -> Result<String, ledger::Rejection> {
    crypto::create_settlement_token(
        bet_id,
        user_address,
        currency,
        max_payout,
        SETTLEMENT_TTL_SECONDS,
    )
    .map_err(|err| {
        tracing::error!("[bet] settlement signing failed: {err}");
        ledger::route_crash()
    })
}

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

async fn bet(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(err) =
        require_wallet_session(&headers, body["userAddress"].as_str().unwrap_or_default())
    {
        return err.into_response();
    }
    match bet_run(&body).await {
        Ok(body) => Json(body).into_response(),
        Err(rejection) => reject(rejection),
    }
}

pub(crate) async fn place_bet(body: &Value) -> ledger::BetOutcome {
    if ledger::sanitize_bet_request_id(body.get("betRequestId")).is_none() {
        return ledger::BetOutcome::Rejected("Invalid bet request id".into());
    }
    ledger::bet_outcome(&bet_run(body).await)
}

/// 1 unless the bet asks for Blitz, in which case it needs an active pass.
async fn blitz_boost(body: &Value, wallet: &str, now: i64) -> Result<f64, ledger::Rejection> {
    let unavailable = |err: ApiError| {
        tracing::error!("[bet] blitz pass lookup failed: {err}");
        (503, ledger::error_body("Service unavailable"))
    };
    let database = db::db().await.map_err(unavailable)?;
    blitz::boost_for(database, body, wallet, now)
        .await
        .map_err(unavailable)?
}

async fn bet_run(body: &Value) -> Result<Value, ledger::Rejection> {
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

    let stake = ledger::exact_amount(plan.amount)
        .ok_or_else(|| (400, ledger::error_body("Invalid bet amount")))?;
    let now = now_ms();
    let boost = blitz_boost(body, user_address, now).await?;
    let frozen = settlement::freeze_bet_boosted(body, stake, ticks::buffer(), now, boost)?;
    let terms = serde_json::to_value(&frozen.terms).map_err(|err| {
        tracing::error!("[bet] round terms failed to serialize: {err}");
        ledger::route_crash()
    })?;
    let max_payout = frozen.max_payout.to_f64().ok_or_else(ledger::route_crash)?;

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

    let client_request_id = ledger::sanitize_bet_request_id(body.get("betRequestId"));
    if bets::is_truthy(body.get("betRequestId")) && client_request_id.is_none() {
        tracing::warn!("[bet] rejected malformed betRequestId, deriving a server key");
    }
    let bet_request_id = client_request_id.unwrap_or_else(|| {
        ledger::derived_bet_request_id(body.get("roundId"), &plan.user_key, now_ms())
    });

    let bet_id = ledger::build_bet_id(now_ms(), &uuid_hex12());
    let settlement_token = mint_settlement(&bet_id, &ledger_user_key, &plan.currency, max_payout)?;

    let result = db::call_rpc(
        "place_bet_locked",
        &[
            ("p_user_address", &Value::String(ledger_user_key.clone())),
            ("p_bet_amount", &plan.bet_amount),
            ("p_currency", &Value::String(plan.currency.clone())),
            ("p_idempotency_key", &Value::String(bet_request_id.clone())),
            ("p_bet_id", &Value::String(bet_id.clone())),
            (
                "p_max_payout",
                &Value::String(frozen.max_payout.to_string()),
            ),
            (
                "p_end_time",
                &Value::String(settlement::end_time_iso(&frozen)),
            ),
            (
                "p_settlement_token",
                &Value::String(settlement_token.clone()),
            ),
            ("p_round", &terms),
        ],
    )
    .await
    .map_err(|err| {
        tracing::error!("[bet] place_bet_locked failed: {err}");
        (503, ledger::error_body("Service unavailable"))
    })?;

    let round = result.get("round");
    match ledger::bet_rpc_decision(&result, &ledger_user_key, &plan.currency) {
        ledger::BetRpcDecision::ReplayMint(mint) => {
            tracing::warn!("[bet] duplicate request replayed: {bet_request_id}");
            let token = mint_settlement(
                &mint.bet_id,
                &mint.user_address,
                &mint.currency,
                mint.max_payout,
            )?;
            Ok(ledger::bet_success_body(
                new_balance_value(&result),
                &mint.bet_id,
                &token,
                true,
                round,
            ))
        }
        ledger::BetRpcDecision::ReplayStored { bet_id, token, .. } => {
            tracing::warn!(
                "[bet] duplicate request replayed with the stored token: {bet_request_id}"
            );
            Ok(ledger::bet_success_body(
                new_balance_value(&result),
                &bet_id,
                &token,
                true,
                round,
            ))
        }
        ledger::BetRpcDecision::Conflict { body: error } => {
            tracing::warn!("[bet] duplicate request without a settlement token: {bet_request_id}");
            Err((409, error))
        }
        ledger::BetRpcDecision::FailClosed {
            status,
            body: error,
        } => {
            tracing::error!(
                "[bet] bet not placed (fail closed): {}",
                error
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("malformed RPC result")
            );
            Err((status, error))
        }
        ledger::BetRpcDecision::Success {
            new_balance,
            bet_id,
            token,
        } => Ok(ledger::bet_success_body(
            bets::js_num(new_balance),
            &bet_id,
            &token,
            false,
            round,
        )),
    }
}

async fn deposit(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(err) =
        require_wallet_session(&headers, body["userAddress"].as_str().unwrap_or_default())
    {
        return err.into_response();
    }
    let hold = eth::hold_payout();
    let run = tokio::spawn(async move {
        let _hold = hold;
        deposit_run(&body).await
    });
    match run.await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(rejection)) => reject(rejection),
        Err(panic) => {
            tracing::error!("[deposit] task failed: {panic}");
            reject(ledger::deposit_unavailable())
        }
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
    let currency = ledger::deposit_currency(body, head.amount)?;

    let deposit_user_key = address::canonical(user_address);
    let tier = tier_for(&deposit_user_key).await;

    let split = ledger::deposit_net(head.amount, tier);
    let Some((fee_amount, net_deposit_amount)) = split.filter(|(_, net)| *net > Decimal::ZERO)
    else {
        return Err(ledger::deposit_net_rejection(ledger::fee_percent_label(
            tier,
        )));
    };
    let net_deposit_text = Value::String(net_deposit_amount.to_string());

    let tx_hash = ledger::js_to_string(head.tx_hash).trim().to_lowercase();
    if tx_hash.len() != 66
        || !tx_hash.starts_with("0x")
        || !tx_hash[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err((400, ledger::error_body("Invalid transaction hash")));
    }
    let token = strike_core::config::token_address(&currency).unwrap_or_default();
    let verification = match eth::verify_deposit(
        &tx_hash,
        user_address,
        &ledger::deposit_required_amount_string(head.amount),
        ledger::USDC_DECIMALS,
        &token,
    )
    .await
    {
        Ok(verification) => verification,
        Err((failure, message)) => {
            let reason = failure_reason(&failure);
            if failure.retryable() {
                tracing::warn!("[deposit] on-chain verification pending, retryable: {reason}");
                let confirmations = if matches!(failure, DepositFailure::InsufficientConfirmations)
                {
                    confirmations_from_message(&message)
                } else {
                    None
                };
                return Err(ledger::deposit_pending_body(reason, confirmations));
            }
            tracing::warn!("[deposit] deposit rejected on-chain: {reason} {message}");
            return Err(ledger::deposit_terminal(reason, &message));
        }
    };

    let mut locks = Binds::new();
    let mut placeholders = Vec::new();
    for (name, value) in [
        ("transaction_hash", Value::String(tx_hash.clone())),
        ("user_address", Value::String(deposit_user_key.clone())),
        ("currency", Value::String(currency.clone())),
        ("amount", net_deposit_text.clone()),
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

    let combined_tx_hash = tx_hash.clone();

    let user_key = address::canonical(if verification.payer_address.is_empty() {
        user_address
    } else {
        verification.payer_address.as_str()
    });

    let rpc = db::call_rpc(
        "update_balance_for_deposit",
        &[
            ("p_user_address", &Value::String(user_key.clone())),
            ("p_deposit_amount", &net_deposit_text),
            ("p_currency", &Value::String(currency.clone())),
            (
                "p_transaction_hash",
                &Value::String(combined_tx_hash.clone()),
            ),
        ],
    )
    .await;

    let result = match rpc {
        Err(err) => {
            tracing::error!("Database error in deposit: {err}");
            release_deposit_lock(&tx_hash, "database error").await;
            return Err(ledger::deposit_unavailable());
        }
        Ok(value) => rpc_object(value),
    };

    if !db::rpc_success(&result) {
        let message = result
            .get("error")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or("Deposit failed")
            .to_string();
        if ledger::is_audit_duplicate(&message) {
            tracing::warn!("[deposit] audit hash already recorded for txHash={tx_hash}");
            return Err(ledger::deposit_duplicate_body());
        }
        release_deposit_lock(&tx_hash, &message).await;
        return Err((400, ledger::error_body(&message)));
    }

    if fee_amount > Decimal::ZERO {
        if let Err(err) =
            log_platform_fee(&user_key, &currency, fee_amount, &combined_tx_hash).await
        {
            tracing::warn!("[deposit] fee log failed (non-blocking): {err}");
        }
    }

    Ok(ledger::deposit_success_body(
        ledger::parse_float_of(result.get("new_balance")),
        fee_amount.to_f64().unwrap_or(f64::NAN),
        net_deposit_amount.to_f64().unwrap_or(f64::NAN),
        &iso_ms(now_ms()),
    ))
}

async fn log_platform_fee(
    user_key: &str,
    currency: &str,
    fee_amount: Decimal,
    combined_tx_hash: &str,
) -> Result<(), ApiError> {
    let mut binds = Binds::new();
    let mut names = Vec::new();
    let mut placeholders = Vec::new();
    for (name, value) in [
        ("user_address", Value::String(user_key.to_string())),
        ("currency", Value::String(currency.to_string())),
        ("operation_type", Value::String("platform_fee".to_string())),
        ("amount", Value::String(fee_amount.to_string())),
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
    let request = ledger::win_head(body)?;
    let user_address = request.user_address;

    if !address::is_address(user_address) {
        return Err((400, ledger::error_body("Invalid wallet address format")));
    }
    if is_globally_banned(user_address).await {
        return Err(ledger::banned_rejection());
    }

    let user_key = address::canonical(user_address);
    let currency = ledger::win_after_ban(&request)?;

    let Some(token) = request.settlement_token.as_str() else {
        return Err(ledger::route_crash());
    };
    let payload = crypto::verify_settlement_token(Some(token));
    if payload.is_none() {
        return Err((401, ledger::error_body("Invalid settlement token")));
    }
    if let Some(rejection) =
        ledger::win_token_failure(payload.as_ref(), request.bet_id, &user_key, &currency)
    {
        return Err(rejection);
    }

    let bet_id = bets::value_to_string(request.bet_id);
    let database = db::db().await.map_err(|err| {
        tracing::error!("[balance/win] database unavailable: {err}");
        ledger::win_unavailable()
    })?;
    match settlement::settle(database, &bet_id, "claim", now_ms()).await {
        Ok(Settled::Done(result)) => Ok(ledger::win_body(&result, &bet_id)),
        Ok(Settled::Open { end_ms }) => Err(ledger::win_round_open(end_ms)),
        Ok(Settled::Unknown) => Err(ledger::win_unknown_bet()),
        Err(err) => {
            tracing::error!("[balance/win] database error while settling: {err}");
            Err(ledger::win_unavailable())
        }
    }
}

async fn withdraw(headers: HeaderMap, raw: Bytes) -> Response {
    let body = match parse_body(&headers, &raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let (id, mut queued) = match withdraw_run(&body).await {
        Ok(Withdrawal::Replay(body)) => return Json(body).into_response(),
        Ok(Withdrawal::Queued { id, body }) => (id, body),
        Err(rejection) => return reply(rejection),
    };
    let paid = super::payout::pay(id).await;
    if !paid.status().is_success() {
        super::payout::cancel_if_pending(id).await;
        return paid;
    }
    let receipt: Value = match axum::body::to_bytes(paid.into_body(), 64 * 1024).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    queued["status"] = Value::from("paid");
    queued["newBalance"] = receipt.get("newBalance").cloned().unwrap_or(Value::Null);
    queued["txHash"] = receipt.get("txHash").cloned().unwrap_or(Value::Null);
    Json(queued).into_response()
}

enum Withdrawal {
    Replay(Value),
    Queued { id: i64, body: Value },
}

async fn withdraw_human_check(
    database: &'static db::Db,
    body: &Value,
    wallet: &str,
    head: &ledger::WithdrawHead<'_>,
    request: &withdrawals::QueueRequest,
) -> Result<(), ledger::Rejection> {
    let unavailable = |err: ApiError| {
        tracing::error!("[withdraw] human check failed: {err}");
        ledger::withdraw_insert_failed()
    };
    let human = agentpass::require_human(database, wallet)
        .await
        .map_err(unavailable)??;
    let amount = Decimal::try_from(head.amount_num).unwrap_or(Decimal::MAX);
    if amount <= config().world_limits.stepup_withdraw_over {
        return Ok(());
    }
    let key = format!(
        "withdraw:{}:{}:{}",
        address::canonical(wallet),
        amount.normalize(),
        head.currency
    );
    let now = now_ms();
    match stepup_id(body) {
        Some(id) => agentpass::consume_now(database, &id, &human.id, "withdraw", &key, now)
            .await
            .map_err(unavailable)?,
        None => {
            withdrawals::dry_run(database, request.clone()).await?;
            let action = Action {
                kind: "withdraw",
                key,
                summary: format!("Withdraw {} {}", amount.normalize(), head.currency),
                session_id: None,
            };
            let asked = agentpass::begin(database, &human, wallet, action, now)
                .await
                .map_err(unavailable)?;
            Err(match asked {
                Ok(stepup) => agentpass::step_up_required(&stepup),
                Err(rejection) => rejection,
            })
        }
    }
}

async fn withdraw_run(body: &Value) -> Result<Withdrawal, ledger::Rejection> {
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

    let signature = body.get("signature");
    let signed_at = body.get("signedAt");
    if !ALLOW_TEST_BYPASS {
        if !bets::is_truthy(signature) || !bets::is_truthy(signed_at) {
            return Err(ledger::withdraw_missing_authorization());
        }
        let signed_at_ms = signed_at
            .and_then(ledger::number_of)
            .filter(|value| value.is_finite());
        match signed_at_ms {
            Some(ms) if crypto::is_authorization_fresh(ms as i64) => {}
            _ => return Err(ledger::withdraw_expired()),
        }

        let message = ledger::withdraw_intent_message(
            user_address_value,
            head.amount,
            &head.currency,
            signed_at.unwrap_or(&Value::Null),
        )?;
        let signature_text = signature.and_then(Value::as_str);
        let Some(signature_text) = signature_text else {
            return Err(ledger::route_crash());
        };
        let signed = eth::verify_personal_signature(user_address, &message, signature_text)
            .await
            .map_err(|err| {
                tracing::error!("[withdraw] could not check the signature: {err}");
                (
                    503,
                    ledger::error_body("Could not check the signature right now, try again"),
                )
            })?;
        if !signed {
            return Err(ledger::withdraw_signature_mismatch());
        }
    }

    let variants = address::search_variants(user_address);
    let raw_currency = raw_currency(body);

    let rows = balance_rows(&variants, &head.currency).await;
    let (db_address, balance) =
        match ledger::withdraw_choose_row(&rows, head.amount_num, &raw_currency) {
            ledger::WithdrawRows::Ledger(address, balance) => (address, balance),
            ledger::WithdrawRows::Reject(rejection) => return Err(rejection),
        };
    let database = db::db().await.map_err(|err| {
        tracing::error!("[withdraw] database unavailable: {err}");
        ledger::withdraw_insert_failed()
    })?;
    let request = withdrawals::QueueRequest {
        user_key: address::canonical(user_address),
        variants,
        ledger_address: db_address,
        currency: head.currency.clone(),
        amount: head.amount.clone(),
        amount_num: head.amount_num,
        signature: signature.cloned().unwrap_or(Value::Null),
        signed_at: signed_at.cloned().unwrap_or(Value::Null),
        frequency_exempt: ledger::frequency_review_exempt(
            user_address,
            &config().withdrawal_frequency_exempt,
        ),
    };
    withdraw_human_check(database, body, user_address, &head, &request).await?;

    let queued = withdrawals::queue(database, request).await?;

    match queued {
        withdrawals::Queued::Replay(existing) => {
            tracing::warn!(
                "[withdraw] replaying existing withdrawal request {} for a repeated intent",
                existing
                    .get("id")
                    .map(ledger::js_to_string)
                    .unwrap_or_default()
            );
            Ok(Withdrawal::Replay(ledger::withdraw_replay_body(
                &existing, &balance,
            )))
        }
        withdrawals::Queued::Created {
            id,
            fee_amount,
            net_amount,
            frequency_review,
            withdrawal_count,
        } => Ok(Withdrawal::Queued {
            id: id.as_i64().ok_or_else(ledger::route_crash)?,
            body: ledger::withdraw_success_body(
                id,
                &balance,
                fee_amount,
                net_amount,
                &iso_ms(now_ms()),
                frequency_review,
                withdrawal_count,
            ),
        }),
    }
}
