//! One task per running agent session, and the hub its feed listens on.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use tokio::sync::{broadcast, watch, Notify};

use strike_core::agent::{self, Decision, Release, Reservation, Reserve, Session, Signal};
use strike_core::bets::now_ms;
use strike_core::db::{self, Db};
use strike_core::error::ApiResult;
use strike_core::jev::{self, Gate};
use strike_core::ledger::BetOutcome;
use strike_core::settlement::binomo_multiplier;
use strike_core::ticks;
use strike_core::world;

use crate::routes::balance_mutations::place_bet;

/// How often an open bet is looked up. The sweep settles once a second.
const SETTLE_POLL_MS: u64 = 1_000;

struct Live {
    frames: broadcast::Sender<String>,
    stop: watch::Sender<bool>,
    approval: Approval,
    /// Set while a YOLO agent waits for its human, until this time.
    paused_until: Option<i64>,
    resumed: Arc<Notify>,
}

/// Held by whoever answers a proposal, the trader or the expiry, so a second
/// answer waits for the first and then reads it.
#[derive(Clone)]
pub struct Approval {
    pub lock: Arc<tokio::sync::Mutex<()>>,
    pub answered: Arc<Notify>,
}

static LIVE: LazyLock<Mutex<HashMap<String, Live>>> = LazyLock::new(Mutex::default);

fn live() -> std::sync::MutexGuard<'static, HashMap<String, Live>> {
    LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn session_frame(session: &Session) -> String {
    format!("event: session\ndata: {}\n\n", session.to_json())
}

pub fn decision_frame(decision: &Decision) -> String {
    format!("event: decision\ndata: {}\n\n", decision.to_json())
}

/// Frames for a running session. `None` once its task has ended.
pub fn subscribe(session_id: &str) -> Option<broadcast::Receiver<String>> {
    live().get(session_id).map(|l| l.frames.subscribe())
}

pub fn publish(session_id: &str, frame: String) {
    if let Some(l) = live().get(session_id) {
        let _ = l.frames.send(frame);
    }
}

/// Wakes the task so it ends without placing another bet.
pub fn halt(session_id: &str) {
    if let Some(l) = live().get(session_id) {
        let _ = l.stop.send(true);
    }
}

/// `None` once the session's task has ended.
pub fn approval(session_id: &str) -> Option<Approval> {
    live().get(session_id).map(|l| l.approval.clone())
}

/// When the paused agent gives up on its human. `None` when it isn't paused.
pub fn paused_until(session_id: &str) -> Option<i64> {
    live().get(session_id).and_then(|l| l.paused_until)
}

/// Wakes a paused agent to read its checkpoint.
pub fn resume(session_id: &str) {
    if let Some(l) = live().get(session_id) {
        l.resumed.notify_one();
    }
}

fn set_paused(session_id: &str, until: Option<i64>) -> Option<Arc<Notify>> {
    live().get_mut(session_id).map(|l| {
        l.paused_until = until;
        l.resumed.clone()
    })
}

pub fn spawn(session: Session) {
    let (frames, _) = broadcast::channel(256);
    let (stop, stopped) = watch::channel(false);
    let approval = Approval {
        lock: Arc::default(),
        answered: Arc::default(),
    };
    live().insert(
        session.id.clone(),
        Live {
            frames,
            stop,
            approval: approval.clone(),
            paused_until: None,
            resumed: Arc::default(),
        },
    );
    tokio::spawn(run(session, stopped, approval));
}

async fn run(mut session: Session, mut stopped: watch::Receiver<bool>, approval: Approval) {
    let id = session.id.clone();
    let ended = match db::db().await {
        Ok(database) => run_on(database, &mut session, &mut stopped, &approval).await,
        Err(err) => Err(err),
    };
    let reason = match ended {
        Ok(reason) => reason,
        Err(err) => {
            tracing::error!("[agent] session {id} failed: {err}");
            Some("agent error".to_string())
        }
    };
    if let Some(reason) = reason {
        match db::db().await {
            Ok(database) => stop(database, &id, &reason).await,
            Err(err) => tracing::error!("[agent] session {id} not marked stopped: {err}"),
        }
    }
    live().remove(&id);
}

