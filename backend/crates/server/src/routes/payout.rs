//! Withdrawal payouts under the auto-pay policy: no human in the loop.
//!
//! `/api/balance/withdraw` queues a signed request (inside the per-request and
//! per-day caps), then calls [`pay`] at once. Payment re-verifies the signed
//! intent, checks bans and balance, claims and debits in one commit, then sends.
//! A refusal before the debit cancels the request so nothing sits pending with
//! no one to clear it; a failure after the debit parks it for reconciliation and
//! is never retried, because the transfer may already have landed.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use strike_core::address::search_variants;
use strike_core::bets::{is_truthy, now_ms, number_coerce, to_number, value_to_string};
use strike_core::config::USDC_DECIMALS;
use strike_core::db;
use strike_core::error::ApiResult;
use strike_core::eth::{self, parse_units, PayError, Transfer, Treasury};
use strike_core::ledger::{exact_amount, floor_to_token};
use strike_core::payout_rules::{
    js_number_string, plan_payout, reconciliation_note, sanitize_error_text, stale_intent_message,
    verify_withdrawal_intent, within_accept_window,
};
use strike_core::withdrawals::{self, Claim};
use rust_decimal::Decimal;

use crate::bans::is_globally_banned;
use crate::http;
use crate::sql;

const ACCEPT_REQUEST_COLUMNS: &str = "id, user_address, currency, amount, net_amount, fee_amount, \
    requested_at, status, decided_by, tx_hash, signature, signed_at, created_at";

fn error(status: StatusCode, msg: impl AsRef<str>) -> Response {
    http::json_status(status, json!({ "error": msg.as_ref() }))
}

fn row_field<'a>(row: &'a Value, key: &str) -> &'a Value {
    row.get(key).unwrap_or(&Value::Null)
}

fn text_binds(values: &[Value]) -> Vec<(&str, &Value)> {
    values.iter().map(|v| ("text", v)).collect()
}

/// Pays request `id` in its own task: a client hanging up must not stop a
/// payout before its hash is recorded, and the hold makes shutdown wait for it.
pub async fn pay(id: i64) -> Response {
    let hold = eth::hold_payout();
    let task = tokio::spawn(async move {
        let _hold = hold;
        run(id).await
    });
    match task.await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            sanitize_error_text(&err.to_string(), "Withdrawal payout failed"),
        ),
        Err(panic) => {
            tracing::error!("[withdrawal/pay] id={id} task failed: {panic}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Withdrawal payout failed",
            )
        }
    }
}

/// A request refused before any debit goes back to `rejected`, so its amount
/// stops counting against the caps and the user can try again. Conditional on
/// `pending`: a paid or parked row is never touched.
pub async fn cancel_if_pending(id: i64) {
    let id_bind = Value::from(id);
    let decided_at = Value::String(strike_core::bets::iso_ms(now_ms()));
    if let Err(err) = sql::fetch(
        "UPDATE withdrawal_requests SET status = 'rejected', \
             decided_at = CAST($1 AS timestamp with time zone), decided_by = 'auto' \
         WHERE id = CAST($2 AS int8) AND status = 'pending' RETURNING id",
        &[
            ("timestamp with time zone", &decided_at),
            ("int8", &id_bind),
        ],
    )
    .await
    {
        tracing::error!("[withdrawal/pay] id={id} could not be cancelled: {err}");
    }
}

async fn run(id: i64) -> ApiResult<Response> {
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
    )
    .await?
    {
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
    let Some(token) = strike_core::config::token_address(&currency) else {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            "Unsupported withdrawal currency",
        ));
    };
    let treasury = match Treasury::from_config() {
        Ok(treasury) => treasury.for_token(token),
        Err(err) => {
            tracing::error!("[withdrawal/pay] treasury unavailable: {err}");
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
                tracing::error!("[withdrawal/pay] claim failed: {err}");
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
            tracing::error!("[withdrawal/pay] id={id} treasury read failed: {err}");
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
    let written = combined.clone();

    let finalize_failure = match withdrawals::finalize(db::db().await?, id, written, None).await {
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

    Ok(
        axum::Json(json!({ "success": true, "newBalance": new_balance, "txHash": combined }))
            .into_response(),
    )
}

/// `markNeedsReconciliation`: once a row is claimed, a failure is no longer a
/// plain 500. Funds may have left the treasury, so park it where no second
/// admin can pay it again, and shout in the logs.
async fn mark_needs_reconciliation(id: i64, reason: &str) {
    let note = reconciliation_note(reason);
    tracing::error!("[withdrawal/pay] id={id} {note}");
    let parked = match db::db().await {
        Ok(database) => withdrawals::park(database, id, note).await,
        Err(err) => Err(err),
    };
    // Left `accepted` with no tx hash, which is equally unpayable.
    if !matches!(parked, Ok(true)) {
        tracing::error!("[withdrawal/pay] id={id} could not be parked: {parked:?}");
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
