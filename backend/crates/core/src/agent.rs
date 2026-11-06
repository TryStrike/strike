use rusqlite::{params, Connection, OptionalExtension, Row};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{json, Value};

use crate::config::{config, USDC_DECIMALS};
use crate::db::Db;
use crate::error::ApiResult;
use crate::ledger::Rejection;
use crate::money::{from_fixed, to_fixed, MONEY_SCALE};
use crate::prices;
use crate::settlement::{binomo_multiplier, PRICE_SCALE};
use crate::ticks::TickBuffer;
use crate::{agentpass, world};

pub const CHECK_EVERY_MS: u64 = 5_000;
pub const PROPOSAL_MS: i64 = 5_000;
pub const PROPOSAL_EXPIRED: &str = "Proposal expired";
pub const ROUND_SECONDS: i64 = 30;
pub const CLOSING_MS: i64 = 35_000;
const LOOKBACK_MS: i64 = 15_000;
const RANGE_MS: i64 = 120_000;
/// The 15 s move has to be at least this share of the 2 minute range.
pub const MOVE_THRESHOLD: f64 = 0.3;
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
pub const HUMAN_CHECK_EXPIRED: &str = "human check expired";
pub const HUMAN_BANNED: &str = "This human is banned";
pub const HUMAN_REQUIRED: &str = "Verify you are human with World ID first";
pub const HUMAN_WAIT_MS: i64 = 2 * 60 * 1000;
pub const CHASE_MS: i64 = 60_000;

pub fn human_wait_ms() -> i64 {
    std::env::var("HUMAN_WAIT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(HUMAN_WAIT_MS)
}

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

fn coded(status: u16, code: &str, message: &str) -> Rejection {
    agentpass::refusal(status, code, message)
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
        if value < stake_floor() {
            return Err(refuse(
                400,
                &format!("{name} must be at least {} USDC", stake_floor().normalize()),
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

pub struct Reading {
    pub price: f64,
    pub move_pct: f64,
    pub range_share: f64,
}

/// The numbers `signal` judged, for showing even when it skips.
pub fn reading(ring: &TickBuffer, asset: &str, now_ms: i64) -> Option<Reading> {
    let now = ring.latest(asset)?;
    let then = ring.at_or_before(asset, now_ms - LOOKBACK_MS)?;
    let range = ring.range(asset, now_ms - RANGE_MS);
    (range > 0.0).then(|| Reading {
        price: now.price,
        move_pct: (now.price - then.price) / then.price * 100.0,
        range_share: (now.price - then.price).abs() / range,
    })
}

/// Stop-loss minus realized net loss minus open stakes. Profit never widens it.
pub fn stop_loss_headroom(session: &Session, open: Decimal) -> Decimal {
    let realized_loss = (-session.realized_pnl).max(Decimal::ZERO);
    session.stop_loss - realized_loss - open
}

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

fn checkpoints_due(session: &Session) -> i64 {
    let quarters = (-session.realized_pnl * Decimal::from(4) / session.stop_loss)
        .floor()
        .to_string()
        .parse::<i64>()
        .unwrap_or(0);
    (quarters - 1).clamp(0, 2)
}

pub fn needs_human(session: &Session) -> bool {
    session.mode == "yolo"
        && session.stop_loss > Decimal::ZERO
        && checkpoints_due(session) > session.checks_passed
}

pub type LastLoss = (String, Decimal, i64);

pub fn chasing(last: Option<&LastLoss>, stake: Decimal, now_ms: i64) -> bool {
    last.is_some_and(|(_, lost, at)| now_ms - at <= CHASE_MS && stake > *lost)
}

pub async fn last_loss(db: &Db, session_id: &str) -> ApiResult<Option<LastLoss>> {
    let id = session_id.to_string();
    db.read(move |conn| {
        let last: Option<(String, i64, i64, i64)> = conn
            .query_row(
                "SELECT id, stake, pnl, created_at FROM agent_decisions \
                 WHERE session_id = ?1 AND verdict = 'placed' AND result IS NOT NULL \
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        Ok(last
            .filter(|(_, _, pnl, _)| *pnl < 0)
            .map(|(id, stake, _, at)| (id, money(stake), at / 1_000 + ROUND_SECONDS * 1_000)))
    })
    .await
}

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
    pub wins: i64,
    pub losses: i64,
    pub paused_until_ms: Option<i64>,
    pub pause_stepup_id: Option<String>,
    pub checks_passed: i64,
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
    pub strike: Option<Decimal>,
    pub round_ends_at_ms: Option<i64>,
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
            "wins": self.wins,
            "losses": self.losses,
            "pausedUntil": self.paused_until_ms,
            "pauseStepupId": self.pause_stepup_id,
            "checksPassed": self.checks_passed,
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
            "strike": self.strike.map(money_json),
            "roundEndsAt": self.round_ends_at_ms,
        })
    }
}

pub fn trace(session: &Session, signal: &str, jev_needed: Option<f64>) -> Value {
    json!({
        "signal": signal,
        "jevNeeded": jev_needed,
        "budgetLeft": money_json(session.budget - session.spent),
        "stopLossRoom": money_json(stop_loss_headroom(session, Decimal::ZERO)),
    })
}

const SESSION_COLUMNS: &str = "id, wallet, asset, mode, budget, max_per_trade, stop_loss, \
     starts_at, ends_at, status, stopped_reason, spent, realized_pnl, paused_until, \
     pause_stepup_id, checks_passed, \
     (SELECT count(*) FROM agent_decisions d WHERE d.session_id = agent_sessions.id AND d.result = 'win'), \
     (SELECT count(*) FROM agent_decisions d WHERE d.session_id = agent_sessions.id AND d.result = 'loss')";
const DECISION_COLUMNS: &str =
    "id, session_id, created_at, direction, stake, verdict, reason, skip_count, bet_id, result, pnl, expires_at, confidence, trace, \
     (SELECT r.strike_price FROM bet_rounds r WHERE r.bet_id = agent_decisions.bet_id), \
     (SELECT r.end_time FROM bet_rounds r WHERE r.bet_id = agent_decisions.bet_id)";

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
        paused_until_ms: row.get::<_, Option<i64>>(13)?.map(|us| us / 1_000),
        pause_stepup_id: row.get(14)?,
        checks_passed: row.get(15)?,
        wins: row.get(16)?,
        losses: row.get(17)?,
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
        strike: row
            .get::<_, Option<i64>>(14)?
            .map(|fixed| from_fixed(fixed, PRICE_SCALE)),
        round_ends_at_ms: row.get::<_, Option<i64>>(15)?.map(|us| us / 1_000),
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
        return Ok(Some(coded(409, "duplicate", "Start message already used")));
    }
    let active: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE wallet = ?1 AND status = 'running')",
        [wallet],
        |r| r.get(0),
    )?;
    if active {
        return Ok(Some(coded(
            409,
            "agent_running",
            "This wallet already has an active agent session",
        )));
    }
    Ok(None)
}

