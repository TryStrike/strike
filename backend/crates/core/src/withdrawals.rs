//! The two atomic steps of a withdrawal.
//!
//! Queueing: the replay check, the cap and the insert are one write job on the
//! single writer, so parallel requests see each other's pending rows. A signed
//! intent is one row, enforced by `idx_wr_signed_intent` on
//! (user, currency, signed_at). The key is not the signature: the same intent
//! has several valid spellings (v 0/1 or 27/28, hex case, another nonce), and
//! amounts differing below 1e-8 sign the same message.
//!
//! Accepting: [`claim_and_debit`] commits the claim and the ledger debit together
//! BEFORE any transfer, and fails closed. The route then sends the transfer with
//! no database lock held, and calls [`finalize`] or parks the row. There is no
//! way back to `pending`:
//!   * `accepted`, `tx_hash` NULL: debited, transfer in flight or its outcome
//!     unknown (a crash leaves it here). Nothing retries it.
//!   * `accepted`, `tx_hash` set: paid.
//!   * `paid_needs_reconciliation`: debited, transfer failed or unknown. The debit
//!     stands; an operator decides. Nothing re-credits it.
//!
//! Past `WITHDRAWAL_STUCK_SECS` the first state means something died: [`stuck`]
//! lists those rows, [`watch_stuck`] logs them, and an admin read counts them.
//! None of that changes a row.
//!
//! The debit's audit row carries the placeholder hash `withdrawal:<id>` until
//! [`finalize`] writes the real one, and its unique index makes a second debit of
//! one request impossible.

use rusqlite::types::Value as Param;
use rusqlite::{params, params_from_iter, Connection};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde_json::{json, Value};

use crate::config::config;
use crate::db::{db, now_us, query_rows, typed_param, Db};
use crate::error::ApiResult;
use crate::ledger::{self, Rejection};
use crate::money::parse_decimal;
use crate::rpc;

pub struct QueueRequest {
    /// Canonical address the row is stored under.
    pub user_key: String,
    /// Every legacy spelling of the wallet, for the totals.
    pub variants: Vec<String>,
    /// The spelling of the funded balance row, whose tier sets the fee.
    pub ledger_address: String,
    pub currency: String,
    pub amount: Value,
    pub amount_num: f64,
    pub signature: Value,
    pub signed_at: Value,
    pub frequency_exempt: bool,
}

#[derive(Debug)]
pub enum Queued {
    /// The intent already has a row; nothing was written.
    Replay(Value),
    Created {
        id: Value,
        fee_amount: f64,
        net_amount: f64,
        frequency_review: bool,
        withdrawal_count: i64,
    },
}

fn text_params(first: &[&str], variants: &[String]) -> Vec<Param> {
    first
        .iter()
        .map(|s| Param::Text(s.to_string()))
        .chain(variants.iter().map(|v| Param::Text(v.clone())))
        .collect()
}

