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
use crate::world::{self, HumanGrant};

pub const CHECK_EVERY_MS: u64 = 5_000;
/// How long a normal mode proposal waits for the trader's tap.
pub const PROPOSAL_MS: i64 = 5_000;
pub const PROPOSAL_EXPIRED: &str = "Proposal expired";
pub const ROUND_SECONDS: i64 = 30;
/// No new trade once a 30 s round could outlive the session.
pub const CLOSING_MS: i64 = 35_000;
const LOOKBACK_MS: i64 = 15_000;
const RANGE_MS: i64 = 120_000;
/// The 15 s move has to be at least this share of the 2 minute range.
const MOVE_THRESHOLD: f64 = 0.3;
/// A start message may not be valid for longer than this.
const MAX_START_AHEAD_MS: i64 = 10 * 60 * 1000;

pub const USER_STOPPED: &str = "You stopped the agent";
pub const TIME_UP: &str = "time up";
pub const LIMIT_REACHED: &str = "limit reached";
pub const BUDGET_SPENT: &str = "budget spent";
pub const STOP_LOSS_REACHED: &str = "stop-loss reached";
pub const HOUSE_LIMIT: &str = "House agent limit reached";
pub const SERVER_RESTART: &str = "server restart";
pub const WAITING_FOR_HUMAN: &str = "Waiting for a human";
pub const HUMAN_CHECK_DENIED: &str = "human check denied";
/// How long a paused YOLO agent waits for its human to step up.
pub const HUMAN_WAIT_MS: i64 = 2 * 60 * 1000;

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

pub(crate) fn refuse(status: u16, message: &str) -> Rejection {
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
    if !t.wallet.starts_with("0x") || !crate::address::is_address(&t.wallet) {
        return Err(refuse(400, "Wallet must be a 0x address"));
    }
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
        move_pct: f64,
        range_share: f64,
        range_pct: f64,
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
        move_pct: moved / then.price * 100.0,
        range_share: share,
        range_pct: range / then.price * 100.0,
        reason: format!(
            "{} {:.2}% in 15s, {:.0}% of the 2 minute range",
            if moved > 0.0 { "up" } else { "down" },
            moved.abs() / then.price * 100.0,
            share * 100.0
        ),
    }
}

/// Stop-loss minus realized net loss minus open stakes. Profit never widens it.
pub fn stop_loss_headroom(session: &Session, open: Decimal) -> Decimal {
    let realized_loss = (-session.realized_pnl).max(Decimal::ZERO);
    session.stop_loss - realized_loss - open
}

/// The smallest of the per trade cap, budget left and stop-loss headroom, floored to
/// USDC's 6 decimals. `Err` carries the reason the session has to stop.
/// Headroom counts open stakes, so a loss in flight can't overshoot it.
pub fn stake(session: &Session, open: Decimal) -> Result<Decimal, &'static str> {
    let left = session.budget - session.spent;
    if left <= Decimal::ZERO {
        return Err(BUDGET_SPENT);
    }
    let headroom = stop_loss_headroom(session, open);
    if headroom <= Decimal::ZERO {
        return Err(STOP_LOSS_REACHED);
    }
    let stake = session
        .max_per_trade
        .min(left)
        .min(headroom)
        .round_dp_with_strategy(USDC_DECIMALS, RoundingStrategy::ToZero);
    if stake < stake_floor() {
        return Err(LIMIT_REACHED);
    }
    Ok(stake)
}

/// A YOLO agent that has lost half its stop-loss pauses for its human.
pub fn needs_human(session: &Session) -> bool {
    session.mode == "yolo" && -session.realized_pnl * Decimal::TWO >= session.stop_loss
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
    pub result: Option<String>,
    pub pnl: Option<Decimal>,
    pub expires_at_ms: Option<i64>,
    pub confidence: Option<f64>,
    pub trace: Option<Value>,
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
            "confidence": self.confidence,
            "betId": self.bet_id,
            "result": self.result,
            "pnl": self.pnl.map(money_json),
            "expiresAt": self.expires_at_ms,
            "trace": self.trace,
        })
    }
}

/// The numbers behind a proposal, as they stood when it was decided.
pub fn trace(session: &Session, signal: &str, jev_needed: Option<f64>) -> Value {
    json!({
        "signal": signal,
        "jevNeeded": jev_needed,
        "budgetLeft": money_json(session.budget - session.spent),
        "stopLossRoom": money_json(stop_loss_headroom(session, Decimal::ZERO)),
    })
}