fn human_start_blocked(
    conn: &Connection,
    t: &StartTerms,
    wallet: &str,
    human_id: &str,
) -> rusqlite::Result<Option<Rejection>> {
    if let Some(refused) = start_blocked(conn, &t.nonce, wallet)? {
        return Ok(Some(refused));
    }
    let mut wallets = world::wallets_of_human(conn, human_id)?;
    wallets.push(wallet.to_string());
    if world::any_banned(conn, &wallets)? {
        return Ok(Some(coded(403, "banned", HUMAN_BANNED)));
    }
    let running: bool = conn.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE status = 'running' AND wallet IN ({}))",
            vec!["?"; wallets.len()].join(", ")
        ),
        rusqlite::params_from_iter(&wallets),
        |r| r.get(0),
    )?;
    if running {
        return Ok(Some(coded(
            409,
            "agent_running",
            "This human already runs an agent",
        )));
    }
    Ok(None)
}

pub fn start_key(t: &StartTerms) -> String {
    agentpass::message_key(&start_message(t))
}

pub async fn start_precheck(
    db: &Db,
    t: &StartTerms,
    human_id: &str,
) -> ApiResult<Option<Rejection>> {
    let (t, wallet, human_id) = (
        t.clone(),
        crate::address::canonical(&t.wallet),
        human_id.to_string(),
    );
    db.read(move |conn| Ok(human_start_blocked(conn, &t, &wallet, &human_id)?))
        .await
}

