//! Agent mode: the start message, the momentum signal, sizing, and the session
//! and decision rows. The task that runs a session lives in the server crate,
//! next to the bet runner it calls.

use rusqlite::{params, Connection, OptionalExtension, Row};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{json, Value};

use crate::config::{config, USDC_DECIMALS};
use crate::db::Db;
use crate::error::ApiResult;
use crate::ledger::Rejection;
use crate::money::{from_fixed, to_fixed, MONEY_SCALE};
use crate::prices;
use crate::settlement::binomo_multiplier;
use crate::ticks::TickBuffer;

pub const CHECK_EVERY_MS: u64 = 5_000;
pub const ROUND_SECONDS: i64 = 30;
const LOOKBACK_MS: i64 = 15_000;
const RANGE_MS: i64 = 120_000;
/// The 15 s move has to be at least this share of the 2 minute range.
const MOVE_THRESHOLD: f64 = 0.3;
/// A start message may not be valid for longer than this.
const MAX_START_AHEAD_MS: i64 = 10 * 60 * 1000;

pub const USER_STOPPED: &str = "You stopped the agent";
pub const TIME_UP: &str = "time up";
pub const LIMIT_REACHED: &str = "limit reached";
pub const SERVER_RESTART: &str = "server restart";

fn stake_floor() -> Decimal {
    Decimal::new(10, 2)
}

#[derive(Debug, Clone, PartialEq)]
pub struct StartTerms {
    pub wallet: String,
    pub chain_id: u64,
    pub asset: String,
    pub mode: String,
    pub budget: Decimal,
    pub max_per_trade: Decimal,
    pub stop_loss: Decimal,
    pub minutes: i64,
    pub expires_ms: i64,
    pub nonce: String,
}

/// The exact text the trader signs. Parsing re-renders it and demands the same
/// bytes back, so there is one spelling per set of terms.
pub fn start_message(t: &StartTerms) -> String {
    format!(
        "Strike agent session\nWallet: {}\nChain: {}\nAsset: {}\nMode: {}\nBudget: {} USDC\n\
         Max per trade: {} USDC\nStop-loss: {} USDC\nMinutes: {}\nExpires: {}\nNonce: {}",
        t.wallet,
        t.chain_id,
        t.asset,
        t.mode,
        t.budget.normalize(),
        t.max_per_trade.normalize(),
        t.stop_loss.normalize(),
        t.minutes,
        t.expires_ms,
        t.nonce
    )
}

fn malformed() -> Rejection {
    refuse(400, "Malformed start message")
}

fn refuse(status: u16, message: &str) -> Rejection {
    (status, json!({ "error": message }))
}

pub fn parse_start(message: &str) -> Result<StartTerms, Rejection> {
    let mut lines = message.split('\n');
    if lines.next() != Some("Strike agent session") {
        return Err(malformed());
    }
    let mut field = |key: &str| {
        lines
            .next()
            .and_then(|line| line.strip_prefix(key))
            .and_then(|rest| rest.strip_prefix(": "))
            .map(str::to_string)
            .ok_or_else(malformed)
    };
    let usdc = |raw: String| {
        raw.strip_suffix(" USDC")
            .and_then(|n| n.parse::<Decimal>().ok())
            .ok_or_else(malformed)
    };
    let terms = StartTerms {
        wallet: field("Wallet")?,
        chain_id: field("Chain")?.parse().map_err(|_| malformed())?,
        asset: field("Asset")?,
        mode: field("Mode")?,
        budget: usdc(field("Budget")?)?,
        max_per_trade: usdc(field("Max per trade")?)?,
        stop_loss: usdc(field("Stop-loss")?)?,
        minutes: field("Minutes")?.parse().map_err(|_| malformed())?,
        expires_ms: field("Expires")?.parse().map_err(|_| malformed())?,
        nonce: field("Nonce")?,
    };
    if lines.next().is_some() || start_message(&terms) != message {
        return Err(malformed());
    }
    Ok(terms)
}