const SESSION_COLUMNS: &str = "id, wallet, asset, mode, budget, max_per_trade, stop_loss, \
     starts_at, ends_at, status, stopped_reason, spent, realized_pnl";
const DECISION_COLUMNS: &str =
    "id, session_id, created_at, direction, stake, verdict, reason, skip_count, bet_id, result, pnl, expires_at, confidence, trace";

/// Stored like a multiplier, at 4 decimals.
fn confidence_fixed(confidence: f64) -> i64 {
    (confidence * 10_000.0).round() as i64
}

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
        result: row.get(9)?,
        pnl: row.get::<_, Option<i64>>(10)?.map(money),
        expires_at_ms: row.get::<_, Option<i64>>(11)?.map(|us| us / 1_000),
        confidence: row
            .get::<_, Option<i64>>(12)?
            .map(|fixed| fixed as f64 / 10_000.0),
        trace: row
            .get::<_, Option<String>>(13)?
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    13,
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            })?,
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

/// Why the rows that exist refuse a start, or `None`.
pub(crate) fn start_blocked(
    conn: &Connection,
    nonce: &str,
    wallet: &str,
) -> rusqlite::Result<Option<Rejection>> {
    let used: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE nonce = ?1)",
        [nonce],
        |r| r.get(0),
    )?;
    if used {
        return Ok(Some(refuse(409, "Start message already used")));
    }
    let active: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE wallet = ?1 AND status = 'running')",
        [wallet],
        |r| r.get(0),
    )?;
    if active {
        return Ok(Some(refuse(
            409,
            "This wallet already has an active agent session",
        )));
    }
    Ok(None)
}

/// Creates the session, or says why it can't. The checks and the insert share
/// the single writer, so two starts can't both pass them. A YOLO session
/// carries the human that approved it, whose attempt is spent in the same write.
pub async fn create_session(
    db: &Db,
    t: StartTerms,
    now_ms: i64,
    human: Option<HumanGrant>,
) -> ApiResult<Result<Session, Rejection>> {
    let id = uuid::Uuid::new_v4().to_string();
    let wallet = crate::address::canonical(&t.wallet);
    let (budget, max, stop) = (
        fixed(t.budget)?,
        fixed(t.max_per_trade)?,
        fixed(t.stop_loss)?,
    );
    if t.mode == "yolo" && human.is_none() {
        if world::enabled() {
            return Ok(Err(refuse(401, "A YOLO agent needs a human check")));
        }
        if config().production {
            return Ok(Err(refuse(503, world::NOT_CONFIGURED)));
        }
    }
    db.write(move |conn| {
        let refused = match &human {
            Some(grant) => world::claim(conn, grant, &wallet, &t.nonce, now_ms)?,
            None => start_blocked(conn, &t.nonce, &wallet)?,
        };
        if let Some(refused) = refused {
            return Ok(Err(refused));
        }
        conn.execute(
            "INSERT INTO agent_sessions (id, wallet, asset, mode, budget, max_per_trade, stop_loss,              starts_at, ends_at, nonce, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'running')",
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
        if let Some(grant) = &human {
            world::approve(conn, grant, &wallet, &id, now_ms)?;
        }
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
        conn.execute(
            "UPDATE agent_decisions SET verdict = 'skipped', reason = ?2 \
             WHERE session_id = ?1 AND verdict = 'awaiting'",
            [&id, &reason],
        )?;
        Ok(match changed {
            0 => None,
            _ => Some(load_session(conn, &id)?),
        })
    })
    .await
}

/// No task survives a restart, so no session may claim to be running. A
/// reservation the crash left without a bet id gets it back from the ledger,
/// keyed by the decision id it was placed under, or is released.
pub async fn stop_all_running(db: &Db) -> ApiResult<usize> {
    db.write(|conn| {
        conn.execute(
            "UPDATE agent_decisions SET bet_id = (
               SELECT bet_id FROM balance_audit_log
                WHERE idempotency_key = agent_decisions.id AND bet_id IS NOT NULL LIMIT 1)
             WHERE verdict = 'placed' AND bet_id IS NULL",
            [],
        )?;
        conn.execute(
            "UPDATE agent_sessions SET spent = spent - (
               SELECT coalesce(sum(stake), 0) FROM agent_decisions
                WHERE session_id = agent_sessions.id AND verdict = 'placed' AND bet_id IS NULL)",
            [],
        )?;
        conn.execute(
            "UPDATE agent_decisions SET verdict = 'rejected', reason = ?1 \
             WHERE verdict = 'placed' AND bet_id IS NULL",
            [SERVER_RESTART],
        )?;
        conn.execute(
            "UPDATE agent_decisions SET verdict = 'skipped', reason = ?1 WHERE verdict = 'awaiting'",
            [SERVER_RESTART],
        )?;
        Ok(conn.execute(
            "UPDATE agent_sessions SET status = 'stopped', stopped_reason = ?1 WHERE status = 'running'",
            [SERVER_RESTART],
        )?)
    })
    .await
}

