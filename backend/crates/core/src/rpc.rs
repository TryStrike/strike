use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use rust_decimal::Decimal;
use serde_json::{json, Value};

use crate::config::config;
use crate::db::{is_unique_violation, json_bind_text, now_us, parse_timestamp_us};
use crate::error::{ApiError, ApiResult};
use crate::money::{
    self, decimal_json, fixed_json, from_fixed, parse_decimal, to_fixed, MONEY_SCALE,
};
use crate::settlement::{decide, EndTick, Outcome, Terms, MULTIPLIER_SCALE, PRICE_SCALE};
use crate::world;

const FUNCTIONS: &[(&str, &[&str])] = &[
    (
        "place_bet_locked",
        &[
            "p_user_address",
            "p_bet_amount",
            "p_currency",
            "p_idempotency_key",
            "p_bet_id",
            "p_max_payout",
            "p_end_time",
            "p_settlement_token",
            "p_round",
        ],
    ),
    (
        "settle_round",
        &[
            "p_bet_id",
            "p_end_price",
            "p_end_at",
            "p_source",
            "p_settled_by",
        ],
    ),
    (
        "update_balance_for_deposit",
        &[
            "p_user_address",
            "p_deposit_amount",
            "p_currency",
            "p_transaction_hash",
        ],
    ),
    (
        "deduct_balance_for_bet",
        &["p_user_address", "p_bet_amount", "p_currency"],
    ),
    (
        "credit_balance_for_payout",
        &[
            "p_user_address",
            "p_payout_amount",
            "p_currency",
            "p_bet_id",
        ],
    ),
    (
        "update_balance_for_withdrawal",
        &[
            "p_user_address",
            "p_withdrawal_amount",
            "p_currency",
            "p_transaction_hash",
        ],
    ),
    ("normalize_ban_address", &["p"]),
    ("is_wallet_globally_banned", &["p_address"]),
];

pub struct Args(HashMap<String, Value>);

impl Args {
    pub fn new(function: &str, params: &[(&str, &Value)]) -> ApiResult<Self> {
        let known = FUNCTIONS
            .iter()
            .find(|(name, _)| *name == function)
            .map(|(_, params)| *params)
            .ok_or_else(|| ApiError::internal(format!("Unknown function: {function}")))?;
        let mut map = HashMap::with_capacity(params.len());
        for (name, value) in params {
            if !known.contains(name) {
                return Err(ApiError::internal(format!(
                    "Function {function} has no parameter {name} in the public schema"
                )));
            }
            map.insert(name.to_string(), (*value).clone());
        }
        Ok(Self(map))
    }

    fn text(&self, name: &str) -> Option<String> {
        self.0.get(name).and_then(json_bind_text)
    }

    fn text_or(&self, name: &str, default: &str) -> Option<String> {
        match self.0.get(name) {
            None => Some(default.to_string()),
            Some(value) => json_bind_text(value),
        }
    }

    fn decimal(&self, name: &str) -> ApiResult<Option<Decimal>> {
        self.text(name).map(|t| parse_decimal(&t)).transpose()
    }

    fn terms(&self) -> ApiResult<Option<Terms>> {
        self.0
            .get("p_round")
            .map(|round| {
                serde_json::from_value(round.clone())
                    .map_err(|err| ApiError::internal(format!("invalid round terms: {err}")))
            })
            .transpose()
    }

    fn end_tick(&self) -> Option<EndTick> {
        Some(EndTick {
            price: self.0.get("p_end_price")?.as_i64()?,
            at_us: self.0.get("p_end_at")?.as_i64()?,
            source: self.text("p_source")?,
        })
    }

    fn timestamp(&self, name: &str) -> ApiResult<Option<i64>> {
        self.text(name)
            .map(|t| {
                parse_timestamp_us(&t).ok_or_else(|| {
                    ApiError::Other(format!(
                        "invalid input syntax for type timestamp with time zone: \"{t}\""
                    ))
                })
            })
            .transpose()
    }
}