/// Everything the server refuses a start for, apart from the signature and the
/// rows that already exist.
pub fn check_start(t: &StartTerms, now_ms: i64) -> Result<(), Rejection> {
    let cfg = config();
    if t.chain_id != cfg.arc_chain_id {
        return Err(refuse(400, "Start message is for another chain"));
    }
    if t.expires_ms < now_ms {
        return Err(refuse(400, "Start message expired"));
    }
    if t.expires_ms > now_ms + MAX_START_AHEAD_MS {
        return Err(refuse(400, "Start message expires too far ahead"));
    }
    if !(8..=64).contains(&t.nonce.len()) || !t.nonce.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(refuse(400, "Nonce must be 8 to 64 letters or digits"));
    }
    if !prices::is_crypto(&t.asset) {
        return Err(refuse(400, "The agent trades crypto assets only"));
    }
    if t.mode != "normal" && t.mode != "yolo" {
        return Err(refuse(400, "Mode must be normal or yolo"));
    }
    for (name, value) in [
        ("Budget", t.budget),
        ("Max per trade", t.max_per_trade),
        ("Stop-loss", t.stop_loss),
    ] {
        if value <= Decimal::ZERO || value.scale() > USDC_DECIMALS {
            return Err(refuse(
                400,
                &format!("{name} must be a positive USDC amount"),
            ));
        }
    }
    let ceiling = |name: &str, max: Decimal| {
        refuse(
            400,
            &format!("{name} is above the {} USDC ceiling", max.normalize()),
        )
    };
    if t.budget > cfg.agent_max_budget {
        return Err(ceiling("Budget", cfg.agent_max_budget));
    }
    if t.max_per_trade > cfg.agent_max_per_trade {
        return Err(ceiling("Max per trade", cfg.agent_max_per_trade));
    }
    if t.max_per_trade > t.budget {
        return Err(refuse(400, "Max per trade is above the budget"));
    }
    if t.stop_loss > t.budget {
        return Err(refuse(400, "Stop-loss is above the budget"));
    }
    if t.minutes < 1 {
        return Err(refuse(400, "Session must run at least 1 minute"));
    }
    if t.minutes > cfg.agent_max_minutes {
        return Err(refuse(
            400,
            &format!(
                "Session length is above the {} minute ceiling",
                cfg.agent_max_minutes
            ),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Signal and sizing
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Signal {
    Trade {
        direction: &'static str,
        strike: f64,
        reason: String,
    },
    Skip(&'static str),
}

/// Price now against price 15 s ago, scaled by the 2 minute range.
pub fn signal(ring: &TickBuffer, asset: &str, now_ms: i64) -> Signal {
    let max_age = config().bet_tick_max_age_ms;
    let Some(now) = ring.latest(asset) else {
        return Signal::Skip("Price data is stale");
    };
    if now_ms - now.at_ms > max_age {
        return Signal::Skip("Price data is stale");
    }
    let then_ms = now_ms - LOOKBACK_MS;
    let Some(then) = ring.at_or_before(asset, then_ms) else {
        return Signal::Skip("Not enough price history");
    };
    if then_ms - then.at_ms > max_age {
        return Signal::Skip("Price data is stale");
    }
    if then.source != now.source {
        return Signal::Skip("Price sources differ");
    }
    let range = ring.range(asset, now_ms - RANGE_MS);
    if range <= 0.0 {
        return Signal::Skip("Market is flat");
    }
    let moved = now.price - then.price;
    let share = moved.abs() / range;
    if share < MOVE_THRESHOLD {
        return Signal::Skip("No clear move");
    }
    let direction = if moved > 0.0 { "UP" } else { "DOWN" };
    Signal::Trade {
        direction,
        strike: now.price,
        reason: format!(
            "{} {:.2}% in 15s, {:.0}% of the 2 minute range",
            if moved > 0.0 { "up" } else { "down" },
            moved.abs() / then.price * 100.0,
            share * 100.0
        ),
    }
}

/// Mode size capped by what is left of the budget, floored to USDC's 6
/// decimals. `None` once that is under the floor.
pub fn stake(session: &Session) -> Option<Decimal> {
    let mode_size = if session.mode == "yolo" {
        session.max_per_trade
    } else {
        Decimal::ONE
    };
    let left = session.budget - session.spent;
    let stake = mode_size
        .min(left)
        .round_dp_with_strategy(USDC_DECIMALS, RoundingStrategy::ToZero);
    (stake >= stake_floor()).then_some(stake)
}

/// The body the manual bet route takes, with the strike from the server tick.
pub fn bet_body(
    session: &Session,
    decision_id: &str,
    direction: &str,
    strike: f64,
    stake: Decimal,
) -> Value {
    let multiplier = binomo_multiplier(ROUND_SECONDS)
        .and_then(|m| rust_decimal::prelude::ToPrimitive::to_f64(&m))
        .expect("the payout table offers the agent's round length");
    json!({
        "userAddress": session.wallet,
        "betAmount": stake.to_string(),
        "currency": "USDC",
        "asset": session.asset,
        "mode": "binomo",
        "strikePrice": strike,
        "multiplier": multiplier,
        "betRequestId": decision_id,
        "targetCell": { "id": 0, "priceChange": 0, "direction": direction, "timeframe": ROUND_SECONDS },
    })
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub wallet: String,
    pub asset: String,
    pub mode: String,
    pub budget: Decimal,
    pub max_per_trade: Decimal,
    pub stop_loss: Decimal,
    pub starts_at_ms: i64,
    pub ends_at_ms: i64,
    pub status: String,
    pub stopped_reason: Option<String>,
    pub spent: Decimal,
    pub realized_pnl: Decimal,
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub id: String,
    pub session_id: String,
    pub created_at_ms: i64,
    pub direction: Option<String>,
    pub stake: Option<Decimal>,
    pub verdict: String,
    pub reason: String,
    pub skip_count: i64,
    pub bet_id: Option<String>,
}

fn money_json(value: Decimal) -> Value {
    json!(rust_decimal::prelude::ToPrimitive::to_f64(&value))
}

impl Session {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "wallet": self.wallet,
            "asset": self.asset,
            "mode": self.mode,
            "budget": money_json(self.budget),
            "maxPerTrade": money_json(self.max_per_trade),
            "stopLoss": money_json(self.stop_loss),
            "startsAt": self.starts_at_ms,
            "endsAt": self.ends_at_ms,
            "status": self.status,
            "stoppedReason": self.stopped_reason,
            "spent": money_json(self.spent),
            "realizedPnl": money_json(self.realized_pnl),
        })
    }
}

impl Decision {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "sessionId": self.session_id,
            "createdAt": self.created_at_ms,
            "direction": self.direction,
            "stake": self.stake.map(money_json),
            "verdict": self.verdict,
            "reason": self.reason,
            "skipCount": self.skip_count,
            "confidence": Value::Null,
            "betId": self.bet_id,
            "result": Value::Null,
            "pnl": Value::Null,
            "expiresAt": Value::Null,
        })
    }
}