/// A proposed trade and the numbers behind it.
pub struct Proposed {
    pub direction: &'static str,
    pub stake: Decimal,
    pub trace: Value,
}

/// A skip or a block, folded into the previous row when that was the same one.
pub async fn record_note(
    db: &Db,
    session_id: &str,
    verdict: &'static str,
    reason: &str,
    confidence: Option<f64>,
    proposed: Option<Proposed>,
    now_ms: i64,
) -> ApiResult<Decision> {
    let confidence = confidence.map(confidence_fixed);
    let (session_id, reason) = (session_id.to_string(), reason.to_string());
    let (direction, stake, trace) = match proposed {
        Some(p) => (
            Some(p.direction),
            Some(fixed(p.stake)?),
            Some(p.trace.to_string()),
        ),
        None => (None, None, None),
    };
    db.write(move |conn| {
        let last: Option<(String, String, String)> = conn
            .query_row(
                "SELECT id, verdict, reason FROM agent_decisions WHERE session_id = ?1 \
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [&session_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((id, last_verdict, last_reason)) = last {
            if last_verdict == verdict && last_reason == reason {
                conn.execute(
                    "UPDATE agent_decisions SET skip_count = skip_count + 1, \
                     confidence = ?2, direction = ?3, stake = ?4, trace = ?5 WHERE id = ?1",
                    params![id, confidence, direction, stake, trace],
                )?;
                return load_decision(conn, &id);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO agent_decisions (id, session_id, created_at, verdict, reason, confidence, direction, stake, trace) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, session_id, now_ms * 1_000, verdict, reason, confidence, direction, stake, trace],
        )?;
        load_decision(conn, &id)
    })
    .await
}

pub enum Reserve {
    /// The stake is held: counted in `spent` and in open stake, not yet a bet.
    Held(Decimal),
    Blocked,
    Stop(&'static str),
    /// The proposal was answered or expired before this approve got to it.
    Gone,
}

/// Placed stakes whose round hasn't settled, for one session or every agent.
fn open_stake(conn: &Connection, session_id: Option<&str>) -> rusqlite::Result<Decimal> {
    conn.query_row(
        "SELECT coalesce(sum(d.stake), 0) FROM agent_decisions d \
         LEFT JOIN bet_rounds r ON r.bet_id = d.bet_id \
         WHERE d.verdict = 'placed' AND r.outcome IS NULL \
           AND (?1 IS NULL OR d.session_id = ?1)",
        [session_id],
        |r| r.get::<_, i64>(0),
    )
    .map(money)
}

/// Sizes the trade and holds its stake in one write, so the house cap is
/// checked and taken atomically across every agent. Open stake is every placed
/// decision whose round hasn't settled, held ones included.
pub struct Reservation<'a> {
    pub decision_id: &'a str,
    pub direction: &'a str,
    pub reason: &'a str,
    pub proposal: bool,
    pub confidence: Option<f64>,
    pub trace: Option<&'a Value>,
}