pub fn dispatch(conn: &mut Connection, function: &str, args: &Args) -> ApiResult<Value> {
    match function {
        "place_bet_locked" => {
            let amount = args.decimal("p_bet_amount")?;
            let max_payout = match args.0.contains_key("p_max_payout") {
                true => args.decimal("p_max_payout")?,
                false => Some(Decimal::ZERO),
            };
            let end_time = args.timestamp("p_end_time")?;
            let terms = args.terms()?;
            in_transaction(conn, |c| {
                place_bet_locked(
                    c,
                    args.text("p_user_address").as_deref(),
                    amount,
                    args.text("p_currency").as_deref(),
                    args.text("p_idempotency_key").as_deref(),
                    args.text("p_bet_id").as_deref(),
                    max_payout,
                    end_time,
                    args.text("p_settlement_token").as_deref(),
                    terms.as_ref(),
                )
            })
        }
        "settle_round" => {
            let end = args.end_tick();
            in_transaction(conn, |c| {
                settle_round(
                    c,
                    args.text("p_bet_id").as_deref(),
                    end.as_ref(),
                    args.text("p_settled_by").as_deref(),
                )
            })
        }
        "update_balance_for_deposit" => {
            let amount = args.decimal("p_deposit_amount")?;
            in_transaction(conn, |c| {
                update_balance_for_deposit(
                    c,
                    args.text("p_user_address").as_deref(),
                    amount,
                    args.text_or("p_currency", "BOT").as_deref(),
                    args.text("p_transaction_hash").as_deref(),
                )
                .map(|o| o.json)
            })
        }
        "deduct_balance_for_bet" => {
            let amount = args.decimal("p_bet_amount")?;
            in_transaction(conn, |c| {
                deduct_balance_for_bet(
                    c,
                    args.text("p_user_address").as_deref(),
                    amount,
                    args.text_or("p_currency", "BOT").as_deref(),
                )
                .map(|o| o.json)
            })
        }
        "credit_balance_for_payout" => {
            let amount = args.decimal("p_payout_amount")?;
            in_transaction(conn, |c| {
                credit_balance_for_payout(
                    c,
                    args.text("p_user_address").as_deref(),
                    amount,
                    args.text_or("p_currency", "BOT").as_deref(),
                    args.text("p_bet_id").as_deref(),
                )
                .map(|o| o.json)
            })
        }
        "update_balance_for_withdrawal" => {
            let amount = args.decimal("p_withdrawal_amount")?;
            in_transaction(conn, |c| {
                update_balance_for_withdrawal(
                    c,
                    args.text("p_user_address").as_deref(),
                    amount,
                    args.text_or("p_currency", "BOT").as_deref(),
                    args.text("p_transaction_hash").as_deref(),
                )
                .map(|o| o.json)
            })
        }
        "normalize_ban_address" => Ok(args
            .text("p")
            .map(|p| Value::String(normalize_ban_address(&p)))
            .unwrap_or(Value::Null)),
        "is_wallet_globally_banned" => in_transaction(conn, |c| {
            is_wallet_globally_banned(c, args.text("p_address").as_deref()).map(Value::Bool)
        }),
        other => Err(ApiError::internal(format!("Unknown function: {other}"))),
    }
}

fn in_transaction<T>(
    conn: &mut Connection,
    body: impl FnOnce(&Connection) -> ApiResult<T>,
) -> ApiResult<T> {
    let tx = conn.savepoint()?;
    let out = body(&tx)?;
    tx.commit()?;
    Ok(out)
}

struct Balance {
    json: Value,
    success: bool,
    new_balance: Option<Decimal>,
}

fn refused(error: &str, new_balance: Value) -> Balance {
    Balance {
        json: json!({"success": false, "error": error, "new_balance": new_balance}),
        success: false,
        new_balance: None,
    }
}

fn credited(new_balance: Decimal) -> Balance {
    Balance {
        json: json!({"success": true, "error": null, "new_balance": decimal_json(new_balance)}),
        success: true,
        new_balance: Some(new_balance),
    }
}

fn guarded(
    conn: &Connection,
    body: impl FnOnce(&Connection) -> ApiResult<Balance>,
) -> ApiResult<Balance> {
    conn.execute_batch("SAVEPOINT balance_fn")?;
    match body(conn) {
        Ok(outcome) => {
            conn.execute_batch("RELEASE balance_fn")?;
            Ok(outcome)
        }
        Err(err) => {
            conn.execute_batch("ROLLBACK TO balance_fn; RELEASE balance_fn")?;
            let message = sqlerrm(&err);
            tracing::error!("ledger function refused: {message}");
            Ok(refused(&message, json!(0)))
        }
    }
}