/// Marks the session stopped, tells the feed, and wakes the task.
pub async fn stop(database: &Db, session_id: &str, reason: &str) {
    match agent::stop_session(database, session_id, reason).await {
        Ok(Some(stopped)) => publish(session_id, session_frame(&stopped)),
        Ok(None) => {}
        Err(err) => tracing::error!("[agent] session {session_id} not marked stopped: {err}"),
    }
    halt(session_id);
}

/// `Some(reason)` when the agent stops itself, `None` when it was stopped. An
/// open bet is always followed to its result first, even after a stop, so the
/// session's P&L is complete when the task ends.
async fn run_on(
    database: &Db,
    session: &mut Session,
    stopped: &mut watch::Receiver<bool>,
    approval: &Approval,
) -> ApiResult<Option<String>> {
    let mut open: Option<String> = None;
    let mut human_checked = false;
    loop {
        if let Some(decision_id) = &open {
            match agent::record_result(database, decision_id).await? {
                Some((decision, updated)) => {
                    *session = updated;
                    publish(&session.id, decision_frame(&decision));
                    publish(&session.id, session_frame(session));
                    open = None;
                }
                None => {
                    tokio::time::sleep(Duration::from_millis(SETTLE_POLL_MS)).await;
                    continue;
                }
            }
        }
        if *stopped.borrow() {
            return Ok(None);
        }
        match check(database, session, stopped, human_checked).await? {
            Placement::Stop(reason) => return Ok(Some(reason)),
            Placement::Pause => {
                if let Some(reason) = pause(database, session, stopped).await? {
                    return Ok(Some(reason));
                }
                human_checked = true;
                continue;
            }
            Placement::Opened(decision_id) => {
                open = Some(decision_id);
                continue;
            }
            Placement::Proposed { id, expires_ms } => {
                open = await_answer(database, session, &id, expires_ms, stopped, approval).await?;
                if open.is_some() {
                    continue;
                }
            }
            Placement::Noted | Placement::Gone => {}
        }
        tokio::select! {
            _ = stopped.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(agent::CHECK_EVERY_MS)) => {}
        }
    }
}

pub enum Placement {
    Noted,
    Opened(String),
    Proposed {
        id: String,
        expires_ms: i64,
    },
    Stop(String),
    /// A proposal someone else answered first.
    Gone,
    /// The YOLO agent lost half its stop-loss and waits for its human.
    Pause,
}

fn jev_proposal(
    session: &Session,
    direction: &'static str,
    stake: Decimal,
    move_15s_pct: f64,
    move_share_of_2m_range: f64,
    range_2m_pct: f64,
) -> jev::Proposal {
    let usdc = |value: Decimal| value.to_f64().unwrap_or(0.0);
    jev::Proposal {
        asset: session.asset.clone(),
        direction,
        move_15s_pct,
        move_share_of_2m_range,
        range_2m_pct,
        stake_usdc: usdc(stake),
        budget_left_usdc: usdc(session.budget - session.spent),
        stop_loss_headroom_usdc: usdc(session.stop_loss + session.realized_pnl),
        payout_multiplier: binomo_multiplier(agent::ROUND_SECONDS)
            .and_then(|multiplier| multiplier.to_f64())
            .expect("the payout table offers the agent's round length"),
    }
}

