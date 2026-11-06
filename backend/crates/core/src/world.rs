//! World ID step-up (World IdP, plain OIDC) that unlocks a YOLO agent. A start
//! saves a pending attempt bound to the signed terms, the human approves in
//! World App, and the callback redeems the code, checks the ID token, and
//! creates the session in the same write that spends the attempt. Nothing here
//! runs once a session exists.

use std::sync::{LazyLock, RwLock};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use rusqlite::{params, Connection, OptionalExtension};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::address::canonical;
use crate::agent::{self, refuse, Session, StartTerms};
use crate::config::{config, WorldClient};
use crate::db::{is_unique_violation, Db};
use crate::error::{ApiError, ApiResult};
use crate::ledger::Rejection;

pub const WORLD_COOKIE: &str = "strike_world";
/// An attempt that resumes a paused YOLO session instead of starting one.
pub const CHECKPOINT: &str = "checkpoint";
/// World's authorization codes live 5 minutes, so the attempt does too.
pub const ATTEMPT_TTL_MS: i64 = 5 * 60 * 1000;
pub const ACR_PREFIX: &str = "https://world.org/oidc/acr/";
/// Weakest first. `WORLD_ACR_FLOOR` and the budget tiers cut from the left.
const CLASSES: [&str; 3] = ["selfie", "orb", "orb-face"];
/// `auth_time` may sit this far before the attempt (clock skew) or after now.
const AUTH_TIME_BEFORE_S: i64 = 5;
const AUTH_TIME_AHEAD_S: i64 = 30;

pub const NOT_CONFIGURED: &str = "Human checks are not configured on this server";
pub const VERIFIED: &str = "Human verified";
pub const CANCELLED: &str = "You cancelled in World App";
pub const ALREADY_USED: &str = "This approval link was already used";
pub const OTHER_BROWSER: &str = "Approval opened in another browser";
pub const WRONG_ISSUER: &str = "Wrong identity provider";
pub const EXPIRED: &str = "Human check expired";
pub const SUPERSEDED: &str = "A newer human check replaced this one";
pub const CODE_SPENT: &str = "Approval code expired or used";
pub const UNAVAILABLE: &str = "World ID unavailable, nothing started";
pub const MISMATCH: &str = "A different human approved this";
pub const BANNED_HUMAN: &str = "This human is banned";
pub const ONE_PER_HUMAN: &str = "This human already runs a YOLO agent";
pub const NOT_PAUSED: &str = "The agent is not waiting for a human";
pub const AGENT_GONE: &str = "The agent already stopped";

pub fn configured() -> ApiResult<&'static WorldClient> {
    config()
        .world
        .as_ref()
        .ok_or_else(|| ApiError::unavailable(NOT_CONFIGURED))
}

/// The proof classes a budget may be backed by, weakest first.
pub fn accepted_classes(
    budget: Decimal,
    selfie_max: Decimal,
    orb_max: Decimal,
    floor: Option<&str>,
) -> Result<&'static [&'static str], String> {
    if selfie_max > orb_max {
        return Err(format!(
            "WORLD_SELFIE_MAX {selfie_max} is above WORLD_ORB_MAX {orb_max}"
        ));
    }
    let tier = if budget <= selfie_max {
        0
    } else if budget <= orb_max {
        1
    } else {
        2
    };
    let floor = match floor {
        None => 0,
        Some(name) => CLASSES.iter().position(|c| *c == name).ok_or_else(|| {
            format!("WORLD_ACR_FLOOR is {name}, it must be selfie, orb or orb-face")
        })?,
    };
    Ok(&CLASSES[tier.max(floor)..])
}

fn classes_for(budget: Decimal) -> ApiResult<&'static [&'static str]> {
    let cfg = config();
    accepted_classes(
        budget,
        cfg.world_selfie_max,
        cfg.world_orb_max,
        cfg.world_acr_floor.as_deref(),
    )
    .map_err(|err| {
        tracing::error!("[world] {err}");
        ApiError::unavailable(NOT_CONFIGURED)
    })
}

fn full_acr(classes: &[&str]) -> Vec<String> {
    classes.iter().map(|c| format!("{ACR_PREFIX}{c}")).collect()
}

fn random_b64() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// What the browser stores is the secret, what the row stores is its hash.
pub fn browser_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// The ID token carries this, so an approval is for these exact terms only.
fn terms_nonce(attempt_id: &str, message: &str) -> String {
    hex::encode(Sha256::digest(format!("{attempt_id}{message}").as_bytes()))
}

fn authorize_url(
    client: &WorldClient,
    state: &str,
    nonce: &str,
    verifier: &str,
    classes: &[&str],
    sub: Option<&str>,
) -> String {
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut claims =
        json!({ "id_token": { "acr": { "essential": true, "values": full_acr(classes) } } });
    if let Some(sub) = sub {
        // World answers access_denied when another human authenticates.
        claims["id_token"]["sub"] = json!({ "value": sub });
    }
    reqwest::Url::parse_with_params(
        &format!("{}/api/v1/authorize", client.issuer),
        [
            ("client_id", client.client_id.as_str()),
            ("redirect_uri", client.redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", "openid"),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("max_age", "0"),
            ("claims", &claims.to_string()),
        ],
    )
    .expect("the issuer is a URL")
    .to_string()
}

pub struct Challenge {
    pub attempt_id: String,
    pub verify_url: String,
    pub expires_at_ms: i64,
    pub classes: &'static [&'static str],
    /// Goes to the browser as the `strike_world` cookie, never stored.
    pub browser_secret: String,
}

