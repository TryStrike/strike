//! One task per running agent session, and the hub its feed listens on.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use tokio::sync::{broadcast, watch};

use strike_core::agent::{self, Session, Signal};
use strike_core::bets::now_ms;
use strike_core::db::{self, Db};
use strike_core::error::ApiResult;
use strike_core::ledger::BetOutcome;
use strike_core::ticks;

use crate::routes::balance_mutations::place_bet;

struct Live {
    frames: broadcast::Sender<String>,
    stop: watch::Sender<bool>,
}

static LIVE: Lazy<Mutex<HashMap<String, Live>>> = Lazy::new(Mutex::default);

fn live() -> std::sync::MutexGuard<'static, HashMap<String, Live>> {
    LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn session_frame(session: &Session) -> String {
    format!("event: session\ndata: {}\n\n", session.to_json())
}

pub fn decision_frame(decision: &agent::Decision) -> String {
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

pub fn spawn(session: Session) {
    let (frames, _) = broadcast::channel(256);
    let (stop, stopped) = watch::channel(false);
    live().insert(session.id.clone(), Live { frames, stop });
    tokio::spawn(run(session, stopped));
}

async fn run(mut session: Session, mut stopped: watch::Receiver<bool>) {
    let id = session.id.clone();
    let ended = match db::db().await {
        Ok(database) => run_on(database, &mut session, &mut stopped).await,
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
            Ok(database) => match agent::stop_session(database, &id, &reason).await {
                Ok(Some(stopped)) => publish(&id, session_frame(&stopped)),
                Ok(None) => {}
                Err(err) => tracing::error!("[agent] session {id} not marked stopped: {err}"),
            },
            Err(err) => tracing::error!("[agent] session {id} not marked stopped: {err}"),
        }
    }
    live().remove(&id);
}

/// `Some(reason)` when the agent stops itself, `None` when it was stopped. An
/// open bet is always followed to its result first, even after a stop, so the
/// session's P&L is complete when the task ends.
async fn run_on(
    database: &Db,
    session: &mut Session,
    stopped: &mut watch::Receiver<bool>,
) -> ApiResult<Option<String>> {
    let mut open: Option<String> = None;
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
        match check(database, session, stopped).await? {
            Next::Stop(reason) => return Ok(Some(reason)),
            Next::Opened(decision_id) => {
                open = Some(decision_id);
                continue;
            }
            Next::Idle => {}
        }
        tokio::select! {
            _ = stopped.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(agent::CHECK_EVERY_MS)) => {}
        }
    }
}

/// How often an open bet is looked up. The sweep settles once a second.
const SETTLE_POLL_MS: u64 = 1_000;

enum Next {
    Idle,
    Opened(String),
    Stop(String),
}

/// One look at the market, with no bet open.
async fn check(
    database: &Db,
    session: &mut Session,
    stopped: &watch::Receiver<bool>,
) -> ApiResult<Next> {
    let now = now_ms();
    if now >= session.ends_at_ms {
        return Ok(Next::Stop(agent::TIME_UP.into()));
    }
    if let Err(reason) = agent::stake(session, rust_decimal::Decimal::ZERO) {
        return Ok(Next::Stop(reason.into()));
    }
    let (direction, strike, reason) = match agent::signal(ticks::buffer(), &session.asset, now) {
        Signal::Skip(why) => return note(database, session, "skipped", why).await,
        Signal::Trade {
            direction,
            strike,
            reason,
        } => (direction, strike, reason),
    };
    if *stopped.borrow() {
        return Ok(Next::Idle);
    }

    let decision_id = uuid::Uuid::new_v4().to_string();
    let stake =
        match agent::reserve(database, &session.id, &decision_id, direction, &reason, now).await? {
            agent::Reserve::Held(stake) => stake,
            agent::Reserve::Blocked => {
                return note(database, session, "blocked", agent::HOUSE_LIMIT).await
            }
            agent::Reserve::Stop(reason) => return Ok(Next::Stop(reason.into())),
        };
    let body = agent::bet_body(session, &decision_id, direction, strike, stake);
    let refused = match place_bet(&body).await {
        BetOutcome::Placed { bet_id } => {
            let (decision, updated) = agent::confirm(database, &decision_id, &bet_id).await?;
            *session = updated;
            publish(&session.id, decision_frame(&decision));
            publish(&session.id, session_frame(session));
            return Ok(Next::Opened(decision_id));
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
    match refused {
        Refused::Skip(why) => {
            *session = agent::release(database, &decision_id, None).await?.1;
            note(database, session, "skipped", why).await
        }
        Refused::Stop(why, reason) => {
            let (decision, updated) = agent::release(database, &decision_id, Some(&why)).await?;
            *session = updated;
            if let Some(decision) = decision {
                publish(&session.id, decision_frame(&decision));
            }
            Ok(Next::Stop(reason))
        }
    }
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
) -> ApiResult<Next> {
    let decision = agent::record_note(database, &session.id, verdict, why, now_ms()).await?;
    publish(&session.id, decision_frame(&decision));
    Ok(Next::Idle)
}
