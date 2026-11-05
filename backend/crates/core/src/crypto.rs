//! Signed-token formats for cookies and settlement tokens.
//!
//! Three formats, all `base64url(payload).base64url(sig)` or a JSON envelope:
//!   balance session  {v,exp,n}            HMAC-SHA256 over the payload string
//!   settlement token {betId,...,iat,exp}  HMAC-SHA256 over the payload string
//!   admin session    {iat,sig}            sig = hex HMAC-SHA256("admin:<iat>")
//!
//! Payload key order follows the struct field order.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::config::config;

const SESSION_VERSION: u8 = 1;
const SESSION_TTL_SECONDS: i64 = 60 * 60 * 12;
const DEFAULT_SETTLEMENT_TTL_SECONDS: i64 = 5 * 60;
const MIN_SETTLEMENT_TTL_SECONDS: i64 = 60;

/// Withdrawal-intent freshness windows.
pub const MAX_INTENT_AGE_MS: i64 = 5 * 60 * 1000;
pub const MAX_CLOCK_SKEW_MS: i64 = 60 * 1000;
pub const MAX_ACCEPT_INTENT_AGE_MS: i64 = 10 * 60 * 1000;

pub const BALANCE_SESSION_COOKIE: &str = "strike_balance_gate";
pub const ADMIN_COOKIE_NAME: &str = "strike_admin_session";

#[derive(Serialize, Deserialize)]
struct SessionPayload {
    v: u8,
    exp: i64,
    n: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettlementPayload {
    pub bet_id: String,
    pub user_address: String,
    pub currency: String,
    pub max_payout: f64,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Serialize)]
struct AdminPayload<'a> {
    iat: i64,
    sig: &'a str,
}

#[derive(Deserialize)]
struct AdminPayloadOwned {
    iat: i64,
    sig: String,
}

fn now_seconds() -> i64 {
    chrono::Utc::now().timestamp()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn hmac_b64url(secret: &str, input: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(input.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn hmac_hex(secret: &str, input: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(input.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time string compare, mirroring the TS `timingSafeEqual` on the
/// UTF-8 bytes plus its explicit length check.
fn constant_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Balance session cookie
// ---------------------------------------------------------------------------

/// `mintBalanceSessionCookieValue()` — returns None when the secret is unset,
/// exactly as the TS version does.
pub fn mint_balance_session() -> Option<String> {
    mint_balance_session_with(config().balance_internal_secret.as_deref())
}

pub fn mint_balance_session_with(secret: Option<&str>) -> Option<String> {
    // An empty secret is falsy in the TS code, which mints nothing.
    let secret = secret.filter(|s| !s.is_empty())?;
    let exp = now_seconds() + SESSION_TTL_SECONDS;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).expect("OS randomness");
    let n = hex::encode(nonce);
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&SessionPayload {
            v: SESSION_VERSION,
            exp,
            n,
        })
        .ok()?,
    );
    let sig = hmac_b64url(secret, &payload);
    Some(format!("{payload}.{sig}"))
}

/// `verifyBalanceSessionCookieValue()` — signature first, then expiry.
pub fn verify_balance_session(raw: Option<&str>) -> bool {
    verify_balance_session_with(config().balance_internal_secret.as_deref(), raw)
}

pub fn verify_balance_session_with(secret: Option<&str>, raw: Option<&str>) -> bool {
    let Some(secret) = secret.filter(|s| !s.is_empty()) else {
        return false;
    };
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return false;
    };

    let mut parts = value.split('.');
    let (Some(payload), Some(sig), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if payload.is_empty() || sig.is_empty() {
        return false;
    }
    if !constant_eq(sig, &hmac_b64url(secret, payload)) {
        return false;
    }

    let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(decoded) = serde_json::from_slice::<SessionPayload>(&bytes) else {
        return false;
    };
    decoded.v == SESSION_VERSION && decoded.exp >= now_seconds()
}

// ---------------------------------------------------------------------------
// Settlement tokens
// ---------------------------------------------------------------------------

/// `createSettlementToken()`. Requires BALANCE_SETTLEMENT_SECRET; the TS code
/// throws when it is missing, so callers must surface a 503 instead.
pub fn create_settlement_token(
    bet_id: &str,
    user_address: &str,
    currency: &str,
    max_payout: f64,
    ttl_seconds: i64,
) -> Result<String, String> {
    create_settlement_token_with(
        config().balance_settlement_secret.as_deref(),
        bet_id,
        user_address,
        currency,
        max_payout,
        ttl_seconds,
    )
}

pub fn create_settlement_token_with(
    secret: Option<&str>,
    bet_id: &str,
    user_address: &str,
    currency: &str,
    max_payout: f64,
    ttl_seconds: i64,
) -> Result<String, String> {
    let secret = secret
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "BALANCE_SETTLEMENT_SECRET is not configured.".to_string())?;

    let now = now_seconds();
    let ttl = if ttl_seconds > 0 {
        ttl_seconds
    } else {
        DEFAULT_SETTLEMENT_TTL_SECONDS
    }
    .max(MIN_SETTLEMENT_TTL_SECONDS);
    let payload = SettlementPayload {
        bet_id: bet_id.to_string(),
        user_address: user_address.to_string(),
        currency: currency.to_string(),
        max_payout,
        iat: now,
        exp: now + ttl,
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).map_err(|e| e.to_string())?);
    let sig = hmac_b64url(secret, &encoded);
    Ok(format!("{encoded}.{sig}"))
}

