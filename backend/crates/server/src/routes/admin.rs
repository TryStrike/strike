//! `/api/admin/auth` and `/api/admin/logout`.
//!
//! The failed-attempt limiter is transcribed from the TS route, including its
//! doubling lockout, its 24-hour ceiling and the eviction policy that stops a
//! spray of spoofed IPs from growing the table without bound. It is in-process
//! state: like the TS version it resets on restart and does not coordinate
//! across instances - it exists to blunt brute force, not to be a durable ban.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::Value;

use strike_core::config::config;
use strike_core::crypto::{dashboard_password_matches, issue_admin_token, ADMIN_COOKIE_NAME};
use strike_core::error::ApiResult;

use crate::http::{
    client_ip, cleared_cookie, json_status, json_with_cookie, ok_false_error, too_many, Cookie,
};

const MAX_FAILURES_BEFORE_LOCK: u32 = 5;
const BASE_LOCK_MS: i64 = 15 * 60 * 1000;
const MAX_LOCK_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_TRACKED_IPS: usize = 10_000;
const LOCKED_MESSAGE: &str = "Too many failed attempts. Try again later.";

pub fn routes() -> Router {
    Router::new()
        .route("/api/admin/auth", post(auth))
        .route("/api/admin/logout", post(logout))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttemptState {
    pub failures: u32,
    pub locked_until_ms: i64,
}

impl AttemptState {
    const NEW: Self = Self { failures: 0, locked_until_ms: 0 };

    /// Whole seconds until the lock expires, rounded up; 0 when not locked.
    pub fn retry_after_seconds(&self, now_ms: i64) -> i64 {
        let remaining = self.locked_until_ms - now_ms;
        if remaining > 0 {
            (remaining + 999) / 1000
        } else {
            0
        }
    }

    /// Records one more failure. From the fifth onward the lockout doubles,
    /// capped at `MAX_LOCK_MS`.
    pub fn with_failure(&self, now_ms: i64) -> Self {
        let failures = self.failures + 1;
        if failures < MAX_FAILURES_BEFORE_LOCK {
            return Self { failures, locked_until_ms: self.locked_until_ms };
        }
        let exponent = (failures - MAX_FAILURES_BEFORE_LOCK).min(10);
        let penalty = (BASE_LOCK_MS * (1_i64 << exponent)).min(MAX_LOCK_MS);
        Self { failures, locked_until_ms: now_ms + penalty }
    }
}

#[derive(Default)]
struct AttemptTable {
    entries: HashMap<String, (AttemptState, u64)>,
    sequence: u64,
}

impl AttemptTable {
    fn state(&self, ip: &str) -> Option<AttemptState> {
        self.entries.get(ip).map(|(state, _)| *state)
    }

    fn note_failure(&mut self, ip: &str, now_ms: i64) -> AttemptState {
        self.make_room(now_ms);
        let current = self.state(ip).unwrap_or(AttemptState::NEW);
        let next = current.with_failure(now_ms);
        self.sequence += 1;
        self.entries.insert(ip.to_string(), (next, self.sequence));
        next
    }

    fn clear(&mut self, ip: &str) {
        self.entries.remove(ip);
    }

    /// First drop rows whose lock already expired and that never reached the
    /// lock threshold; if the table is still full, discard the oldest half.
    fn make_room(&mut self, now_ms: i64) {
        if self.entries.len() < MAX_TRACKED_IPS {
            return;
        }
        self.entries
            .retain(|_, (state, _)| state.locked_until_ms > now_ms || state.failures >= MAX_FAILURES_BEFORE_LOCK);
        if self.entries.len() < MAX_TRACKED_IPS {
            return;
        }
        let mut ordered: Vec<(String, u64)> = self
            .entries
            .iter()
            .map(|(ip, (_, seq))| (ip.clone(), *seq))
            .collect();
        ordered.sort_by_key(|(_, seq)| *seq);
        for (ip, _) in ordered.into_iter().take(MAX_TRACKED_IPS / 2) {
            self.entries.remove(&ip);
        }
    }
}

fn attempts() -> &'static Mutex<AttemptTable> {
    static TABLE: OnceLock<Mutex<AttemptTable>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(AttemptTable::default()))
}