/// `?from, ?from+1, ...`; an empty list renders NULL, which matches nothing.
fn placeholders(from: usize, count: usize) -> String {
    if count == 0 {
        return "NULL".to_string();
    }
    (from..from + count)
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn count_of(conn: &Connection, sql: &str, params: Vec<Param>) -> ApiResult<i64> {
    Ok(conn
        .prepare_cached(sql)?
        .query_row(params_from_iter(params), |r| r.get(0))?)
}

fn truthy_or_null(value: &Value) -> Value {
    if crate::bets::is_truthy(Some(value)) {
        value.clone()
    } else {
        Value::Null
    }
}

fn existing_intent(conn: &Connection, request: &QueueRequest) -> ApiResult<Option<Value>> {
    let signed_at = typed_param("bigint", &truthy_or_null(&request.signed_at))?;
    if matches!(signed_at, Param::Null) {
        return Ok(None);
    }
    let rows = query_rows(
        conn,
        "SELECT id, status, amount, fee_amount, net_amount FROM withdrawal_requests \
         WHERE user_address = ?1 AND currency = ?2 AND signed_at = ?3 LIMIT 1",
        vec![
            Param::Text(request.user_key.clone()),
            Param::Text(request.currency.clone()),
            signed_at,
        ],
    )?;
    Ok(rows.into_iter().next())
}

fn queue_in_transaction(
    conn: &Connection,
    request: &QueueRequest,
) -> ApiResult<Result<Queued, Rejection>> {
    if let Some(existing) = existing_intent(conn, request)? {
        return Ok(Ok(Queued::Replay(existing)));
    }

    let n = request.variants.len();
    let audit_amounts = |operation: &str| {
        query_rows(
            conn,
            &format!(
                "SELECT amount FROM balance_audit_log \
                 WHERE operation_type = ?1 AND currency = ?2 AND user_address IN ({})",
                placeholders(3, n)
            ),
            text_params(&[operation, &request.currency], &request.variants),
        )
    };
    let deposits = audit_amounts("deposit")?;
    // A debit lands here the moment a request is accepted, so accepted rows need
    // no separate count below.
    let withdrawn = audit_amounts("withdrawal")?;
    let pending = query_rows(
        conn,
        &format!(
            "SELECT amount FROM withdrawal_requests \
             WHERE currency = ?1 AND status = 'pending' AND user_address IN ({})",
            placeholders(2, n)
        ),
        text_params(&[&request.currency], &request.variants),
    )?;
    if let Err(rejection) = ledger::withdraw_cap_check(
        &request.amount,
        &deposits,
        &withdrawn,
        &pending,
        &request.currency,
    ) {
        return Ok(Err(rejection));
    }

    // Abuse detection is global: every currency, completed plus pending.
    let withdrawal_count = count_of(
        conn,
        &format!(
            "SELECT count(*) FROM balance_audit_log \
             WHERE operation_type = 'withdrawal' AND user_address IN ({})",
            placeholders(1, n)
        ),
        text_params(&[], &request.variants),
    )? + count_of(
        conn,
        &format!(
            "SELECT count(*) FROM withdrawal_requests \
             WHERE status = 'pending' AND user_address IN ({})",
            placeholders(1, n)
        ),
        text_params(&[], &request.variants),
    )?;
    let frequency_review =
        ledger::frequency_review_triggered(request.frequency_exempt, withdrawal_count);

    let tier_rows = query_rows(
        conn,
        "SELECT user_tier FROM user_balances WHERE user_address = ?1 LIMIT 1",
        vec![Param::Text(request.ledger_address.clone())],
    )?;
    let tier = ledger::resolve_tier(tier_rows.first().and_then(|r| r.get("user_tier")));
    let split = ledger::withdraw_net(request.amount_num, tier);
    let Some((fee_amount, net_amount)) = split.filter(|(_, net)| *net > Decimal::ZERO) else {
        return Ok(Err(ledger::withdraw_net_rejection(
            ledger::fee_percent_label(tier),
        )));
    };

    let decided_by = if frequency_review {
        Value::String(ledger::frequency_review_stamp(withdrawal_count))
    } else {
        Value::Null
    };
    let rows = query_rows(
        conn,
        "INSERT INTO withdrawal_requests \
         (user_address, currency, amount, fee_amount, net_amount, signature, signed_at, \
          status, decided_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8) RETURNING id",
        vec![
            Param::Text(request.user_key.clone()),
            Param::Text(request.currency.clone()),
            typed_param("numeric(30,10)", &request.amount)?,
            typed_param("numeric(30,10)", &Value::String(fee_amount.to_string()))?,
            typed_param("numeric(30,10)", &Value::String(net_amount.to_string()))?,
            typed_param("text", &truthy_or_null(&request.signature))?,
            typed_param("bigint", &truthy_or_null(&request.signed_at))?,
            typed_param("text", &decided_by)?,
        ],
    )?;
    Ok(Ok(Queued::Created {
        id: rows
            .first()
            .and_then(|r| r.get("id"))
            .cloned()
            .unwrap_or(Value::Null),
        fee_amount: fee_amount.to_f64().unwrap_or(f64::NAN),
        net_amount: net_amount.to_f64().unwrap_or(f64::NAN),
        frequency_review,
        withdrawal_count,
    }))
}

/// Replay check, cap and insert as one transaction.
pub async fn queue(db: &Db, request: QueueRequest) -> Result<Queued, Rejection> {
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let outcome = queue_in_transaction(&tx, &request)?;
        tx.commit()?;
        Ok(outcome)
    })
    .await
    .unwrap_or_else(|err| {
        // Fail closed: a totals read that errored must not let a request through.
        tracing::error!("[withdraw] failed to queue withdrawal request: {err}");
        Err(ledger::withdraw_insert_failed())
    })
}

#[derive(Debug, PartialEq)]
pub enum Claim {
    /// Committed: the row is `accepted` and the ledger is debited. Only this
    /// result may lead to a transfer.
    Debited { new_balance: Value },
    /// Another call took it; nothing changed.
    NotPending,
    /// The debit refused (insufficient, frozen, banned). Rolled back, so the row
    /// is still `pending`.
    Refused(String),
}