const SESSION_COLUMNS: &str = "id, wallet, asset, mode, budget, max_per_trade, stop_loss, \
     starts_at, ends_at, status, stopped_reason, spent, realized_pnl";
const DECISION_COLUMNS: &str =
    "id, session_id, created_at, direction, stake, verdict, reason, skip_count, bet_id";

fn money(fixed: i64) -> Decimal {
    from_fixed(fixed, MONEY_SCALE)
}

fn fixed(value: Decimal) -> ApiResult<i64> {
    to_fixed(value, MONEY_SCALE)
}

fn session_row(row: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        wallet: row.get(1)?,
        asset: row.get(2)?,
        mode: row.get(3)?,
        budget: money(row.get(4)?),
        max_per_trade: money(row.get(5)?),
        stop_loss: money(row.get(6)?),
        starts_at_ms: row.get::<_, i64>(7)? / 1_000,
        ends_at_ms: row.get::<_, i64>(8)? / 1_000,
        status: row.get(9)?,
        stopped_reason: row.get(10)?,
        spent: money(row.get(11)?),
        realized_pnl: money(row.get(12)?),
    })
}

fn decision_row(row: &Row) -> rusqlite::Result<Decision> {
    Ok(Decision {
        id: row.get(0)?,
        session_id: row.get(1)?,
        created_at_ms: row.get::<_, i64>(2)? / 1_000,
        direction: row.get(3)?,
        stake: row.get::<_, Option<i64>>(4)?.map(money),
        verdict: row.get(5)?,
        reason: row.get(6)?,
        skip_count: row.get(7)?,
        bet_id: row.get(8)?,
    })
}

