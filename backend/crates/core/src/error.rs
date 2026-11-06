use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{message}")]
    Json {
        status: StatusCode,
        message: String,
        extra: Option<Map<String, Value>>,
    },
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Http(reqwest::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for ApiError {
    fn from(err: reqwest::Error) -> Self {
        Self::Http(err.without_url())
    }
}

impl ApiError {
    pub fn json(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Json {
            status,
            message: message.into(),
            extra: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::json(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::json(StatusCode::UNAUTHORIZED, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::json(StatusCode::CONFLICT, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::json(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::json(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        let status = StatusCode::from_u16(status_of(code)).unwrap_or(StatusCode::BAD_REQUEST);
        let err = Self::json(status, message).with("code", Value::String(code.to_string()));
        if status.is_server_error() {
            err.with("retryable", Value::Bool(true))
        } else {
            err
        }
    }

    pub fn with(mut self, key: &str, value: Value) -> Self {
        if let Self::Json { extra, .. } = &mut self {
            let map = extra.get_or_insert_with(Map::new);
            map.insert(key.to_string(), value);
        }
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message, extra) = match self {
            ApiError::Db(err) => {
                tracing::error!("database error: {err}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                    None,
                )
            }
            ApiError::Http(err) => {
                tracing::error!("upstream error: {err}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                    None,
                )
            }
            ApiError::Serde(err) => {
                tracing::error!("serialization error: {err}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                    None,
                )
            }
            ApiError::Other(msg) => {
                tracing::error!("{msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                    None,
                )
            }
            ApiError::Json {
                status,
                message,
                extra,
            } => {
                if status.is_server_error() {
                    tracing::error!(status = status.as_u16(), "{message}");
                }
                (status, message, extra)
            }
        };

        let mut body = Map::new();
        body.insert("error".to_string(), Value::String(message));
        if let Some(extra) = extra {
            for (k, v) in extra {
                body.insert(k, v);
            }
        }

        (status, axum::Json(Value::Object(body))).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

pub fn status_of(code: &str) -> u16 {
    match code {
        "session_required" | "step_up_required" => 401,
        "human_required" | "human_tier_too_low" | "human_mismatch" | "banned" | "frozen"
        | "stepup_denied" | "attempt_denied" | "attempt_failed" => 403,
        "not_found" => 404,
        "human_exposure_cap" | "human_daily_loss" | "human_cooloff" | "stepup_pending"
        | "stepup_used" | "not_paused" | "duplicate" | "betting_closed" | "market_quiet"
        | "market_closed" | "price_moved" | "round_open" | "attempt_pending" | "dev_bypass" => 409,
        "stepup_expired" | "attempt_expired" => 410,
        "invalid_body" => 422,
        "rate_limited" | "daily_cap" => 429,
        "world_unavailable" | "world_unconfigured" | "price_unavailable" => 503,
        _ => 400,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_request_error_never_carries_the_url() {
        let err = reqwest::Client::new()
            .get("http://127.0.0.1:1/ark_live_secret")
            .send()
            .await
            .unwrap_err();
        let shown = ApiError::from(err).to_string();
        assert!(!shown.contains("ark_live_secret"), "{shown}");
    }
}
