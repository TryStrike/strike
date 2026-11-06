//! `POST /api/copilot`: one question, streamed back as SSE. `text` frames carry
//! answer deltas, `action` frames carry typed UI actions, then `done` or `error`.

use std::convert::Infallible;
use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use strike_core::agent;
use strike_core::bets::now_ms;
use strike_core::bets::{canonical_address, HistoryQuery};
use strike_core::config::config;
use strike_core::copilot;
use strike_core::copilot::{Ran, ToolUse};
use strike_core::crypto::{self, AgentClaims, AGENT_COOKIE};
use strike_core::db;
use strike_core::error::ApiError;
use strike_core::ticks;
use rust_decimal::prelude::ToPrimitive;

use crate::http;
use crate::routes::stream::sse_headers;

pub fn routes() -> Router {
    Router::new().route("/api/copilot", post(ask))
}

async fn ask(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let Some(key) = config().anthropic_api_key.clone() else {
        return ApiError::unavailable("The copilot is not configured on this server")
            .into_response();
    };
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return ApiError::bad_request("Body must be JSON with messages").into_response();
    };
    let messages = match copilot::conversation(&body) {
        Ok(messages) => messages,
        Err(why) => return ApiError::bad_request(why).into_response(),
    };
    let claims = crypto::verify_agent_token(http::cookie(&headers, AGENT_COOKIE).as_deref());
    let asker = match &claims {
        Some(claims) => format!("wallet:{}", claims.wallet),
        None => format!("ip:{}", http::client_ip(&headers, peer.ip())),
    };
    if !copilot::take_question(&asker, now_ms()) {
        return http::too_many(copilot::RATE_LIMITED, 60);
    }

    let ticket_open = body
        .get("ticketOpen")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(answer(key, messages, ticket_open, claims, tx));
    let frames = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|frame| (Ok::<_, Infallible>(frame), rx))
    });
    (
        StatusCode::OK,
        sse_headers(),
        axum::body::Body::from_stream(frames),
    )
        .into_response()
}

type Frames = mpsc::UnboundedSender<String>;

/// `Err` once the client has hung up, so no more turns are paid for.
fn send(tx: &Frames, event: &str, data: Value) -> Result<(), String> {
    tx.send(format!("event: {event}\ndata: {data}\n\n"))
        .map_err(|_| "client disconnected".to_string())
}

async fn answer(
    key: String,
    mut messages: Vec<Value>,
    ticket_open: bool,
    claims: Option<AgentClaims>,
    tx: Frames,
) {
    let context = copilot::Context {
        ticket_open,
        has_session: claims.is_some(),
    };
    let build = |messages: &[Value]| copilot::request(messages, context);
    let sink = |event: &str, data: Value| match event {
        "thinking" => Ok(()),
        event => send(&tx, event, data),
    };
    let (event, data) = match converse(
        &key,
        &mut messages,
        ticket_open,
        claims.as_ref(),
        build,
        sink,
    )
    .await
    {
        Ok(()) => ("done", json!({})),
        Err(why) => {
            tracing::warn!("[copilot] {why}");
            ("error", json!({ "error": why }))
        }
    };
    // A client that already hung up has nobody left to tell.
    let _ = send(&tx, event, data);
}

/// The tool loop. `build` shapes each request and `sink` gets every `thinking`,
/// `text`, `tool` and `action` frame, and its `Err` ends the loop.
pub async fn converse(
    key: &str,
    messages: &mut Vec<Value>,
    ticket_open: bool,
    claims: Option<&AgentClaims>,
    build: impl Fn(&[Value]) -> Value,
    sink: impl Fn(&str, Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut desk = copilot::Desk::new(ticks::buffer(), now_ms(), ticket_open);
    for turn_number in 0..=copilot::MAX_TOOL_TURNS {
        let turn = copilot::stream_turn(key, &build(messages), |delta| match delta {
            copilot::Delta::Text(text) => sink("text", json!({ "text": text })),
            copilot::Delta::Thinking(text) => sink("thinking", json!({ "thinking": text })),
        })
        .await?;
        match turn.stop_reason.as_deref() {
            Some("end_turn") | Some("stop_sequence") => return Ok(()),
            Some("tool_use") => {}
            Some("max_tokens") => return Err("The copilot's answer ran too long".into()),
            Some("refusal") => return Err("The copilot declined this question".into()),
            other => return Err(format!("Claude stopped unexpectedly: {other:?}")),
        }
        if turn_number == copilot::MAX_TOOL_TURNS {
            return Err(copilot::TOO_MANY_TOOL_TURNS.into());
        }
        let mut results = Vec::new();
        for tool in turn.tool_uses() {
            let ran = if copilot::PERSONAL.contains(&tool.name.as_str()) {
                personal(&tool, claims).await
            } else {
                desk.run(&tool)
            };
            if let Some(action) = ran.action {
                sink("action", action)?;
            }
            let label = copilot::step_label(&tool.name);
            let step = if ran.is_error {
                json!({ "label": label, "ok": false, "error": ran.content })
            } else {
                json!({ "label": label, "ok": true })
            };
            sink("tool", step)?;
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": tool.id,
                "content": ran.content,
                "is_error": ran.is_error,
            }));
        }
        messages.push(json!({ "role": "assistant", "content": turn.blocks }));
        messages.push(json!({ "role": "user", "content": results }));
    }
    Err(copilot::TOO_MANY_TOOL_TURNS.into())
}

