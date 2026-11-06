use std::convert::Infallible;

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use strike_core::agent;
use strike_core::agentpass::{self, Action};
use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::crypto::{self, AgentClaims, AGENT_COOKIE};
use strike_core::db::{self, Db};
use strike_core::error::ApiError;
use strike_core::eth;
use strike_core::ledger::Rejection;
use strike_core::prices;
use strike_core::stream;

use crate::agent as live;
use crate::bans;
use crate::http::{self, Cookie};
use crate::routes::stepup::{reply, stepup_id};
use crate::routes::stream::sse_headers;

const REPLAY: i64 = 50;
const COOKIE_GRACE_SECONDS: i64 = 3_600;
pub(crate) const AGENTS_NOT_CONFIGURED: &str = "Agent sessions are not configured on this server";

pub fn routes() -> Router {
    Router::new()
        .route("/api/agent/start", post(start))
        .route("/api/agent/stop", post(stop))
        .route("/api/agent/checkpoint", post(checkpoint))
        .route("/api/agent/state", get(state))
        .route("/api/agent/decisions", get(decisions))
        .route("/api/agent/decisions/{id}/approve", post(approve))
        .route("/api/agent/decisions/{id}/reject", post(reject_proposal))
}

fn reject(rejection: Rejection) -> Response {
    reply(rejection)
}

fn claims(headers: &HeaderMap) -> Result<AgentClaims, ApiError> {
    crypto::verify_agent_token(http::cookie(headers, AGENT_COOKIE).as_deref())
        .ok_or_else(|| ApiError::unauthorized("Start an agent session first"))
}