/// `verifySettlementToken()` — HMAC, then required fields, then exp, then the
/// maxPayout guard (finite and > 0).
pub fn verify_settlement_token(token: Option<&str>) -> Option<SettlementPayload> {
    verify_settlement_token_with(config().balance_settlement_secret.as_deref(), token)
}

pub fn verify_settlement_token_with(
    secret: Option<&str>,
    token: Option<&str>,
) -> Option<SettlementPayload> {
    let secret = secret.filter(|s| !s.is_empty())?;
    let value = token?.trim();
    if value.is_empty() {
        return None;
    }
    let mut parts = value.split('.');
    let (Some(encoded), Some(sig), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    if encoded.is_empty() || sig.is_empty() {
        return None;
    }
    if !constant_eq(sig, &hmac_b64url(secret, encoded)) {
        return None;
    }

    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let parsed: SettlementPayload = serde_json::from_slice(&bytes).ok()?;
    if parsed.bet_id.is_empty() || parsed.user_address.is_empty() || parsed.currency.is_empty() {
        return None;
    }
    if !parsed.max_payout.is_finite() || parsed.max_payout <= 0.0 {
        return None;
    }
    if parsed.exp < now_seconds() {
        return None;
    }
    Some(parsed)
}

// ---------------------------------------------------------------------------
// Agent token
// ---------------------------------------------------------------------------

pub const AGENT_COOKIE: &str = "strike_agent";

/// Binds a cookie to one wallet and one agent session.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct AgentClaims {
    pub session_id: String,
    pub wallet: String,
    pub exp: i64,
}

/// Signed with the settlement secret under its own prefix, so an agent token
/// never verifies as a settlement token or the other way round.
fn agent_mac(secret: &str, encoded: &str) -> String {
    hmac_b64url(secret, &format!("agent.{encoded}"))
}

pub fn mint_agent_token(
    session_id: &str,
    wallet: &str,
    ttl_seconds: i64,
) -> Result<String, String> {
    let secret = config()
        .balance_settlement_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "BALANCE_SETTLEMENT_SECRET is not configured.".to_string())?;
    let claims = AgentClaims {
        session_id: session_id.to_string(),
        wallet: wallet.to_string(),
        exp: now_seconds() + ttl_seconds,
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|e| e.to_string())?);
    Ok(format!("{encoded}.{}", agent_mac(secret, &encoded)))
}

pub fn verify_agent_token(token: Option<&str>) -> Option<AgentClaims> {
    let secret = config()
        .balance_settlement_secret
        .as_deref()
        .filter(|s| !s.is_empty())?;
    let (encoded, sig) = token?.trim().split_once('.')?;
    if encoded.is_empty() || !constant_eq(sig, &agent_mac(secret, encoded)) {
        return None;
    }
    let claims: AgentClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    (claims.exp >= now_seconds()).then_some(claims)
}

// ---------------------------------------------------------------------------
// Admin session token
// ---------------------------------------------------------------------------

/// `issueAdminToken()`: base64url JSON envelope of `{iat, sig}`.
pub fn issue_admin_token() -> Result<String, String> {
    issue_admin_token_with(config().dashboard_password.as_deref())
}

pub fn issue_admin_token_with(key: Option<&str>) -> Result<String, String> {
    let key = key
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "DASHBOARD_PASSWORD env var not set".to_string())?;
    let iat = now_seconds();
    let sig = hmac_hex(key, &format!("admin:{iat}"));
    let body = serde_json::to_vec(&AdminPayload { iat, sig: &sig }).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(body))
}