fn sqlerrm(err: &ApiError) -> String {
    let ApiError::Db(rusqlite::Error::SqliteFailure(_, Some(message))) = err else {
        return err.to_string();
    };
    if let Some(columns) = message.strip_prefix("UNIQUE constraint failed: ") {
        let constraint = match columns {
            "balance_audit_log.transaction_hash" => "idx_balance_audit_tx_hash_unique",
            "balance_audit_log.idempotency_key" => "idx_balance_audit_idempotency",
            "balance_audit_log.bet_id, balance_audit_log.operation_type" => {
                "idx_balance_audit_settlement_lock"
            }
            "user_balances.user_address, user_balances.currency" => "user_balances_pkey",
            other => other,
        };
        return format!("duplicate key value violates unique constraint \"{constraint}\"");
    }
    if let Some(name) = message.strip_prefix("CHECK constraint failed: ") {
        let relation = name.split("_check").next().and_then(|n| n.rsplit_once('_'));
        let relation = relation.map(|(table, _)| table).unwrap_or(name);
        return format!("new row for relation \"{relation}\" violates check constraint \"{name}\"");
    }
    if let Some(column) = message.strip_prefix("NOT NULL constraint failed: ") {
        if let Some((table, column)) = column.split_once('.') {
            return format!(
                "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
            );
        }
    }
    message.clone()
}

pub fn normalize_ban_address(p: &str) -> String {
    let trimmed = p.trim_matches(' ');
    if trimmed.starts_with("0x") {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn is_wallet_globally_banned(conn: &Connection, address: Option<&str>) -> ApiResult<bool> {
    let Some(address) = address else {
        return Ok(false);
    };
    let found = conn
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM banned_wallets WHERE wallet_address = ?1)")?
        .query_row(params![normalize_ban_address(address)], |row| {
            row.get::<_, bool>(0)
        })?;
    Ok(found)
}

const BANNED: &str = "This wallet is banned from the platform.";

fn balance_of(
    conn: &Connection,
    user: Option<&str>,
    currency: Option<&str>,
) -> ApiResult<Option<i64>> {
    Ok(conn
        .prepare_cached(
            "SELECT balance FROM user_balances WHERE user_address = ?1 AND currency = ?2",
        )?
        .query_row(params![user, currency], |row| row.get(0))
        .optional()?)
}

fn balance_and_status(
    conn: &Connection,
    user: Option<&str>,
    currency: Option<&str>,
) -> ApiResult<Option<(i64, String)>> {
    Ok(conn
        .prepare_cached(
            "SELECT balance, status FROM user_balances WHERE user_address = ?1 AND currency = ?2",
        )?
        .query_row(params![user, currency], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?)
}

fn store(value: Option<Decimal>) -> ApiResult<Option<i64>> {
    value.map(|v| to_fixed(v, MONEY_SCALE)).transpose()
}

fn set_balance(
    conn: &Connection,
    user: Option<&str>,
    currency: Option<&str>,
    balance: Option<Decimal>,
) -> ApiResult<()> {
    conn.prepare_cached(
        "UPDATE user_balances SET balance = ?1, updated_at = ?2 \
         WHERE user_address = ?3 AND currency = ?4",
    )?
    .execute(params![store(balance)?, now_us(), user, currency])?;
    Ok(())
}

struct AuditRow<'a> {
    user: Option<&'a str>,
    currency: Option<&'a str>,
    operation: &'a str,
    amount: Option<Decimal>,
    before: Decimal,
    after: Option<Decimal>,
    transaction_hash: Option<&'a str>,
    bet_id: Option<&'a str>,
}

fn audit(conn: &Connection, row: AuditRow) -> ApiResult<()> {
    conn.prepare_cached(
        "INSERT INTO balance_audit_log \
         (user_address, currency, operation_type, amount, balance_before, balance_after, \
          transaction_hash, bet_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![
        row.user,
        row.currency,
        row.operation,
        store(row.amount)?,
        store(Some(row.before))?,
        store(row.after)?,
        row.transaction_hash,
        row.bet_id,
        now_us()
    ])?;
    Ok(())
}

fn not_positive(amount: Option<Decimal>) -> bool {
    amount.is_some_and(|a| a <= Decimal::ZERO)
}