/// One look at the market, with no bet open.
async fn check(
    database: &Db,
    session: &mut Session,
    stopped: &watch::Receiver<bool>,
    human_checked: bool,
) -> ApiResult<Placement> {
    let now = now_ms();
    if now >= session.ends_at_ms {
        return Ok(Placement::Stop(agent::TIME_UP.into()));
    }
    let stake = match agent::stake(session, Decimal::ZERO) {
        Ok(stake) => stake,
        Err(reason) => return Ok(Placement::Stop(reason.into())),
    };
    if !human_checked && agent::needs_human(session) {
        return Ok(Placement::Pause);
    }
    let (direction, strike, reason, proposal) =
        match agent::signal(ticks::buffer(), &session.asset, now) {
            Signal::Skip(why) => return note(database, session, "skipped", why).await,
            Signal::Trade {
                direction,
                strike,
                reason,
                move_pct,
                range_share,
                range_pct,
            } => (
                direction,
                strike,
                reason,
                jev_proposal(session, direction, stake, move_pct, range_share, range_pct),
            ),
        };
    if jev::enabled() && session.ends_at_ms - now < jev::CLOSING_MS {
        return note(database, session, "skipped", "Session is closing").await;
    }
    let confidence = match jev::review(&proposal).await {
        Gate::Off => None,
        Gate::Pass(confidence) => Some(confidence),
        Gate::Block(confidence) => {
            return note_scored(database, session, "blocked", jev::BLOCKED, Some(confidence)).await
        }
        Gate::Failed(why) => return note(database, session, "skipped", why).await,
    };
    if *stopped.borrow() {
        return Ok(Placement::Noted);
    }
    if session.mode == "normal" {
        let proposal = agent::record_proposal(
            database,
            &session.id,
            direction,
            stake,
            &reason,
            confidence,
            now,
        )
        .await?;
        publish(&session.id, decision_frame(&proposal));
        let expires_ms = proposal.expires_at_ms.unwrap_or(now + agent::PROPOSAL_MS);
        return Ok(Placement::Proposed {
            id: proposal.id,
            expires_ms,
        });
    }
    let decision_id = uuid::Uuid::new_v4().to_string();
    let trade = Trade {
        decision_id: &decision_id,
        direction,
        strike,
        reason: &reason,
        proposal: false,
        confidence,
    };
    place(database, session, trade).await
}

/// Places nothing until the session's human steps up again through
/// `/api/agent/checkpoint`. `Some(reason)` when the wait ran out, `None` when
/// the human approved or the session was stopped.
async fn pause(
    database: &Db,
    session: &Session,
    stopped: &mut watch::Receiver<bool>,
) -> ApiResult<Option<String>> {
    let until = (now_ms() + agent::HUMAN_WAIT_MS).min(session.ends_at_ms);
    let Some(resumed) = set_paused(&session.id, Some(until)) else {
        return Ok(None);
    };
    note(database, session, "blocked", agent::WAITING_FOR_HUMAN).await?;
    let ended = loop {
        let left = Duration::from_millis((until - now_ms()).max(0) as u64);
        tokio::select! {
            _ = resumed.notified() => {}
            _ = stopped.changed() => {}
            _ = tokio::time::sleep(left) => {}
        }
        if *stopped.borrow() {
            break None;
        }
        let now = now_ms();
        let out_of_time = now >= until;
        if world::checkpoint_passed(database, &session.id, out_of_time, now).await? {
            break None;
        }
        if out_of_time {
            break Some(if now >= session.ends_at_ms {
                agent::TIME_UP
            } else {
                agent::HUMAN_CHECK_DENIED
            });
        }
    };
    set_paused(&session.id, None);
    Ok(ended.map(str::to_string))
}

/// Waits for the trader's answer or the expiry. Returns the decision id when
/// the approve placed a bet.
async fn await_answer(
    database: &Db,
    session: &mut Session,
    proposal_id: &str,
    expires_ms: i64,
    stopped: &mut watch::Receiver<bool>,
    approval: &Approval,
) -> ApiResult<Option<String>> {
    loop {
        let left = Duration::from_millis((expires_ms - now_ms()).max(0) as u64);
        tokio::select! {
            _ = approval.answered.notified() => {}
            _ = stopped.changed() => {}
            _ = tokio::time::sleep(left) => {}
        }
        let _answering = approval.lock.lock().await;
        let current = agent::decision(database, proposal_id).await?;
        if current.verdict == "awaiting" {
            if now_ms() < expires_ms {
                continue;
            }
            answer(
                database,
                session,
                proposal_id,
                "skipped",
                agent::PROPOSAL_EXPIRED,
            )
            .await?;
            return Ok(None);
        }
        if let Some(updated) = agent::session_for(database, &session.id, &session.wallet).await? {
            *session = updated;
        }
        let placed = current.verdict == "placed" && current.bet_id.is_some();
        return Ok(placed.then(|| proposal_id.to_string()));
    }
}

