//! The watcher: a read-only copilot run beside a yolo agent. It reads the same
//! frames the trader gets, so it can't delay or change a decision, and it holds
//! its own sender so its last thought outlives the session.

use std::collections::HashSet;

use serde_json::{json, Value};
use tokio::sync::broadcast::Sender;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use strike_core::agent::Session;
use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::copilot;
use strike_core::crypto::AgentClaims;

use crate::routes::copilot::converse;

/// Where the session sends its frames for the watcher. `None` when it has none.
pub fn spawn(session: &Session, frames: Sender<String>) -> Option<UnboundedSender<String>> {
    let key = config().anthropic_api_key.clone()?;
    if session.mode != "yolo" {
        return None;
    }
    let claims = AgentClaims {
        session_id: session.id.clone(),
        wallet: session.wallet.clone(),
        exp: session.ends_at_ms / 1_000,
    };
    let (events, received) = mpsc::unbounded_channel();
    tokio::spawn(run(key, claims, frames, received));
    Some(events)
}

#[derive(Default)]
struct Watch {
    seen: HashSet<String>,
    latest: Option<Value>,
    over: bool,
}

impl Watch {
    /// Keeps the newest event worth a call: a placed bet, a jev block, a result or a stop.
    fn take(&mut self, frame: &str) {
        let Some((head, data)) = frame.split_once('\n') else {
            return;
        };
        let Some(Ok(event)) = data
            .trim()
            .strip_prefix("data: ")
            .map(serde_json::from_str::<Value>)
        else {
            return;
        };
        let wanted = match head {
            "event: decision" => {
                event["verdict"] == "placed"
                    || (event["verdict"] == "blocked" && !event["trace"].is_null())
            }
            "event: session" if event["status"] == "stopped" => {
                self.over = true;
                true
            }
            _ => false,
        };
        let id = format!("{}:{}:{}", event["id"], event["verdict"], event["result"]);
        if wanted && self.seen.insert(id) {
            self.latest = Some(event);
        }
    }
}

async fn run(
    key: String,
    claims: AgentClaims,
    frames: Sender<String>,
    mut events: UnboundedReceiver<String>,
) {
    let mut watch = Watch::default();
    while let Some(frame) = events.recv().await {
        watch.take(&frame);
        while let Ok(frame) = events.try_recv() {
            watch.take(&frame);
        }
        if let Some(event) = watch.latest.take() {
            if let Err(why) = think(&key, &claims, &frames, &event).await {
                tracing::warn!("[watcher] session {}: {why}", claims.session_id);
            }
        }
        if watch.over {
            return;
        }
    }
}

async fn think(
    key: &str,
    claims: &AgentClaims,
    frames: &Sender<String>,
    event: &Value,
) -> Result<(), String> {
    let (id, at) = (uuid::Uuid::new_v4().to_string(), now_ms());
    let sink = |kind: &str, data: Value| {
        let part = match kind {
            "tool" => json!({ "step": data }),
            _ => data,
        };
        let mut frame = part;
        frame["id"] = json!(id);
        frame["at"] = json!(at);
        let _ = frames.send(format!("event: thought\ndata: {frame}\n\n"));
        Ok(())
    };
    let mut messages = vec![json!({ "role": "user", "content": format!("Latest event: {event}") })];
    converse(key, &mut messages, claims, copilot::watch_request, sink).await
}
