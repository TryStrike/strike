//! `/api/arc/treasury` — the public on-chain treasury panel feed.
//!
//! The RPC work, decoding and response shape live in
//! `strike_core::treasury_view`; this is the HTTP layer that attaches the CDN
//! headers and the route's two fixed error bodies.

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use strike_core::treasury_view::{self, TREASURY_CACHE_CONTROL};

pub fn routes() -> Router {
    Router::new().route("/api/arc/treasury", get(treasury))
}

async fn treasury() -> Response {
    let (status, body) = match treasury_view::treasury_view().await {
        Ok(response) => response,
        // `treasury_view` turns every failure into its own 502 body, so this
        // arm only guards a bug in the core module — and still cannot leak the
        // RPC's error text to the browser.
        Err(err) => {
            tracing::error!("[arc/treasury] unexpected failure: {err}");
            (502u16, treasury_view::RPC_UNAVAILABLE_BODY.to_string())
        }
    };
    panel_response(status, body)
}

fn panel_response(status: u16, body: String) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = (code, Body::from(body)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    // A 503/502 must not be cached: the panel would then keep showing a
    // configured-but-unreachable treasury for ten seconds after it recovers.
    let cache_control = if status == 200 {
        TREASURY_CACHE_CONTROL
    } else {
        "no-store"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_fresh_panel_is_cacheable() {
        for status in [503u16, 502] {
            let response = panel_response(status, treasury_view::RPC_UNAVAILABLE_BODY.to_string());
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store",
                "status {status} must never be cached"
            );
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        }

        let fresh = panel_response(200, "{\"address\":\"0x0\"}".to_string());
        assert_eq!(
            fresh.headers()[header::CACHE_CONTROL],
            TREASURY_CACHE_CONTROL,
            "a live panel is the only thing the CDN may hold"
        );
    }

    #[test]
    fn an_unexpected_status_code_still_reports_bad_gateway() {
        // Core only ever emits 200/503/502; anything else must degrade safely.
        assert_eq!(
            panel_response(0, "{}".to_string()).status(),
            StatusCode::BAD_GATEWAY
        );
    }
}
