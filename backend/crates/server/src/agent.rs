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

/// `Some(reason)` when the agent stops itself, `None` when it was stopped.
async fn run_on(
    database: &Db,
    session: &mut Session,
    stopped: &mut watch::Receiver<bool>,
) -> ApiResult<Option<String>> {
    loop {
        if *stopped.borrow() {
            return Ok(None);
        }
        if let Some(reason) = check(database, session, stopped).await? {
            return Ok(Some(reason));
        }
        tokio::select! {
            _ = stopped.changed() => return Ok(None),
            _ = tokio::time::sleep(Duration::from_millis(agent::CHECK_EVERY_MS)) => {}
        }
    }
}

async fn check(
    database: &Db,
    session: &mut Session,
    stopped: &watch::Receiver<bool>,
) -> ApiResult<Option<String>> {
    let now = now_ms();
    if now >= session.ends_at_ms {
        return Ok(Some(agent::TIME_UP.into()));
    }
    let Some(stake) = agent::stake(session) else {
        return Ok(Some(agent::LIMIT_REACHED.into()));
    };
    let (direction, strike, reason) = match agent::signal(ticks::buffer(), &session.asset, now) {
        Signal::Skip(why) => return skip(database, session, why).await,
        Signal::Trade {
            direction,
            strike,
            reason,
        } => (direction, strike, reason),
    };
    if *stopped.borrow() {
        return Ok(None);
    }

    let decision_id = uuid::Uuid::new_v4().to_string();
    let body = agent::bet_body(session, &decision_id, direction, strike, stake);
    let (bet_id, rejection, stop) = match place_bet(&body).await {
        BetOutcome::Placed { bet_id } => (Some(bet_id), None, None),
        BetOutcome::PriceMoved => {
            return skip(database, session, "Price moved before the bet").await
        }
        BetOutcome::PriceUnavailable => {
            return skip(database, session, "Live price unavailable").await
        }
        BetOutcome::Banned => (None, Some("Wallet is banned".to_string()), Some("banned")),
        BetOutcome::InsufficientBalance => (
            None,
            Some("Insufficient house balance".to_string()),
            Some("insufficient balance"),
        ),
        BetOutcome::Rejected(message) => (None, Some(message), None),
    };
    let recorded_reason = rejection.clone().unwrap_or(reason);
    let placed = bet_id.is_some();
    let trade = agent::Trade {
        decision_id,
        direction: direction.to_string(),
        stake,
        reason: recorded_reason.clone(),
        bet_id,
    };
    let (decision, updated) = agent::record_trade(database, &session.id, trade, now_ms()).await?;
    *session = updated;
    publish(&session.id, decision_frame(&decision));
    if placed {
        publish(&session.id, session_frame(session));
        return Ok(None);
    }
    Ok(Some(stop.map_or(recorded_reason, str::to_string)))
}

async fn skip(database: &Db, session: &Session, why: &str) -> ApiResult<Option<String>> {
    let decision = agent::record_skip(database, &session.id, why, now_ms()).await?;
    publish(&session.id, decision_frame(&decision));
    Ok(None)
}
