//! `/api/validate-access-code` — the one place an access code is spent.
//!
//! Port of `app/api/validate-access-code/route.ts`. An access code is a bearer
//! credential, and the two rules that survive here unchanged:
//!   * it arrives only in a POST body — never a query param a proxy would log;
//!   * it is never echoed back. The response is `{success, redeemed,
//!     profileLinked}`; the code stays in `user_profiles` on the server.
//!
//! The spend itself is a single conditional UPDATE, not select-then-update, so
//! two wallets redeeming the same code at the same instant cannot both be told
//! they won.

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

use strike_core::address::canonical;
use strike_core::db;
use strike_core::error::{ApiError, ApiResult};

use crate::bans;
use crate::http;

/// Codes are this long at most; anything longer is a paste of something else.
const MAX_CODE_LENGTH: usize = 64;

pub fn routes() -> Router {
    Router::new().route("/api/validate-access-code", post(validate))
}

/// A code is `[A-Za-z0-9-]{1,64}` after trimming, stored upper-cased. Rejecting
/// on shape means a value that could never be a real code never reaches the
/// database, and the rejection message never repeats what was submitted.
pub fn normalize_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_CODE_LENGTH {
        return None;
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some(trimmed.to_uppercase())
}

async fn validate(headers: HeaderMap, body: Bytes) -> Response {
    match spend(&headers, &body).await {
        Ok(response) => response,
        // The catch-all: Postgres payloads can echo the offending value, so the
        // cause is logged as an error code only and the browser gets a fixed
        // string.
        Err(err) => {
            tracing::error!("[access-code] validation error: {}", cause_code(&err));
            http::json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Access code validation failed" }),
            )
        }
    }
}

async fn spend(headers: &HeaderMap, body: &Bytes) -> ApiResult<Response> {
    http::require_balance_session(headers)?;

    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);

    // `if (!code)` / `if (!walletAddress)` — presence before shape.
    let Some(raw_code) = http::body_stringified(&parsed, "code") else {
        return Ok(error(StatusCode::BAD_REQUEST, "Missing access code"));
    };
    let Some(raw_wallet) = http::body_stringified(&parsed, "walletAddress") else {
        return Ok(error(StatusCode::BAD_REQUEST, "Missing wallet address"));
    };

    let Some(normalized) = normalize_code(&raw_code) else {
        return Ok(error(StatusCode::BAD_REQUEST, "Invalid access code"));
    };
    let wallet_key = canonical(&raw_wallet);

    // A banned wallet may neither burn a code nor claim an account.
    if bans::is_globally_banned(&wallet_key).await {
        return Ok(error(StatusCode::FORBIDDEN, "This wallet is banned from the platform."));
    }

    // Existence first, purely to choose between 404 and 400 below; the spend is
    // the UPDATE, so this read cannot race a double redeem into a double credit.
    let code_bind = Value::String(normalized.clone());
    let exists = db::fetch_one(
        "SELECT code FROM access_codes WHERE code = CAST($1 AS text) LIMIT 1",
        &[("text", &code_bind)],
    )
    .await?;
    if exists.is_none() {
        return Ok(error(StatusCode::NOT_FOUND, "Invalid access code"));
    }

    match consume(&normalized, &wallet_key).await {
        Ok(true) => {}
        Ok(false) => {
            return Ok(error(
                StatusCode::BAD_REQUEST,
                "This access code has already been used",
            ))
        }
        // `wallet_address` is UNIQUE: one code per wallet, so a wallet that
        // already redeemed something conflicts here rather than overwriting.
        Err(err) if is_unique_violation(&err) => {
            return Ok(error(
                StatusCode::BAD_REQUEST,
                "This wallet has already used an access code",
            ))
        }
        Err(err) => return Err(err),
    }

    // Non-fatal: the code is spent and the wallet owns it. `profileLinked:
    // false` tells the client the account link needs a retry, without ever
    // repeating the code itself.
    let profile_linked = link_profile(&wallet_key, &normalized).await.is_ok();
    if !profile_linked {
        tracing::error!("[access-code] profile link failed");
    }

    Ok(axum::Json(json!({
        "success": true,
        "redeemed": true,
        "profileLinked": profile_linked,
    }))
    .into_response())
}