impl Challenge {
    /// RFC 9470 step-up challenge.
    pub fn www_authenticate(&self) -> String {
        format!(
            "Bearer error=\"insufficient_user_authentication\", max_age=\"0\", acr_values=\"{}\"",
            full_acr(self.classes).join(" ")
        )
    }

    pub fn to_json(&self) -> Value {
        json!({
            "error": "Human check required",
            "attempt": self.attempt_id,
            "verifyUrl": self.verify_url,
            "expiresAt": self.expires_at_ms,
            "acr": self.classes,
        })
    }
}

/// Saves a pending attempt for a signed, checked YOLO start.
pub async fn begin(
    db: &Db,
    terms: &StartTerms,
    message: &str,
    now_ms: i64,
) -> ApiResult<Result<Challenge, Rejection>> {
    let client = configured()?;
    let classes = classes_for(terms.budget)?;
    let expires_at_ms = (now_ms + ATTEMPT_TTL_MS).min(terms.expires_ms);
    let draft = Draft::new(
        client,
        classes,
        expires_at_ms,
        |_| message.to_string(),
        None,
    );
    let (wallet, start_nonce) = (canonical(&terms.wallet), terms.nonce.clone());
    db.write(move |conn| {
        if let Some(refused) = agent::start_blocked(conn, &start_nonce, &wallet)? {
            return Ok(Err(refused));
        }
        match draft.save(conn, &wallet, "start", None, now_ms) {
            Err(err) if is_unique_violation(&err) => {
                Ok(Err(refuse(409, "Start message already used")))
            }
            Err(err) => Err(err.into()),
            Ok(_) => Ok(Ok(draft.challenge)),
        }
    })
    .await
}

/// Saves a checkpoint for a YOLO session paused until `until_ms`. World lets
/// only the human linked to its wallet approve it.
pub async fn begin_checkpoint(
    db: &Db,
    session: &Session,
    until_ms: i64,
    now_ms: i64,
) -> ApiResult<Result<Challenge, Rejection>> {
    let client = configured()?;
    let classes = classes_for(session.budget)?;
    let (session_id, wallet) = (session.id.clone(), session.wallet.clone());
    db.write(move |conn| {
        if until_ms <= now_ms || !running(conn, &session_id)? {
            return Ok(Err(refuse(409, NOT_PAUSED)));
        }
        let Some((_, sub)) = link_of(conn, &wallet)? else {
            return Ok(Err(refuse(409, "No human is linked to this wallet")));
        };
        let draft = Draft::new(
            client,
            classes,
            (now_ms + ATTEMPT_TTL_MS).min(until_ms),
            |id| format!("Strike checkpoint\nSession: {session_id}\nAttempt: {id}"),
            Some(&sub),
        );
        draft.save(conn, &wallet, CHECKPOINT, Some(&session_id), now_ms)?;
        Ok(Ok(draft.challenge))
    })
    .await
}

/// A pending attempt before it is saved.
struct Draft {
    challenge: Challenge,
    message: String,
    state: String,
    nonce: String,
    verifier: String,
}

impl Draft {
    /// `message` is what the approval is for, given the attempt id.
    fn new(
        client: &WorldClient,
        classes: &'static [&'static str],
        expires_at_ms: i64,
        message: impl FnOnce(&str) -> String,
        sub: Option<&str>,
    ) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let (state, verifier) = (random_b64(), random_b64());
        let message = message(&id);
        let nonce = terms_nonce(&id, &message);
        Draft {
            challenge: Challenge {
                verify_url: authorize_url(client, &state, &nonce, &verifier, classes, sub),
                attempt_id: id,
                expires_at_ms,
                classes,
                browser_secret: random_b64(),
            },
            message,
            state,
            nonce,
            verifier,
        }
    }

    /// Supersedes the wallet's pending attempt and saves this one.
    fn save(
        &self,
        conn: &Connection,
        wallet: &str,
        kind: &str,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> rusqlite::Result<usize> {
        conn.execute(
            "UPDATE world_attempts SET status = 'expired', reason = ?2, done_at = ?3 \
             WHERE wallet = ?1 AND status = 'pending'",
            params![wallet, SUPERSEDED, now_ms * 1_000],
        )?;
        conn.execute(
            "INSERT INTO world_attempts (id, wallet, message, state, nonce, verifier, browser, \
             acr_allowed, status, expires_at, created_at, kind, session_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11, ?12)",
            params![
                self.challenge.attempt_id,
                wallet,
                self.message,
                self.state,
                self.nonce,
                self.verifier,
                browser_hash(&self.challenge.browser_secret),
                full_acr(self.challenge.classes).join(" "),
                self.challenge.expires_at_ms * 1_000,
                now_ms * 1_000,
                kind,
                session_id
            ],
        )
    }
}

#[derive(Debug, Clone)]
pub struct Attempt {
    pub id: String,
    pub wallet: String,
    pub message: String,
    pub nonce: String,
    pub verifier: String,
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

const ATTEMPT_COLUMNS: &str = "id, wallet, message, nonce, verifier, browser, acr_allowed, \
     status, reason, acr, session_id, expires_at, created_at, kind";

fn attempt_row(row: &rusqlite::Row) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: row.get(0)?,
        wallet: row.get(1)?,
        message: row.get(2)?,
        nonce: row.get(3)?,
        verifier: row.get(4)?,
        browser: row.get(5)?,
        acr_allowed: row
            .get::<_, String>(6)?
            .split(' ')
            .map(str::to_string)
            .collect(),
        status: row.get(7)?,
        reason: row.get(8)?,
        acr: row.get(9)?,
        session_id: row.get(10)?,
        expires_at_ms: row.get::<_, i64>(11)? / 1_000,
        created_at_ms: row.get::<_, i64>(12)? / 1_000,
        kind: row.get(13)?,
    })
}

