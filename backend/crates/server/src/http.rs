//! HTTP plumbing shared by every handler: cookies, guards, and response
//! assembly. The Next.js routes are the specification — the status codes,
//! bodies and cookie attributes here reproduce them byte for byte, because the
//! browser bundle is unchanged during the migration.

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

use strike_core::config::config;
use strike_core::crypto::{
    self, ADMIN_COOKIE_NAME, BALANCE_SESSION_COOKIE,
};
use strike_core::error::ApiError;

/// The header the browser may send with the raw internal secret, which the TS
/// guard answers with a 401 that tells the caller to use the session endpoint.
const BROWSER_KEY_HEADER: &str = "x-strike-balance-key";

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Cookie {
    pub name: &'static str,
    pub value: String,
    pub max_age: i64,
    pub same_site: &'static str,
    pub http_only: bool,
}

impl Cookie {
    fn render(&self) -> String {
        // `Secure` follows NODE_ENV=production, like the TS routes.
        let secure = if config().production { "; Secure" } else { "" };
        let http_only = if self.http_only { "; HttpOnly" } else { "" };
        format!(
            "{}={}; Path=/; Max-Age={}{}{}; SameSite={}",
            self.name, self.value, self.max_age, http_only, secure, self.same_site
        )
    }
}

/// Reads one cookie out of the request's `Cookie:` header.
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for raw in headers.get_all(HeaderName::from_static("cookie")) {
        let Ok(all) = raw.to_str() else { continue };
        for pair in all.split(';') {
            let pair = pair.trim();
            if let Some(value) = pair.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')) {
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// A JSON response that also sets a cookie.
pub fn json_with_cookie(body: Value, cookie: Cookie) -> Response {
    let mut headers = HeaderMap::new();
    headers.append(
        HeaderName::from_static("set-cookie"),
        HeaderValue::from_str(&cookie.render())
            .unwrap_or_else(|_| HeaderValue::from_static("invalid")),
    );
    (headers, axum::Json(body)).into_response()
}

/// The cookie value that clears a session cookie (Max-Age=0).
pub fn cleared_cookie(name: &'static str, same_site: &'static str) -> Cookie {
    Cookie { name, value: String::new(), max_age: 0, same_site, http_only: true }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/// `assertBalanceApiAuthorized()`. `Ok(())` means "continue"; the error carries
/// the exact status and message the TS route returns.
pub fn require_balance_session(headers: &HeaderMap) -> Result<(), ApiError> {
    let secret = config().balance_internal_secret.clone().unwrap_or_default();

    if secret.is_empty() {
        return if config().production {
            Err(ApiError::unavailable(
                "Balance API auth is not configured on server.",
            ))
        } else {
            Ok(())
        };
    }

    if bearer(headers).as_deref() == Some(secret.as_str()) {
        return Ok(());
    }

    if crypto::verify_balance_session(
        cookie(headers, BALANCE_SESSION_COOKIE).as_deref(),
    ) {
        return Ok(());
    }

    if header_str(headers, BROWSER_KEY_HEADER).as_deref() == Some(secret.as_str()) {
        return Err(ApiError::unauthorized(
            "Use POST /api/balance/session for browser auth or Bearer for server callers.",
        ));
    }

    Err(ApiError::unauthorized("Unauthorized"))
}

/// `requireAdminAuth()`.
pub fn require_admin(headers: &HeaderMap) -> Result<(), ApiError> {
    if config().dashboard_password.is_none() {
        return Err(ApiError::unavailable(
            "Admin auth not configured on server. Set DASHBOARD_PASSWORD.",
        ));
    }
    if crypto::verify_admin_token(cookie(headers, ADMIN_COOKIE_NAME).as_deref()) {
        return Ok(());
    }
    Err(ApiError::unauthorized("Unauthorized"))
}

pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = header_str(headers, "authorization")?;
    let (_, token) = raw.split_once(char::is_whitespace)?;
    // The TS strips only the leading "Bearer "; any further whitespace is part
    // of the credential the caller sent.
    Some(token.trim().to_string())
}

pub fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// `clientIp()` from the admin auth route: first hop of X-Forwarded-For, then
/// X-Real-Ip, then the literal "unknown" the TS used.
pub fn client_ip(headers: &HeaderMap) -> String {
    if let Some(forwarded) = header_str(headers, "x-forwarded-for") {
        if let Some(first) = forwarded.split(',').next() {
            let first = first.trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    header_str(headers, "x-real-ip").unwrap_or_else(|| "unknown".to_string())
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/// `NextResponse.json(body, { status })` for the shapes that are not errors.
pub fn json_status(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

/// `NextResponse.json({ ok: false, error })` bodies used by the admin family.
pub fn ok_false_error(message: &str) -> Value {
    Value::Object(Map::from_iter([
        ("ok".to_string(), Value::Bool(false)),
        ("error".to_string(), Value::String(message.to_string())),
    ]))
}

pub fn too_many(message: &str, retry_after_seconds: i64) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("retry-after"),
        HeaderValue::from(retry_after_seconds),
    );
    (
        StatusCode::TOO_MANY_REQUESTS,
        headers,
        axum::Json(ok_false_error(message)),
    )
        .into_response()
}

/// Pulls a string field, mirroring `typeof x === 'string'` checks.
pub fn body_str<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str).map(str::trim)
}

/// JS truthiness — the check `if (!code)` performed before any coercion.
pub fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// `String(value).trim()` for a field the TS only guarded with `if (!x)`: a
/// number or a bool arrives here as its string spelling rather than being
/// rejected as "not a string".
pub fn body_stringified<'a>(body: &'a Value, key: &str) -> Option<std::borrow::Cow<'a, str>> {
    if !json_truthy(body.get(key)) {
        return None;
    }
    match body.get(key) {
        Some(Value::String(s)) => Some(std::borrow::Cow::Owned(s.trim().to_string())),
        Some(Value::Number(n)) => Some(std::borrow::Cow::Owned(n.to_string())),
        Some(Value::Bool(b)) => Some(std::borrow::Cow::Owned(b.to_string())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(HeaderName::from_lowercase(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn cookie_parsing_matches_the_browser_format() {
        let map = headers(&[("cookie", "a=1; strike_balance_gate=payload.sig; b=2")]);
        assert_eq!(cookie(&map, BALANCE_SESSION_COOKIE).as_deref(), Some("payload.sig"));
        assert_eq!(cookie(&map, "missing"), None);
        // A prefix collision must not match: `strike_balance_gate_x` is a
        // different cookie.
        let tricky = headers(&[("cookie", "strike_balance_gate_x=zzz")]);
        assert_eq!(cookie(&tricky, BALANCE_SESSION_COOKIE), None);
        let empty = headers(&[("cookie", "strike_balance_gate=")]);
        assert_eq!(cookie(&empty, BALANCE_SESSION_COOKIE), None);
    }

    #[test]
    fn cookie_rendering_carries_the_ts_attributes() {
        let cookie = Cookie {
            name: BALANCE_SESSION_COOKIE,
            value: "p.s".into(),
            max_age: 43_200,
            same_site: "lax",
            http_only: true,
        };
        let rendered = cookie.render();
        assert!(rendered.starts_with("strike_balance_gate=p.s; Path=/; Max-Age=43200; HttpOnly"), "{rendered}");
        assert!(rendered.contains("SameSite=lax"));
    }

    #[test]
    fn bearer_extraction_is_case_insensitive_on_the_scheme() {
        let map = headers(&[("authorization", "Bearer  sekret ")]);
        assert_eq!(bearer(&map).as_deref(), Some("sekret"));
        assert_eq!(bearer(&headers(&[])), None);
    }

    #[test]
    fn client_ip_falls_back_like_the_ts_route() {
        assert_eq!(client_ip(&headers(&[("x-forwarded-for", " 1.2.3.4, 5.6.7.8 ")])), "1.2.3.4");
        assert_eq!(client_ip(&headers(&[("x-real-ip", "9.9.9.9")])), "9.9.9.9");
        assert_eq!(client_ip(&headers(&[("x-forwarded-for", ", ")])), "unknown");
        assert_eq!(client_ip(&headers(&[])), "unknown");
    }

    #[test]
    fn too_many_sets_retry_after() {
        let response = too_many("nope", 42);
        assert_eq!(response.headers().get("retry-after").unwrap(), "42");
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