pub async fn create_session(
    db: &Db,
    t: StartTerms,
    now_ms: i64,
    human_id: &str,
    stepup_id: Option<String>,
) -> ApiResult<Result<Session, Rejection>> {
    let id = uuid::Uuid::new_v4().to_string();
    let wallet = crate::address::canonical(&t.wallet);
    let (budget, max, stop) = (
        fixed(t.budget)?,
        fixed(t.max_per_trade)?,
        fixed(t.stop_loss)?,
    );
    let (human_id, key) = (human_id.to_string(), start_key(&t));
    db.write(move |conn| {
        if let Some(refused) = human_start_blocked(conn, &t, &wallet, &human_id)? {
            return Ok(Err(refused));
        }
        if t.mode == "yolo" {
            let Some(stepup) = &stepup_id else {
                return Ok(Err(coded(
                    401,
                    "step_up_required",
                    "A YOLO agent needs your approval in World App",
                )));
            };
            if let Err(refused) =
                agentpass::consume(conn, stepup, &human_id, "yolo_start", &key, now_ms)?
            {
                return Ok(Err(refused));
            }
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
        Ok(Ok(load_session(conn, &id)?))
    })
    .await
}

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

pub async fn stop_session(db: &Db, id: &str, reason: &str) -> ApiResult<Option<Session>> {
    let (id, reason) = (id.to_string(), reason.to_string());
    db.write(move |conn| {
        end_pause(conn, Some(&id), &reason)?;
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
        end_pause(conn, None, SERVER_RESTART)?;
        Ok(conn.execute(
            "UPDATE agent_sessions SET status = 'stopped', stopped_reason = ?1 WHERE status = 'running'",
            [SERVER_RESTART],
        )?)
    })
    .await
}

fn end_pause(conn: &Connection, session_id: Option<&str>, reason: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE stepups SET status = 'cancelled', reason = ?2 \
         WHERE status IN ('pending', 'approved') AND id IN (SELECT pause_stepup_id \
           FROM agent_sessions WHERE status = 'running' AND (?1 IS NULL OR id = ?1))",
        params![session_id, reason],
    )?;
    conn.execute(
        "UPDATE agent_sessions SET paused_until = NULL, pause_stepup_id = NULL \
         WHERE status = 'running' AND (?1 IS NULL OR id = ?1)",
        [session_id],
    )?;
    Ok(())
}

pub async fn pause(
    db: &Db,
    session_id: &str,
    until_ms: i64,
    stepup_id: Option<&str>,
) -> ApiResult<Option<Session>> {
    let (id, stepup) = (session_id.to_string(), stepup_id.map(str::to_string));
    db.write(move |conn| {
        let changed = conn.execute(
            "UPDATE agent_sessions SET paused_until = ?2, pause_stepup_id = ?3 \
             WHERE id = ?1 AND status = 'running'",
            params![id, until_ms * 1_000, stepup],
        )?;
        Ok(match changed {
            0 => None,
            _ => Some(load_session(conn, &id)?),
        })
    })
    .await
}

pub async fn repoint_pause(db: &Db, session_id: &str, stepup_id: &str) -> ApiResult<bool> {
    let (id, stepup) = (session_id.to_string(), stepup_id.to_string());
    db.write(move |conn| {
        Ok(conn.execute(
            "UPDATE agent_sessions SET pause_stepup_id = ?2 \
             WHERE id = ?1 AND status = 'running' AND paused_until IS NOT NULL",
            [&id, &stepup],
        )? > 0)
    })
    .await
}