fn load_session(conn: &Connection, id: &str) -> ApiResult<Session> {
    Ok(conn.query_row(
        &format!("SELECT {SESSION_COLUMNS} FROM agent_sessions WHERE id = ?1"),
        [id],
        session_row,
    )?)
}

fn load_decision(conn: &Connection, id: &str) -> ApiResult<Decision> {
    Ok(conn.query_row(
        &format!("SELECT {DECISION_COLUMNS} FROM agent_decisions WHERE id = ?1"),
        [id],
        decision_row,
    )?)
}

/// Creates the session, or says why it can't. The checks and the insert share
/// the single writer, so two starts can't both pass them.
pub async fn create_session(
    db: &Db,
    t: StartTerms,
    now_ms: i64,
) -> ApiResult<Result<Session, Rejection>> {
    let id = uuid::Uuid::new_v4().to_string();
    let wallet = crate::address::canonical(&t.wallet);
    let (budget, max, stop) = (
        fixed(t.budget)?,
        fixed(t.max_per_trade)?,
        fixed(t.stop_loss)?,
    );
    db.write(move |conn| {
        let used: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE nonce = ?1)",
            [&t.nonce],
            |r| r.get(0),
        )?;
        if used {
            return Ok(Err(refuse(409, "Start message already used")));
        }
        let active: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE wallet = ?1 AND status = 'running')",
            [&wallet],
            |r| r.get(0),
        )?;
        if active {
            return Ok(Err(refuse(409, "This wallet already has an active agent session")));
        }
        conn.execute(
            "INSERT INTO agent_sessions (id, wallet, asset, mode, budget, max_per_trade, stop_loss, \
             starts_at, ends_at, nonce, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'running')",
            params![
                id,
                wallet,
                t.asset,
                t.mode,
                budget,
                max,
                stop,
                now_ms * 1_000,
                (now_ms + t.minutes * 60_000) * 1_000,
                t.nonce
            ],
        )?;
        Ok(Ok(load_session(conn, &id)?))
    })
    .await
}

/// The wallet's own session, or `None` when that id isn't theirs.
pub async fn session_for(db: &Db, id: &str, wallet: &str) -> ApiResult<Option<Session>> {
    let (id, wallet) = (id.to_string(), wallet.to_string());
    db.read(move |conn| {
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {SESSION_COLUMNS} FROM agent_sessions WHERE id = ?1 AND wallet = ?2"
                ),
                [&id, &wallet],
                session_row,
            )
            .optional()?)
    })
    .await
}

/// The newest `limit` decisions, oldest first.
pub async fn recent_decisions(db: &Db, session_id: &str, limit: i64) -> ApiResult<Vec<Decision>> {
    let id = session_id.to_string();
    db.read(move |conn| {
        let mut statement = conn.prepare_cached(&format!(
            "SELECT {DECISION_COLUMNS} FROM agent_decisions WHERE session_id = ?1 \
             ORDER BY created_at DESC, rowid DESC LIMIT ?2"
        ))?;
        let mut rows: Vec<Decision> = statement
            .query_map(params![id, limit], decision_row)?
            .collect::<Result<_, _>>()?;
        rows.reverse();
        Ok(rows)
    })
    .await
}

/// Stops a running session. `None` when it was already stopped, so the first
/// reason is the one that stays.
pub async fn stop_session(db: &Db, id: &str, reason: &str) -> ApiResult<Option<Session>> {
    let (id, reason) = (id.to_string(), reason.to_string());
    db.write(move |conn| {
        let changed = conn.execute(
            "UPDATE agent_sessions SET status = 'stopped', stopped_reason = ?2 \
             WHERE id = ?1 AND status = 'running'",
            [&id, &reason],
        )?;
        Ok(match changed {
            0 => None,
            _ => Some(load_session(conn, &id)?),
        })
    })
    .await
}

