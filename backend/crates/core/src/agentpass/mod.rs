mod client;
mod token;

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use jsonwebtoken::jwk::JwkSet;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::address::canonical;
use crate::db::Db;
use crate::error::ApiResult;
use crate::ledger::Rejection;
use crate::world::{self, Human};

pub use token::ORB;

pub const STEPUP_TTL_MS: i64 = 5 * 60 * 1000;
pub const DEV_BYPASS: &str = "dev bypass";

pub struct ApConfig {
    pub issuer: String,
    pub client_id: String,
    client_secret: String,
    pub env: String,
    endpoints: tokio::sync::OnceCell<client::Endpoints>,
    jwks: Mutex<Option<JwkSet>>,
}

impl ApConfig {
    pub fn new(issuer: &str, client_id: &str, client_secret: &str) -> Self {
        Self {
            issuer: issuer.trim_end_matches('/').to_string(),
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            env: std::env::var("WORLD_ENVIRONMENT").unwrap_or_else(|_| "production".into()),
            endpoints: Default::default(),
            jwks: Mutex::new(None),
        }
    }
}

pub fn ap_config() -> Option<&'static ApConfig> {
    static CONFIG: OnceLock<Option<ApConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let var = |key| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
            Some(ApConfig::new(
                &var("WORLD_AP_ISSUER").unwrap_or_else(|| "https://auth.world.org".into()),
                &var("WORLD_AP_CLIENT_ID")?,
                &var("WORLD_AP_CLIENT_SECRET")?,
            ))
        })
        .as_ref()
}

pub fn enabled() -> bool {
    world::dev_bypass() || ap_config().is_some()
}

pub fn refusal(status: u16, code: &str, error: &str) -> Rejection {
    (status, json!({ "error": error, "code": code }))
}

pub fn step_up_required(stepup: &Stepup) -> Rejection {
    (
        401,
        json!({
            "error": "Approve this in World App",
            "code": "step_up_required",
            "stepup": stepup.to_json(),
        }),
    )
}

#[derive(Debug, Clone)]
pub struct Stepup {
    pub id: String,
    pub human_id: String,
    pub wallet: String,
    pub kind: String,
    pub subject: Value,
    pub status: String,
    pub reason: Option<String>,
    pub user_code: Option<String>,
    pub verify_uri: Option<String>,
    pub verify_uri_complete: Option<String>,
    pub interval_ms: Option<i64>,
    pub started_at_ms: i64,
    pub expires_at_ms: i64,
    pub approved_at_ms: Option<i64>,
    pub session_id: Option<String>,
}

const COLUMNS: &str =
    "id, human_id, wallet, kind, subject, status, reason, user_code, verify_uri, \
     verify_uri_complete, interval_ms, started_at, expires_at, approved_at, session_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Stepup> {
    Ok(Stepup {
        id: r.get(0)?,
        human_id: r.get(1)?,
        wallet: r.get(2)?,
        kind: r.get(3)?,
        subject: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Null),
        status: r.get(5)?,
        reason: r.get(6)?,
        user_code: r.get(7)?,
        verify_uri: r.get(8)?,
        verify_uri_complete: r.get(9)?,
        interval_ms: r.get(10)?,
        started_at_ms: r.get::<_, i64>(11)? / 1_000,
        expires_at_ms: r.get::<_, i64>(12)? / 1_000,
        approved_at_ms: r.get::<_, Option<i64>>(13)?.map(|us| us / 1_000),
        session_id: r.get(14)?,
    })
}

impl Stepup {
    pub fn key(&self) -> &str {
        self.subject["key"].as_str().unwrap_or_default()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "reason": self.reason,
            "userCode": self.user_code,
            "verifyUri": self.verify_uri,
            "verifyUriComplete": self.verify_uri_complete,
            "expiresAt": self.expires_at_ms,
            "intervalMs": self.interval_ms,
            "summary": self.subject["summary"],
        })
    }
}

fn load(conn: &Connection, id: &str) -> rusqlite::Result<Option<Stepup>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM stepups WHERE id = ?1"),
        [id],
        row,
    )
    .optional()
}