/// `verifyAdminToken()`: expiry window first, then constant-time HMAC compare.
pub fn verify_admin_token(token: Option<&str>) -> bool {
    let cfg = config();
    verify_admin_token_with(
        cfg.dashboard_password.as_deref(),
        (cfg.admin_session_hours * 3600.0) as i64,
        token,
    )
}

pub fn verify_admin_token_with(key: Option<&str>, ttl_seconds: i64, token: Option<&str>) -> bool {
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return false;
    };
    let Some(value) = token.map(str::trim).filter(|v| !v.is_empty()) else {
        return false;
    };

    let Ok(bytes) = URL_SAFE_NO_PAD.decode(value) else {
        return false;
    };
    let Ok(AdminPayloadOwned { iat, sig }) = serde_json::from_slice::<AdminPayloadOwned>(&bytes)
    else {
        return false;
    };

    let age = now_seconds() - iat;
    if age < 0 || age > ttl_seconds {
        return false;
    }
    constant_eq(&hmac_hex(key, &format!("admin:{iat}")), &sig)
}

/// `verifyAdminToken()`'s password comparison: both the candidate and the
/// stored secret are hashed under the stored secret as the HMAC key, so the
/// comparison time reveals nothing about the stored password's length.
pub fn dashboard_password_matches(stored: &str, candidate: &str) -> bool {
    constant_eq(&hmac_hex(stored, candidate), &hmac_hex(stored, stored))
}

// ---------------------------------------------------------------------------
// Withdrawal intent freshness
// ---------------------------------------------------------------------------

/// Signature good for 5 minutes, tolerating a client clock 60s ahead.
pub fn is_authorization_fresh(signed_at_ms: i64) -> bool {
    is_authorization_fresh_at(now_millis(), signed_at_ms)
}

/// Same rule with the clock passed in, so the boundary is testable. Every
/// freshness check reads "now" twice if the clock is implicit - once in the
/// test and once here - and a signature that is exactly as old as the limit
/// then flips to stale.
pub fn is_authorization_fresh_at(now_ms: i64, signed_at_ms: i64) -> bool {
    within_window(now_ms, signed_at_ms, MAX_INTENT_AGE_MS)
}

/// Wider window for a signature sitting in the manual approval queue.
pub fn is_within_accept_window(signed_at_ms: i64) -> bool {
    is_within_accept_window_at(now_millis(), signed_at_ms)
}

pub fn is_within_accept_window_at(now_ms: i64, signed_at_ms: i64) -> bool {
    within_window(now_ms, signed_at_ms, MAX_ACCEPT_INTENT_AGE_MS)
}