pub struct Trade<'a> {
    pub decision_id: &'a str,
    pub direction: &'static str,
    pub strike: f64,
    pub reason: &'a str,
    /// Placing an approved proposal rather than a new yolo trade.
    pub proposal: bool,
    pub confidence: Option<f64>,
}

/// Holds the stake under every limit, runs the locked bet path, and records
/// what happened. Shared by yolo trades and approved proposals.
pub async fn place(database: &Db, session: &mut Session, trade: Trade<'_>) -> ApiResult<Placement> {
    let id = trade.decision_id;
    let reserved = agent::reserve(
        database,
        &session.id,
        Reservation {
            decision_id: id,
            direction: trade.direction,
            reason: trade.reason,
            proposal: trade.proposal,
            confidence: trade.confidence,
        },
        now_ms(),
    )
    .await?;
    let stake = match reserved {
        Reserve::Held(stake) => stake,
        Reserve::Gone => return Ok(Placement::Gone),
        Reserve::Blocked if trade.proposal => {
            return answer(database, session, id, "blocked", agent::HOUSE_LIMIT).await
        }
        Reserve::Blocked => return note(database, session, "blocked", agent::HOUSE_LIMIT).await,
        Reserve::Stop(reason) => {
            if trade.proposal {
                answer(database, session, id, "skipped", reason).await?;
            }
            return Ok(Placement::Stop(reason.into()));
        }
    };
    let body = agent::bet_body(session, id, trade.direction, trade.strike, stake);
    let refused = match place_bet(&body).await {
        BetOutcome::Placed { bet_id } => {
            let (decision, updated) = agent::confirm(database, id, &bet_id).await?;
            *session = updated;
            publish(&session.id, decision_frame(&decision));
            publish(&session.id, session_frame(session));
            return Ok(Placement::Opened(id.to_string()));
        }
        BetOutcome::PriceMoved => Refused::Skip("Price moved before the bet"),
        BetOutcome::PriceUnavailable => Refused::Skip("Live price unavailable"),
        BetOutcome::Banned => Refused::Stop("Wallet is banned".into(), "banned".into()),
        BetOutcome::InsufficientBalance => Refused::Stop(
            "Insufficient house balance".into(),
            "insufficient balance".into(),
        ),
        BetOutcome::Rejected(message) => Refused::Stop(message.clone(), message),
    };
    let (how, outcome) = match refused {
        Refused::Skip(why) if trade.proposal => {
            (Release::Mark("skipped", why.into()), Placement::Noted)
        }
        Refused::Skip(why) => {
            *session = agent::release(database, id, Release::Drop).await?.1;
            return note(database, session, "skipped", why).await;
        }
        Refused::Stop(why, reason) => (Release::Mark("rejected", why), Placement::Stop(reason)),
    };
    let (decision, updated) = agent::release(database, id, how).await?;
    *session = updated;
    if let Some(decision) = decision {
        publish(&session.id, decision_frame(&decision));
    }
    Ok(outcome)
}

/// A refusal skips the proposal, or stops the session with `(row reason, stop reason)`.
enum Refused {
    Skip(&'static str),
    Stop(String, String),
}

async fn note(
    database: &Db,
    session: &Session,
    verdict: &'static str,
    why: &str,
) -> ApiResult<Placement> {
    note_scored(database, session, verdict, why, None).await
}

async fn note_scored(
    database: &Db,
    session: &Session,
    verdict: &'static str,
    why: &str,
    confidence: Option<f64>,
) -> ApiResult<Placement> {
    let decision =
        agent::record_note(database, &session.id, verdict, why, confidence, now_ms()).await?;
    publish(&session.id, decision_frame(&decision));
    Ok(Placement::Noted)
}

/// Settles a waiting proposal with `verdict` and tells the feed.
pub async fn answer(
    database: &Db,
    session: &Session,
    decision_id: &str,
    verdict: &'static str,
    why: &str,
) -> ApiResult<Placement> {
    if let Some(decision) = agent::resolve(database, decision_id, verdict, why).await? {
        publish(&session.id, decision_frame(&decision));
    }
    Ok(Placement::Noted)
}
