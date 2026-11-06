use rusqlite::{params, Connection, OptionalExtension};
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
    pub expires_at_ms: i64,
    pub created_at_ms: i64,
    pub kind: String,
}

const ATTEMPT_COLUMNS: &str = "id, wallet, message, nonce, browser, acr_allowed, \
     status, reason, acr, expires_at, created_at, kind";

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
        expires_at_ms: row.get::<_, i64>(9)? / 1_000,
        created_at_ms: row.get::<_, i64>(10)? / 1_000,
        kind: row.get(11)?,
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

pub async fn attempt_for(
    db: &Db,
    id: &str,
    browser_secret: Option<&str>,
    now_ms: i64,
) -> ApiResult<Option<Attempt>> {
    let id = id.to_string();
    let browser = browser_secret.map(browser_hash);
    db.write(move |conn| {
        let select = format!("SELECT {ATTEMPT_COLUMNS} FROM world_attempts WHERE id = ?1");
        let Some(attempt) = conn.query_row(&select, [&id], attempt_row).optional()? else {
            return Ok(None);
        };
        if browser.as_deref() != Some(attempt.browser.as_str()) {
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
            "expiresAt": self.expires_at_ms,
            "kind": self.kind,
        })
    }
}

fn error_outcome(error: &str) -> (&'static str, String) {
    match error {
        "access_denied" => ("denied", CANCELLED.to_string()),
        "unmet_authentication_requirements" => (
            "denied",
            "Your World ID level can't pass this check".to_string(),
        ),
        other => ("failed", could_not_finish(other)),
    }
}

pub fn idkit_error_outcome(code: &str) -> (&'static str, String) {
    error_outcome(match code {
        "user_rejected" | "verification_rejected" | "cancelled" => "access_denied",
        "credential_unavailable" => "unmet_authentication_requirements",
        other => other,
    })
}

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
            idkit_error_outcome("user_rejected"),
            ("denied", CANCELLED.into())
        );
        assert_eq!(idkit_error_outcome("credential_unavailable").0, "denied");
        assert_eq!(
            idkit_error_outcome("connection_failed"),
            (
                "failed",
                "World ID could not finish: connection_failed".into()
            )
        );
        assert_eq!(error_outcome("access_denied"), ("denied", CANCELLED.into()));
        assert_eq!(error_outcome("login_required").0, "failed");
        assert!(error_outcome("<script>").1.ends_with("unexpected error"));
    }
}
