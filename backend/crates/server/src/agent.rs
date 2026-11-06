use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use tokio::sync::{broadcast, mpsc, watch, Notify};

use serde_json::{json, Value};
use strike_core::agent::{
    self, Decision, Proposed, Release, Reservation, Reserve, Session, Signal,
};
use strike_core::agentpass::{self, Action, Stepup};
use strike_core::bets::now_ms;
use strike_core::db::{self, Db};
use strike_core::error::ApiResult;
use strike_core::jev::{self, Gate};
use strike_core::ledger::BetOutcome;
use strike_core::ledger::Rejection;
use strike_core::settlement::binomo_multiplier;
use strike_core::ticks;

use crate::routes::balance_mutations::place_bet;

const SETTLE_POLL_MS: u64 = 1_000;
const PAUSE_POLL_MS: u64 = 1_000;

struct Live {
    frames: broadcast::Sender<String>,
    watcher: Option<mpsc::UnboundedSender<String>>,
    stop: watch::Sender<bool>,
    approval: Approval,
}

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

pub fn subscribe(session_id: &str) -> Option<broadcast::Receiver<String>> {
    live().get(session_id).map(|l| l.frames.subscribe())
}

pub fn publish(session_id: &str, frame: String) {
    if let Some(l) = live().get(session_id) {
        if let Some(watcher) = &l.watcher {
            let _ = watcher.send(frame.clone());
        }
        let _ = l.frames.send(frame);
    }
}

/// One step of a check as it happens. Live only: never stored or replayed.
fn step(session_id: &str, data: Value) {
    if let Some(l) = live().get(session_id) {
        let _ = l.frames.send(format!("event: check\ndata: {data}\n\n"));
    }
}

/// Wakes the task so it ends without placing another bet.
pub fn halt(session_id: &str) {
    if let Some(l) = live().get(session_id) {
        let _ = l.stop.send(true);
    }
}

pub fn approval(session_id: &str) -> Option<Approval> {
    live().get(session_id).map(|l| l.approval.clone())
}

pub fn stepup_frame(stepup: &Stepup) -> String {
    format!("event: stepup\ndata: {}\n\n", stepup.to_json())
}