pub async fn attempt_by_state(db: &Db, state: &str) -> ApiResult<Option<Attempt>> {
    let state = state.to_string();
    db.read(move |conn| {
        Ok(conn
            .query_row(
                &format!("SELECT {ATTEMPT_COLUMNS} FROM world_attempts WHERE state = ?1"),
                [&state],
                attempt_row,
            )
            .optional()?)
    })
    .await
}

fn settle(
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

/// `(status, reason)` for an `error` World sent back instead of a code.
pub fn error_outcome(error: &str, budget: Option<Decimal>) -> (&'static str, String) {
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

/// An OAuth error code is `[a-z_]`. Anything else is not echoed.
fn could_not_finish(code: &str) -> String {
    let safe = code.len() <= 64 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    format!(
        "World ID could not finish: {}",
        if safe { code } else { "unexpected error" }
    )
}

// ---------------------------------------------------------------------------
// Code exchange and ID token checks
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Failure {
    /// World did not answer. Never an approval.
    Unavailable,
    /// The token endpoint's OAuth `error`.
    Rejected(String),
    /// The ID token failed this check.
    Invalid(&'static str),
}

impl Failure {
    pub fn reason(&self) -> String {
        match self {
            Failure::Unavailable => UNAVAILABLE.to_string(),
            Failure::Rejected(code) if code == "invalid_grant" => CODE_SPENT.to_string(),
            Failure::Rejected(code) => could_not_finish(code),
            Failure::Invalid("acr") => {
                "Your World ID level is too low for this budget, lower it or verify with Orb"
                    .to_string()
            }
            Failure::Invalid(claim) => format!("Approval did not validate ({claim})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HumanGrant {
    pub attempt_id: String,
    pub iss: String,
    pub sub: String,
    pub acr: String,
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client builds")
});

/// Swaps the code for an ID token and checks it against the attempt.
pub async fn redeem(code: &str, attempt: &Attempt, now_ms: i64) -> Result<HumanGrant, Failure> {
    let client = configured().map_err(|_| Failure::Unavailable)?;
    let id_token = exchange(client, code, &attempt.verifier).await?;
    let jwt = parse_jwt(&id_token)?;
    let key = match cached_key(&jwt.kid) {
        Some(key) => key,
        None => {
            refresh_keys(client).await?;
            cached_key(&jwt.kid).ok_or(Failure::Invalid("kid"))?
        }
    };
    check_signature(&jwt, &key)?;
    check_claims(&jwt.claims, client, attempt, now_ms).map_err(Failure::Invalid)
}

/// One retry on a timeout or 503 with the same code, as World allows.
async fn exchange(client: &WorldClient, code: &str, verifier: &str) -> Result<String, Failure> {
    for retry in [false, true] {
        let sent = HTTP
            .post(format!("{}/api/v1/token", client.issuer))
            .basic_auth(&client.client_id, Some(&client.client_secret))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", client.redirect_uri.as_str()),
                ("code_verifier", verifier),
            ])
            .send()
            .await;
        let res = match sent {
            Ok(res) if res.status() != reqwest::StatusCode::SERVICE_UNAVAILABLE => res,
            Ok(_) | Err(_) if !retry => continue,
            Ok(_) => return Err(Failure::Unavailable),
            Err(err) => {
                tracing::warn!("[world] token endpoint unreachable: {}", err.without_url());
                return Err(Failure::Unavailable);
            }
        };
        let status = res.status();
        let body: Value = res.json().await.map_err(|_| Failure::Unavailable)?;
        if !status.is_success() {
            let code = body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("token_error");
            tracing::warn!("[world] token endpoint said {status} {code}");
            return Err(Failure::Rejected(code.to_string()));
        }
        return body
            .get("id_token")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(Failure::Invalid("id_token"));
    }
    Err(Failure::Unavailable)
}

#[derive(Debug, Clone)]
struct Jwk {
    kid: String,
    n: Vec<u8>,
    e: Vec<u8>,
}

/// Fetched on the first callback, refetched only for a `kid` it lacks.
static KEYS: RwLock<Vec<Jwk>> = RwLock::new(Vec::new());

fn cached_key(kid: &str) -> Option<Jwk> {
    KEYS.read()
        .expect("jwks lock")
        .iter()
        .find(|k| k.kid == kid)
        .cloned()
}

fn parse_jwks(body: &Value) -> Vec<Jwk> {
    let b64 = |key: &Value, name: &str| {
        key.get(name)
            .and_then(Value::as_str)
            .and_then(|v| URL_SAFE_NO_PAD.decode(v).ok())
    };
    body.get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|key| key.get("kty").and_then(Value::as_str) == Some("RSA"))
        .filter_map(|key| {
            Some(Jwk {
                kid: key.get("kid")?.as_str()?.to_string(),
                n: b64(key, "n")?,
                e: b64(key, "e")?,
            })
        })
        .collect()
}

async fn refresh_keys(client: &WorldClient) -> Result<(), Failure> {
    let res = HTTP
        .get(format!("{}/.well-known/jwks.json", client.issuer))
        .send()
        .await
        .and_then(|res| res.error_for_status())
        .map_err(|err| {
            tracing::warn!("[world] jwks fetch failed: {}", err.without_url());
            Failure::Unavailable
        })?;
    let body: Value = res.json().await.map_err(|_| Failure::Unavailable)?;
    let keys = parse_jwks(&body);
    if keys.is_empty() {
        tracing::error!("[world] jwks has no RSA keys");
        return Err(Failure::Unavailable);
    }
    *KEYS.write().expect("jwks lock") = keys;
    Ok(())
}

struct Jwt<'a> {
    kid: String,
    signed: &'a str,
    signature: Vec<u8>,
    claims: Value,
}

fn parse_jwt(token: &str) -> Result<Jwt<'_>, Failure> {
    let bad = |claim| Failure::Invalid(claim);
    let (signed, signature) = token.rsplit_once('.').ok_or(bad("format"))?;
    let (header, payload) = signed.split_once('.').ok_or(bad("format"))?;
    let json = |part: &str| -> Result<Value, Failure> {
        let bytes = URL_SAFE_NO_PAD.decode(part).map_err(|_| bad("format"))?;
        serde_json::from_slice(&bytes).map_err(|_| bad("format"))
    };
    let header = json(header)?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err(bad("alg"));
    }
    Ok(Jwt {
        kid: header
            .get("kid")
            .and_then(Value::as_str)
            .ok_or(bad("kid"))?
            .to_string(),
        signed,
        signature: URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| bad("format"))?,
        claims: json(payload)?,
    })
}