fn settle(conn: &Connection, id: &str, status: &str, reason: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE stepups SET status = ?2, reason = ?3 WHERE id = ?1 AND status = 'pending'",
        params![id, status, reason],
    )
}

pub struct Action<'a> {
    pub kind: &'static str,
    pub key: String,
    pub summary: String,
    pub session_id: Option<&'a str>,
}

pub async fn begin(
    db: &'static Db,
    human: &Human,
    wallet: &str,
    action: Action<'_>,
    now_ms: i64,
) -> ApiResult<Result<Stepup, Rejection>> {
    begin_with(db, ap_config(), human, wallet, action, now_ms).await
}

pub(crate) async fn begin_with(
    db: &'static Db,
    config: Option<&'static ApConfig>,
    human: &Human,
    wallet: &str,
    action: Action<'_>,
    now_ms: i64,
) -> ApiResult<Result<Stepup, Rejection>> {
    let wallet = canonical(wallet);
    let subject = json!({ "key": action.key, "summary": action.summary }).to_string();
    let (human_id, kind, key) = (human.id.clone(), action.kind, action.key.clone());
    let session_id = action.session_id.map(str::to_string);
    let reuse = {
        let (human_id, key) = (human_id.clone(), key.clone());
        db.read(move |conn| {
            Ok(conn
                .query_row(
                    &format!(
                        "SELECT {COLUMNS} FROM stepups WHERE human_id = ?1 AND kind = ?2 \
                         AND json_extract(subject, '$.key') = ?3 AND status = 'pending' \
                         AND expires_at > ?4 ORDER BY started_at DESC LIMIT 1"
                    ),
                    params![human_id, kind, key, now_ms * 1_000],
                    row,
                )
                .optional()?)
        })
        .await?
    };
    if let Some(pending) = reuse {
        return Ok(Ok(pending));
    }
    let id = uuid::Uuid::new_v4().to_string();
    if world::dev_bypass() {
        let row_id = id.clone();
        return db
            .write(move |conn| {
                conn.execute(
                    "INSERT INTO stepups (id, human_id, wallet, kind, subject, status, reason, \
                     started_at, expires_at, approved_at, session_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 'approved', ?6, ?7, ?8, ?7, ?9)",
                    params![
                        row_id,
                        human_id,
                        wallet,
                        kind,
                        subject,
                        DEV_BYPASS,
                        now_ms * 1_000,
                        (now_ms + STEPUP_TTL_MS) * 1_000,
                        session_id
                    ],
                )?;
                Ok(Ok(load(conn, &row_id)?.expect("just inserted")))
            })
            .await;
    }
    let Some(cfg) = config else {
        return Ok(Err(refusal(
            503,
            "world_unconfigured",
            "World Agent Pass is not configured on this server",
        )));
    };
    let grant = match client::start(cfg).await {
        Ok(grant) => grant,
        Err(client::Unavailable::RateLimited(wait)) => {
            let (status, mut body) = refusal(429, "rate_limited", "World ID is busy, try again");
            body["retryAfter"] = json!(wait);
            return Ok(Err((status, body)));
        }
        Err(client::Unavailable::Down) => {
            let (status, mut body) = refusal(
                503,
                "world_unavailable",
                "World ID unavailable, nothing was approved",
            );
            body["retryable"] = json!(true);
            return Ok(Err((status, body)));
        }
    };
    let expires_ms = now_ms + STEPUP_TTL_MS.min(grant.expires_in.max(1) * 1_000);
    let interval_ms = grant.interval.unwrap_or(5).max(1) * 1_000;
    let device_code = grant.device_code.clone();
    let row_id = id.clone();
    let stepup = db
        .write(move |conn| {
            conn.execute(
                "INSERT INTO stepups (id, human_id, wallet, kind, subject, status, \
                 device_code_hash, device_code_enc, user_code, verify_uri, verify_uri_complete, \
                 interval_ms, acr_required, started_at, expires_at, session_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    row_id,
                    human_id,
                    wallet,
                    kind,
                    subject,
                    hex::encode(Sha256::digest(grant.device_code.as_bytes())),
                    None::<String>,
                    grant.user_code,
                    grant.verification_uri,
                    grant.verification_uri_complete,
                    interval_ms,
                    token::accepted_acr().join(" "),
                    now_ms * 1_000,
                    expires_ms * 1_000,
                    session_id
                ],
            )?;
            Ok(load(conn, &row_id)?.expect("just inserted"))
        })
        .await?;
    tokio::spawn(run_poller(
        db,
        cfg,
        id,
        device_code,
        interval_ms,
        now_ms,
        expires_ms,
    ));
    Ok(Ok(stepup))
}