pub async fn reserve(
    db: &Db,
    session_id: &str,
    reservation: Reservation<'_>,
    now_ms: i64,
) -> ApiResult<Reserve> {
    let Reservation {
        decision_id,
        direction,
        reason,
        proposal,
        confidence,
        trace,
    } = reservation;
    let confidence = confidence.map(confidence_fixed);
    let trace = trace.map(Value::to_string);
    let (session_id, id, direction, reason) = (
        session_id.to_string(),
        decision_id.to_string(),
        direction.to_string(),
        reason.to_string(),
    );
    let cap = config().agent_max_open_stake;
    db.write(move |conn| {
        let session = load_session(conn, &session_id)?;
        if now_ms >= session.ends_at_ms {
            return Ok(Reserve::Stop(TIME_UP));
        }
        let stake = match stake(&session, open_stake(conn, Some(&session_id))?) {
            Ok(stake) => stake,
            Err(reason) => return Ok(Reserve::Stop(reason)),
        };
        if open_stake(conn, None)? + stake > cap {
            return Ok(Reserve::Blocked);
        }
        let held = fixed(stake)?;
        if proposal {
            let taken = conn.execute(
                "UPDATE agent_decisions SET verdict = 'placed', direction = ?2, stake = ?3, reason = ?4 \
                 WHERE id = ?1 AND verdict = 'awaiting'",
                params![id, direction, held, reason],
            )?;
            if taken == 0 {
                return Ok(Reserve::Gone);
            }
        } else {
            conn.execute(
                "INSERT INTO agent_decisions (id, session_id, created_at, direction, stake, verdict, reason, confidence, trace) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'placed', ?6, ?7, ?8)",
                params![id, session_id, now_ms * 1_000, direction, held, reason, confidence, trace],
            )?;
        }
        conn.execute(
            "UPDATE agent_sessions SET spent = spent + ?2 WHERE id = ?1",
            params![session_id, held],
        )?;
        Ok(Reserve::Held(stake))
    })
    .await
}

/// A normal mode proposal, waiting for the trader until `expires_ms`.
pub async fn record_proposal(
    db: &Db,
    session_id: &str,
    proposed: Proposed,
    reason: &str,
    confidence: Option<f64>,
    now_ms: i64,
) -> ApiResult<Decision> {
    let confidence = confidence.map(confidence_fixed);
    let Proposed {
        direction,
        stake,
        trace,
    } = proposed;
    let trace = trace.to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let (session_id, direction, reason) = (
        session_id.to_string(),
        direction.to_string(),
        reason.to_string(),
    );
    let stake = fixed(stake)?;
    db.write(move |conn| {
        conn.execute(
            "INSERT INTO agent_decisions (id, session_id, created_at, direction, stake, verdict, reason, expires_at, confidence, trace) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'awaiting', ?6, ?7, ?8, ?9)",
            params![
                id,
                session_id,
                now_ms * 1_000,
                direction,
                stake,
                reason,
                (now_ms + PROPOSAL_MS) * 1_000,
                confidence,
                trace
            ],
        )?;
        load_decision(conn, &id)
    })
    .await
}

/// Answers a proposal that is still waiting. `None` when it already wasn't.
pub async fn resolve(
    db: &Db,
    decision_id: &str,
    verdict: &'static str,
    reason: &str,
) -> ApiResult<Option<Decision>> {
    let (id, reason) = (decision_id.to_string(), reason.to_string());
    db.write(move |conn| {
        let changed = conn.execute(
            "UPDATE agent_decisions SET verdict = ?2, reason = ?3 WHERE id = ?1 AND verdict = 'awaiting'",
            params![id, verdict, reason],
        )?;
        Ok(match changed {
            0 => None,
            _ => Some(load_decision(conn, &id)?),
        })
    })
    .await
}

pub async fn decision(db: &Db, decision_id: &str) -> ApiResult<Decision> {
    let id = decision_id.to_string();
    db.read(move |conn| load_decision(conn, &id)).await
}

/// The decision when it belongs to this wallet's session, `None` otherwise.
pub async fn decision_for(
    db: &Db,
    decision_id: &str,
    session_id: &str,
    wallet: &str,
) -> ApiResult<Option<Decision>> {
    let (id, session_id, wallet) = (
        decision_id.to_string(),
        session_id.to_string(),
        wallet.to_string(),
    );
    db.read(move |conn| {
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {} FROM agent_decisions d JOIN agent_sessions s ON s.id = d.session_id \
                     WHERE d.id = ?1 AND d.session_id = ?2 AND s.wallet = ?3",
                    DECISION_COLUMNS
                        .split(", ")
                        .map(|c| format!("d.{c}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                [&id, &session_id, &wallet],
                decision_row,
            )
            .optional()?)
    })
    .await
}

/// The held stake became a bet.
pub async fn confirm(db: &Db, decision_id: &str, bet_id: &str) -> ApiResult<(Decision, Session)> {
    let (id, bet_id) = (decision_id.to_string(), bet_id.to_string());
    db.write(move |conn| {
        conn.execute(
            "UPDATE agent_decisions SET bet_id = ?2 WHERE id = ?1",
            [&id, &bet_id],
        )?;
        let decision = load_decision(conn, &id)?;
        let session = load_session(conn, &decision.session_id)?;
        Ok((decision, session))
    })
    .await
}