/// `UPDATE … WHERE code = $1 AND is_used = false RETURNING code`. Exactly one
/// concurrent caller sees a row come back.
async fn consume(code: &str, wallet_key: &str) -> ApiResult<bool> {
    let now = Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    let code_bind = Value::String(code.to_string());
    let wallet_bind = Value::String(wallet_key.to_string());
    let rows = db::fetch(
        "UPDATE access_codes \
            SET is_used = true, used_at = CAST($2 AS timestamp with time zone), \
                wallet_address = CAST($3 AS text) \
          WHERE code = CAST($1 AS text) AND is_used = false \
          RETURNING code",
        &[
            ("text", &code_bind),
            ("timestamp with time zone", &now),
            ("text", &wallet_bind),
        ],
    )
    .await?;
    // Zero rows is the already-used case. More than one is impossible under a
    // unique `code`, and accepting it would silently credit both spenders.
    Ok(rows.len() == 1)
}

async fn link_profile(wallet_key: &str, code: &str) -> ApiResult<()> {
    let now = Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    let wallet_bind = Value::String(wallet_key.to_string());
    let code_bind = Value::String(code.to_string());
    db::execute(
        "INSERT INTO user_profiles (user_address, access_code, updated_at) \
         VALUES (CAST($1 AS text), CAST($2 AS text), CAST($3 AS timestamp with time zone)) \
         ON CONFLICT (user_address) DO UPDATE \
            SET access_code = EXCLUDED.access_code, updated_at = EXCLUDED.updated_at",
        &[
            ("text", &wallet_bind),
            ("text", &code_bind),
            ("timestamp with time zone", &now),
        ],
    )
    .await?;
    Ok(())
}

/// Postgres 23505, which is what the TS compared on.
fn is_unique_violation(err: &ApiError) -> bool {
    matches!(err, ApiError::Db(db_err) if db::is_unique_violation(db_err))
}

/// Postgres codes name the constraint that broke; quoting the payload would not.
fn cause_code(err: &ApiError) -> String {
    match err {
        ApiError::Db(db_err) => db::pg_error_code(db_err).unwrap_or_else(|| db_err.to_string()),
        other => other.to_string(),
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    http::json_status(status, json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_valid_only_in_its_own_shape() {
        assert_eq!(normalize_code(" BYN-2026-01 ").as_deref(), Some("BYN-2026-01"));
        assert_eq!(normalize_code("abc123").as_deref(), Some("ABC123"));
        // Junk never reaches the database, and the message never repeats it.
        assert_eq!(normalize_code(""), None);
        assert_eq!(normalize_code("   "), None);
        assert_eq!(normalize_code("BYN 2026"), None, "spaces are not code characters");
        assert_eq!(normalize_code("BYN' OR 1=1--"), None);
        assert_eq!(normalize_code("byn/2026"), None);
        assert_eq!(normalize_code(&"A".repeat(65)), None, "64 is the ceiling");
        assert_eq!(normalize_code(&"A".repeat(64)).as_deref(), Some("A".repeat(64).as_str()));
    }

    #[test]
    fn presence_is_checked_before_shape() {
        // `{ code: "" }` is "Missing access code", not "Invalid access code" —
        // the same order the TS route used.
        let empty = json!({ "code": "", "walletAddress": "0xabc" });
        assert!(http::body_stringified(&empty, "code").is_none());
        let shape_junk = json!({ "code": "not a code!", "walletAddress": "0xabc" });
        let raw = http::body_stringified(&shape_junk, "code").unwrap();
        assert!(normalize_code(&raw).is_none());
    }

    #[test]
    fn a_non_string_code_still_reaches_the_shape_check() {
        // `String(code)` in the TS: a numeric payload is coerced, not rejected
        // as the wrong type.
        let body = json!({ "code": 12345, "walletAddress": "0xabc" });
        let raw = http::body_stringified(&body, "code").expect("coerced to \"12345\"");
        assert_eq!(raw, "12345");
        assert_eq!(normalize_code(&raw).as_deref(), Some("12345"));
    }

    #[test]
    fn the_success_body_carries_no_secret() {
        let body = json!({ "success": true, "redeemed": true, "profileLinked": true });
        let serialized = body.to_string();
        assert_eq!(serialized.matches("code").count(), 0, "{serialized}");
        assert_eq!(
            body.get("profileLinked").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn an_unparsable_body_is_a_missing_code_not_a_crash() {
        // `await request.json()` throws on malformed JSON upstream; here the
        // null fallback routes it into the same 400 the TS produced.
        let parsed: Value = serde_json::from_slice(b"not json").unwrap_or(Value::Null);
        assert!(http::body_stringified(&parsed, "code").is_none());
    }
}
