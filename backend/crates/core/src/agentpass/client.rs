use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use jsonwebtoken::jwk::JwkSet;
use serde::Deserialize;
use serde_json::{json, Value};

use super::ApConfig;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
pub(super) struct Endpoints {
    device_authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

#[derive(Deserialize)]
pub(super) struct DeviceGrant {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    pub expires_in: i64,
    #[serde(default)]
    pub interval: Option<i64>,
}

pub(super) enum Unavailable {
    RateLimited(i64),
    Down,
}

pub(super) enum Poll {
    Pending,
    SlowDown,
    Token(String),
    End(&'static str, String),
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("reqwest client")
    })
}

fn basic(cfg: &ApConfig) -> String {
    let encode = |raw: &str| {
        raw.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    let pair = format!("{}:{}", encode(&cfg.client_id), encode(&cfg.client_secret));
    format!("Basic {}", STANDARD.encode(pair))
}

async fn endpoints(cfg: &ApConfig) -> Option<&Endpoints> {
    cfg.endpoints
        .get_or_try_init(|| async {
            let url = format!("{}/.well-known/openid-configuration", cfg.issuer);
            let res = http().get(url).send().await.map_err(|_| ())?;
            if !res.status().is_success() {
                return Err(());
            }
            res.json::<Endpoints>().await.map_err(|_| ())
        })
        .await
        .ok()
}

pub(super) async fn start(cfg: &ApConfig) -> Result<DeviceGrant, Unavailable> {
    let urls = endpoints(cfg).await.ok_or(Unavailable::Down)?;
    let claims = if super::token::any_account() {
        json!({ "id_token": { "acr": null } })
    } else {
        json!({ "id_token": { "acr": { "essential": true, "values": super::token::accepted_acr() } } })
    }
    .to_string();
    let mut form = vec![("scope", "openid")];
    if super::token::requests_acr() {
        form.push(("claims", &claims));
    }
    let res = http()
        .post(&urls.device_authorization_endpoint)
        .header("authorization", basic(cfg))
        .form(&form)
        .send()
        .await
        .map_err(|_| Unavailable::Down)?;
    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok()?.parse().ok())
            .unwrap_or(60);
        return Err(Unavailable::RateLimited(wait));
    }
    if !res.status().is_success() {
        tracing::warn!("[agentpass] device authorization refused: {}", res.status());
        return Err(Unavailable::Down);
    }
    res.json().await.map_err(|_| Unavailable::Down)
}

fn safe(code: &str) -> &str {
    if code.len() <= 64 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        code
    } else {
        "unexpected_error"
    }
}

pub(super) async fn poll(cfg: &ApConfig, device_code: &str) -> Poll {
    // A hiccup (no discovery, timeout, 429, 5xx) is not an answer: keep polling
    // until the step-up expires. Only World ID's own refusals end it.
    let Some(urls) = endpoints(cfg).await else {
        return Poll::Pending;
    };
    let sent = http()
        .post(&urls.token_endpoint)
        .header("authorization", basic(cfg))
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", device_code),
        ])
        .send()
        .await;
    let Ok(res) = sent else {
        return Poll::Pending;
    };
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return match body.get("id_token").and_then(Value::as_str) {
            Some(token) => Poll::Token(token.to_string()),
            None => Poll::End("failed", "World ID sent no ID token".into()),
        };
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Poll::SlowDown;
    }
    if status != reqwest::StatusCode::BAD_REQUEST && status != reqwest::StatusCode::UNAUTHORIZED {
        return Poll::Pending;
    }
    let error = body.get("error").and_then(Value::as_str).unwrap_or("");
    if !matches!(error, "authorization_pending" | "slow_down") {
        let why: String = body
            .get("error_description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .chars()
            .take(200)
            .collect();
        tracing::info!("[agentpass] token poll ended: {} ({why})", safe(error));
    }
    match error {
        "authorization_pending" => Poll::Pending,
        "slow_down" => Poll::SlowDown,
        "access_denied" => Poll::End("denied", "You declined in World App".into()),
        "expired_token" => Poll::End("expired", "Approval timed out".into()),
        other => Poll::End("failed", format!("World ID refused: {}", safe(other))),
    }
}

pub(super) async fn keys(cfg: &ApConfig, kid: &str) -> Option<JwkSet> {
    if let Some(set) = cfg.jwks.lock().ok()?.as_ref() {
        if set.find(kid).is_some() {
            return Some(set.clone());
        }
    }
    let urls = endpoints(cfg).await?;
    let res = http().get(&urls.jwks_uri).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let set: JwkSet = res.json().await.ok()?;
    *cfg.jwks.lock().ok()? = Some(set.clone());
    Some(set)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_auth_form_encodes_both_halves() {
        let cfg = ApConfig::new("https://x", "app:1", "s/e cret");
        assert_eq!(
            basic(&cfg),
            format!("Basic {}", STANDARD.encode("app%3A1:s%2Fe%20cret"))
        );
    }
}