pub async fn resume(
    db: &Db,
    session_id: &str,
    now_ms: i64,
) -> ApiResult<Result<Session, Rejection>> {
    let id = session_id.to_string();
    db.write(move |conn| {
        let session = load_session(conn, &id)?;
        let (Some(_), Some(stepup)) = (session.paused_until_ms, &session.pause_stepup_id) else {
            return Ok(Err(coded(
                409,
                "not_paused",
                "The agent is not waiting for a human",
            )));
        };
        let Some(human) = world::human_of_wallet(conn, &session.wallet)? else {
            return Ok(Err(coded(403, "human_required", HUMAN_REQUIRED)));
        };
        let (kind, key): (String, String) = conn.query_row(
            "SELECT kind, coalesce(json_extract(subject, '$.key'), '') FROM stepups WHERE id = ?1",
            [stepup],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let Err(refused) = agentpass::consume(conn, stepup, &human.id, &kind, &key, now_ms)? {
            return Ok(Err(refused));
        }
        let passed = match kind.as_str() {
            "agent_checkpoint" => (session.checks_passed + 1).max(checkpoints_due(&session)),
            _ => session.checks_passed,
        };
        conn.execute(
            "UPDATE agent_sessions SET paused_until = NULL, pause_stepup_id = NULL, \
             checks_passed = ?2 WHERE id = ?1",
            params![id, passed],
        )?;
        Ok(Ok(load_session(conn, &id)?))
    })
    .await
}

pub async fn extend_proposal(db: &Db, decision_id: &str, until_ms: i64) -> ApiResult<()> {
    let id = decision_id.to_string();
    db.write(move |conn| {
        conn.execute(
            "UPDATE agent_decisions SET expires_at = max(expires_at, ?2) \
             WHERE id = ?1 AND verdict = 'awaiting'",
            params![id, until_ms * 1_000],
        )?;
        Ok(())
    })
    .await
}

pub struct Proposed {
    pub direction: &'static str,
    pub stake: Decimal,
    pub trace: Value,
}

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
    Held(Decimal),
    Blocked,
    Stop(&'static str),
    /// The session stopped, or the proposal was answered or expired, first.
    Gone,
    Paused,
    Refused(Rejection),
}

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

pub struct Reservation<'a> {
    pub decision_id: &'a str,
    pub direction: &'a str,
    pub reason: &'a str,
    pub proposal: bool,
    pub confidence: Option<f64>,
    pub trace: Option<&'a Value>,
    pub stepup: Option<&'a str>,
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
        stepup,
    } = reservation;
    let confidence = confidence.map(confidence_fixed);
    let trace = trace.map(Value::to_string);
    let (session_id, id, direction, reason) = (
        session_id.to_string(),
        decision_id.to_string(),
        direction.to_string(),
        reason.to_string(),
    );
    let stepup = stepup.map(str::to_string);
    let cap = config().agent_max_open_stake;
    db.write(move |conn| {
        let session = load_session(conn, &session_id)?;
        if session.status != "running" {
            return Ok(Reserve::Gone);
        }
        if session.paused_until_ms.is_some() {
            return Ok(Reserve::Paused);
        }
        if now_ms >= session.ends_at_ms {
            return Ok(Reserve::Stop(TIME_UP));
        }
        let Some(human) = world::human_of_wallet(conn, &session.wallet)? else {
            return Ok(Reserve::Stop(HUMAN_REQUIRED));
        };
        if world::any_banned(conn, &world::wallets_of_human(conn, &human.id)?)? {
            return Ok(Reserve::Stop(HUMAN_BANNED));
        }
        let mut stake = match stake(&session, open_stake(conn, Some(&session_id))?) {
            Ok(stake) => stake,
            Err(reason) => return Ok(Reserve::Stop(reason)),
        };
        if proposal {
            let proposed = load_decision(conn, &id)?;
            if proposed.verdict != "awaiting" {
                return Ok(Reserve::Gone);
            }
            stake = stake.min(proposed.stake.unwrap_or(Decimal::ZERO));
        }
        if open_stake(conn, None)? + stake > cap {
            return Ok(Reserve::Blocked);
        }
        match &stepup {
            Some(stepup) => {
                if let Err(refused) =
                    agentpass::consume(conn, stepup, &human.id, "proposal", &id, now_ms)?
                {
                    return Ok(Reserve::Refused(refused));
                }
            }
            None if proposal && stake > config().world_limits.stepup_proposal_over => {
                return Ok(Reserve::Refused(coded(
                    401,
                    "step_up_required",
                    "Approve this stake in World App first",
                )));
            }
            None => {}
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

/// A normal mode proposal, waiting for the trader until `expires_ms`. `None`
/// when the session stopped first.
pub async fn record_proposal(
    db: &Db,
    session_id: &str,
    proposed: Proposed,
    reason: &str,
    confidence: Option<f64>,
    now_ms: i64,
) -> ApiResult<Option<Decision>> {
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
        if load_session(conn, &session_id)?.status != "running" {
            return Ok(None);
        }
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
        load_decision(conn, &id).map(Some)
    })
    .await
}

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
                    "SELECT {DECISION_COLUMNS} FROM agent_decisions \
                     WHERE id = ?1 AND session_id = ?2 AND session_id IN \
                       (SELECT id FROM agent_sessions WHERE wallet = ?3)"
                ),
                [&id, &session_id, &wallet],
                decision_row,
            )
            .optional()?)
    })
    .await
}

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
    Drop,
    Mark(&'static str, String),
}

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