fn update_balance_for_deposit(
    conn: &Connection,
    user: Option<&str>,
    amount: Option<Decimal>,
    currency: Option<&str>,
    transaction_hash: Option<&str>,
) -> ApiResult<Balance> {
    guarded(conn, |c| {
        if is_wallet_globally_banned(c, user)? {
            return Ok(refused(BANNED, json!(0)));
        }
        if not_positive(amount) {
            return Ok(refused(
                "Deposit amount must be greater than zero",
                json!(0),
            ));
        }

        c.prepare_cached(
            "INSERT INTO user_balances (user_address, currency, balance) VALUES (?1, ?2, 0) \
             ON CONFLICT (user_address, currency) DO NOTHING",
        )?
        .execute(params![user, currency])?;

        let old = from_fixed(balance_of(c, user, currency)?.unwrap_or(0), MONEY_SCALE);
        let new = amount.map(|a| money::add(old, a));
        set_balance(c, user, currency, new)?;
        audit(
            c,
            AuditRow {
                user,
                currency,
                operation: "deposit",
                amount,
                before: old,
                after: new,
                transaction_hash,
                bet_id: None,
            },
        )?;
        Ok(credited(new.unwrap_or(old)))
    })
}

fn deduct_balance_for_bet(
    conn: &Connection,
    user: Option<&str>,
    amount: Option<Decimal>,
    currency: Option<&str>,
) -> ApiResult<Balance> {
    guarded(conn, |c| {
        if is_wallet_globally_banned(c, user)? {
            return Ok(refused(BANNED, json!(0)));
        }
        if not_positive(amount) {
            return Ok(refused("Bet amount must be greater than zero", json!(0)));
        }
        let Some((balance, status)) = balance_and_status(c, user, currency)? else {
            return Ok(refused("User not found", json!(0)));
        };
        let old = from_fixed(balance, MONEY_SCALE);

        if status == "frozen" {
            return Ok(refused(
                "Account is frozen. Please contact support.",
                decimal_json(old),
            ));
        }
        if status == "banned" {
            return Ok(refused("Account is banned.", decimal_json(old)));
        }
        if amount.is_some_and(|a| old < a) {
            return Ok(refused("Insufficient balance", decimal_json(old)));
        }

        let new = amount.map(|a| money::sub(old, a));
        set_balance(c, user, currency, new)?;
        audit(
            c,
            AuditRow {
                user,
                currency,
                operation: "bet_placed",
                amount,
                before: old,
                after: new,
                transaction_hash: None,
                bet_id: None,
            },
        )?;
        Ok(credited(new.unwrap_or(old)))
    })
}

fn credit_balance_for_payout(
    conn: &Connection,
    user: Option<&str>,
    amount: Option<Decimal>,
    currency: Option<&str>,
    bet_id: Option<&str>,
) -> ApiResult<Balance> {
    credit_balance(conn, user, amount, currency, bet_id, "payout")
}

fn credit_balance(
    conn: &Connection,
    user: Option<&str>,
    amount: Option<Decimal>,
    currency: Option<&str>,
    bet_id: Option<&str>,
    operation: &str,
) -> ApiResult<Balance> {
    guarded(conn, |c| {
        if is_wallet_globally_banned(c, user)? {
            return Ok(refused(BANNED, json!(0)));
        }
        if not_positive(amount) {
            return Ok(refused("Payout amount must be greater than zero", json!(0)));
        }

        let (old, new) = match balance_of(c, user, currency)? {
            None => {
                c.prepare_cached(
                    "INSERT INTO user_balances (user_address, currency, balance) \
                     VALUES (?1, ?2, ?3)",
                )?
                .execute(params![user, currency, store(amount)?])?;
                (Decimal::ZERO, amount)
            }
            Some(balance) => {
                let old = from_fixed(balance, MONEY_SCALE);
                let new = amount.map(|a| money::add(old, a));
                set_balance(c, user, currency, new)?;
                (old, new)
            }
        };

        audit(
            c,
            AuditRow {
                user,
                currency,
                operation,
                amount,
                before: old,
                after: new,
                transaction_hash: None,
                bet_id,
            },
        )?;
        Ok(credited(new.unwrap_or(old)))
    })
}