pub fn spawn(session: Session) {
    let (frames, _) = broadcast::channel(256);
    let (stop, stopped) = watch::channel(false);
    let approval = Approval {
        lock: Arc::default(),
        answered: Arc::default(),
    };
    let watcher = crate::watcher::spawn(&session, frames.clone());
    live().insert(
        session.id.clone(),
        Live {
            frames,
            watcher,
            stop,
            approval: approval.clone(),
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

/// Finishes results no task is left to follow, after a restart or a failed task.
pub async fn run_result_recorder() {
    let mut every = tokio::time::interval(Duration::from_millis(agent::CHECK_EVERY_MS));
    loop {
        every.tick().await;
        if let Err(err) = record_unfollowed().await {
            tracing::error!("[agent] results not recorded: {err}");
        }
    }
}

async fn record_unfollowed() -> ApiResult<()> {
    let database = db::db().await?;
    for (decision_id, session_id) in agent::unrecorded_results(database).await? {
        if !live().contains_key(&session_id) {
            agent::record_result(database, &decision_id).await?;
        }
    }
    Ok(())
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

async fn run_on(
    database: &'static Db,
    session: &mut Session,
    stopped: &mut watch::Receiver<bool>,
    approval: &Approval,
) -> ApiResult<Option<String>> {
    let mut open: Option<String> = None;
    let mut chase_cleared: Option<String> = None;
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
        match check(database, session, stopped, chase_cleared.as_deref()).await? {
            Placement::Stop(reason) => return Ok(Some(reason)),
            Placement::Pause(why) => {
                if let Some(reason) = pause(database, session, &why, stopped).await? {
                    return Ok(Some(reason));
                }
                if let Pause::Chase(after) = why {
                    chase_cleared = Some(after);
                }
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
            Placement::Noted | Placement::Gone | Placement::Refused(_) => {}
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
    Proposed { id: String, expires_ms: i64 },
    Stop(String),
    Gone,
    Pause(Pause),
    Refused(Rejection),
}

pub enum Pause {
    Checkpoint,
    Chase(String),
}

impl Pause {
    fn action<'a>(&self, session: &'a Session) -> Action<'a> {
        let lost = (-session.realized_pnl).max(Decimal::ZERO).normalize();
        let (kind, key, summary) = match self {
            Pause::Checkpoint => (
                "agent_checkpoint",
                format!("{}:checkpoint:{}", session.id, session.checks_passed),
                format!(
                    "Keep YOLO agent trading: lost {lost} of {} USDC stop-loss, {}",
                    session.stop_loss.normalize(),
                    session.asset
                ),
            ),
            Pause::Chase(after) => (
                "agent_chase",
                format!("{}:chase:{after}", session.id),
                format!(
                    "Let YOLO agent raise its stake right after a loss, {}",
                    session.asset
                ),
            ),
        };
        Action {
            kind,
            key,
            summary,
            session_id: Some(&session.id),
        }
    }
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
        stop_loss_headroom_usdc: usdc(agent::stop_loss_headroom(session, Decimal::ZERO)),
        payout_multiplier: binomo_multiplier(agent::ROUND_SECONDS)
            .and_then(|multiplier| multiplier.to_f64())
            .expect("the payout table offers the agent's round length"),
    }
}

async fn check(
    database: &Db,
    session: &mut Session,
    stopped: &watch::Receiver<bool>,
    chase_cleared: Option<&str>,
) -> ApiResult<Placement> {
    let now = now_ms();
    if now >= session.ends_at_ms {
        return Ok(Placement::Stop(agent::TIME_UP.into()));
    }
    let stake = match agent::stake(session, Decimal::ZERO) {
        Ok(stake) => stake,
        Err(reason) => return Ok(Placement::Stop(reason.into())),
    };
    if agent::needs_human(session) {
        return Ok(Placement::Pause(Pause::Checkpoint));
    }
    if session.mode == "yolo" {
        let last = agent::last_loss(database, &session.id).await?;
        if agent::chasing(last.as_ref(), stake, now) {
            let after = last.map(|(id, _, _)| id).unwrap_or_default();
            if chase_cleared != Some(after.as_str()) {
                return Ok(Placement::Pause(Pause::Chase(after)));
            }
        }
    }
    let signal = agent::signal(ticks::buffer(), &session.asset, now);
    let closing = session.ends_at_ms - now < agent::CLOSING_MS;
    let skip = match &signal {
        Signal::Skip(why) => Some(*why),
        Signal::Trade { .. } if closing => Some("Session is closing"),
        Signal::Trade { .. } => None,
    };
    let read = agent::reading(ticks::buffer(), &session.asset, now);
    step(
        &session.id,
        json!({
            "stage": "signal",
            "at": now,
            "price": read.as_ref().map(|r| r.price),
            "movePct": read.as_ref().map(|r| r.move_pct),
            "rangeShare": read.as_ref().map(|r| r.range_share),
            "needed": agent::MOVE_THRESHOLD,
            "skip": skip,
            "stake": stake.to_f64(),
            "room": agent::stop_loss_headroom(session, Decimal::ZERO).to_f64(),
        }),
    );
    let (direction, strike, reason, proposal) = match signal {
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
    if closing {
        return note(database, session, "skipped", "Session is closing").await;
    }
    let needed = jev::enabled().then(|| jev::needed(proposal.payout_multiplier));
    let trace = agent::trace(session, &reason, needed);
    if jev::enabled() {
        step(&session.id, json!({ "stage": "ai", "status": "running" }));
    }
    let asked = std::time::Instant::now();
    let gate = jev::review(&proposal).await;
    let ms = asked.elapsed().as_millis() as u64;
    let ai = |status: &str, score: Option<f64>, why: Option<&str>| json!({ "stage": "ai", "status": status, "score": score, "needed": needed, "why": why, "ms": ms });
    step(
        &session.id,
        match &gate {
            Gate::Off => ai("off", None, None),
            Gate::Pass(score) => ai("pass", Some(*score), None),
            Gate::Block(score) => ai("block", Some(*score), None),
            Gate::Failed(why) => ai("failed", None, Some(why)),
        },
    );
    let confidence = match gate {
        Gate::Off => None,
        Gate::Pass(confidence) => Some(confidence),
        Gate::Block(confidence) => {
            let proposed = Proposed {
                direction,
                stake,
                trace,
            };
            return note_scored(
                database,
                session,
                "blocked",
                jev::BLOCKED,
                Some(confidence),
                Some(proposed),
            )
            .await;
        }
        Gate::Failed(why) => return note(database, session, "skipped", why).await,
    };
    if *stopped.borrow() {
        return Ok(Placement::Noted);
    }
    if session.mode == "normal" {
        let recorded = agent::record_proposal(
            database,
            &session.id,
            Proposed {
                direction,
                stake,
                trace,
            },
            &reason,
            confidence,
            now,
        )
        .await?;
        let Some(proposal) = recorded else {
            return Ok(Placement::Gone);
        };
        publish(&session.id, decision_frame(&proposal));
        step(
            &session.id,
            json!({ "stage": "result", "outcome": "proposed" }),
        );
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
        trace: Some(&trace),
        stepup: None,
    };
    let placed = place(database, session, trade).await?;
    let outcome = match placed {
        Placement::Opened(_) => "placed",
        _ => "refused",
    };
    step(
        &session.id,
        json!({ "stage": "result", "outcome": outcome }),
    );
    Ok(placed)
}

async fn pause(
    database: &'static Db,
    session: &mut Session,
    why: &Pause,
    stopped: &mut watch::Receiver<bool>,
) -> ApiResult<Option<String>> {
    let now = now_ms();
    let until = (now + agent::human_wait_ms()).min(session.ends_at_ms);
    let Ok(human) = agentpass::require_human(database, &session.wallet).await? else {
        return Ok(Some(agent::HUMAN_REQUIRED.into()));
    };
    let stepup = match agentpass::begin(database, &human, &session.wallet, why.action(session), now)
        .await?
    {
        Ok(stepup) => Some(stepup),
        Err((status, body)) => {
            tracing::warn!(
                "[agent] session {} stepup refused: {status} {body}",
                session.id
            );
            None
        }
    };
    let pausing = agent::pause(
        database,
        &session.id,
        until,
        stepup.as_ref().map(|s| s.id.as_str()),
    );
    let Some(paused) = pausing.await? else {
        return Ok(None);
    };
    *session = paused;
    publish(&session.id, session_frame(session));
    if let Some(stepup) = &stepup {
        publish(&session.id, stepup_frame(stepup));
    }
    note(database, session, "blocked", agent::WAITING_FOR_HUMAN).await?;
    loop {
        tokio::select! {
            _ = stopped.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(PAUSE_POLL_MS)) => {}
        }
        if *stopped.borrow() {
            return Ok(None);
        }
        let now = now_ms();
        let Some(current) = agent::session_for(database, &session.id, &session.wallet).await?
        else {
            return Ok(None);
        };
        if current.status != "running" {
            return Ok(None);
        }
        let status = match &current.pause_stepup_id {
            Some(id) => agentpass::get(database, id, now).await?.map(|s| s.status),
            None => None,
        };
        match status.as_deref() {
            Some("approved") => match agent::resume(database, &session.id, now).await? {
                Ok(resumed) => {
                    *session = resumed;
                    publish(&session.id, session_frame(session));
                    return Ok(None);
                }
                Err((403, _)) => return Ok(Some(agent::HUMAN_CHECK_DENIED.into())),
                Err(_) => {}
            },
            Some("denied" | "mismatch" | "cancelled") => {
                return Ok(Some(agent::HUMAN_CHECK_DENIED.into()))
            }
            _ => {}
        }
        if now >= until {
            return Ok(Some(if now >= session.ends_at_ms {
                agent::TIME_UP.into()
            } else {
                agent::HUMAN_CHECK_EXPIRED.into()
            }));
        }
    }
}

async fn await_answer(
    database: &Db,
    session: &mut Session,
    proposal_id: &str,
    mut expires_ms: i64,
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
            expires_ms = current.expires_at_ms.unwrap_or(expires_ms).max(expires_ms);
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
    pub proposal: bool,
    pub confidence: Option<f64>,
    pub trace: Option<&'a Value>,
    pub stepup: Option<&'a str>,
}

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
            trace: trade.trace,
            stepup: trade.stepup,
        },
        now_ms(),
    )
    .await?;
    let stake = match reserved {
        Reserve::Held(stake) => stake,
        Reserve::Gone => return Ok(Placement::Gone),
        Reserve::Refused(refused) => return Ok(Placement::Refused(refused)),
        Reserve::Paused if trade.proposal => {
            return answer(database, session, id, "blocked", agent::WAITING_FOR_HUMAN).await
        }
        Reserve::Paused => {
            return note(database, session, "blocked", agent::WAITING_FOR_HUMAN).await
        }
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
    note_scored(database, session, verdict, why, None, None).await
}

async fn note_scored(
    database: &Db,
    session: &Session,
    verdict: &'static str,
    why: &str,
    confidence: Option<f64>,
    proposed: Option<Proposed>,
) -> ApiResult<Placement> {
    let decision = agent::record_note(
        database,
        &session.id,
        verdict,
        why,
        confidence,
        proposed,
        now_ms(),
    )
    .await?;
    publish(&session.id, decision_frame(&decision));
    Ok(Placement::Noted)
}

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