async fn run_poller(
    db: &'static Db,
    cfg: &'static ApConfig,
    id: String,
    device_code: String,
    mut interval_ms: i64,
    started_ms: i64,
    expires_ms: i64,
) {
    loop {
        tokio::time::sleep(Duration::from_millis(interval_ms as u64)).await;
        let now = crate::bets::now_ms();
        let outcome = if now >= expires_ms {
            Some(("expired", "Approval timed out".to_string()))
        } else {
            match still_pending(db, &id).await {
                Ok(true) => {}
                Ok(false) => return,
                Err(err) => {
                    tracing::error!("[agentpass] stepup {id} unreadable: {err}");
                    return;
                }
            }
            match client::poll(cfg, &device_code).await {
                client::Poll::Pending => None,
                client::Poll::SlowDown => {
                    interval_ms += 5_000;
                    None
                }
                client::Poll::End(status, reason) => Some((status, reason)),
                client::Poll::Token(token) => Some(approve(db, cfg, &id, &token, started_ms).await),
            }
        };
        if let Some((status, reason)) = outcome {
            if status != "approved" {
                tracing::info!("[agentpass] stepup {id} {status}: {reason}");
                let id = id.clone();
                if let Err(err) = db
                    .write(move |conn| Ok(settle(conn, &id, status, &reason)?))
                    .await
                {
                    tracing::error!("[agentpass] stepup outcome not saved: {err}");
                }
            }
            return;
        }
    }
}