fn update_balance_for_withdrawal(
    conn: &Connection,
    user: Option<&str>,
    amount: Option<Decimal>,
    currency: Option<&str>,
    transaction_hash: Option<&str>,
) -> ApiResult<Balance> {
    guarded(conn, |c| {
        if is_wallet_globally_banned(c, user)? {
            return Ok(refused(BANNED, json!(0)));
        }
        if not_positive(amount) {
            return Ok(refused(
                "Withdrawal amount must be greater than zero",
                json!(0),
            ));
        }
        let Some((balance, status)) = balance_and_status(c, user, currency)? else {
            return Ok(refused("User not found", json!(0)));
        };
        let old = from_fixed(balance, MONEY_SCALE);

        if status == "frozen" {
            return Ok(refused(
                "Account is frozen. Withdrawals are disabled.",
                decimal_json(old),
            ));
        }
        if status == "banned" {
            return Ok(refused("Account is banned.", decimal_json(old)));
        }
        if amount.is_some_and(|a| old < a) {
            return Ok(refused("Insufficient balance", decimal_json(old)));
        }

        let new = amount.map(|a| money::sub(old, a));
        set_balance(c, user, currency, new)?;
        audit(
            c,
            AuditRow {
                user,
                currency,
                operation: "withdrawal",
                amount,
                before: old,
                after: new,
                transaction_hash,
                bet_id: None,
            },
        )?;
        Ok(credited(new.unwrap_or(old)))
    })
}

/// Takes a Blitz pass fee off `user`'s balance, with a `blitz_fee` audit row.
pub(crate) fn debit_blitz_fee(
    conn: &Connection,
    user: &str,
    amount: Decimal,
    currency: &str,
    transaction_hash: &str,
) -> ApiResult<Value> {
    let (user, currency) = (Some(user), Some(currency));
    guarded(conn, |c| {
        if is_wallet_globally_banned(c, user)? {
            return Ok(refused(BANNED, json!(0)));
        }
        let Some((balance, status)) = balance_and_status(c, user, currency)? else {
            return Ok(refused("User not found", json!(0)));
        };
        let old = from_fixed(balance, MONEY_SCALE);
        if status != "active" {
            return Ok(refused(&format!("Account is {status}."), decimal_json(old)));
        }
        if old < amount {
            return Ok(refused("Insufficient balance", decimal_json(old)));
        }
        let new = money::sub(old, amount);
        set_balance(c, user, currency, Some(new))?;
        audit(
            c,
            AuditRow {
                user,
                currency,
                operation: "blitz_fee",
                amount: Some(amount),
                before: old,
                after: Some(new),
                transaction_hash: Some(transaction_hash),
                bet_id: None,
            },
        )?;
        Ok(credited(new))
    })
    .map(|outcome| outcome.json)
}

pub(crate) fn debit_for_withdrawal(
    conn: &Connection,
    user: Option<&str>,
    amount: Decimal,
    currency: &str,
    transaction_hash: &str,
) -> ApiResult<Value> {
    update_balance_for_withdrawal(
        conn,
        user,
        Some(amount),
        Some(currency),
        Some(transaction_hash),
    )
    .map(|outcome| outcome.json)
}

