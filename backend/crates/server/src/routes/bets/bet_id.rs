//! `GET /api/bets/:id`.
//!
//! Settlement proof for one bet, read with BOTH the id and the caller's
//! canonical wallet in the predicate so a foreign bet is indistinguishable from
//! a missing one (same 404). The deep ledger lookup degrades to
//! `ledger.available: false` instead of failing the whole proof, and the HMAC
//! settlement token is never echoed — only whether one was issued.

use std::collections::HashMap;

use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};

use strike_core::bets::{
    canonical_address, is_chain_hash_strict, is_evm_address, is_truthy, js_num, proof_iso,
    proof_num, value_to_string,
};
use strike_core::error::ApiError;

use crate::http::require_balance_session;
use crate::sql;

use super::{column_type, Binds};

const SELECT_FIELDS: &str = "id, asset, direction, amount, multiplier, strike_price, \
     end_price, payout, won, mode, network, resolved_at, created_at";

const AUDIT_FIELDS: &str = "operation_type, amount, currency, transaction_hash, \
     idempotency_key, end_time, settlement_token, created_at";

pub fn routes() -> Router {
    Router::new().route("/api/bets/{id}", get(handle))
}

async fn handle(
    headers: HeaderMap,
    Path(raw_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    // Same first-party gate as every other bet route.
    if let Err(err) = require_balance_session(&headers) {
        return err.into_response();
    }

    let bet_id = raw_id.trim().to_string();
    let Some(wallet) = params.get("wallet") else {
        return error_json(400, "Missing wallet parameter");
    };
    if !is_evm_address(wallet.trim()) {
        tracing::warn!("[bets/[id]] rejected malformed wallet param");
        return error_json(400, "Invalid wallet parameter");
    }
    if !bet_id_ok(&bet_id) {
        return error_json(400, "Invalid bet id");
    }
    let address = canonical_address(wallet);

    match run(&bet_id, &address).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

pub(crate) async fn run(bet_id: &str, address: &str) -> Result<Value, ApiError> {
    // Row lookup: id + wallet in the predicate, wallet never in the projection.
    let mut binds = Binds::new();
    let id_ph = binds.push(
        column_type("bet_history", "id").await?,
        Value::String(bet_id.to_string()),
    );
    let wallet_ph = binds.push(
        column_type("bet_history", "wallet_address").await?,
        Value::String(address.to_string()),
    );
    let statement = format!(
        "SELECT {SELECT_FIELDS} FROM bet_history WHERE id = {id_ph} AND wallet_address = {wallet_ph} LIMIT 1"
    );
    let row = sql::fetch_one(&statement, &binds.refs())
        .await
        .map_err(|err| {
            tracing::error!("[bets/[id]] query failed {err}");
            ApiError::internal("Failed to fetch bets")
        })?;

    // Not found OR not yours — identical response, nothing leaked.
    let Some(row) = row else {
        return Err(ApiError::json(StatusCode::NOT_FOUND, "Bet not found"));
    };

    // Ledger references. Any failure degrades to `available: false` and an empty
    // audit list rather than failing the whole proof.
    let (available, audit) = read_audit(&row, address).await;
    let mut proof = build_proof(&row, audit, available);
    if let Some(round) = read_round(bet_id).await {
        proof["bet"]["server_settlement"] = round;
    }
    Ok(proof)
}

/// The permanent record, for rounds the server settled. A failed read leaves the
/// proof as it was, like the audit read above.
async fn read_round(bet_id: &str) -> Option<Value> {
    let id = Value::String(bet_id.to_string());
    sql::fetch_one(
        "SELECT outcome, strike_at, strike_source, end_time, end_price_at, end_source, \
                settled_by, settled_at \
         FROM bet_rounds WHERE bet_id = CAST($1 AS text)",
        &[("text", &id)],
    )
    .await
    .unwrap_or_else(|err| {
        tracing::error!("[bets/[id]] round lookup failed {err}");
        None
    })
}

/// Returns `(available, rows)`; `available` is false only when the read failed.
async fn read_audit(row: &Value, address: &str) -> (bool, Vec<Value>) {
    let bet_ref = value_to_string(row.get("id").unwrap_or(&Value::Null));
    let mut binds = Binds::new();
    let bet_id_ph = binds.push(
        column_type("balance_audit_log", "bet_id")
            .await
            .unwrap_or_else(|_| "text".to_string()),
        Value::String(bet_ref),
    );
    let user_ph = binds.push(
        column_type("balance_audit_log", "user_address")
            .await
            .unwrap_or_else(|_| "text".to_string()),
        Value::String(address.to_string()),
    );
    let limit_ph = binds.push_static("bigint", Value::String("25".to_string()));
    let statement = format!(
        "SELECT {AUDIT_FIELDS} FROM balance_audit_log \
         WHERE bet_id = {bet_id_ph} AND user_address = {user_ph} \
         ORDER BY created_at ASC LIMIT {limit_ph}"
    );
    match sql::fetch(&statement, &binds.refs()).await {
        Ok(rows) => (true, rows),
        Err(err) => {
            tracing::error!("[bets/[id]] ledger lookup failed {err}");
            (false, Vec::new())
        }
    }
}

fn build_proof(bet: &Value, audit: Vec<Value>, available: bool) -> Value {
    let bet_lock: Option<&Value> = audit
        .iter()
        .find(|a| a.get("operation_type").and_then(Value::as_str) == Some("bet_lock"));

    // `iso(betLock?.end_time ?? null)`
    let ledger_end_time = bet_lock
        .and_then(|bl| bl.get("end_time"))
        .filter(|v| !v.is_null())
        .and_then(|v| proof_iso(Some(v)));
    let tx_hashes = collect_tx_hashes(&audit);
    let operations: Vec<Value> = audit
        .iter()
        .map(|a| Value::String(string_or_empty(a.get("operation_type"))))
        .filter(|v| is_truthy(Some(v)))
        .collect();

    let stake = proof_num(bet.get("amount"));
    let payout = proof_num(bet.get("payout"));
    let multiplier = proof_num(bet.get("multiplier"));
    let won = matches!(bet.get("won"), Some(Value::Bool(true)));
    let tie_refund = won
        && stake.is_some_and(|s| s > 0.0)
        && payout.is_some()
        && payout == stake
        && multiplier.map(|m| m > 1.0).unwrap_or(true);
    let outcome = if tie_refund {
        "draw"
    } else if won {
        "win"
    } else {
        "loss"
    };

    let resolved_at = bet.get("resolved_at").and_then(|v| proof_iso(Some(v)));
    let taken_at = ledger_end_time.clone().or_else(|| resolved_at.clone());
    let taken_at_source: Value = if ledger_end_time.is_some() {
        Value::String("ledger_end_time".into())
    } else if resolved_at.is_some() {
        Value::String("resolved_at".into())
    } else {
        Value::Null
    };

    let mut ledger = Map::new();
    ledger.insert("available".into(), Value::Bool(available));
    ledger.insert("touched".into(), Value::Bool(!audit.is_empty()));
    ledger.insert(
        "bet_request_id".into(),
        coalesce_idempotency(bet_lock, &audit, "idempotency_key"),
    );
    ledger.insert("end_time".into(), opt_string(ledger_end_time));
    ledger.insert("operations".into(), Value::Array(operations));
    ledger.insert(
        "settlement_token_issued".into(),
        Value::Bool(audit.iter().any(|a| is_truthy(a.get("settlement_token")))),
    );
    ledger.insert("tx_hashes".into(), Value::Array(tx_hashes));
    ledger.insert(
        "currency".into(),
        coalesce_idempotency(bet_lock, &audit, "currency"),
    );
    let ledger_amount = bet_lock
        .and_then(|bl| bl.get("amount"))
        .and_then(|v| proof_num(Some(v)));
    ledger.insert("ledger_amount".into(), opt_num(ledger_amount));

    let mut settlement = Map::new();
    settlement.insert("price".into(), opt_num(proof_num(bet.get("end_price"))));
    settlement.insert("taken_at".into(), opt_string(taken_at));
    settlement.insert("taken_at_source".into(), taken_at_source);
    settlement.insert(
        "asset".into(),
        bet.get("asset").cloned().unwrap_or(Value::Null),
    );

    let mut out = Map::new();
    out.insert("id".into(), bet.get("id").cloned().unwrap_or(Value::Null));
    out.insert(
        "asset".into(),
        bet.get("asset").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "mode".into(),
        bet.get("mode").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "direction".into(),
        bet.get("direction").cloned().unwrap_or(Value::Null),
    );
    out.insert("stake".into(), opt_num(stake));
    out.insert("multiplier".into(), opt_num(multiplier));
    out.insert("payout".into(), opt_num(payout));
    out.insert("won".into(), Value::Bool(won));
    out.insert("tie_refund".into(), Value::Bool(tie_refund));
    out.insert("outcome".into(), Value::String(outcome.to_string()));
    out.insert(
        "strike_price".into(),
        opt_num(proof_num(bet.get("strike_price"))),
    );
    out.insert(
        "recorded_end_price".into(),
        opt_num(proof_num(bet.get("end_price"))),
    );
    out.insert("settlement".into(), Value::Object(settlement));
    out.insert(
        "network".into(),
        bet.get("network").cloned().unwrap_or(Value::Null),
    );
    out.insert("resolved_at".into(), opt_string(resolved_at));
    out.insert(
        "created_at".into(),
        opt_string(bet.get("created_at").and_then(|v| proof_iso(Some(v)))),
    );
    out.insert("ledger".into(), Value::Object(ledger));

    Value::Object(Map::from_iter([("bet".to_string(), Value::Object(out))]))
}

/// `betLock?.KEY ?? audit.find(a => a.KEY)?.KEY ?? null` with `??` semantics:
/// a present-but-empty string from the bet-lock survives; the scan for a
/// fallback uses truthiness (so empty strings are skipped there).
fn coalesce_idempotency(bet_lock: Option<&Value>, audit: &[Value], key: &str) -> Value {
    if let Some(v) = bet_lock.and_then(|bl| bl.get(key)) {
        if !v.is_null() {
            return v.clone();
        }
    }
    if let Some(found) = audit.iter().find(|a| is_truthy(a.get(key))) {
        return found.get(key).cloned().unwrap_or(Value::Null);
    }
    Value::Null
}

/// `Array.from(new Set(...))` over split/scrubbed transaction hashes.
fn collect_tx_hashes(audit: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for a in audit {
        let raw = a
            .get("transaction_hash")
            .filter(|v| is_truthy(Some(v)))
            .map(value_to_string)
            .unwrap_or_default();
        for part in raw.split([',', '|']) {
            let scrubbed = part
                .strip_prefix("netTx:")
                .unwrap_or(part)
                .trim()
                .to_string();
            if is_chain_hash_strict(&scrubbed)
                && !out.iter().any(|v| v.as_str() == Some(scrubbed.as_str()))
            {
                out.push(Value::String(scrubbed));
            }
        }
    }
    out
}

fn opt_num(value: Option<f64>) -> Value {
    value.map(js_num).unwrap_or(Value::Null)
}

fn opt_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => value_to_string(v),
    }
}

/// `BET_ID = /^[A-Za-z0-9_.:-]{1,120}$/`.
/// Never a quote, so an id is safe inside an Arkiv `str('…')`.
pub(crate) fn bet_id_ok(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    (1..=120).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn error_json(status: u16, message: &str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = Value::Object(Map::from_iter([(
        "error".to_string(),
        Value::String(message.to_string()),
    )]));
    (code, axum::Json(body)).into_response()
}