async fn still_pending(db: &Db, id: &str) -> ApiResult<bool> {
    let id = id.to_string();
    db.read(move |conn| {
        Ok(conn
            .query_row("SELECT status FROM stepups WHERE id = ?1", [&id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .as_deref()
            == Some("pending"))
    })
    .await
}

async fn approve(
    db: &'static Db,
    cfg: &'static ApConfig,
    id: &str,
    token: &str,
    started_ms: i64,
) -> (&'static str, String) {
    let Some(kid) = token::kid(token) else {
        return ("failed", "Malformed ID token".into());
    };
    let Some(keys) = client::keys(cfg, &kid).await else {
        return ("failed", "World ID keys unavailable, try again".into());
    };
    let now = crate::bets::now_ms();
    let claims = match token::verify(
        token,
        &keys,
        &cfg.issuer,
        &cfg.client_id,
        &token::accepted_acr()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        started_ms,
        now,
    ) {
        Ok(claims) => claims,
        Err(reason) => return ("failed", reason.into()),
    };
    let id = id.to_string();
    let saved = db
        .write(move |conn| {
            let Some(stepup) = load(conn, &id)? else {
                return Ok(("failed", "Approval vanished".to_string()));
            };
            if stepup.status != "pending" {
                return Ok(("cancelled", "Already ended".to_string()));
            }
            if stepup.expires_at_ms <= now {
                return Ok(("expired", "Approval timed out".to_string()));
            }
            let acr = claims.acr.clone().unwrap_or_default();
            let linked = world::link_agent_pass(
                conn,
                &stepup.human_id,
                &cfg.issuer,
                &claims.sub,
                &acr,
                &cfg.env,
                now,
            )?;
            if linked.is_err() {
                return Ok(("mismatch", "A different human approved this".to_string()));
            }
            conn.execute(
                "UPDATE stepups SET status = 'approved', reason = 'Approved in World App', \
                 approved_at = ?2, sub = ?3, acr = ?4, amr = ?5 WHERE id = ?1 AND status = 'pending'",
                params![id, now * 1_000, claims.sub, acr, claims.amr.join(" ")],
            )?;
            Ok(("approved", String::new()))
        })
        .await;
    saved.unwrap_or_else(|err| {
        tracing::error!("[agentpass] approval not saved: {err}");
        ("failed", "Approval could not be saved".into())
    })
}

pub async fn get(db: &Db, id: &str, now_ms: i64) -> ApiResult<Option<Stepup>> {
    let id = id.to_string();
    db.write(move |conn| {
        let Some(stepup) = load(conn, &id)? else {
            return Ok(None);
        };
        if stepup.status == "pending" && stepup.expires_at_ms <= now_ms {
            settle(conn, &id, "expired", "Approval timed out")?;
            return Ok(load(conn, &id)?);
        }
        Ok(Some(stepup))
    })
    .await
}

pub async fn cancel(db: &Db, id: &str, reason: &str) -> ApiResult<Option<Stepup>> {
    let (id, reason) = (id.to_string(), reason.to_string());
    db.write(move |conn| {
        conn.execute(
            "UPDATE stepups SET status = 'cancelled', reason = ?2 \
             WHERE id = ?1 AND status IN ('pending', 'approved')",
            params![id, reason],
        )?;
        Ok(load(conn, &id)?)
    })
    .await
}

pub(crate) fn consume(
    conn: &Connection,
    id: &str,
    human_id: &str,
    kind: &str,
    key: &str,
    now_ms: i64,
) -> rusqlite::Result<Result<(), Rejection>> {
    let found = load(conn, id)?;
    let Some(stepup) = found.filter(|s| s.human_id == human_id && s.kind == kind) else {
        return Ok(Err(refusal(
            403,
            "stepup_denied",
            "No such approval for you",
        )));
    };
    if stepup.key() != key {
        return Ok(Err(refusal(
            403,
            "stepup_denied",
            "This approval is for a different action",
        )));
    }
    let expired = || {
        Ok(Err(refusal(
            410,
            "stepup_expired",
            "The approval expired, ask again",
        )))
    };
    match stepup.status.as_str() {
        "approved" => {
            if stepup.approved_at_ms.unwrap_or(0) + STEPUP_TTL_MS <= now_ms {
                return expired();
            }
            conn.execute(
                "UPDATE stepups SET status = 'used', used_at = ?2 WHERE id = ?1 AND status = 'approved'",
                params![id, now_ms * 1_000],
            )?;
            Ok(Ok(()))
        }
        "pending" if stepup.expires_at_ms > now_ms => Ok(Err(refusal(
            409,
            "stepup_pending",
            "Waiting for your approval in World App",
        ))),
        "used" => Ok(Err(refusal(
            409,
            "stepup_used",
            "This approval was already used",
        ))),
        "mismatch" => Ok(Err(refusal(
            403,
            "human_mismatch",
            "A different human approved this",
        ))),
        "denied" | "cancelled" => Ok(Err(refusal(
            403,
            "stepup_denied",
            "The approval was declined",
        ))),
        _ => expired(),
    }
}

pub async fn consume_now(
    db: &Db,
    id: &str,
    human_id: &str,
    kind: &'static str,
    key: &str,
    now_ms: i64,
) -> ApiResult<Result<(), Rejection>> {
    let (id, human_id, key) = (id.to_string(), human_id.to_string(), key.to_string());
    db.write(move |conn| Ok(consume(conn, &id, &human_id, kind, &key, now_ms)?))
        .await
}

pub async fn require_human(db: &Db, wallet: &str) -> ApiResult<Result<Human, Rejection>> {
    if let Err(code) = world::gate_ready() {
        return Ok(Err(refusal(
            503,
            code,
            "World ID is not configured on this server",
        )));
    }
    let wallet = canonical(wallet);
    let human = db
        .read(move |conn| Ok(world::human_of_wallet(conn, &wallet)?))
        .await?;
    Ok(human.ok_or_else(|| {
        refusal(
            403,
            "human_required",
            "Verify you are human with World ID first",
        )
    }))
}

pub async fn fail_orphans(db: &Db) -> ApiResult<usize> {
    db.write(|conn| {
        Ok(conn.execute(
            "UPDATE stepups SET status = 'failed', reason = 'server restart' WHERE status = 'pending'",
            [],
        )?)
    })
    .await
}

pub fn message_key(message: &str) -> String {
    hex::encode(Sha256::digest(message.as_bytes()))
}

#[cfg(test)]
mod tests;