#[allow(clippy::too_many_arguments)]
fn place_bet_locked(
    conn: &Connection,
    user: Option<&str>,
    amount: Option<Decimal>,
    currency: Option<&str>,
    idempotency_key: Option<&str>,
    bet_id: Option<&str>,
    max_payout: Option<Decimal>,
    end_time: Option<i64>,
    settlement_token: Option<&str>,
    terms: Option<&Terms>,
) -> ApiResult<Value> {
    let (Some(idempotency_key), Some(bet_id)) = (idempotency_key, bet_id) else {
        return Ok(json!({
            "success": false,
            "duplicate": false,
            "error": "Bet placement requires an idempotency key",
            "new_balance": 0,
        }));
    };

    let locked = conn
        .prepare_cached(
            "INSERT INTO balance_audit_log \
             (user_address, currency, operation_type, amount, bet_id, idempotency_key, \
              max_payout, end_time, settlement_token, created_at) \
             VALUES (?1, ?2, 'bet_lock', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(params![
            user,
            currency,
            store(amount)?,
            bet_id,
            idempotency_key,
            store(max_payout)?,
            end_time,
            settlement_token,
            now_us()
        ]);
    match locked {
        Err(err) if is_unique_violation(&err) => return duplicate_bet(conn, idempotency_key),
        Err(err) => return Err(err.into()),
        Ok(_) => {}
    }

    let void_lock = || {
        conn.prepare_cached(
            "DELETE FROM balance_audit_log \
             WHERE idempotency_key = ?1 AND operation_type = 'bet_lock'",
        )?
        .execute(params![idempotency_key])
    };

    let stake = amount.unwrap_or(Decimal::ZERO);
    if let Some(refusal) =
        world::bet_refusal(conn, user.unwrap_or_default(), stake, now_us() / 1_000)?
    {
        void_lock()?;
        return Ok(json!({
            "success": false,
            "duplicate": false,
            "error": refusal.message,
            "code": refusal.code,
            "until": refusal.until,
            "new_balance": 0,
        }));
    }

    let open: i64 = conn
        .prepare_cached(
            "SELECT coalesce(sum(stake), 0) FROM bet_rounds \
             WHERE user_address = ?1 AND outcome IS NULL",
        )?
        .query_row([user], |row| row.get(0))?;
    let cap = config().max_wallet_open_stake;
    if open + store(amount)?.unwrap_or(0) > store(Some(cap))?.unwrap_or(0) {
        void_lock()?;
        return Ok(json!({
            "success": false,
            "duplicate": false,
            "error": format!("Open bets are limited to {cap} USDC per wallet"),
            "new_balance": 0,
        }));
    }

    let deducted = deduct_balance_for_bet(conn, user, amount, currency)?;

    if !deducted.success {
        void_lock()?;
        let error = deducted.json["error"]
            .as_str()
            .unwrap_or("Bet placement failed");
        return Ok(json!({
            "success": false,
            "duplicate": false,
            "error": error,
            "new_balance": deducted.json["new_balance"],
        }));
    }

    conn.prepare_cached(
        "UPDATE balance_audit_log SET balance_after = ?1 \
         WHERE idempotency_key = ?2 AND operation_type = 'bet_lock'",
    )?
    .execute(params![store(deducted.new_balance)?, idempotency_key])?;

    let mut placed = json!({
        "success": true,
        "duplicate": false,
        "error": null,
        "bet_id": bet_id,
        "settlement_token": settlement_token,
        "new_balance": deducted.json["new_balance"],
        "max_payout": max_payout.map(decimal_json),
        "user_address": user,
        "currency": currency,
    });
    if let Some(terms) = terms {
        insert_round(
            conn,
            bet_id,
            user,
            currency,
            store(amount)?,
            end_time,
            terms,
        )?;
        placed["round"] = round_view(conn, bet_id)?;
    }
    Ok(placed)
}