fn within_window(now_ms: i64, signed_at_ms: i64, max_age_ms: i64) -> bool {
    let age = now_ms - signed_at_ms;
    age >= -MAX_CLOCK_SKEW_MS && age <= max_age_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "unit-test-secret";
    const ADMIN_TTL: i64 = 8 * 3600;

    #[test]
    fn session_payload_round_trips() {
        let minted = mint_balance_session_with(Some(SECRET)).expect("mint");
        assert!(verify_balance_session_with(Some(SECRET), Some(&minted)));
        // Flipping one byte of the signature must fail.
        let (payload, sig) = minted.rsplit_once('.').unwrap();
        let mut bad = sig.chars().collect::<Vec<_>>();
        let last = bad.len() - 1;
        bad[last] = if bad[last] == 'A' { 'B' } else { 'A' };
        assert!(!verify_balance_session_with(
            Some(SECRET),
            Some(&format!("{payload}.{}", bad.iter().collect::<String>()))
        ));
    }

    #[test]
    fn malformed_session_values_are_rejected() {
        for case in ["", "no-dot", "a.b.c", ".", "YXlb.YQ", "###.###"] {
            assert!(
                !verify_balance_session_with(Some(SECRET), Some(case)),
                "accepted {case:?}"
            );
        }
    }

    #[test]
    fn settlement_token_verifies_and_reports_payload() {
        let token = create_settlement_token_with(Some(SECRET), "bet-1", "0xABC", "USDC", 12.5, 300)
            .unwrap();
        let verified = verify_settlement_token_with(Some(SECRET), Some(&token)).expect("verify");
        assert_eq!(verified.bet_id, "bet-1");
        assert_eq!(verified.currency, "USDC");
        assert_eq!(verified.max_payout, 12.5);
    }

    #[test]
    fn settlement_token_is_secret_bound() {
        let token =
            create_settlement_token_with(Some(SECRET), "bet-2", "0xABC", "USDC", 5.0, 300).unwrap();
        assert!(verify_settlement_token_with(Some(SECRET), Some(&token)).is_some());
        // A token minted under one secret must not verify under another.
        assert!(verify_settlement_token_with(Some("other-secret"), Some(&token)).is_none());
        assert!(verify_settlement_token_with(None, Some(&token)).is_none());
    }

    #[test]
    fn settlement_rejects_nonpositive_maxpayout() {
        for payout in [0.0, -1.0] {
            let token =
                create_settlement_token_with(Some(SECRET), "bet-3", "0xABC", "USDC", payout, 300)
                    .unwrap();
            assert!(
                verify_settlement_token_with(Some(SECRET), Some(&token)).is_none(),
                "accepted {payout}"
            );
        }
    }

    #[test]
    fn settlement_ttl_floors_at_sixty_seconds() {
        // TS: ttl = max(ttlSeconds || DEFAULT, MIN_TTL)
        let token = create_settlement_token_with(Some(SECRET), "b", "0xA", "USDC", 1.0, 5).unwrap();
        let payload = verify_settlement_token_with(Some(SECRET), Some(&token)).unwrap();
        assert!((payload.exp - payload.iat) >= MIN_SETTLEMENT_TTL_SECONDS);
        let token = create_settlement_token_with(Some(SECRET), "b", "0xA", "USDC", 1.0, 0).unwrap();
        let payload = verify_settlement_token_with(Some(SECRET), Some(&token)).unwrap();
        assert_eq!(payload.exp - payload.iat, DEFAULT_SETTLEMENT_TTL_SECONDS);
    }

    #[test]
    fn admin_token_round_trip_and_expiry_shape() {
        let token = issue_admin_token_with(Some(SECRET)).unwrap();
        assert!(verify_admin_token_with(
            Some(SECRET),
            ADMIN_TTL,
            Some(&token)
        ));
        assert!(!verify_admin_token_with(
            Some("other"),
            ADMIN_TTL,
            Some(&token)
        ));
        assert!(!verify_admin_token_with(
            Some(SECRET),
            ADMIN_TTL,
            Some("not-base64!!")
        ));
        // The window is inclusive: a token issued this second passes at TTL 0
        // and fails one second before it.
        assert!(verify_admin_token_with(Some(SECRET), 0, Some(&token)));
        assert!(!verify_admin_token_with(Some(SECRET), -1, Some(&token)));
    }

    #[test]
    fn dashboard_password_comparison() {
        assert!(dashboard_password_matches("hunter2", "hunter2"));
        assert!(!dashboard_password_matches("hunter2", "hunter3"));
        assert!(!dashboard_password_matches("hunter2", ""));
        // A different-length candidate still compares in the same shape: both
        // sides are fixed-length digests, never the passwords themselves.
        assert!(!dashboard_password_matches(
            "a-very-long-dashboard-passphrase",
            "short"
        ));
    }

    #[test]
    fn intent_windows_match_ts_bounds() {
        // A fixed clock: with `now_millis()` recomputed inside the function, the
        // exact-boundary asserts below would fail once every few runs.
        let now = 1_780_000_000_000;
        assert!(is_authorization_fresh_at(now, now - MAX_INTENT_AGE_MS));
        assert!(!is_authorization_fresh_at(now, now - MAX_INTENT_AGE_MS - 1));
        assert!(is_authorization_fresh_at(now, now + MAX_CLOCK_SKEW_MS));
        assert!(!is_authorization_fresh_at(now, now + MAX_CLOCK_SKEW_MS + 1));
        assert!(is_within_accept_window_at(
            now,
            now - MAX_ACCEPT_INTENT_AGE_MS
        ));
        assert!(!is_within_accept_window_at(
            now,
            now - MAX_ACCEPT_INTENT_AGE_MS - 1
        ));
        // The wall-clock wrappers agree with the injected clock today.
        assert!(is_authorization_fresh(now_millis()));
        assert!(is_within_accept_window(now_millis()));
    }

    #[test]
    fn missing_secrets_disable_verification_not_panic() {
        assert_eq!(mint_balance_session_with(None), None);
        assert_eq!(mint_balance_session_with(Some("")), None);
        assert!(!verify_balance_session_with(Some(""), Some("a.b")));
        assert!(verify_settlement_token_with(Some(""), Some("a.b")).is_none());
        assert!(create_settlement_token_with(None, "b", "0xA", "USDC", 1.0, 300).is_err());
        assert!(!verify_admin_token_with(Some(""), ADMIN_TTL, Some("YWJj")));
        assert!(issue_admin_token_with(None).is_err());
    }
}