/// Claims `id` and debits the ledger in one committed transaction. Runs on the
/// writer and returns before any network call can start.
pub async fn claim_and_debit(
    db: &Db,
    id: i64,
    ledger_address: Value,
    amount: String,
    currency: String,
) -> ApiResult<Claim> {
    let amount = parse_decimal(&amount)?;
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let claimed = tx
            .prepare_cached(
                "UPDATE withdrawal_requests \
                 SET status = 'accepted', decided_at = ?1, decided_by = 'admin' \
                 WHERE id = ?2 AND status = 'pending'",
            )?
            .execute(params![now_us(), id])?;
        if claimed != 1 {
            return Ok(Claim::NotPending);
        }
        let debit = rpc::debit_for_withdrawal(
            &tx,
            ledger_address.as_str(),
            amount,
            &currency,
            &format!("withdrawal:{id}"),
        )?;
        if debit["success"] != json!(true) {
            let error = debit["error"]
                .as_str()
                .unwrap_or("Debit failed")
                .to_string();
            return Ok(Claim::Refused(error)); // `tx` drops: claim and debit undone.
        }
        tx.commit()?;
        Ok(Claim::Debited {
            new_balance: debit["new_balance"].clone(),
        })
    })
    .await
}

/// Records a sent payout. `Ok(false)`: the row was no longer `accepted`.
pub async fn finalize(
    db: &Db,
    id: i64,
    tx_hash: String,
    fee_tx_hash: Option<String>,
) -> ApiResult<bool> {
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let updated = tx
            .prepare_cached(
                "UPDATE withdrawal_requests \
                 SET decided_at = ?1, decided_by = 'admin', tx_hash = ?2, fee_tx_hash = ?3 \
                 WHERE id = ?4 AND status = 'accepted' AND tx_hash IS NULL",
            )?
            .execute(params![now_us(), tx_hash, fee_tx_hash, id])?;
        if updated != 1 {
            return Ok(false);
        }
        tx.prepare_cached(
            "UPDATE balance_audit_log SET transaction_hash = ?1 \
             WHERE transaction_hash = ?2 AND operation_type = 'withdrawal'",
        )?
        .execute(params![tx_hash, format!("withdrawal:{id}")])?;
        tx.commit()?;
        Ok(true)
    })
    .await
}

/// Parks a claimed row. The debit stands, nothing is re-credited, and a parked
/// row can never be accepted again. `Ok(false)`: the row was not `accepted`.
pub async fn park(db: &Db, id: i64, note: String) -> ApiResult<bool> {
    db.write(move |conn| {
        let parked = conn
            .prepare_cached(
                "UPDATE withdrawal_requests \
                 SET status = 'paid_needs_reconciliation', notes = ?1, decided_at = ?2 \
                 WHERE id = ?3 AND status = 'accepted'",
            )?
            .execute(params![note, now_us(), id])?;
        Ok(parked == 1)
    })
    .await
}

/// Ids of rows debited before `decided_before_us` that never got a hash and were
/// never parked. Read-only: their transfers may have gone out.
pub async fn stuck(db: &Db, decided_before_us: i64) -> ApiResult<Vec<i64>> {
    db.read(move |conn| {
        let mut statement = conn.prepare_cached(
            "SELECT id FROM withdrawal_requests \
             WHERE status = 'accepted' AND tx_hash IS NULL AND decided_at < ?1 ORDER BY id",
        )?;
        let ids = statement
            .query_map(params![decided_before_us], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(ids)
    })
    .await
}

/// The cutoff for a stuck row, right now.
pub fn stuck_cutoff_us() -> i64 {
    now_us() - config().withdrawal_stuck_secs * 1_000_000
}

/// Logs stuck rows once a minute for the life of the process.
pub async fn watch_stuck() {
    let mut every = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        every.tick().await;
        let found = match db().await {
            Ok(database) => stuck(database, stuck_cutoff_us()).await,
            Err(err) => Err(err),
        };
        match found {
            Ok(ids) if ids.is_empty() => {}
            Ok(ids) => tracing::error!(
                "[withdrawal] {} accepted with no tx hash past the {} s timeout, \
                 debited and unresolved, needs an operator: ids {ids:?}",
                ids.len(),
                config().withdrawal_stuck_secs
            ),
            Err(err) => tracing::error!("[withdrawal] stuck-row check failed: {err}"),
        }
    }
}