fn insert_round(
    conn: &Connection,
    bet_id: &str,
    user: Option<&str>,
    currency: Option<&str>,
    stake: Option<i64>,
    end_time: Option<i64>,
    terms: &Terms,
) -> ApiResult<()> {
    conn.prepare_cached(
        "INSERT INTO bet_rounds \
         (bet_id, user_address, currency, asset, mode, direction, stake, multiplier, \
          strike_price, strike_at, strike_source, price_top, price_bottom, end_time, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )?
    .execute(params![
        bet_id,
        user,
        currency,
        terms.asset,
        terms.mode,
        terms.direction,
        stake,
        terms.multiplier,
        terms.strike_price,
        terms.strike_at_us,
        terms.strike_source,
        terms.price_top,
        terms.price_bottom,
        end_time,
        now_us()
    ])?;
    Ok(())
}

fn round_view(conn: &Connection, bet_id: &str) -> ApiResult<Value> {
    let view = conn
        .prepare_cached(
            "SELECT strike_price, end_time, multiplier FROM bet_rounds WHERE bet_id = ?1",
        )?
        .query_row(params![bet_id], |r| {
            Ok(json!({
                "strike_price": fixed_json(r.get(0)?, PRICE_SCALE),
                "end_time_ms": r.get::<_, i64>(1)?.div_euclid(1_000),
                "multiplier": fixed_json(r.get(2)?, MULTIPLIER_SCALE),
            }))
        })
        .optional()?;
    Ok(view.unwrap_or(Value::Null))
}

fn duplicate_bet(conn: &Connection, idempotency_key: &str) -> ApiResult<Value> {
    type Row = (
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        String,
        String,
    );
    let row: Option<Row> = conn
        .prepare_cached(
            "SELECT bet_id, settlement_token, balance_after, max_payout, user_address, currency \
             FROM balance_audit_log WHERE idempotency_key = ?1 LIMIT 1",
        )?
        .query_row(params![idempotency_key], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .optional()?;

    let Some((bet_id, token, balance_after, max_payout, user, currency)) = row else {
        return Ok(json!({
            "success": false,
            "duplicate": true,
            "error": "Bet already processed",
            "new_balance": 0,
        }));
    };

    let round = match &bet_id {
        Some(id) => round_view(conn, id)?,
        None => Value::Null,
    };
    let mut replay = json!({
        "success": token.is_some(),
        "duplicate": true,
        "error": if token.is_none() { Some("Bet already processed") } else { None },
        "bet_id": bet_id,
        "settlement_token": token,
        "new_balance": balance_after.map(|b| fixed_json(b, MONEY_SCALE)),
        "max_payout": max_payout.map(|m| fixed_json(m, MONEY_SCALE)),
        "user_address": user,
        "currency": currency,
    });
    if !round.is_null() {
        replay["round"] = round;
    }
    Ok(replay)
}

fn raise(message: String) -> ApiError {
    ApiError::Other(message)
}

struct Round {
    user: String,
    currency: String,
    stake: i64,
    end_time: i64,
    created_at: i64,
    terms: Terms,
    settled: Option<(String, i64, Option<i64>)>,
}

fn round_of(conn: &Connection, bet_id: &str) -> ApiResult<Option<Round>> {
    Ok(conn
        .prepare_cached(
            "SELECT user_address, currency, stake, end_time, created_at, asset, mode, direction, \
                    multiplier, strike_price, strike_at, strike_source, price_top, price_bottom, \
                    outcome, payout, end_price \
             FROM bet_rounds WHERE bet_id = ?1",
        )?
        .query_row(params![bet_id], |r| {
            let outcome: Option<String> = r.get(14)?;
            Ok(Round {
                user: r.get(0)?,
                currency: r.get(1)?,
                stake: r.get(2)?,
                end_time: r.get(3)?,
                created_at: r.get(4)?,
                terms: Terms {
                    asset: r.get(5)?,
                    mode: r.get(6)?,
                    direction: r.get(7)?,
                    multiplier: r.get(8)?,
                    strike_price: r.get(9)?,
                    strike_at_us: r.get(10)?,
                    strike_source: r.get(11)?,
                    price_top: r.get(12)?,
                    price_bottom: r.get(13)?,
                },
                settled: match outcome {
                    Some(outcome) => Some((outcome, r.get(15)?, r.get(16)?)),
                    None => None,
                },
            })
        })
        .optional()?)
}

fn settled_json(
    bet_id: &str,
    outcome: &str,
    payout: i64,
    end_price: Option<i64>,
    new_balance: Value,
    duplicate: bool,
) -> Value {
    json!({
        "success": true,
        "duplicate": duplicate,
        "bet_id": bet_id,
        "outcome": outcome,
        "payout": fixed_json(payout, MONEY_SCALE),
        "end_price": end_price.map(|price| fixed_json(price, PRICE_SCALE)),
        "new_balance": new_balance,
    })
}

fn settle_round(
    conn: &Connection,
    bet_id: Option<&str>,
    end: Option<&EndTick>,
    settled_by: Option<&str>,
) -> ApiResult<Value> {
    let Some(bet_id) = bet_id else {
        return Err(raise("strike_unknown_bet:".to_string()));
    };
    let Some(round) = round_of(conn, bet_id)? else {
        return Err(raise(format!("strike_unknown_bet:{bet_id}")));
    };
    let user = Some(round.user.as_str());
    let currency = Some(round.currency.as_str());
    let balance_now = |c: &Connection| -> ApiResult<Value> {
        Ok(balance_of(c, user, currency)?
            .map(|balance| fixed_json(balance, MONEY_SCALE))
            .unwrap_or(Value::Null))
    };

    if let Some((outcome, payout, end_price)) = &round.settled {
        let balance = balance_now(conn)?;
        return Ok(settled_json(
            bet_id, outcome, *payout, *end_price, balance, true,
        ));
    }
    let now = now_us();
    if now < round.end_time {
        return Err(raise("strike_round_open".to_string()));
    }

    conn.prepare_cached(
        "INSERT INTO balance_audit_log \
         (user_address, currency, operation_type, amount, bet_id, transaction_hash, created_at) \
         VALUES (?1, ?2, 'payout_lock', 0, ?3, ?4, ?5)",
    )?
    .execute(params![
        user,
        currency,
        bet_id,
        format!("lock:{bet_id}"),
        now
    ])?;
    conn.prepare_cached(
        "UPDATE balance_audit_log SET consumed_at = ?1 \
         WHERE bet_id = ?2 AND operation_type = 'bet_lock' AND consumed_at IS NULL",
    )?
    .execute(params![now, bet_id])?;

    let (mut outcome, mut payout) = decide(&round.terms, round.stake, end)?;
    let mut new_balance = None;
    if payout > 0 {
        let operation = if outcome == Outcome::Win {
            "payout"
        } else {
            "refund"
        };
        let amount = Some(from_fixed(payout, MONEY_SCALE));
        let credit = credit_balance(conn, user, amount, currency, Some(bet_id), operation)?;
        if credit.success {
            new_balance = Some(credit.json["new_balance"].clone());
        } else if credit.json["error"] == json!(BANNED) {
            (outcome, payout) = (Outcome::Withheld, 0);
        } else {
            let error = credit.json["error"].as_str().unwrap_or("unknown");
            return Err(raise(format!("strike_credit_failed:{error}")));
        }
    }

    let end_price = end.map(|tick| tick.price);
    conn.prepare_cached(
        "UPDATE bet_rounds SET end_price = ?1, end_price_at = ?2, end_source = ?3, outcome = ?4, \
                payout = ?5, settled_by = ?6, settled_at = ?7 \
         WHERE bet_id = ?8",
    )?
    .execute(params![
        end_price,
        end.map(|tick| tick.at_us),
        end.map(|tick| tick.source.as_str()),
        outcome.as_str(),
        payout,
        settled_by,
        now,
        bet_id
    ])?;

    let won = !matches!(outcome, Outcome::Loss | Outcome::Withheld);
    conn.prepare_cached(
        "INSERT INTO bet_history \
         (id, wallet_address, asset, direction, amount, multiplier, strike_price, end_price, \
          payout, won, mode, network, resolved_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )?
    .execute(params![
        bet_id,
        round.user,
        round.terms.asset,
        round.terms.direction,
        round.stake,
        round.terms.multiplier,
        round.terms.strike_price,
        end_price,
        payout,
        won,
        round.terms.mode,
        round.currency,
        now,
        round.created_at
    ])?;

    let balance = match new_balance {
        Some(balance) => balance,
        None => balance_now(conn)?,
    };
    Ok(settled_json(
        bet_id,
        outcome.as_str(),
        payout,
        end_price,
        balance,
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ban_normalisation_matches_the_sql_function() {
        assert_eq!(normalize_ban_address("  0xABC "), "0xabc");
        assert_eq!(normalize_ban_address("0XABC"), "0XABC");
        assert_eq!(normalize_ban_address(" Csx2cq3q "), "Csx2cq3q");
        assert_eq!(normalize_ban_address("\t0xABC"), "\t0xABC");
    }

    #[test]
    fn unknown_functions_and_parameters_are_refused() {
        assert!(Args::new("drop_everything", &[]).is_err());
        let value = Value::from(1);
        let err = Args::new("deduct_balance_for_bet", &[("p_nope", &value)]).err();
        assert_eq!(
            err.unwrap().to_string(),
            "Function deduct_balance_for_bet has no parameter p_nope in the public schema"
        );
    }

    #[test]
    fn constraint_errors_read_like_postgres() {
        fn failure(message: &str) -> ApiError {
            ApiError::Db(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some(message.to_string()),
            ))
        }
        assert_eq!(
            sqlerrm(&failure(
                "UNIQUE constraint failed: balance_audit_log.transaction_hash"
            )),
            "duplicate key value violates unique constraint \"idx_balance_audit_tx_hash_unique\""
        );
        assert_eq!(
            sqlerrm(&failure(
                "CHECK constraint failed: user_balances_balance_check"
            )),
            "new row for relation \"user_balances\" violates check constraint \
             \"user_balances_balance_check\""
        );
        assert_eq!(
            sqlerrm(&failure(
                "NOT NULL constraint failed: user_balances.balance"
            )),
            "null value in column \"balance\" of relation \"user_balances\" violates \
             not-null constraint"
        );
        let overflow = crate::money::OVERFLOW;
        assert_eq!(sqlerrm(&ApiError::Other(overflow.to_string())), overflow);
    }
}
