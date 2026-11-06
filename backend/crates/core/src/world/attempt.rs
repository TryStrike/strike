//! Reading an attempt back, and the outcome a World error ends it with.

use rusqlite::{params, Connection, OptionalExtension};
use rust_decimal::Decimal;
use serde_json::{json, Value};

use super::{browser_hash, ACR_PREFIX, CANCELLED, EXPIRED};
use crate::db::Db;
use crate::error::ApiResult;

#[derive(Debug, Clone)]
pub struct Attempt {
    pub id: String,
    pub wallet: String,
    pub message: String,
    pub nonce: String,
    pub browser: String,
    pub acr_allowed: Vec<String>,
    pub status: String,
    pub reason: Option<String>,
    pub acr: Option<String>,
    pub session_id: Option<String>,
    pub expires_at_ms: i64,
    pub created_at_ms: i64,
    pub kind: String,
}

const ATTEMPT_COLUMNS: &str = "id, wallet, message, nonce, browser, acr_allowed, \
     status, reason, acr, session_id, expires_at, created_at, kind";

fn attempt_row(row: &rusqlite::Row) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: row.get(0)?,
        wallet: row.get(1)?,
        message: row.get(2)?,
        nonce: row.get(3)?,
        browser: row.get(4)?,
        acr_allowed: row
            .get::<_, String>(5)?
            .split(' ')
            .map(str::to_string)
            .collect(),
        status: row.get(6)?,
        reason: row.get(7)?,
        acr: row.get(8)?,
        session_id: row.get(9)?,
        expires_at_ms: row.get::<_, i64>(10)? / 1_000,
        created_at_ms: row.get::<_, i64>(11)? / 1_000,
        kind: row.get(12)?,
    })
}

pub(super) fn settle(
    conn: &Connection,
    id: &str,
    status: &str,
    reason: &str,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE world_attempts SET status = ?2, reason = ?3, done_at = ?4 \
         WHERE id = ?1 AND status = 'pending'",
        params![id, status, reason, now_ms * 1_000],
    )
}

/// Ends a pending attempt. The first outcome wins, so `false` means one was
/// already recorded.
pub async fn deny(
    db: &Db,
    id: &str,
    status: &'static str,
    reason: &str,
    now_ms: i64,
) -> ApiResult<bool> {
    let (id, reason) = (id.to_string(), reason.to_string());
    db.write(move |conn| Ok(settle(conn, &id, status, &reason, now_ms)? > 0))
        .await
}

/// The attempt for a browser holding its `strike_world` cookie, or for the
/// agent cookie of the session it created. A pending one past its expiry
/// is recorded as expired on the way.
pub async fn attempt_for(
    db: &Db,
    id: &str,
    browser_secret: Option<&str>,
    agent_session: Option<&str>,
    now_ms: i64,
) -> ApiResult<Option<Attempt>> {
    let id = id.to_string();
    let browser = browser_secret.map(browser_hash);
    let session = agent_session.map(str::to_string);
    db.write(move |conn| {
        let select = format!("SELECT {ATTEMPT_COLUMNS} FROM world_attempts WHERE id = ?1");
        let Some(attempt) = conn.query_row(&select, [&id], attempt_row).optional()? else {
            return Ok(None);
        };
        let mine = browser.as_deref() == Some(attempt.browser.as_str())
            || (session.is_some() && session == attempt.session_id);
        if !mine {
            return Ok(None);
        }
        if attempt.status == "pending" && attempt.expires_at_ms <= now_ms {
            settle(conn, &id, "expired", EXPIRED, now_ms)?;
            return Ok(conn.query_row(&select, [&id], attempt_row).optional()?);
        }
        Ok(Some(attempt))
    })
    .await
}

impl Attempt {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "status": self.status,
            "reason": self.reason,
            "acr": self.acr.as_deref().map(|a| a.strip_prefix(ACR_PREFIX).unwrap_or(a)),
            "sessionId": self.session_id,
            "expiresAt": self.expires_at_ms,
            "kind": self.kind,
        })
    }
}

/// `(status, reason)` for a World error.
fn error_outcome(error: &str, budget: Option<Decimal>) -> (&'static str, String) {
    match error {
        "access_denied" => ("denied", CANCELLED.to_string()),
        "unmet_authentication_requirements" => (
            "denied",
            match budget {
                Some(budget) => format!(
                    "Your World ID level can't back a {} USDC budget",
                    budget.normalize()
                ),
                None => "Your World ID level can't pass this check".to_string(),
            },
        ),
        other => ("failed", could_not_finish(other)),
    }
}

/// `(status, reason)` for an IDKit error code the widget reported.
pub fn idkit_error_outcome(code: &str, budget: Option<Decimal>) -> (&'static str, String) {
    error_outcome(
        match code {
            "user_rejected" | "verification_rejected" | "cancelled" => "access_denied",
            "credential_unavailable" => "unmet_authentication_requirements",
            other => other,
        },
        budget,
    )
}

/// A World error code is `[a-z_]`. Anything else is not echoed.
pub(super) fn could_not_finish(code: &str) -> String {
    let safe = code.len() <= 64 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    format!(
        "World ID could not finish: {}",
        if safe { code } else { "unexpected error" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_errors_map_to_outcomes() {
        assert_eq!(
            idkit_error_outcome("user_rejected", None),
            ("denied", CANCELLED.into())
        );
        assert_eq!(
            idkit_error_outcome("credential_unavailable", None).0,
            "denied"
        );
        assert_eq!(
            idkit_error_outcome("connection_failed", None),
            (
                "failed",
                "World ID could not finish: connection_failed".into()
            )
        );
        assert_eq!(
            error_outcome("access_denied", None),
            ("denied", CANCELLED.into())
        );
        assert_eq!(
            error_outcome(
                "unmet_authentication_requirements",
                Some(Decimal::new(1000, 1))
            )
            .1,
            "Your World ID level can't back a 100 USDC budget"
        );
        assert_eq!(error_outcome("login_required", None).0, "failed");
        assert!(error_outcome("<script>", None)
            .1
            .ends_with("unexpected error"));
    }
}