fn check_signature(jwt: &Jwt, key: &Jwk) -> Result<(), Failure> {
    RsaPublicKeyComponents {
        n: &key.n,
        e: &key.e,
    }
    .verify(
        &RSA_PKCS1_2048_8192_SHA256,
        jwt.signed.as_bytes(),
        &jwt.signature,
    )
    .map_err(|_| Failure::Invalid("signature"))
}

/// Every claim World documents for a step-up, in the order a failure is named.
fn check_claims(
    claims: &Value,
    client: &WorldClient,
    attempt: &Attempt,
    now_ms: i64,
) -> Result<HumanGrant, &'static str> {
    let text = |name: &'static str| claims.get(name).and_then(Value::as_str).ok_or(name);
    let seconds = |name: &'static str| claims.get(name).and_then(Value::as_i64).ok_or(name);
    let now_s = now_ms / 1_000;

    if text("iss")? != client.issuer {
        return Err("iss");
    }
    let audience_ok = match claims.get("aud") {
        Some(Value::String(aud)) => *aud == client.client_id,
        Some(Value::Array(auds)) => {
            auds.iter().any(|a| a.as_str() == Some(&client.client_id))
                && (auds.len() == 1 || text("azp").ok() == Some(client.client_id.as_str()))
        }
        _ => false,
    };
    if !audience_ok {
        return Err("aud");
    }
    if seconds("exp")? <= now_s {
        return Err("exp");
    }
    if text("nonce")? != attempt.nonce {
        return Err("nonce");
    }
    let auth_time = seconds("auth_time")?;
    if auth_time < attempt.created_at_ms / 1_000 - AUTH_TIME_BEFORE_S
        || auth_time > now_s + AUTH_TIME_AHEAD_S
    {
        return Err("auth_time");
    }
    let acr = text("acr")?;
    if !attempt.acr_allowed.iter().any(|a| a == acr) {
        return Err("acr");
    }
    let face = claims
        .get("amr")
        .and_then(Value::as_array)
        .is_some_and(|amr| amr.iter().any(|m| m.as_str() == Some("face")));
    if acr.ends_with("-face") && !face {
        return Err("amr");
    }
    let sub = text("sub")?;
    if sub.is_empty() {
        return Err("sub");
    }
    Ok(HumanGrant {
        attempt_id: attempt.id.clone(),
        iss: client.issuer.clone(),
        sub: sub.to_string(),
        acr: acr.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Per-human rules, run inside the session's write
// ---------------------------------------------------------------------------

/// `(iss, sub)` of the human linked to a wallet.
fn link_of(conn: &Connection, wallet: &str) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT iss, sub FROM world_links WHERE wallet = ?1",
        [wallet],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

fn running(conn: &Connection, session_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE id = ?1 AND status = 'running')",
        [session_id],
        |r| r.get(0),
    )
}

fn wallets_of(conn: &Connection, iss: &str, sub: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(
        "SELECT wallet FROM world_links WHERE iss = ?1 AND sub = ?2 ORDER BY linked_at",
    )?
    .query_map([iss, sub], |r| r.get(0))?
    .collect()
}

/// `bans::is_globally_banned` over every wallet, read inside the write so it
/// can't drift from the rows it gates.
fn any_banned(conn: &Connection, wallets: &[String]) -> rusqlite::Result<bool> {
    let env = &config().banned_wallet_addresses;
    for wallet in wallets {
        let key = canonical(wallet);
        if env.iter().any(|banned| canonical(banned) == key) {
            return Ok(true);
        }
        let listed: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM banned_wallets WHERE wallet_address = ?1)",
            [&key],
            |r| r.get(0),
        )?;
        if listed {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Why this human can't start this wallet's YOLO session, recorded on the
/// attempt. `None` lets the insert go ahead.
pub(crate) fn claim(
    conn: &Connection,
    grant: &HumanGrant,
    wallet: &str,
    start_nonce: &str,
    now_ms: i64,
) -> rusqlite::Result<Option<Rejection>> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT status, expires_at FROM world_attempts WHERE id = ?1 AND wallet = ?2",
            [&grant.attempt_id, wallet],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((status, expires_at)) = row else {
        return Ok(Some(refuse(404, ALREADY_USED)));
    };
    if status != "pending" {
        return Ok(Some(refuse(409, ALREADY_USED)));
    }
    let end = |status: &str, http: u16, reason: &str| {
        settle(conn, &grant.attempt_id, status, reason, now_ms)?;
        Ok(Some(refuse(http, reason)))
    };
    if expires_at <= now_ms * 1_000 {
        return end("expired", 410, EXPIRED);
    }
    if link_of(conn, wallet)?.is_some_and(|(iss, sub)| iss != grant.iss || sub != grant.sub) {
        return end("mismatch", 403, MISMATCH);
    }
    let mut wallets = wallets_of(conn, &grant.iss, &grant.sub)?;
    wallets.push(wallet.to_string());
    if any_banned(conn, &wallets)? {
        return end("denied", 403, BANNED_HUMAN);
    }
    let running: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE status = 'running' AND mode = 'yolo' \
           AND wallet IN (SELECT wallet FROM world_links WHERE iss = ?1 AND sub = ?2))",
        [&grant.iss, &grant.sub],
        |r| r.get(0),
    )?;
    if running {
        return end("denied", 409, ONE_PER_HUMAN);
    }
    if let Some((http, body)) = agent::start_blocked(conn, start_nonce, wallet)? {
        let reason = body["error"]
            .as_str()
            .unwrap_or("Start refused")
            .to_string();
        return end("denied", http, &reason);
    }
    Ok(None)
}

