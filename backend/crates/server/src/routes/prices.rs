//! `/api/prices/latest` — the one-second poll every client shares.
//!
//! The aggregation, caching and framing live in `strike_core::prices`; this is
//! the thin HTTP layer that reproduces the route's query handling and headers.

use crate::http::Query;
use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::Value;

use strike_core::prices::{self, PricesResponse};

#[derive(Deserialize)]
struct LatestQuery {
    asset: Option<String>,
}

pub fn routes() -> Router {
    Router::new().route("/api/prices/latest", get(latest_get).post(latest_post))
}

/// `GET ?asset=BTC` - one asset if asked for one, otherwise the whole feed list.
/// The name is not validated: an unknown asset simply yields no quote.
async fn latest_get(Query(query): Query<LatestQuery>) -> Response {
    let assets = match query.asset.filter(|a| !a.is_empty()) {
        Some(asset) => vec![asset],
        None => prices::default_assets(),
    };
    render(prices::latest_get(&assets).await).await
}

/// `POST {assets:[...]}` - non-string entries are dropped, exactly as the TS
/// `filter(v => typeof v === 'string')` did, and an unusable body falls back to
/// the full list.
async fn latest_post(raw: Bytes) -> Response {
    let mut requested: Vec<String> = serde_json::from_slice::<Value>(&raw)
        .ok()
        .and_then(|body| body.get("assets").and_then(Value::as_array).cloned())
        .map(|rows| {
            rows.into_iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if requested.is_empty() {
        requested = prices::default_assets();
    }
    render(prices::latest_post(&requested).await).await
}

async fn render(result: strike_core::error::ApiResult<PricesResponse>) -> Response {
    let response = match result {
        Ok(response) => response,
        Err(err) => {
            tracing::error!("[prices/latest] failed: {err}");
            PricesResponse {
                status: 500,
                body: prices::PRICE_ERROR_BODY.to_string(),
                cache_control: prices::PRICE_ERROR_CACHE_CONTROL.to_string(),
                vary: None,
            }
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );
    if !response.cache_control.is_empty() {
        headers.insert(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_str(&response.cache_control)
                .unwrap_or_else(|_| HeaderValue::from_static("no-store")),
        );
    }
    if let Some(vary) = response.vary {
        headers.insert(
            HeaderName::from_static("vary"),
            HeaderValue::from_str(&vary)
                .unwrap_or_else(|_| HeaderValue::from_static("accept-encoding")),
        );
    }

    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, headers, response.body).into_response()
}
