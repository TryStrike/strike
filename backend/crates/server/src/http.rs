use axum::extract::{FromRequest, Request};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

use strike_core::config::config;
use strike_core::crypto::{self, BALANCE_SESSION_COOKIE};
use strike_core::error::ApiError;

const BROWSER_KEY_HEADER: &str = "x-strike-balance-key";

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
        let secure = if config().production { "; Secure" } else { "" };
        let http_only = if self.http_only { "; HttpOnly" } else { "" };
        format!(
            "{}={}; Path=/; Max-Age={}{}{}; SameSite={}",
            self.name, self.value, self.max_age, http_only, secure, self.same_site
        )
    }
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for raw in headers.get_all(HeaderName::from_static("cookie")) {
        let Ok(all) = raw.to_str() else { continue };
        for pair in all.split(';') {
            let pair = pair.trim();
            if let Some(value) = pair
                .strip_prefix(name)
                .and_then(|rest| rest.strip_prefix('='))
            {
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

pub fn json_with_cookie(body: Value, cookie: Cookie) -> Response {
    json_with_cookies(body, &[cookie])
}

pub fn json_with_cookies(body: Value, cookies: &[Cookie]) -> Response {
    let mut headers = HeaderMap::new();
    for cookie in cookies {
        headers.append(
            HeaderName::from_static("set-cookie"),
            HeaderValue::from_str(&cookie.render())
                .unwrap_or_else(|_| HeaderValue::from_static("invalid")),
        );
    }
    (headers, axum::Json(body)).into_response()
}

pub fn cleared_cookie(name: &'static str, same_site: &'static str) -> Cookie {
    Cookie {
        name,
        value: String::new(),
        max_age: 0,
        same_site,
        http_only: true,
    }
}

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

    if crypto::balance_session_wallet(cookie(headers, BALANCE_SESSION_COOKIE).as_deref()).is_some()
    {
        return Ok(());
    }

    if header_str(headers, BROWSER_KEY_HEADER).as_deref() == Some(secret.as_str()) {
        return Err(session_required(
            "Use POST /api/balance/session for browser auth or Bearer for server callers.",
        ));
    }

    Err(session_required("Unauthorized"))
}

pub fn require_wallet_session(headers: &HeaderMap, wallet: &str) -> Result<(), ApiError> {
    require_balance_session(headers)?;
    let secret = config().balance_internal_secret.clone().unwrap_or_default();
    if secret.is_empty() || bearer(headers).as_deref() == Some(secret.as_str()) {
        return Ok(());
    }
    let signed_in =
        crypto::balance_session_wallet(cookie(headers, BALANCE_SESSION_COOKIE).as_deref());
    if signed_in.as_deref() == Some(strike_core::address::canonical(wallet).as_str()) {
        return Ok(());
    }
    Err(session_required(
        "This session is signed in for a different wallet",
    ))
}

fn session_required(message: &str) -> ApiError {
    ApiError::unauthorized(message).with("code", json!("session_required"))
}

pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(body)| Self(body))
            .map_err(|rejection| ApiError::coded("invalid_body", rejection.body_text()))
    }
}

pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = header_str(headers, "authorization")?;
    let (_, token) = raw.split_once(char::is_whitespace)?;
    Some(token.trim().to_string())
}

pub fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

const API_CSP: &str = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";

pub fn with_api_headers(router: Router, origin: Option<&str>) -> Router {
    let set = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        )
    };
    let router = router
        .layer(set("x-content-type-options", "nosniff"))
        .layer(set("x-frame-options", "DENY"))
        .layer(set("referrer-policy", "strict-origin-when-cross-origin"))
        .layer(set("content-security-policy", API_CSP));
    let Some(origin) = origin.map(|o| o.trim().trim_end_matches('/')) else {
        return router;
    };
    match HeaderValue::from_str(origin) {
        Ok(origin) => router.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                ])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]),
        ),
        Err(_) => {
            tracing::error!("NEXT_PUBLIC_APP_URL is not a valid origin; CORS stays off");
            router
        }
    }
}

pub fn json_status(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(
                HeaderName::from_lowercase(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        map
    }

    #[test]
    fn cookie_parsing_matches_the_browser_format() {
        let map = headers(&[("cookie", "a=1; strike_balance_gate=payload.sig; b=2")]);
        assert_eq!(
            cookie(&map, BALANCE_SESSION_COOKIE).as_deref(),
            Some("payload.sig")
        );
        assert_eq!(cookie(&map, "missing"), None);
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
        assert!(
            rendered.starts_with("strike_balance_gate=p.s; Path=/; Max-Age=43200; HttpOnly"),
            "{rendered}"
        );
        assert!(rendered.contains("SameSite=lax"));
    }

    #[test]
    fn bearer_extraction_is_case_insensitive_on_the_scheme() {
        let map = headers(&[("authorization", "Bearer  sekret ")]);
        assert_eq!(bearer(&map).as_deref(), Some("sekret"));
        assert_eq!(bearer(&headers(&[])), None);
    }

    #[test]
    fn too_many_sets_retry_after() {
        let response = too_many("nope", 42);
        assert_eq!(response.headers().get("retry-after").unwrap(), "42");
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
