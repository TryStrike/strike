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

use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::copilot;
use strike_core::crypto::{self, AGENT_COOKIE};
use strike_core::error::ApiError;
use strike_core::ticks;

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
    let asker = match crypto::verify_agent_token(http::cookie(&headers, AGENT_COOKIE).as_deref()) {
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
    tokio::spawn(answer(key, messages, ticket_open, tx));
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

async fn answer(key: String, mut messages: Vec<Value>, ticket_open: bool, tx: Frames) {
    let (event, data) = match converse(&key, &mut messages, ticket_open, &tx).await {
        Ok(()) => ("done", json!({})),
        Err(why) => {
            tracing::warn!("[copilot] {why}");
            ("error", json!({ "error": why }))
        }
    };
    // A client that already hung up has nobody left to tell.
    let _ = send(&tx, event, data);
}

async fn converse(
    key: &str,
    messages: &mut Vec<Value>,
    ticket_open: bool,
    tx: &Frames,
) -> Result<(), String> {
    let mut desk = copilot::Desk::new(ticks::buffer(), now_ms(), ticket_open);
    for turn_number in 0..=copilot::MAX_TOOL_TURNS {
        let turn = copilot::stream_turn(key, messages, ticket_open, |text| {
            send(tx, "text", json!({ "text": text }))
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
            let ran = desk.run(&tool);
            if let Some(action) = ran.action {
                send(tx, "action", action)?;
            }
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
