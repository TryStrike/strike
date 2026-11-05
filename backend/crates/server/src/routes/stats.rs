//! `/api/stats/public` — the landing page's aggregate numbers.
//!
//! Port of `app/api/stats/public/route.ts`. The single source of truth is
//! `strike_core::platform_stats`, so these figures are the same computation the
//! admin dashboard runs; only the `real` subset is exposed, with no demo data,
//! no per-user figures and no addresses.
//!
//! `revalidate = 300` in Next becomes an in-process cache here. That matters more
//! than usual: the aggregate page-scans `bet_history`, so an uncached public
//! endpoint on a landing page is a self-inflicted denial of service.

use std::time::{Duration, Instant};

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use strike_core::error::ApiResult;
use strike_core::platform_stats;

/// `export const revalidate = 300`.
const REVALIDATE: Duration = Duration::from_secs(300);
const CACHE_HEADER: &str = "public, s-maxage=300, stale-while-revalidate=600";

pub fn routes() -> Router {
    Router::new().route("/api/stats/public", get(public))
}

/// The zeros the TS route handed back on failure, so the landing page renders an
/// honest empty state instead of a stack trace — and the same status code it
/// paired with them.
fn unavailable_body() -> (StatusCode, Value) {
    let mut map = Map::new();
    for key in [
        "totalBets",
        "totalWins",
        "totalLosses",
        "winRate",
        "totalWagered",
        "totalPaidOut",
        "uniqueWallets",
        "totalDeposits",
        "totalWithdrawals",
    ] {
        map.insert(key.to_string(), Value::from(0));
    }
    map.insert("chainsActive".to_string(), Value::from(1));
    map.insert("topCurrencies".to_string(), Value::Array(vec![]));
    (StatusCode::INTERNAL_SERVER_ERROR, Value::Object(map))
}

async fn public() -> Response {
    match serve().await {
        Ok(body) => respond(StatusCode::OK, body, CACHE_HEADER),
        Err(err) => {
            tracing::error!("[stats/public] {err}");
            let (status, body) = unavailable_body();
            respond(status, body, "no-store")
        }
    }
}

/// The lock is held across the refresh, so a stampede of landing-page visitors
/// recomputes once rather than once per request.
async fn serve() -> ApiResult<Value> {
    let slot = cache().await;
    let mut guard = slot.lock().await;
    if let Some((at, body)) = guard.as_ref() {
        if at.elapsed() < REVALIDATE {
            return Ok(body.clone());
        }
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let body = platform_stats::compute(now_ms)
        .await
        .map(|stats| stats.public_value())
        .inspect_err(|_err| {
            // A failed refresh drops the stale copy: serving week-old money
            // numbers as current would be worse than the zeros.
            *guard = None;
        })?;
    *guard = Some((Instant::now(), body.clone()));
    Ok(body)
}

type CacheSlot = Mutex<Option<(Instant, Value)>>;

static CACHE: tokio::sync::OnceCell<CacheSlot> = tokio::sync::OnceCell::const_new();

async fn cache() -> &'static CacheSlot {
    CACHE.get_or_init(|| async { Mutex::new(None) }).await
}

fn respond(status: StatusCode, body: Value, cache_control: &str) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_str(cache_control)
            .unwrap_or_else(|_| HeaderValue::from_static("no-store")),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_shape_is_the_ts_zero_payload() {
        let (status, body) = unavailable_body();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        // Every key the landing page reads must exist, or its selectors throw.
        for key in [
            "totalBets",
            "totalWins",
            "totalLosses",
            "winRate",
            "totalWagered",
            "totalPaidOut",
            "uniqueWallets",
            "chainsActive",
            "totalDeposits",
            "totalWithdrawals",
            "topCurrencies",
        ] {
            assert!(body.get(key).is_some(), "{key} missing from the fallback");
        }
        assert_eq!(
            body["chainsActive"],
            Value::from(1),
            "Arc only, like the TS"
        );
        assert!(body["topCurrencies"].is_array());
        assert!(body.get("real").is_none() && body.get("demo").is_none());
    }

    #[test]
    fn a_failure_is_never_cacheable() {
        let response = respond(StatusCode::OK, Value::Null, CACHE_HEADER);
        assert_eq!(response.headers()[header::CACHE_CONTROL], CACHE_HEADER);
        let failed = respond(StatusCode::INTERNAL_SERVER_ERROR, Value::Null, "no-store");
        assert_eq!(failed.headers()[header::CACHE_CONTROL], "no-store");
    }
}
