use rusqlite::types::Value as Param;
use rusqlite::{params, params_from_iter, Connection};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde_json::{json, Value};

use crate::config::{config, USDC_DECIMALS};
use crate::db::{db, now_us, query_rows, typed_param, Db};
use crate::error::ApiResult;
use crate::ledger::{self, Rejection};
use crate::money::parse_decimal;
use crate::rpc;
use crate::world;

#[derive(Clone)]
pub struct QueueRequest {
    pub user_key: String,
    pub variants: Vec<String>,
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

pub const MAX_PER_REQUEST_USDC: i128 = 50;
pub const MAX_PER_DAY_USDC: i128 = 200;
const DAY_US: i64 = 86_400_000_000;

fn auto_pay_caps(amount: &Value, today: &[Value]) -> Result<(), Rejection> {
    let unit = 10i128.pow(USDC_DECIMALS);
    let null = Value::Null;
    let (Some(amount), Some(spent)) = (
        ledger::amount_to_base_units(amount, USDC_DECIMALS),
        ledger::sum_amounts_to_base_units(
            today.iter().map(|r| r.get("amount").unwrap_or(&null)),
            USDC_DECIMALS,
        ),
    ) else {
        return Err((
            503,
            ledger::error_body("Service temporarily unavailable. Please try again."),
        ));
    };
    if amount > MAX_PER_REQUEST_USDC * unit {
        return Err((
            400,
            ledger::coded_body(
                "withdraw_cap",
                &format!("Withdrawals are capped at {MAX_PER_REQUEST_USDC} USDC per request."),
            ),
        ));
    }
    if spent + amount > MAX_PER_DAY_USDC * unit {
        let left = (MAX_PER_DAY_USDC * unit - spent).max(0) as f64 / unit as f64;
        return Err((
            429,
            ledger::coded_body(
                "daily_cap",
                &format!(
                    "Withdrawals are capped at {MAX_PER_DAY_USDC} USDC per human per day. You can withdraw {left} more in the next 24 hours."
                ),
            ),
        ));
    }
    Ok(())
}

fn queue_in_transaction(
    conn: &Connection,
    request: &QueueRequest,
) -> ApiResult<Result<Queued, Rejection>> {
    if let Some(existing) = existing_intent(conn, request)? {
        return Ok(Ok(Queued::Replay(existing)));
    }
    if let Err(code) = world::gate_ready() {
        let mut body = ledger::coded_body(code, world::NOT_CONFIGURED);
        body["retryable"] = json!(true);
        return Ok(Err((503, body)));
    }
    let Some(human) = world::human_of_wallet(conn, &request.user_key)? else {
        return Ok(Err((
            403,
            ledger::coded_body("human_required", "Verify with World ID before withdrawing"),
        )));
    };
    let mut human_wallets = world::wallets_of_human(conn, &human.id)?;
    if world::any_banned(conn, &human_wallets)? {
        return Ok(Err((
            403,
            ledger::coded_body("banned", world::BANNED_HUMAN),
        )));
    }
    for variant in &request.variants {
        if !human_wallets.contains(variant) {
            human_wallets.push(variant.clone());
        }
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

    let since = now_us() - DAY_US;
    let today_sql = |columns: &str| {
        format!(
            "SELECT {columns} FROM withdrawal_requests \
             WHERE currency = ?1 AND status != 'rejected' AND requested_at > ?2 AND user_address IN ({})",
            placeholders(3, human_wallets.len())
        )
    };
    let today_params = || {
        let mut params = vec![Param::Text(request.currency.clone()), Param::Integer(since)];
        params.extend(human_wallets.iter().map(|v| Param::Text(v.clone())));
        params
    };
    let today = query_rows(conn, &today_sql("amount"), today_params())?;
    if let Err((status, mut body)) = auto_pay_caps(&request.amount, &today) {
        if status == 429 {
            let oldest = count_of(
                conn,
                &today_sql(&format!("coalesce(min(requested_at), {since})")),
                today_params(),
            )?;
            body["retryAfter"] = json!(((oldest - since) / 1_000_000).max(1));
        }
        return Ok(Err((status, body)));
    }

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

pub async fn queue(db: &Db, request: QueueRequest) -> Result<Queued, Rejection> {
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let outcome = queue_in_transaction(&tx, &request)?;
        tx.commit()?;
        Ok(outcome)
    })
    .await
    .unwrap_or_else(|err| {
        tracing::error!("[withdraw] failed to queue withdrawal request: {err}");
        Err(ledger::withdraw_insert_failed())
    })
}

pub async fn dry_run(db: &Db, request: QueueRequest) -> Result<(), Rejection> {
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let outcome = queue_in_transaction(&tx, &request)?;
        drop(tx);
        Ok(outcome.map(|_| ()))
    })
    .await
    .unwrap_or_else(|err| {
        tracing::error!("[withdraw] failed to check withdrawal limits: {err}");
        Err(ledger::withdraw_insert_failed())
    })
}