/// `POST /api/admin/auth`
async fn auth(headers: HeaderMap, raw: Bytes) -> Response {
    match authenticate(&headers, &raw).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn authenticate(headers: &HeaderMap, raw: &Bytes) -> ApiResult<Response> {
    let ip = client_ip(headers);
    let now_ms = chrono::Utc::now().timestamp_millis();

    let locked = attempts()
        .lock()
        .map(|table| table.state(&ip).map(|s| s.retry_after_seconds(now_ms)).unwrap_or(0))
        .unwrap_or(0);
    if locked > 0 {
        return Ok(too_many(LOCKED_MESSAGE, locked));
    }

    // The TS destructures the parsed body, so `null`/invalid JSON throws and
    // becomes a 400, while any other non-object simply has no password.
    let body: Value = match serde_json::from_slice(raw) {
        Ok(value @ Value::Object(_)) => value,
        Ok(Value::Null) | Err(_) => {
            return Ok(json_status(StatusCode::BAD_REQUEST, ok_false_error("Bad request")))
        }
        Ok(other) => other,
    };
    let password = body.get("password").and_then(Value::as_str);

    let Some(stored) = config().dashboard_password.clone() else {
        return Ok(json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            ok_false_error("Auth not configured on server."),
        ));
    };

    let Some(candidate) = password.filter(|p| !p.is_empty()) else {
        return Ok(json_status(StatusCode::UNAUTHORIZED, ok_false_error_empty()));
    };

    if !dashboard_password_matches(&stored, candidate) {
        let state = attempts()
            .lock()
            .map(|mut table| table.note_failure(&ip, chrono::Utc::now().timestamp_millis()))
            .unwrap_or(AttemptState::NEW);
        let retry_after = state.retry_after_seconds(chrono::Utc::now().timestamp_millis());
        if retry_after > 0 {
            return Ok(too_many(LOCKED_MESSAGE, retry_after));
        }
        return Ok(json_status(StatusCode::UNAUTHORIZED, ok_false_error_empty()));
    }

    // Success clears this IP's history.
    if let Ok(mut table) = attempts().lock() {
        table.clear(&ip);
    }

    let ttl_seconds = (config().admin_session_hours * 3600.0) as i64;
    let token = issue_admin_token()
        .map_err(|_| strike_core::error::ApiError::internal("Admin signing failed"))?;
    Ok(json_with_cookie(
        Value::Object(serde_json::Map::from_iter([(
            "ok".to_string(),
            Value::Bool(true),
        )])),
        Cookie { name: ADMIN_COOKIE_NAME, value: token, max_age: ttl_seconds, same_site: "strict", http_only: true },
    ))
}

/// `POST /api/admin/logout` — clears the cookie; no guard, like the TS route.
async fn logout() -> ApiResult<Response> {
    Ok(json_with_cookie(
        Value::Object(serde_json::Map::from_iter([(
            "ok".to_string(),
            Value::Bool(true),
        )])),
        cleared_cookie(ADMIN_COOKIE_NAME, "strict"),
    ))
}

/// `{ ok: false }` with no error field, which is what the TS returns for a bad
/// password so the response cannot be told apart from a missing one.
fn ok_false_error_empty() -> Value {
    Value::Object(serde_json::Map::from_iter([(
        "ok".to_string(),
        Value::Bool(false),
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_lock_before_the_fifth_failure() {
        let now = 1_000_000_000_000;
        let mut state = AttemptState::NEW;
        for attempt in 1..MAX_FAILURES_BEFORE_LOCK {
            state = state.with_failure(now);
            assert_eq!(state.failures, attempt);
            assert_eq!(state.retry_after_seconds(now), 0, "locked too early at {attempt}");
        }
    }

    #[test]
    fn lockout_doubles_from_fifteen_minutes_and_caps_at_a_day() {
        let now = 1_000_000_000_000;
        let mut state = AttemptState::NEW;
        let mut failures: u32 = 0;
        let record = |state: &mut AttemptState, failures: &mut u32| {
            *state = state.with_failure(now);
            *failures += 1;
        };

        // Fifth failure: base lock.
        for _ in 0..MAX_FAILURES_BEFORE_LOCK {
            record(&mut state, &mut failures);
        }
        assert_eq!(state.retry_after_seconds(now), 15 * 60);
        record(&mut state, &mut failures);
        assert_eq!(state.retry_after_seconds(now), 30 * 60);
        record(&mut state, &mut failures);
        assert_eq!(state.retry_after_seconds(now), 60 * 60);
        // The doubling must stop at a day no matter how far the count climbs.
        for _ in 0..30 {
            record(&mut state, &mut failures);
        }
        assert_eq!(state.retry_after_seconds(now), 24 * 60 * 60);
        assert_eq!(state.failures, failures);
    }

    #[test]
    fn retry_after_rounds_up_and_ignores_expired_locks() {
        let state = AttemptState { failures: 5, locked_until_ms: 10_000 };
        assert_eq!(state.retry_after_seconds(9_501), 1);
        assert_eq!(state.retry_after_seconds(10_000), 0);
        assert_eq!(state.retry_after_seconds(11_000), 0);
    }

    #[test]
    fn success_clears_an_ips_history() {
        let mut table = AttemptTable::default();
        let now = 1_000_000_000_000;
        for _ in 0..MAX_FAILURES_BEFORE_LOCK {
            table.note_failure("1.2.3.4", now);
        }
        assert!(table.state("1.2.3.4").unwrap().locked_until_ms > now);
        table.clear("1.2.3.4");
        assert_eq!(table.state("1.2.3.4"), None);
    }

    #[test]
    fn eviction_prefers_expired_rows_then_oldest() {
        let mut table = AttemptTable::default();
        let now = 1_000_000_000_000;
        // Fill to the cap with unlocked rows whose lock is already past.
        for i in 0..MAX_TRACKED_IPS {
            table.entries.insert(format!("ip-{i}"), (AttemptState { failures: 1, locked_until_ms: now - 1 }, i as u64));
            table.sequence = i as u64;
        }
        table.note_failure("newcomer", now);
        assert!(table.state("newcomer").is_some());
        // Every expired, under-threshold row was reclaimed, so the table stays
        // bounded instead of evicting locked attackers.
        assert!(table.entries.len() <= MAX_TRACKED_IPS);
        assert!(table.entries.contains_key("newcomer"));
    }
}