/// Settled rounds of stopped sessions whose result isn't copied yet, as
/// `(decision id, session id)`. A session's own task may still be following one.
pub async fn unrecorded_results(db: &Db) -> ApiResult<Vec<(String, String)>> {
    db.read(|conn| {
        let mut statement = conn.prepare_cached(
            "SELECT d.id, d.session_id FROM agent_decisions d \
             JOIN agent_sessions s ON s.id = d.session_id \
             JOIN bet_rounds r ON r.bet_id = d.bet_id \
             WHERE d.verdict = 'placed' AND d.result IS NULL \
               AND r.outcome IS NOT NULL AND s.status = 'stopped'",
        )?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
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

    fn session(mode: &str, pnl: Decimal, checks_passed: i64) -> Session {
        Session {
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
            realized_pnl: pnl,
            paused_until_ms: None,
            pause_stepup_id: None,
            checks_passed,
            wins: 0,
            losses: 0,
        }
    }

    #[test]
    fn a_yolo_loss_pauses_at_half_the_stop_loss_and_again_at_three_quarters() {
        let due = |pnl: i64, checks| needs_human(&session("yolo", Decimal::from(pnl), checks));
        assert!(!due(-4, 0));
        assert!(due(-5, 0));
        assert!(!due(3, 0));
        assert!(!needs_human(&session("normal", Decimal::from(-9), 0)));
        assert!(!due(-7, 1));
        assert!(needs_human(&session("yolo", Decimal::new(-75, 1), 1)));
        assert!(!due(-9, 2));
        let deep = session("yolo", Decimal::from(-8), 0);
        assert_eq!(checkpoints_due(&deep), 2);
    }

    #[test]
    fn a_bigger_stake_within_a_minute_of_a_loss_is_a_chase() {
        let last: LastLoss = ("d".into(), Decimal::from(2), 1_000_000);
        assert!(chasing(Some(&last), Decimal::from(3), 1_030_000));
        assert!(!chasing(Some(&last), Decimal::from(2), 1_030_000));
        assert!(!chasing(Some(&last), Decimal::from(3), 1_061_000));
        assert!(!chasing(None, Decimal::from(3), 1_030_000));
    }

    #[test]
    fn both_modes_stake_the_per_trade_cap() {
        for mode in ["normal", "yolo"] {
            let s = Session {
                budget: Decimal::ONE,
                max_per_trade: Decimal::new(2, 1),
                stop_loss: Decimal::new(8, 1),
                ..session(mode, Decimal::ZERO, 0)
            };
            assert_eq!(stake(&s, Decimal::ZERO), Ok(Decimal::new(2, 1)));
        }
    }

    async fn paused_world() -> (Db, String, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("pause-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Db::open(&path, 1, 5_000).unwrap();
        let wallet = "0x1111111111111111111111111111111111111111";
        db.write(move |conn| {
            conn.execute("INSERT INTO humans (id, created_at) VALUES ('h1', 0)", [])?;
            conn.execute(
                "INSERT INTO human_wallets (wallet, human_id, linked_at) VALUES (?1, 'h1', 0)",
                [wallet],
            )?;
            conn.execute(
                "INSERT INTO human_limits (human_id, tier) VALUES ('h1', 'orb')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let t = StartTerms {
            mode: "normal".into(),
            max_per_trade: Decimal::from(8),
            ..terms()
        };
        let session = create_session(&db, t, 1_000, "h1", None)
            .await
            .unwrap()
            .unwrap();
        (db, session.id, path)
    }

    async fn approved(db: &Db, id: &str, kind: &str, key: &str, now_ms: i64) {
        let (id, kind, key) = (id.to_string(), kind.to_string(), key.to_string());
        db.write(move |conn| {
            conn.execute(
                "INSERT INTO stepups (id, human_id, wallet, kind, subject, status, started_at, \
                 expires_at, approved_at) VALUES (?1, 'h1', 'w', ?2, ?3, 'approved', ?4, ?5, ?4)",
                params![
                    id,
                    kind,
                    json!({ "key": key }).to_string(),
                    now_ms * 1_000,
                    (now_ms + 300_000) * 1_000
                ],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    fn trade(id: &str) -> Reservation<'_> {
        Reservation {
            decision_id: id,
            direction: "UP",
            reason: "test",
            proposal: false,
            confidence: None,
            trace: None,
            stepup: None,
        }
    }

    #[tokio::test]
    async fn only_the_stepup_of_this_pause_resumes_it_and_nothing_trades_meanwhile() {
        let (db, id, path) = paused_world().await;
        let now = 2_000;
        approved(
            &db,
            "old",
            "agent_checkpoint",
            &format!("{id}:checkpoint:0"),
            now,
        )
        .await;
        approved(
            &db,
            "new",
            "agent_checkpoint",
            &format!("{id}:checkpoint:1"),
            now,
        )
        .await;

        assert_eq!(resume(&db, &id, now).await.unwrap().unwrap_err().0, 409);

        pause(&db, &id, now + 60_000, Some("new"))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            reserve(&db, &id, trade("d1"), now).await.unwrap(),
            Reserve::Paused
        ));

        db.write(|conn| {
            conn.execute(
                "UPDATE stepups SET status = 'pending', approved_at = NULL WHERE id = 'new'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let waiting = resume(&db, &id, now).await.unwrap().unwrap_err();
        assert_eq!(waiting.1["code"], "stepup_pending");
        db.write(move |conn| {
            conn.execute(
                "UPDATE stepups SET status = 'approved', approved_at = ?1 WHERE id = 'new'",
                [now * 1_000],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let resumed = resume(&db, &id, now).await.unwrap().unwrap();
        assert_eq!(resumed.paused_until_ms, None);
        assert_eq!(resumed.checks_passed, 1);
        let old: String = db
            .read(|conn| {
                Ok(
                    conn.query_row("SELECT status FROM stepups WHERE id = 'old'", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(old, "approved");

        pause(&db, &id, now + 60_000, Some("new"))
            .await
            .unwrap()
            .unwrap();
        let again = resume(&db, &id, now).await.unwrap().unwrap_err();
        assert_eq!(
            (again.0, again.1["code"].as_str()),
            (409, Some("stepup_used"))
        );

        approved(&db, "last", "agent_checkpoint", "k", now).await;
        assert!(repoint_pause(&db, &id, "last").await.unwrap());
        stop_session(&db, &id, HUMAN_CHECK_DENIED)
            .await
            .unwrap()
            .unwrap();
        let stopped = load(&db, &id).await;
        assert_eq!(stopped.paused_until_ms, None);
        let last: String = db
            .read(|conn| {
                Ok(
                    conn.query_row("SELECT status FROM stepups WHERE id = 'last'", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(last, "cancelled");
        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    async fn load(db: &Db, id: &str) -> Session {
        let id = id.to_string();
        db.read(move |conn| load_session(conn, &id)).await.unwrap()
    }

    #[tokio::test]
    async fn a_big_proposal_places_only_with_its_own_approved_stepup() {
        let (db, id, path) = paused_world().await;
        let now = 2_000;
        let proposed = Proposed {
            direction: "UP",
            stake: Decimal::from(8),
            trace: json!({}),
        };
        let decision = record_proposal(&db, &id, proposed, "up", None, now)
            .await
            .unwrap()
            .expect("the session is running");
        let place = |stepup| Reservation {
            proposal: true,
            stepup,
            ..trade(&decision.id)
        };
        let Reserve::Refused((401, body)) = reserve(&db, &id, place(None), now).await.unwrap()
        else {
            panic!("a big stake placed without approval");
        };
        assert_eq!(body["code"], "step_up_required");
        approved(&db, "other", "proposal", "another-decision", now).await;
        assert!(matches!(
            reserve(&db, &id, place(Some("other")), now).await.unwrap(),
            Reserve::Refused((403, _))
        ));
        approved(&db, "mine", "proposal", &decision.id, now).await;
        let Reserve::Held(stake) = reserve(&db, &id, place(Some("mine")), now).await.unwrap()
        else {
            panic!("the approved stake was not held");
        };
        assert_eq!(stake, Decimal::from(8));
        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn limits_too_small_to_trade_are_refused_at_the_start() {
        let now = terms().expires_ms - 60_000;
        let small = Decimal::new(9, 2);
        for t in [
            StartTerms {
                budget: small,
                max_per_trade: small,
                stop_loss: small,
                ..terms()
            },
            StartTerms {
                max_per_trade: small,
                ..terms()
            },
            StartTerms {
                stop_loss: small,
                ..terms()
            },
        ] {
            assert_eq!(check_start(&t, now).unwrap_err().0, 400, "{t:?}");
        }
        let floor = stake_floor();
        let t = StartTerms {
            budget: floor,
            max_per_trade: floor,
            stop_loss: floor,
            ..terms()
        };
        assert!(check_start(&t, now).is_ok());
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