/// Links the wallet to its human and spends the attempt on the new session.
pub(crate) fn approve(
    conn: &Connection,
    grant: &HumanGrant,
    wallet: &str,
    session_id: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO world_links (wallet, iss, sub, acr, linked_at) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT (wallet) DO UPDATE SET acr = excluded.acr",
        params![wallet, grant.iss, grant.sub, grant.acr, now_ms * 1_000],
    )?;
    conn.execute(
        "UPDATE world_attempts SET status = 'approved', reason = ?2, acr = ?3, session_id = ?4, \
         done_at = ?5 WHERE id = ?1 AND status = 'pending'",
        params![
            grant.attempt_id,
            VERIFIED,
            grant.acr,
            session_id,
            now_ms * 1_000
        ],
    )?;
    Ok(())
}

/// Spends an approved checkpoint on its paused session: the same human, not
/// banned, before the pause runs out. `Err` is the status the attempt ended
/// with, `"used"` when it had already ended.
pub async fn resume(
    db: &Db,
    grant: HumanGrant,
    now_ms: i64,
) -> ApiResult<Result<String, &'static str>> {
    db.write(move |conn| {
        let row: Option<(String, i64, String, String)> = conn
            .query_row(
                "SELECT status, expires_at, session_id, wallet FROM world_attempts \
                 WHERE id = ?1 AND kind = 'checkpoint'",
                [&grant.attempt_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((status, expires_at, session_id, wallet)) = row else {
            return Ok(Err("used"));
        };
        if status != "pending" {
            return Ok(Err("used"));
        }
        let end = |status: &'static str, reason: &str| {
            settle(conn, &grant.attempt_id, status, reason, now_ms).map(|_| Err(status))
        };
        if expires_at <= now_ms * 1_000 {
            return Ok(end("expired", EXPIRED)?);
        }
        if !running(conn, &session_id)? {
            return Ok(end("failed", AGENT_GONE)?);
        }
        if link_of(conn, &wallet)? != Some((grant.iss.clone(), grant.sub.clone())) {
            return Ok(end("mismatch", MISMATCH)?);
        }
        if any_banned(conn, &wallets_of(conn, &grant.iss, &grant.sub)?)? {
            return Ok(end("denied", BANNED_HUMAN)?);
        }
        conn.execute(
            "UPDATE world_attempts SET status = 'approved', reason = ?2, acr = ?3, done_at = ?4 \
             WHERE id = ?1 AND status = 'pending'",
            params![grant.attempt_id, VERIFIED, grant.acr, now_ms * 1_000],
        )?;
        Ok(Ok(session_id))
    })
    .await
}

/// Whether the paused session's human approved its checkpoint. `give_up`
/// expires one still out at World in the same write, so none lands later.
pub async fn checkpoint_passed(
    db: &Db,
    session_id: &str,
    give_up: bool,
    now_ms: i64,
) -> ApiResult<bool> {
    let session_id = session_id.to_string();
    db.write(move |conn| {
        let passed: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM world_attempts \
              WHERE session_id = ?1 AND kind = 'checkpoint' AND status = 'approved')",
            [&session_id],
            |r| r.get(0),
        )?;
        if !passed && give_up {
            conn.execute(
                "UPDATE world_attempts SET status = 'expired', reason = ?2, done_at = ?3 \
                 WHERE session_id = ?1 AND kind = 'checkpoint' AND status = 'pending'",
                params![session_id, EXPIRED, now_ms * 1_000],
            )?;
        }
        Ok(passed)
    })
    .await
}

