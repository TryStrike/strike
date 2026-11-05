//! `/api/session/ping`: presence, with its opportunistic housekeeping and its "ignore lookup errors and
//! fall through" behaviour, which is what makes a malformed session id a resume
//! instead of a 500.

use std::sync::atomic::{AtomicI64, Ordering};

use axum::body::Bytes;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{Map, Value};

use strike_core::address::{canonical, is_address};
use strike_core::error::{ApiError, ApiResult};

use crate::sql;

const SESSION_TIMEOUT_SECONDS: i64 = 90;
const SESSION_RETENTION_DAYS: i64 = 7;
const CLEANUP_INTERVAL_MS: i64 = 60_000;
/// When the client should ping again: well before the session lapses, so one
/// slow ping never flips a live user to offline.
const REFRESH_AFTER_SECONDS: i64 = SESSION_TIMEOUT_SECONDS / 2;

static LAST_CLEANUP_MS: AtomicI64 = AtomicI64::new(0);

pub fn routes() -> Router {
    Router::new().route("/api/session/ping", post(ping).delete(close))
}

fn iso(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Drops long-ended sessions at most once a minute. `ended_at < cutoff` is
/// never true for NULL, so open sessions are untouched without an extra
/// predicate, and a failure must not break the ping it was folded into.
async fn purge_ended_sessions() {
    let now_ms = Utc::now().timestamp_millis();
    let previous = LAST_CLEANUP_MS.load(Ordering::Relaxed);
    if now_ms - previous < CLEANUP_INTERVAL_MS
        || LAST_CLEANUP_MS
            .compare_exchange(previous, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    let cutoff = iso(Utc
        .timestamp_millis_opt(now_ms - SESSION_RETENTION_DAYS * 86_400_000)
        .unwrap());
    let bind = Value::String(cutoff);
    if let Err(err) = sql::execute(
        "DELETE FROM user_sessions WHERE ended_at < CAST($1 AS timestamp with time zone)",
        &[("timestamp with time zone", &bind)],
    )
    .await
    {
        tracing::warn!("session/ping cleanup failed: {err}");
    }
}

#[derive(Default, serde::Deserialize)]
struct PingBody {
    wallet_address: Option<Value>,
    network: Option<Value>,
    session_id: Option<Value>,
}

/// Bad JSON and `null` are the route's throw. Any other non-object destructures
/// to nothing, which then fails as a missing wallet.
fn parse_ping_body(raw: &Bytes) -> ApiResult<PingBody> {
    match serde_json::from_slice::<Value>(raw) {
        Ok(Value::Null) | Err(_) => {
            tracing::error!("session/ping request failed: unreadable body");
            Err(ApiError::internal("Session update failed"))
        }
        Ok(body) => Ok(serde_json::from_value(body).unwrap_or_default()),
    }
}

/// `POST /api/session/ping` — update, resume or create the caller's session.
async fn ping(raw: Bytes) -> ApiResult<Json<Value>> {
    purge_ended_sessions().await;

    let body = parse_ping_body(&raw)?;
    let Some(Value::String(wallet)) = body.wallet_address else {
        if body.wallet_address.is_none() {
            return Err(ApiError::bad_request("wallet_address required"));
        }
        return Err(ApiError::bad_request("Invalid wallet_address"));
    };
    if !is_address(wallet.trim()) {
        return Err(ApiError::bad_request("Invalid wallet_address"));
    }
    let wallet = canonical(&wallet);
    let network = match &body.network {
        Some(Value::String(n)) if !n.is_empty() => n.clone(),
        _ => "ARC".to_string(),
    };

    let now_ms = Utc::now().timestamp_millis();
    let now = iso(Utc.timestamp_millis_opt(now_ms).unwrap());
    let cutoff = iso(Utc
        .timestamp_millis_opt(now_ms - SESSION_TIMEOUT_SECONDS * 1000)
        .unwrap());

    // A client-supplied session id is only honoured when it is a uuid, still
    // open, still fresh AND owned by this wallet.
    if let Some(Value::String(session_id)) = body.session_id.as_ref().filter(|v| !v.is_null()) {
        if uuid::Uuid::parse_str(session_id).is_ok() {
            let id = Value::String(session_id.clone());
            let existing = sql::fetch_one(
                "SELECT id, last_ping_at FROM user_sessions \
                 WHERE id = CAST($1 AS uuid) AND wallet_address = CAST($2 AS text) \
                   AND ended_at IS NULL \
                 LIMIT 1",
                &[("uuid", &id), ("text", &wallet_bind(&wallet))],
            )
            .await
            .unwrap_or(None);

            if let Some(row) = existing {
                let fresh = row
                    .get("last_ping_at")
                    .and_then(Value::as_str)
                    .is_some_and(|seen| seen > cutoff.as_str());
                if fresh {
                    sql::execute(
                        "UPDATE user_sessions SET last_ping_at = CAST($1 AS timestamp with time zone) \
                         WHERE id = CAST($2 AS uuid) AND wallet_address = CAST($3 AS text)",
                        &[
                            ("timestamp with time zone", &Value::String(now)),
                            ("uuid", &id),
                            ("text", &wallet_bind(&wallet)),
                        ],
                    )
                    .await?;
                    return Ok(Json(accepted(
                        Value::String(session_id.clone()),
                        "updated",
                        now_ms,
                    )));
                }
            }
        }
    }

    // Resume a recent open session for this wallet.
    let active = sql::fetch_one(
        "SELECT id FROM user_sessions \
         WHERE wallet_address = CAST($1 AS text) AND ended_at IS NULL \
           AND last_ping_at > CAST($2 AS timestamp with time zone) \
         ORDER BY last_ping_at DESC LIMIT 1",
        &[
            ("text", &wallet_bind(&wallet)),
            ("timestamp with time zone", &Value::String(cutoff.clone())),
        ],
    )
    .await?;

    if let Some(row) = active {
        let id = row.get("id").cloned().unwrap_or(Value::Null);
        sql::execute(
            "UPDATE user_sessions SET last_ping_at = CAST($1 AS timestamp with time zone) \
             WHERE id = CAST($2 AS uuid) AND wallet_address = CAST($3 AS text)",
            &[
                ("timestamp with time zone", &Value::String(now.clone())),
                ("uuid", &id),
                ("text", &wallet_bind(&wallet)),
            ],
        )
        .await?;
        return Ok(Json(accepted(id, "updated", now_ms)));
    }

    // Close stale open sessions for this wallet, then start a new one.
    sql::execute(
        "UPDATE user_sessions SET ended_at = CAST($1 AS timestamp with time zone) \
         WHERE wallet_address = CAST($2 AS text) AND ended_at IS NULL \
           AND last_ping_at < CAST($1 AS timestamp with time zone)",
        &[
            ("timestamp with time zone", &Value::String(cutoff)),
            ("text", &wallet_bind(&wallet)),
        ],
    )
    .await?;

    let created = sql::fetch_one(
        "INSERT INTO user_sessions (wallet_address, network, started_at, last_ping_at) \
         VALUES (CAST($1 AS text), CAST($2 AS text), CAST($3 AS timestamp with time zone), CAST($3 AS timestamp with time zone)) \
         RETURNING id",
        &[
            ("text", &wallet_bind(&wallet)),
            ("text", &Value::String(network)),
            ("timestamp with time zone", &Value::String(now)),
        ],
    )
    .await
    .map_err(|err| {
        tracing::error!("session/ping insert failed: {err}");
        ApiError::internal("Session creation failed")
    })?
    .ok_or_else(|| ApiError::internal("Session creation failed"))?;

    Ok(Json(accepted(
        created.get("id").cloned().unwrap_or(Value::Null),
        "created",
        now_ms,
    )))
}

/// An accepted ping. The client schedules its next one from these timing fields.
fn accepted(session_id: Value, status: &str, now_ms: i64) -> Value {
    object(&[
        ("session_id", session_id),
        ("status", Value::String(status.to_string())),
        ("ttl_seconds", Value::from(SESSION_TIMEOUT_SECONDS)),
        ("refresh_after_seconds", Value::from(REFRESH_AFTER_SECONDS)),
        (
            "expires_at",
            Value::String(iso(Utc
                .timestamp_millis_opt(now_ms + SESSION_TIMEOUT_SECONDS * 1000)
                .unwrap())),
        ),
        (
            "server_time",
            Value::String(iso(Utc.timestamp_millis_opt(now_ms).unwrap())),
        ),
    ])
}

/// `DELETE /api/session/ping` — the wallet disconnected.
async fn close(raw: Bytes) -> ApiResult<Json<Value>> {
    let body: Value = serde_json::from_slice(&raw)
        .ok()
        .filter(|body: &Value| !body.is_null())
        .ok_or_else(|| {
            tracing::error!("session/ping close failed: unreadable body");
            ApiError::internal("Session close failed")
        })?;

    let session_id = body.get("session_id").and_then(Value::as_str).unwrap_or("");
    let wallet = match body.get("wallet_address").and_then(Value::as_str) {
        Some(w) => w,
        None => {
            return Err(ApiError::bad_request(
                "session_id and wallet_address required",
            ))
        }
    };
    if session_id.is_empty() || wallet.trim().is_empty() {
        return Err(ApiError::bad_request(
            "session_id and wallet_address required",
        ));
    }
    if !is_address(wallet.trim()) {
        return Err(ApiError::bad_request("Invalid wallet_address"));
    }
    let wallet = canonical(wallet);

    // Only an open session, and only this wallet's: a guessed uuid is not
    // enough to close somebody else's uplink.
    if uuid::Uuid::parse_str(session_id).is_ok() {
        let now = Value::String(iso(Utc::now()));
        let id = Value::String(session_id.to_string());
        if let Err(err) = sql::execute(
            "UPDATE user_sessions SET ended_at = CAST($1 AS timestamp with time zone) \
             WHERE id = CAST($2 AS uuid) AND wallet_address = CAST($3 AS text) AND ended_at IS NULL",
            &[
                ("timestamp with time zone", &now),
                ("uuid", &id),
                ("text", &wallet_bind(&wallet)),
            ],
        )
        .await
        {
            tracing::error!("session/ping close failed: {err}");
            return Err(ApiError::internal("Session close failed"));
        }
    }

    Ok(Json(object(&[("status", Value::String("closed".into()))])))
}

fn wallet_bind(wallet: &str) -> Value {
    Value::String(wallet.to_string())
}

fn object(pairs: &[(&str, Value)]) -> Value {
    Value::Object(Map::from_iter(
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())),
    ))
}