pub enum Release {
    /// Forget the row, so the skip that follows folds as usual.
    Drop,
    /// Keep the row with this verdict and reason.
    Mark(&'static str, String),
}

/// The bet path refused the held stake: give it back to the budget.
pub async fn release(
    db: &Db,
    decision_id: &str,
    how: Release,
) -> ApiResult<(Option<Decision>, Session)> {
    let id = decision_id.to_string();
    db.write(move |conn| {
        let held = load_decision(conn, &id)?;
        conn.execute(
            "UPDATE agent_sessions SET spent = spent - ?2 WHERE id = ?1",
            params![held.session_id, held.stake.map(fixed).transpose()?],
        )?;
        let decision = match how {
            Release::Mark(verdict, reason) => {
                conn.execute(
                    "UPDATE agent_decisions SET verdict = ?2, reason = ?3 WHERE id = ?1",
                    params![id, verdict, reason],
                )?;
                Some(load_decision(conn, &id)?)
            }
            Release::Drop => {
                conn.execute("DELETE FROM agent_decisions WHERE id = ?1", [&id])?;
                None
            }
        };
        Ok((decision, load_session(conn, &held.session_id)?))
    })
    .await
}

/// Copies a settled round's outcome onto its decision and the session's P&L,
/// once. P&L is payout minus stake: a win's profit, a loss or withheld round's
/// whole stake, zero for a tie or refund. `None` while the round is open.
pub async fn record_result(db: &Db, decision_id: &str) -> ApiResult<Option<(Decision, Session)>> {
    let id = decision_id.to_string();
    db.write(move |conn| {
        let settled: Option<(String, i64)> = conn
            .query_row(
                "SELECT r.outcome, r.payout - r.stake FROM agent_decisions d \
                 JOIN bet_rounds r ON r.bet_id = d.bet_id \
                 WHERE d.id = ?1 AND r.outcome IS NOT NULL AND d.result IS NULL",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((outcome, pnl)) = settled else {
            return Ok(None);
        };
        conn.execute(
            "UPDATE agent_decisions SET result = ?2, pnl = ?3 WHERE id = ?1",
            params![id, outcome, pnl],
        )?;
        let decision = load_decision(conn, &id)?;
        conn.execute(
            "UPDATE agent_sessions SET realized_pnl = realized_pnl + ?2 WHERE id = ?1",
            params![decision.session_id, pnl],
        )?;
        let session = load_session(conn, &decision.session_id)?;
        Ok(Some((decision, session)))
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

    #[test]
    fn half_the_stop_loss_lost_pauses_yolo_only() {
        let session = |mode: &str, pnl: i64| Session {
            id: "s".into(),
            wallet: "w".into(),
            asset: "BTC".into(),
            mode: mode.into(),
            budget: Decimal::from(20),
            max_per_trade: Decimal::from(5),
            stop_loss: Decimal::from(10),
            starts_at_ms: 0,
            ends_at_ms: 1,
            status: "running".into(),
            stopped_reason: None,
            spent: Decimal::ZERO,
            realized_pnl: Decimal::from(pnl),
        };
        assert!(!needs_human(&session("yolo", -4)));
        assert!(needs_human(&session("yolo", -5)));
        assert!(!needs_human(&session("yolo", 3)));
        assert!(!needs_human(&session("normal", -9)));
    }

    #[test]
    fn both_modes_stake_the_per_trade_cap() {
        let session = |mode: &str| Session {
            id: "s".into(),
            wallet: "w".into(),
            asset: "BTC".into(),
            mode: mode.into(),
            budget: Decimal::ONE,
            max_per_trade: Decimal::new(2, 1),
            stop_loss: Decimal::new(8, 1),
            starts_at_ms: 0,
            ends_at_ms: 1,
            status: "running".into(),
            stopped_reason: None,
            spent: Decimal::ZERO,
            realized_pnl: Decimal::ZERO,
        };
        for mode in ["normal", "yolo"] {
            assert_eq!(stake(&session(mode), Decimal::ZERO), Ok(Decimal::new(2, 1)));
        }
    }

    #[test]
    fn only_a_0x_wallet_starts() {
        let now = terms().expires_ms - 60_000;
        assert!(check_start(&terms(), now).is_ok());
        let body = "1111111111111111111111111111111111111111";
        for wallet in [format!("0X{body}"), body.to_string(), "0x1111".to_string()] {
            let t = StartTerms { wallet, ..terms() };
            assert_eq!(check_start(&t, now).unwrap_err().0, 400, "{}", t.wallet);
        }
    }
}