/// Decisions the copilot reads back. Enough to explain a stop, small enough
/// to keep the turn cheap.
const DECISIONS_READ: i64 = 20;
const HISTORY_READ: i64 = 20;

/// A personal tool, scoped to the token's own wallet and session. The model
/// never names a wallet or a session: both come from the cookie.
async fn personal(tool: &ToolUse, claims: Option<&AgentClaims>) -> Ran {
    let Some(claims) = claims else {
        return refused(copilot::NO_SESSION);
    };
    match read_personal(tool, claims).await {
        Ok(value) => Ran {
            content: value.to_string(),
            is_error: false,
            action: None,
        },
        Err(why) => refused(&why),
    }
}

fn refused(why: &str) -> Ran {
    Ran {
        content: why.to_string(),
        is_error: true,
        action: None,
    }
}

async fn read_personal(tool: &ToolUse, claims: &AgentClaims) -> Result<Value, String> {
    let database = db::db()
        .await
        .map_err(|err| format!("The ledger is unavailable: {err}"))?;
    let session = || async {
        agent::session_for(database, &claims.session_id, &claims.wallet)
            .await
            .map_err(|err| format!("The agent session could not be read: {err}"))?
            .ok_or_else(|| copilot::NO_SESSION.to_string())
    };
    match tool.name.as_str() {
        "get_agent_decisions" => {
            let session = session().await?;
            let decisions = agent::recent_decisions(database, &session.id, DECISIONS_READ)
                .await
                .map_err(|err| format!("The decisions could not be read: {err}"))?;
            let decisions: Vec<Value> = decisions.iter().map(agent::Decision::to_json).collect();
            Ok(json!({ "session": session.to_json(), "decisions": decisions }))
        }
        "get_session_limits" => {
            let cfg = config();
            Ok(json!({
                "session": session().await?.to_json(),
                "ceilings": {
                    "maxPerTrade": cfg.agent_max_per_trade.to_f64(),
                    "maxBudget": cfg.agent_max_budget.to_f64(),
                    "maxMinutes": cfg.agent_max_minutes,
                    "maxOpenStake": cfg.agent_max_open_stake.to_f64(),
                },
            }))
        }
        "get_trade_history" => {
            let query = HistoryQuery {
                address: canonical_address(&claims.wallet),
                limit: HISTORY_READ,
                offset: 0,
                paged: false,
                asset: None,
                outcome: None,
                direction: None,
                from: None,
                to: None,
            };
            crate::routes::bets::history::run(query)
                .await
                .map_err(|err| format!("The trade history could not be read: {err}"))
        }
        "get_round_proof" => {
            let bet_id = tool
                .input
                .get("bet_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if !crate::routes::bets::bet_id::bet_id_ok(bet_id) {
                return Err("That is not a bet id".into());
            }
            let mut proof =
                crate::routes::bets::bet_id::run(bet_id, &canonical_address(&claims.wallet))
                    .await
                    .map_err(|_| "No settled bet with that id for this wallet".to_string())?;
            proof["onchain"] = match strike_core::proofs::bet_proof(database, bet_id).await {
                Ok(Some(onchain)) => json!({
                    "epoch": onchain["epoch"],
                    "status": onchain["status"],
                    "commit_tx": onchain["commit_tx"],
                }),
                Ok(None) => json!({ "status": "not_a_round" }),
                Err(err) => {
                    json!({ "error": format!("The onchain proof could not be read: {err}") })
                }
            };
            Ok(proof)
        }
        other => Err(format!("There is no tool called {other}")),
    }
}