async fn start(raw: Bytes) -> Response {
    match start_run(&raw).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

async fn start_run(raw: &[u8]) -> Result<Response, ApiError> {
    let body: Value = serde_json::from_slice(raw)
        .map_err(|_| ApiError::bad_request("Body must be JSON with message and signature"))?;
    let (Some(message), Some(signature)) = (
        body.get("message").and_then(Value::as_str),
        body.get("signature").and_then(Value::as_str),
    ) else {
        return Err(ApiError::bad_request("Missing message or signature"));
    };
    let terms = match agent::parse_start(message) {
        Ok(terms) => terms,
        Err(rejection) => return Ok(reject(rejection)),
    };
    if !eth::verify_personal_signature(&terms.wallet, message, signature).await? {
        return Err(ApiError::unauthorized(
            "Signature does not match the wallet in the message",
        ));
    }
    let now = now_ms();
    if let Err(rejection) = agent::check_start(&terms, now) {
        return Ok(reject(rejection));
    }
    if bans::is_globally_banned(&terms.wallet).await {
        return Ok(reject(agentpass::refusal(
            403,
            "banned",
            "Wallet is banned",
        )));
    }
    if !config().is_settlement_signing_configured() {
        return Err(ApiError::unavailable(AGENTS_NOT_CONFIGURED));
    }
    let database = db::db().await?;
    let human = match agentpass::require_human(database, &terms.wallet).await? {
        Ok(human) => human,
        Err(rejection) => return Ok(reject(rejection)),
    };
    let stepup = stepup_id(&body);
    if terms.mode == "yolo" {
        if human.tier != "orb" {
            return Ok(reject(agentpass::refusal(
                403,
                "human_tier_too_low",
                "A YOLO agent needs an Orb-verified World ID",
            )));
        }
        if stepup.is_none() {
            if let Some(rejection) = agent::start_precheck(database, &terms, &human.id).await? {
                return Ok(reject(rejection));
            }
            let action = Action {
                kind: "yolo_start",
                key: agent::start_key(&terms),
                summary: format!(
                    "Start YOLO agent: {} USDC, {}, {} min",
                    terms.budget.normalize(),
                    terms.asset,
                    terms.minutes
                ),
                session_id: None,
            };
            let asked = agentpass::begin(database, &human, &terms.wallet, action, now).await?;
            return Ok(reject(match asked {
                Ok(stepup) => agentpass::step_up_required(&stepup),
                Err(rejection) => rejection,
            }));
        }
    }
    Ok(
        match start_session(database, terms, now, &human.id, stepup).await? {
            Ok((session, cookie)) => http::json_with_cookie(json!({ "session": session }), cookie),
            Err(rejection) => reject(rejection),
        },
    )
}

pub(crate) async fn start_session(
    database: &'static Db,
    terms: agent::StartTerms,
    now: i64,
    human_id: &str,
    stepup: Option<String>,
) -> Result<Result<(Value, Cookie), Rejection>, ApiError> {
    let human_id = human_id.to_string();
    tokio::spawn(async move {
        Ok(
            match agent::create_session(database, terms, now, &human_id, stepup).await? {
                Ok(session) => Ok((session.to_json(), started(session)?)),
                Err(rejection) => Err(rejection),
            },
        )
    })
    .await
    .map_err(|err| {
        tracing::error!("[agent] start task failed: {err}");
        ApiError::internal("Agent start failed")
    })?
}

pub(crate) fn started(session: agent::Session) -> Result<Cookie, ApiError> {
    let ttl = (session.ends_at_ms - session.starts_at_ms) / 1_000 + COOKIE_GRACE_SECONDS;
    let token = crypto::mint_agent_token(&session.id, &session.wallet, ttl).map_err(|err| {
        tracing::error!("[agent] token not minted: {err}");
        ApiError::unavailable(AGENTS_NOT_CONFIGURED)
    })?;
    live::spawn(session);
    Ok(Cookie {
        name: AGENT_COOKIE,
        value: token,
        max_age: ttl,
        same_site: "Lax",
        http_only: true,
    })
}

async fn stop(headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let claims = claims(&headers)?;
    let database = db::db().await?;
    if agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .is_none()
    {
        return Err(no_session());
    }
    live::stop(database, &claims.session_id, agent::USER_STOPPED).await;
    let session = agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .ok_or_else(no_session)?;
    Ok(Json(json!({ "session": session.to_json() })))
}

async fn checkpoint(headers: HeaderMap) -> Result<Response, ApiError> {
    let claims = claims(&headers)?;
    let database = db::db().await?;
    let session = agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .ok_or_else(no_session)?;
    let now = now_ms();
    let not_paused = || {
        reject(agentpass::refusal(
            409,
            "not_paused",
            "The agent is not waiting for a human",
        ))
    };
    if session.status != "running" || session.paused_until_ms.is_none_or(|until| until <= now) {
        return Ok(not_paused());
    }
    let current = match &session.pause_stepup_id {
        Some(id) => agentpass::get(database, id, now).await?,
        None => None,
    };
    if let Some(stepup) = current
        .as_ref()
        .filter(|s| matches!(s.status.as_str(), "pending" | "approved"))
    {
        return Ok(Json(json!({ "stepup": stepup.to_json() })).into_response());
    }
    let human = match agentpass::require_human(database, &session.wallet).await? {
        Ok(human) => human,
        Err(rejection) => return Ok(reject(rejection)),
    };
    let (kind, key, summary) = match &current {
        Some(old) if old.kind == "agent_chase" => (
            "agent_chase",
            old.key().to_string(),
            old.subject["summary"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        ),
        _ => (
            "agent_checkpoint",
            format!("{}:checkpoint:{}", session.id, session.checks_passed),
            format!(
                "Keep YOLO agent trading: {} USDC stop-loss, {}",
                session.stop_loss.normalize(),
                session.asset
            ),
        ),
    };
    let action = Action {
        kind,
        key,
        summary,
        session_id: Some(&session.id),
    };
    let stepup = match agentpass::begin(database, &human, &session.wallet, action, now).await? {
        Ok(stepup) => stepup,
        Err(rejection) => return Ok(reject(rejection)),
    };
    if !agent::repoint_pause(database, &session.id, &stepup.id).await? {
        agentpass::cancel(database, &stepup.id, "The agent is not paused").await?;
        return Ok(not_paused());
    }
    live::publish(&session.id, live::stepup_frame(&stepup));
    Ok(Json(json!({ "stepup": stepup.to_json() })).into_response())
}

async fn state(headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let claims = claims(&headers)?;
    let database = db::db().await?;
    let session = agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .ok_or_else(no_session)?;
    let now = now_ms();
    let stepup = match &session.pause_stepup_id {
        Some(id) => agentpass::get(database, id, now).await?,
        None => None,
    };
    let status = match (session.status.as_str(), session.paused_until_ms) {
        ("running", Some(_)) => "paused",
        ("running", None) => "running",
        _ => "stopped",
    };
    Ok(Json(json!({
        "sessionId": session.id,
        "status": status,
        "stoppedReason": session.stopped_reason,
        "pausedUntil": session.paused_until_ms,
        "checksPassed": session.checks_passed,
        "stepup": stepup.map(|s| s.to_json()),
    })))
}

fn no_session() -> ApiError {
    ApiError::json(StatusCode::NOT_FOUND, "No agent session for this wallet")
}

fn decision_reply(decision: &agent::Decision) -> Response {
    if decision.verdict == "skipped" && decision.reason == agent::PROPOSAL_EXPIRED {
        return ApiError::conflict("proposal expired")
            .with("code", "proposal_expired".into())
            .into_response();
    }
    Json(json!({ "decision": decision.to_json() })).into_response()
}

async fn approve(
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Response, ApiError> {
    let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    answer_in_task(id, headers, Some(stepup_id(&body))).await
}

async fn reject_proposal(Path(id): Path<String>, headers: HeaderMap) -> Result<Response, ApiError> {
    answer_in_task(id, headers, None).await
}

async fn answer_in_task(
    id: String,
    headers: HeaderMap,
    approve: Option<Option<String>>,
) -> Result<Response, ApiError> {
    tokio::spawn(async move { answer_proposal(&id, &headers, approve).await })
        .await
        .map_err(|panic| ApiError::Other(format!("proposal answer task failed: {panic}")))?
}

async fn answer_proposal(
    id: &str,
    headers: &HeaderMap,
    approve: Option<Option<String>>,
) -> Result<Response, ApiError> {
    let claims = claims(headers)?;
    let database = db::db().await?;
    let mine = agent::decision_for(database, id, &claims.session_id, &claims.wallet).await?;
    let Some(decision) = mine else {
        return Err(ApiError::json(
            StatusCode::NOT_FOUND,
            "No such proposal for this wallet",
        ));
    };
    let Some(approval) = live::approval(&claims.session_id) else {
        return Ok(decision_reply(&decision));
    };
    let over = config().world_limits.stepup_proposal_over;
    let mut spend = None;
    if let Some(stepup) = &approve {
        let big = decision.stake.unwrap_or(Decimal::ZERO) > over;
        if big && decision.verdict == "awaiting" {
            let human = match agentpass::require_human(database, &claims.wallet).await? {
                Ok(human) => human,
                Err(rejection) => return Ok(reject(rejection)),
            };
            let Some(stepup) = stepup else {
                return ask_for_stake(database, &decision, &human, &claims, &approval).await;
            };
            spend = Some(stepup.clone());
        }
    }
    let answered = {
        let _answering = approval.lock.lock().await;
        settle_proposal(database, &claims, id, approve.is_some(), spend.as_deref()).await?
    };
    approval.answered.notify_one();
    Ok(match answered {
        Ok(decision) => decision_reply(&decision),
        Err(rejection) => reject(rejection),
    })
}

async fn ask_for_stake(
    database: &'static Db,
    decision: &agent::Decision,
    human: &strike_core::world::Human,
    claims: &AgentClaims,
    approval: &live::Approval,
) -> Result<Response, ApiError> {
    let stake = decision.stake.unwrap_or(Decimal::ZERO).normalize();
    let action = Action {
        kind: "proposal",
        key: decision.id.clone(),
        summary: format!(
            "Approve agent trade: {stake} USDC {}",
            decision.direction.as_deref().unwrap_or_default()
        ),
        session_id: Some(&claims.session_id),
    };
    let now = now_ms();
    Ok(
        match agentpass::begin(database, human, &claims.wallet, action, now).await? {
            Ok(stepup) => {
                agent::extend_proposal(database, &decision.id, stepup.expires_at_ms).await?;
                approval.answered.notify_one();
                reject(agentpass::step_up_required(&stepup))
            }
            Err(rejection) => reject(rejection),
        },
    )
}

async fn settle_proposal(
    database: &db::Db,
    claims: &AgentClaims,
    id: &str,
    approve: bool,
    stepup: Option<&str>,
) -> Result<Result<agent::Decision, Rejection>, ApiError> {
    let current = agent::decision(database, id).await?;
    if current.verdict != "awaiting" {
        return Ok(Ok(current));
    }
    let mut session = agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .ok_or_else(no_session)?;
    let now = now_ms();
    if current.expires_at_ms.is_some_and(|at| now >= at) {
        live::answer(database, &session, id, "skipped", agent::PROPOSAL_EXPIRED).await?;
    } else if !approve {
        live::answer(database, &session, id, "rejected", "You rejected it").await?;
    } else {
        match agent::signal(strike_core::ticks::buffer(), &session.asset, now) {
            agent::Signal::Trade {
                direction,
                strike,
                reason,
                ..
            } if current.direction.as_deref() == Some(direction) => {
                let trade = live::Trade {
                    decision_id: id,
                    direction,
                    strike,
                    reason: &reason,
                    proposal: true,
                    confidence: None,
                    trace: None,
                    stepup,
                };
                match live::place(database, &mut session, trade).await? {
                    live::Placement::Stop(why) => live::stop(database, &session.id, &why).await,
                    live::Placement::Refused(refused) => return Ok(Err(refused)),
                    _ => {}
                }
            }
            agent::Signal::Trade { .. } => {
                live::answer(database, &session, id, "skipped", "The move reversed").await?;
            }
            agent::Signal::Skip(why) => {
                live::answer(database, &session, id, "skipped", why).await?;
            }
        }
    }
    Ok(Ok(agent::decision(database, id).await?))
}

async fn decisions(headers: HeaderMap) -> Result<Response, ApiError> {
    let claims = claims(&headers)?;
    let frames = live::subscribe(&claims.session_id);
    let database = db::db().await?;
    let session = agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .ok_or_else(no_session)?;
    let mut replay = vec![live::session_frame(&session)];
    for decision in agent::recent_decisions(database, &session.id, REPLAY).await? {
        replay.push(live::decision_frame(&decision));
    }
    let body = axum::body::Body::from_stream(feed(replay, frames));
    Ok((StatusCode::OK, sse_headers(), body).into_response())
}

fn feed(
    replay: Vec<String>,
    frames: Option<tokio::sync::broadcast::Receiver<String>>,
) -> impl futures::Stream<Item = Result<String, Infallible>> + Send + 'static {
    let live = futures::stream::unfold(frames, |mut frames| async move {
        let heartbeat = tokio::time::sleep(stream::heartbeat_interval());
        let frame = match frames.as_mut() {
            Some(rx) => tokio::select! {
                received = rx.recv() => match received {
                    Ok(frame) => frame,
                    Err(RecvError::Lagged(_)) => return None,
                    Err(RecvError::Closed) => {
                        frames = None;
                        String::new()
                    }
                },
                _ = heartbeat => stream::heartbeat_frame(prices::now_millis()),
            },
            None => {
                heartbeat.await;
                stream::heartbeat_frame(prices::now_millis())
            }
        };
        Some((Ok(frame), frames))
    });
    futures::StreamExt::chain(futures::stream::iter(replay.into_iter().map(Ok)), live)
}
