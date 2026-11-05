//! The single error type every handler returns, shaped so the JSON the browser
//! receives matches the Next.js routes byte for byte.

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
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl ApiError {
    /// `{"error": message, ...extra}` with the given status.
    pub fn json(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Json { status, message: message.into(), extra: None }
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

    /// Adds top-level fields to the error body (e.g. `retryable: true`).
    pub fn with(mut self, key: &str, value: Value) -> Self {
        if let Self::Json { extra, .. } = &mut self {
            let map = extra.get_or_insert_with(Map::new);
            map.insert(key.to_string(), value);
        }
        self
    }

    /// The TS routes log the real cause and answer with this string.
    pub fn leak_safe(context: &str, err: &impl std::fmt::Display) -> Self {
        tracing::error!("{context}: {err}");
        Self::internal("Internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message, extra) = match self {
            // sqlx::Error can carry connection strings / query text; never
            // forward it to a browser.
            ApiError::Db(err) => {
                tracing::error!("database error: {err}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal error".to_string(), None)
            }
            ApiError::Http(err) => {
                tracing::error!("upstream error: {err}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal error".to_string(), None)
            }
            ApiError::Serde(err) => {
                tracing::error!("serialization error: {err}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal error".to_string(), None)
            }
            ApiError::Other(msg) => {
                tracing::error!("{msg}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal error".to_string(), None)
            }
            ApiError::Json { status, message, extra } => (status, message, extra),
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