/// The human behind a wallet for the admin view: proof class, when it was
/// linked, and every wallet that human has used. No `sub`.
pub async fn human_of(db: &Db, wallet: &str) -> ApiResult<Option<Value>> {
    let wallet = canonical(wallet);
    db.read(move |conn| {
        let link: Option<(String, String, Option<String>, i64)> = conn
            .query_row(
                "SELECT iss, sub, acr, linked_at FROM world_links WHERE wallet = ?1",
                [&wallet],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((iss, sub, acr, linked_at)) = link else {
            return Ok(None);
        };
        Ok(Some(json!({
            "acr": acr.as_deref().map(|a| a.strip_prefix(ACR_PREFIX).unwrap_or(a)),
            "linkedAt": linked_at / 1_000,
            "wallets": wallets_of(conn, &iss, &sub)?,
        })))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};

    /// A throwaway 2048 bit key (PKCS#1 DER) and its modulus, for signing fixtures.
    const TEST_KEY: &str = "MIIEpAIBAAKCAQEAtY4WtucT98vTkHFAfXbqawSXZc8VORDY6DWz++QtSBaso3y6v/mX3+e0eRv0IAijmaT5t1YoYFOADvmKA7GZitcTGwjF0ZcmJZegCz1tahZhf3e5SBzczDr+mspqskTex2JovoB0knDBX1YvsY+B931vuVtfydbj0TAjbTwLJB1NTgvqGsTudrp23jJ6H/bLdDS5r4Y0swIGcu0H/28ZKKBKSHU1knGot7vhvEPjrhZ/siXI2wE2BLcPd1BPe35wQPq/yi2Gj8mMouG0YdxiiCgCrFFPTuagI7yZ622H6d5hXgNDzRQnfikw3577QatvsvCQxJZuQl5YWwesyHduBQIDAQABAoIBAAJAv2DpKKsGRTuRYDS+XUXTMoLBqViCMELfabqaOAKhP2au9U1NDlipsihfk62zFb6iGLQw9kLNvnTRHWiS014w8YyAFR5W8xL72PFSw5ERsoeHp42wx/+jysWGdgD80EvmmXiltOydSBUEB4b7SihVTuXcr6lcSIrvvzzLhjLeQcok59+P6Jvd2XyFFB69wu1hfyzMk0Zmram2ZipVjWRnHXi2zM/AAXaZlw/TXKFFdXhYYIxAassieWSyOZAdYVuhMI0LcbnUfnNlXlFmBkyIg2SOFbvTMMHl5WoRznmLj48ImA4hcRwogc7N/1s++4I+yGjD/XjshYrIjn+jpfECgYEA/16rDB4+nuJ2O8UmIz7+j42gGcMxIY76Iul8ht2qAkCVeMYFeFCR0REx2uI3CvaQk5g98e38kBVc+vHOCN4OVvGM+43qkQKrt/yPsLa7FWkGgGCi/7WcZTAFZKj5wbn9+CixAbgSZkkq6sVQ41xZqWJs/MqBL0JN3cLvykkCx9UCgYEAtgDJm1csToxUzawIcG7lm8l8mssfTTnsUym5ksPlIF04G8Yv/KvHYRmnzUW7LGh72hAJtnZazoauCmUMdtPp7gYls8rwotVelpe9XioJ3b9qkAvJSqtV2fhPd2AhSUN1+wDcgAY2fABO8tKEL5Xi9+Z/H1VS8rEODMuHn7OV1XECgYEAm0tInU/vKNPyrppPfPOb/lRT3hbTU+MMvhpa/fDiqAf6Xb2eKfJlGkxokwEqE+KpPPhCA1OEWWKEbp6Jet7+vWSbJYbB9Hk5T+Ooxf/5eSWrLHqX5QTeHLK9NN+FMogWp8inC7KSjd1E2gwwCnNomxcdzASh1sltbMRU6iDILhkCgYBJ3kH1KUlTTANzQlpef7PzKbDIBp7asiKnkiy+U4GgRBVsuGBrlbCjSU1gs+eG25VA6Pd4NcsfPWxPzblkVRgBwj71HO3TuPPd/RIfsMI2XOU8N3xoMOf0QqLGGZ8I5DdzO2NDFsJwS5O/XA/IXHY1FTkNF41F8PR53vVZrQKoEQKBgQCpeQJgVmfYclYZNeGg2wTJ21/wfDKI8a9Q1F+wUUtn8Z6LuIewYofmN0WAo8uhNXCxB4L2n+hE8CIiZfteSIgteWNSbfFWqmmwb1eoYUxmXNAgvO7PkxZuZdTmJDC1LjKhSwVLwc6F4bdLw3KZJG2Og5PhJ8ZE8mBeJwOvZww8Uw==";
    const TEST_N: &str = "tY4WtucT98vTkHFAfXbqawSXZc8VORDY6DWz--QtSBaso3y6v_mX3-e0eRv0IAijmaT5t1YoYFOADvmKA7GZitcTGwjF0ZcmJZegCz1tahZhf3e5SBzczDr-mspqskTex2JovoB0knDBX1YvsY-B931vuVtfydbj0TAjbTwLJB1NTgvqGsTudrp23jJ6H_bLdDS5r4Y0swIGcu0H_28ZKKBKSHU1knGot7vhvEPjrhZ_siXI2wE2BLcPd1BPe35wQPq_yi2Gj8mMouG0YdxiiCgCrFFPTuagI7yZ622H6d5hXgNDzRQnfikw3577QatvsvCQxJZuQl5YWwesyHduBQ";
    const NOW_MS: i64 = 1_800_000_000_000;

    fn client() -> WorldClient {
        WorldClient {
            issuer: "https://sandbox.auth.world.org".into(),
            client_id: "app_client".into(),
            client_secret: "worldidp_client_secret_x".into(),
            redirect_uri: "https://example.org/api/world/callback".into(),
        }
    }

    fn key() -> Jwk {
        parse_jwks(&json!({ "keys": [
            { "kty": "EC", "kid": "k1", "x": "AA", "y": "AA" },
            { "kty": "RSA", "kid": "k1", "n": TEST_N, "e": "AQAB" },
        ]}))
        .remove(0)
    }

    fn attempt() -> Attempt {
        Attempt {
            id: "attempt-1".into(),
            wallet: "0x1111111111111111111111111111111111111111".into(),
            message: "terms".into(),
            nonce: terms_nonce("attempt-1", "terms"),
            verifier: "v".into(),
            browser: browser_hash("secret"),
            acr_allowed: full_acr(&CLASSES[1..]),
            status: "pending".into(),
            reason: None,
            acr: None,
            session_id: None,
            expires_at_ms: NOW_MS + ATTEMPT_TTL_MS,
            created_at_ms: NOW_MS - 20_000,
            kind: "start".into(),
        }
    }

    fn claims() -> Value {
        json!({
            "iss": "https://sandbox.auth.world.org",
            "sub": "human-1",
            "aud": "app_client",
            "exp": NOW_MS / 1000 + 300,
            "iat": NOW_MS / 1000 - 5,
            "auth_time": NOW_MS / 1000 - 10,
            "nonce": terms_nonce("attempt-1", "terms"),
            "acr": format!("{ACR_PREFIX}orb"),
            "amr": ["pop"],
        })
    }

    fn sign(header: Value, claims: &Value) -> String {
        let pair = RsaKeyPair::from_der(
            &base64::engine::general_purpose::STANDARD
                .decode(TEST_KEY)
                .unwrap(),
        )
        .unwrap();
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let mut sig = vec![0; pair.public().modulus_len()];
        pair.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            signed.as_bytes(),
            &mut sig,
        )
        .unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig))
    }

    fn check(token: &str) -> Result<HumanGrant, Failure> {
        let jwt = parse_jwt(token)?;
        check_signature(&jwt, &key())?;
        check_claims(&jwt.claims, &client(), &attempt(), NOW_MS).map_err(Failure::Invalid)
    }

    fn rs256() -> Value {
        json!({ "alg": "RS256", "kid": "k1", "typ": "JWT" })
    }

    #[test]
    fn a_signed_token_for_this_attempt_is_a_grant() {
        let grant = check(&sign(rs256(), &claims())).unwrap();
        assert_eq!(grant.sub, "human-1");
        assert_eq!(grant.acr, format!("{ACR_PREFIX}orb"));
        assert_eq!(grant.attempt_id, "attempt-1");
    }

    #[test]
    fn signature_and_algorithm_are_enforced() {
        let token = sign(rs256(), &claims());
        let (head, rest) = token.split_once('.').unwrap();
        let (_, sig) = rest.rsplit_once('.').unwrap();
        let mut forged = claims();
        forged["sub"] = json!("human-2");
        let swapped = format!(
            "{head}.{}.{sig}",
            URL_SAFE_NO_PAD.encode(forged.to_string())
        );
        assert_eq!(check(&swapped).unwrap_err(), Failure::Invalid("signature"));

        for alg in ["none", "HS256", "RS512"] {
            let token = sign(json!({ "alg": alg, "kid": "k1" }), &claims());
            assert_eq!(check(&token).unwrap_err(), Failure::Invalid("alg"), "{alg}");
        }
        let unsigned = format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(json!({ "alg": "none" }).to_string()),
            URL_SAFE_NO_PAD.encode(claims().to_string())
        );
        assert_eq!(check(&unsigned).unwrap_err(), Failure::Invalid("alg"));
        assert_eq!(check("not-a-jwt").unwrap_err(), Failure::Invalid("format"));
    }

    #[test]
    fn every_claim_is_checked() {
        let now_s = NOW_MS / 1000;
        let cases: Vec<(&str, Value, &str)> = vec![
            ("iss", json!("https://auth.world.org"), "iss"),
            ("aud", json!("someone_else"), "aud"),
            ("aud", json!(["app_client", "other"]), "aud"),
            ("exp", json!(now_s), "exp"),
            ("nonce", json!(terms_nonce("attempt-2", "terms")), "nonce"),
            ("auth_time", json!(now_s - 3_600), "auth_time"),
            ("auth_time", json!(now_s + 120), "auth_time"),
            ("acr", json!(format!("{ACR_PREFIX}selfie")), "acr"),
            ("acr", json!(format!("{ACR_PREFIX}orb-face")), "amr"),
            ("sub", json!(""), "sub"),
        ];
        for (name, value, failed) in cases {
            let mut c = claims();
            c[name] = value.clone();
            assert_eq!(
                check(&sign(rs256(), &c)).unwrap_err(),
                Failure::Invalid(failed),
                "{name} = {value}"
            );
        }
        let mut missing = claims();
        missing.as_object_mut().unwrap().remove("auth_time");
        assert_eq!(
            check(&sign(rs256(), &missing)).unwrap_err(),
            Failure::Invalid("auth_time")
        );

        let mut face = claims();
        face["acr"] = json!(format!("{ACR_PREFIX}orb-face"));
        face["amr"] = json!(["pop", "face", "user"]);
        assert!(check(&sign(rs256(), &face)).is_ok());
        let mut multi = claims();
        multi["aud"] = json!(["app_client", "other"]);
        multi["azp"] = json!("app_client");
        assert!(check(&sign(rs256(), &multi)).is_ok());
    }

    #[test]
    fn the_budget_picks_the_proof_class() {
        let (selfie, orb) = (Decimal::from(10), Decimal::from(50));
        let tier = |budget: i64, floor| {
            accepted_classes(Decimal::from(budget), selfie, orb, floor).unwrap()
        };
        assert_eq!(tier(10, None), ["selfie", "orb", "orb-face"]);
        assert_eq!(tier(11, None), ["orb", "orb-face"]);
        assert_eq!(tier(50, None), ["orb", "orb-face"]);
        assert_eq!(tier(51, None), ["orb-face"]);
        assert_eq!(tier(5, Some("orb")), ["orb", "orb-face"]);
        assert_eq!(tier(60, Some("selfie")), ["orb-face"]);
        assert!(accepted_classes(Decimal::ONE, selfie, orb, Some("passkey")).is_err());
        assert!(accepted_classes(Decimal::from(30), orb, selfie, None).is_err());
    }

    #[test]
    fn the_authorize_url_asks_for_a_fresh_proof_of_the_class() {
        let url = reqwest::Url::parse(&authorize_url(
            &client(),
            "st",
            "no",
            "ver",
            &CLASSES[1..],
            Some("human-1"),
        ))
        .unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/api/v1/authorize");
        assert_eq!(q["max_age"], "0");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(
            q["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"ver"))
        );
        assert_eq!(q["scope"], "openid");
        let claims: Value = serde_json::from_str(&q["claims"]).unwrap();
        assert_eq!(claims["id_token"]["acr"]["essential"], true);
        assert_eq!(claims["id_token"]["sub"]["value"], "human-1");
        assert_eq!(
            claims["id_token"]["acr"]["values"][1],
            format!("{ACR_PREFIX}orb-face")
        );
    }

    #[test]
    fn world_errors_map_to_outcomes() {
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
        assert_eq!(
            Failure::Rejected("invalid_grant".into()).reason(),
            CODE_SPENT
        );
    }

    // -- the write-transaction rules, against a real file --------------------

    fn start_terms(wallet: &str, nonce: &str) -> StartTerms {
        StartTerms {
            wallet: wallet.into(),
            chain_id: 5042002,
            asset: "BTC".into(),
            mode: "yolo".into(),
            budget: Decimal::from(20),
            max_per_trade: Decimal::from(5),
            stop_loss: Decimal::from(10),
            minutes: 10,
            expires_ms: NOW_MS + 600_000,
            nonce: nonce.into(),
        }
    }

    async fn pending(db: &Db, id: &str, wallet: &str) {
        let (id, wallet) = (id.to_string(), wallet.to_string());
        db.write(move |conn| {
            conn.execute(
                "INSERT INTO world_attempts (id, wallet, message, state, nonce, verifier, browser, \
                 acr_allowed, status, expires_at, created_at) \
                 VALUES (?1, ?2, ?1, ?1, 'n', 'v', 'b', 'x', 'pending', ?3, ?4)",
                params![id, wallet, (NOW_MS + 60_000) * 1_000, NOW_MS * 1_000],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    fn grant(attempt: &str, sub: &str) -> HumanGrant {
        HumanGrant {
            attempt_id: attempt.into(),
            iss: "https://sandbox.auth.world.org".into(),
            sub: sub.into(),
            acr: format!("{ACR_PREFIX}orb"),
        }
    }

    async fn outcome(db: &Db, id: &str) -> (String, Option<String>) {
        let id = id.to_string();
        db.read(move |conn| {
            Ok(conn.query_row(
                "SELECT status, reason FROM world_attempts WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn one_human_one_yolo_wallet_stays_with_its_human_bans_follow() {
        let path = std::env::temp_dir().join(format!("world-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Db::open(&path, 1, 5_000).unwrap();
        let (a, b, c) = (
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "0xcccccccccccccccccccccccccccccccccccccccc",
        );

        pending(&db, "a1", a).await;
        let session = agent::create_session(
            &db,
            start_terms(a, "nonceaaa1"),
            NOW_MS,
            Some(grant("a1", "h1")),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            outcome(&db, "a1").await,
            ("approved".into(), Some(VERIFIED.into()))
        );

        // Spent attempt: a replayed callback creates nothing.
        let replay = agent::create_session(
            &db,
            start_terms(a, "nonceaaa2"),
            NOW_MS,
            Some(grant("a1", "h1")),
        )
        .await
        .unwrap();
        assert_eq!(replay.unwrap_err().0, 409);

        // Same human, second wallet, while A runs.
        pending(&db, "b1", b).await;
        let second = agent::create_session(
            &db,
            start_terms(b, "noncebbb1"),
            NOW_MS,
            Some(grant("b1", "h1")),
        )
        .await
        .unwrap();
        assert_eq!(second.unwrap_err().0, 409);
        assert_eq!(
            outcome(&db, "b1").await,
            ("denied".into(), Some(ONE_PER_HUMAN.into()))
        );

        // Another human on A's wallet.
        agent::stop_session(&db, &session.id, agent::USER_STOPPED)
            .await
            .unwrap();
        pending(&db, "a2", a).await;
        let stolen = agent::create_session(
            &db,
            start_terms(a, "nonceaaa3"),
            NOW_MS,
            Some(grant("a2", "h2")),
        )
        .await
        .unwrap();
        assert_eq!(stolen.unwrap_err().0, 403);
        assert_eq!(
            outcome(&db, "a2").await,
            ("mismatch".into(), Some(MISMATCH.into()))
        );

        // Ban A: the human's fresh wallet C is refused too.
        db.write(move |conn| {
            conn.execute(
                "INSERT INTO banned_wallets (wallet_address) VALUES (?1)",
                [a],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        pending(&db, "c1", c).await;
        let banned = agent::create_session(
            &db,
            start_terms(c, "nonceccc1"),
            NOW_MS,
            Some(grant("c1", "h1")),
        )
        .await
        .unwrap();
        assert_eq!(banned.unwrap_err().0, 403);
        assert_eq!(
            outcome(&db, "c1").await,
            ("denied".into(), Some(BANNED_HUMAN.into()))
        );

        // Expired attempt.
        pending(&db, "c2", c).await;
        let late = agent::create_session(
            &db,
            start_terms(c, "nonceccc2"),
            NOW_MS + 120_000,
            Some(grant("c2", "h3")),
        )
        .await
        .unwrap();
        assert_eq!(late.unwrap_err().0, 410);
        assert_eq!(outcome(&db, "c2").await.0, "expired");

        let human = human_of(&db, a).await.unwrap().unwrap();
        assert_eq!(human["wallets"], json!([a]));
        assert_eq!(human["acr"], "orb");

        let sessions: i64 = db
            .read(|conn| {
                Ok(conn.query_row("SELECT count(*) FROM agent_sessions", [], |r| r.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(sessions, 1);
        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