/// No task survives a restart, so no session may claim to be running.
pub async fn stop_all_running(db: &Db) -> ApiResult<usize> {
    db.write(|conn| {
        Ok(conn.execute(
            "UPDATE agent_sessions SET status = 'stopped', stopped_reason = ?1 WHERE status = 'running'",
            [SERVER_RESTART],
        )?)
    })
    .await
}

/// A skip, folded into the previous row when that was the same skip.
pub async fn record_skip(
    db: &Db,
    session_id: &str,
    reason: &str,
    now_ms: i64,
) -> ApiResult<Decision> {
    let (session_id, reason) = (session_id.to_string(), reason.to_string());
    db.write(move |conn| {
        let last: Option<(String, String, String)> = conn
            .query_row(
                "SELECT id, verdict, reason FROM agent_decisions WHERE session_id = ?1 \
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [&session_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((id, verdict, last_reason)) = last {
            if verdict == "skipped" && last_reason == reason {
                conn.execute(
                    "UPDATE agent_decisions SET skip_count = skip_count + 1 WHERE id = ?1",
                    [&id],
                )?;
                return load_decision(conn, &id);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO agent_decisions (id, session_id, created_at, verdict, reason) \
             VALUES (?1, ?2, ?3, 'skipped', ?4)",
            params![id, session_id, now_ms * 1_000, reason],
        )?;
        load_decision(conn, &id)
    })
    .await
}

pub struct Trade {
    pub decision_id: String,
    pub direction: String,
    pub stake: Decimal,
    pub reason: String,
    /// Set when the bet was placed, `None` when the bet path refused it.
    pub bet_id: Option<String>,
}

/// A trade that reached the bet path. A placed one adds its stake to `spent`
/// in the same write.
pub async fn record_trade(
    db: &Db,
    session_id: &str,
    trade: Trade,
    now_ms: i64,
) -> ApiResult<(Decision, Session)> {
    let verdict = if trade.bet_id.is_some() {
        "placed"
    } else {
        "rejected"
    };
    let Trade {
        decision_id: id,
        direction,
        stake,
        reason,
        bet_id,
    } = trade;
    let session_id = session_id.to_string();
    let stake = fixed(stake)?;
    db.write(move |conn| {
        conn.execute(
            "INSERT INTO agent_decisions (id, session_id, created_at, direction, stake, verdict, reason, bet_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, session_id, now_ms * 1_000, direction, stake, verdict, reason, bet_id],
        )?;
        if verdict == "placed" {
            conn.execute(
                "UPDATE agent_sessions SET spent = spent + ?2 WHERE id = ?1",
                params![session_id, stake],
            )?;
        }
        Ok((load_decision(conn, &id)?, load_session(conn, &session_id)?))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> StartTerms {
        StartTerms {
            wallet: "0x1111111111111111111111111111111111111111".into(),
            chain_id: 5042002,
            asset: "BTC".into(),
            mode: "yolo".into(),
            budget: Decimal::new(205, 1),
            max_per_trade: Decimal::new(5, 0),
            stop_loss: Decimal::new(10, 0),
            minutes: 10,
            expires_ms: 1_700_000_000_000,
            nonce: "abcdef12".into(),
        }
    }

    #[test]
    fn the_start_message_round_trips_and_has_one_spelling() {
        let message = start_message(&terms());
        assert!(message.contains("\nBudget: 20.5 USDC\n"), "{message}");
        assert_eq!(parse_start(&message).unwrap(), terms());
        for forged in [
            message.replace("20.5", "20.50"),
            message.replace("20.5 USDC", "20.5USDC"),
            message.replace("Minutes: 10", "Minutes: 010"),
            format!("{message}\n"),
            message.replace("Strike agent session", "Strike"),
        ] {
            assert_eq!(parse_start(&forged).unwrap_err().0, 400, "{forged}");
        }
    }
}