#[derive(Debug, PartialEq)]
pub enum Claim {
    Debited { new_balance: Value },
    NotPending,
    Refused(String),
}

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
            return Ok(Claim::Refused(error));
        }
        tx.commit()?;
        Ok(Claim::Debited {
            new_balance: debit["new_balance"].clone(),
        })
    })
    .await
}

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

/// Parks an accepted row for an operator. `tx_hash` is the broadcast hash when
/// there is one, so the transfer can be found on chain.
pub async fn park(db: &Db, id: i64, note: String, tx_hash: Option<String>) -> ApiResult<bool> {
    db.write(move |conn| {
        let parked = conn
            .prepare_cached(
                "UPDATE withdrawal_requests \
                 SET status = 'paid_needs_reconciliation', notes = ?1, decided_at = ?2, \
                     tx_hash = coalesce(?3, tx_hash) \
                 WHERE id = ?4 AND status = 'accepted'",
            )?
            .execute(params![note, now_us(), tx_hash, id])?;
        Ok(parked == 1)
    })
    .await
}

/// Undoes a claim whose transfer the node refused outright, so nothing went out:
/// the row is rejected and the debit credited back in one commit. `false` when
/// the row was not an unpaid accepted one or the credit was refused (a ban), and
/// then nothing changed.
pub async fn refund(
    db: &Db,
    id: i64,
    ledger_address: Value,
    amount: String,
    currency: String,
) -> ApiResult<bool> {
    let amount = parse_decimal(&amount)?;
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let rejected = tx
            .prepare_cached(
                "UPDATE withdrawal_requests \
                 SET status = 'rejected', decided_at = ?1, decided_by = 'auto', \
                     notes = 'refunded: transfer refused by the node' \
                 WHERE id = ?2 AND status = 'accepted' AND tx_hash IS NULL",
            )?
            .execute(params![now_us(), id])?;
        if rejected != 1 {
            return Ok(false);
        }
        let credit =
            rpc::credit_for_withdrawal_refund(&tx, ledger_address.as_str(), amount, &currency)?;
        if credit["success"] != json!(true) {
            return Ok(false);
        }
        tx.commit()?;
        Ok(true)
    })
    .await
}

/// Rejects requests still `pending` past the cutoff with nothing paid, so one
/// left behind by a crash stops counting against the caps. Returns their ids.
pub async fn expire_pending(db: &Db, requested_before_us: i64) -> ApiResult<Vec<i64>> {
    db.write(move |conn| {
        let mut statement = conn.prepare_cached(
            "UPDATE withdrawal_requests \
             SET status = 'rejected', decided_at = ?1, decided_by = 'auto', \
                 notes = 'expired while pending' \
             WHERE status = 'pending' AND tx_hash IS NULL AND requested_at < ?2 RETURNING id",
        )?;
        let ids = statement
            .query_map(params![now_us(), requested_before_us], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(ids)
    })
    .await
}

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

pub fn stuck_cutoff_us() -> i64 {
    now_us() - config().withdrawal_stuck_secs * 1_000_000
}

pub async fn watch_stuck() {
    let mut every = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        every.tick().await;
        let found = match db().await {
            Ok(database) => {
                match expire_pending(database, stuck_cutoff_us()).await {
                    Ok(ids) if ids.is_empty() => {}
                    Ok(ids) => tracing::warn!(
                        "[withdrawal] rejected {} requests left pending past the timeout: ids {ids:?}",
                        ids.len()
                    ),
                    Err(err) => tracing::error!("[withdrawal] pending sweep failed: {err}"),
                }
                stuck(database, stuck_cutoff_us()).await
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_pay_caps_per_request_and_per_day() {
        let spent = |amounts: &[&str]| -> Vec<Value> {
            amounts.iter().map(|a| json!({ "amount": a })).collect()
        };
        assert!(
            auto_pay_caps(&json!(50), &[]).is_ok(),
            "the cap itself is allowed"
        );
        assert_eq!(auto_pay_caps(&json!(50.000001), &[]).unwrap_err().0, 400);
        assert!(
            auto_pay_caps(&json!(40), &spent(&["50", "50", "60"])).is_ok(),
            "200 exactly"
        );
        let over = auto_pay_caps(&json!(1), &spent(&["50", "50", "50", "50"])).unwrap_err();
        assert_eq!(over.0, 429);
        assert!(
            over.1["error"]
                .as_str()
                .unwrap()
                .contains("withdraw 0 more"),
            "{}",
            over.1
        );
        assert_eq!(
            auto_pay_caps(&json!("abc"), &[]).unwrap_err().0,
            503,
            "unparseable fails closed"
        );
    }
}
