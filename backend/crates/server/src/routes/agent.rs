//! `/api/agent/*`: start a session from one signed message, stop it, and
//! stream its decisions. The wallet always comes from the agent cookie.

use std::convert::Infallible;

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::header::WWW_AUTHENTICATE;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use strike_core::agent;
use strike_core::bets::now_ms;
use strike_core::config::config;
use strike_core::crypto::{self, AgentClaims, AGENT_COOKIE};
use strike_core::db::{self, Db};
use strike_core::error::ApiError;
use strike_core::eth;
use strike_core::ledger::Rejection;
use strike_core::prices;
use strike_core::stream;
use strike_core::world::{self, HumanGrant};

use crate::agent as live;
use crate::bans;
use crate::http::{self, Cookie};
use crate::routes::stream::sse_headers;

/// Decisions replayed to a feed that connects.
const REPLAY: i64 = 50;
/// The cookie outlives the session by an hour so the trader can still read
/// how it ended.
const COOKIE_GRACE_SECONDS: i64 = 3_600;
pub(crate) const AGENTS_NOT_CONFIGURED: &str = "Agent sessions are not configured on this server";

pub fn routes() -> Router {
    Router::new()
        .route("/api/agent/start", post(start))
        .route("/api/agent/stop", post(stop))
        .route("/api/agent/checkpoint", post(checkpoint))
        .route("/api/agent/decisions", get(decisions))
        .route("/api/agent/decisions/{id}/approve", post(approve))
        .route("/api/agent/decisions/{id}/reject", post(reject_proposal))
}

fn reject((status, body): Rejection) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(body)).into_response()
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
    let signer = eth::recover_personal_signer(message, signature);
    if !signer.is_some_and(|s| s.eq_ignore_ascii_case(&terms.wallet)) {
        return Err(ApiError::unauthorized(
            "Signature does not match the wallet in the message",
        ));
    }
    let now = now_ms();
    if let Err(rejection) = agent::check_start(&terms, now) {
        return Ok(reject(rejection));
    }
    if bans::is_globally_banned(&terms.wallet).await {
        return Err(ApiError::json(StatusCode::FORBIDDEN, "Wallet is banned"));
    }
    if !config().is_settlement_signing_configured() {
        return Err(ApiError::unavailable(AGENTS_NOT_CONFIGURED));
    }
    let database = db::db().await?;
    if terms.mode == "yolo" {
        return Ok(match world::begin(database, &terms, message, now).await? {
            Ok(challenge) => human_check(&challenge),
            Err(rejection) => reject(rejection),
        });
    }
    Ok(match start_session(database, terms, now, None).await? {
        Ok((session, cookie)) => http::json_with_cookie(json!({ "session": session }), cookie),
        Err(rejection) => reject(rejection),
    })
}

/// Its own task: a client hanging up after the row commits must not leave a
/// running session with no task and no cookie.
pub(crate) async fn start_session(
    database: &'static Db,
    terms: agent::StartTerms,
    now: i64,
    human: Option<HumanGrant>,
) -> Result<Result<(Value, Cookie), Rejection>, ApiError> {
    tokio::spawn(async move {
        Ok(
            match agent::create_session(database, terms, now, human).await? {
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

/// RFC 9470 step-up: the browser goes to `verifyUrl`, and only this browser,
/// holding the `strike_world` cookie, can finish the attempt.
fn human_check(challenge: &world::Challenge) -> Response {
    let mut response = http::json_with_cookie(
        challenge.to_json(),
        Cookie {
            name: world::WORLD_COOKIE,
            value: challenge.browser_secret.clone(),
            max_age: world::ATTEMPT_TTL_MS / 1_000,
            same_site: "Lax",
            http_only: true,
        },
    );
    *response.status_mut() = StatusCode::UNAUTHORIZED;
    if let Ok(value) = HeaderValue::from_str(&challenge.www_authenticate()) {
        response.headers_mut().insert(WWW_AUTHENTICATE, value);
    }
    response
}

/// Runs a created session and returns the cookie that reads and stops it.
/// Both starts refuse before any write when the cookie can't be minted.
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

/// The step-up that resumes a YOLO agent paused for its human, in the same
/// 401 challenge shape as a YOLO start.
async fn checkpoint(headers: HeaderMap) -> Result<Response, ApiError> {
    let claims = claims(&headers)?;
    let database = db::db().await?;
    let session = agent::session_for(database, &claims.session_id, &claims.wallet)
        .await?
        .ok_or_else(no_session)?;
    let Some(until) = live::paused_until(&session.id) else {
        return Err(ApiError::conflict(world::NOT_PAUSED));
    };
    Ok(
        match world::begin_checkpoint(database, &session, until, now_ms()).await? {
            Ok(challenge) => human_check(&challenge),
            Err(rejection) => reject(rejection),
        },
    )
}

fn no_session() -> ApiError {
    ApiError::json(StatusCode::NOT_FOUND, "No agent session for this wallet")
}

fn decision_reply(decision: &agent::Decision) -> Response {
    if decision.verdict == "skipped" && decision.reason == agent::PROPOSAL_EXPIRED {
        return ApiError::conflict("proposal expired").into_response();
    }
    Json(json!({ "decision": decision.to_json() })).into_response()
}

/// Places a waiting proposal after re-running the signal and every limit. The
/// session's approval lock makes a repeat wait for the first answer and get it.
async fn approve(Path(id): Path<String>, headers: HeaderMap) -> Result<Response, ApiError> {
    answer_proposal(&id, &headers, true).await
}

async fn reject_proposal(Path(id): Path<String>, headers: HeaderMap) -> Result<Response, ApiError> {
    answer_proposal(&id, &headers, false).await
}

async fn answer_proposal(
    id: &str,
    headers: &HeaderMap,
    approve: bool,
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
    let answered = {
        let _answering = approval.lock.lock().await;
        settle_proposal(database, &claims, id, approve).await?
    };
    approval.answered.notify_one();
    Ok(decision_reply(&answered))
}

/// Runs under the approval lock. Returns the decision as it now stands.
async fn settle_proposal(
    database: &db::Db,
    claims: &AgentClaims,
    id: &str,
    approve: bool,
) -> Result<agent::Decision, ApiError> {
    let current = agent::decision(database, id).await?;
    if current.verdict != "awaiting" {
        return Ok(current);
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
            } if current.direction.as_deref() == Some(direction) => {
                let trade = live::Trade {
                    decision_id: id,
                    direction,
                    strike,
                    reason: &reason,
                    proposal: true,
                };
                if let live::Placement::Stop(why) =
                    live::place(database, &mut session, trade).await?
                {
                    live::stop(database, &session.id, &why).await;
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
    agent::decision(database, id).await
}

/// Replays the session and its recent decisions, then streams changes. Frames
/// are whole rows keyed by id, so a client upserts and a duplicate is harmless.
async fn decisions(headers: HeaderMap) -> Result<Response, ApiError> {
    let claims = claims(&headers)?;
    // Subscribed before the replay is read, so nothing falls between the two.
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

/// Live frames until the task ends, then heartbeats only, so an EventSource
/// stays connected instead of reconnecting in a loop.
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
                    // Missed frames: end it, the reconnect replays the truth.
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
