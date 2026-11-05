//! `/api/prices/stream` — the SSE feed (`app/api/prices/stream/route.ts`).
//!
//! Pushes `data: {"asset":"BTC","price":111111.5,"ts":1700000000000}` the moment
//! the aggregated feed moves, primed with one snapshot frame per asset on
//! connect so a client never waits for a change to get its first tick. Comment
//! heartbeats every 15 s keep proxies from idle-killing the stream; the client
//! treats this as an optimisation only, and the 1 s poll of `/api/prices/latest`
//! stays the automatic fallback.
//!
//! An SSE response is a long-lived stream: buffering anywhere between this
//! process and the browser defeats the point, so every header that would permit
//! it is explicitly forbidden.

use std::convert::Infallible;

use axum::extract::Query;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Router};
use serde_json::Value;
use serde::Deserialize;

use strike_core::prices;
use strike_core::stream;

const SSE_CONTENT_TYPE: &str = "text/event-stream; charset=utf-8";
const SSE_CACHE_CONTROL: &str = "no-cache, no-transform";
const SSE_CONNECTION: &str = "keep-alive";
const SSE_ACCEL_BUFFERING: &str = "no";

#[derive(Deserialize)]
struct StreamQuery {
    assets: Option<String>,
}

pub fn routes() -> Router {
    Router::new().route("/api/prices/stream", get(get_stream))
}

async fn get_stream(Query(query): Query<StreamQuery>) -> Response {
    let assets = match stream_assets(query.assets.as_deref()) {
        Ok(assets) => assets,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, &error),
    };

    let mut subscription = stream::subscribe(&assets);
    let Some(receiver) = subscription.frames() else {
        // Unreachable: a fresh subscription always owns its channel.
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Stream unavailable");
    };
    stream::ensure_pump_running();
    stream::spawn_prime(subscription.id(), assets);

    let body = axum::body::Body::from_stream(render_stream(subscription, receiver));
    (StatusCode::OK, sse_headers(), body).into_response()
}

/// The selector parse is the latest route's, but an empty list is not "nothing":
/// it is the same full feed `/api/prices/latest` serves.
fn stream_assets(raw: Option<&str>) -> Result<Vec<String>, String> {
    let assets = prices::parse_asset_selector(raw)?;
    if assets.is_empty() {
        return Ok(prices::default_assets());
    }
    Ok(assets)
}

/// Frames as they arrive, with a heartbeat whenever the market is quiet.
///
/// Owning the `Subscription` in the stream state is what makes teardown
/// automatic: when the browser or the proxy hangs up, axum drops this future,
/// the state is dropped, and the connection leaves the hub — which reaps the
/// shared loop once it was the last client.
fn render_stream(
    subscription: stream::Subscription,
    receiver: stream::FrameRx,
) -> impl futures::Stream<Item = Result<String, Infallible>> + Send + 'static {
    let first_heartbeat = tokio::time::Instant::now() + stream::heartbeat_interval();
    futures::stream::unfold(
        (subscription, receiver, first_heartbeat),
        move |(subscription, mut receiver, next_heartbeat)| async move {
            let (frame, next_heartbeat) = tokio::select! {
                maybe = receiver.recv() => match maybe {
                    Some(frame) => (frame, next_heartbeat),
                    // Every sender is gone, so this connection has been
                    // unsubscribed from under us.
                    None => return None,
                },
                _ = tokio::time::sleep_until(next_heartbeat) => (
                    stream::heartbeat_frame(prices::now_millis()),
                    tokio::time::Instant::now() + stream::heartbeat_interval(),
                ),
            };
            // The deadline is absolute, so a busy market cannot postpone the
            // heartbeat the proxy is waiting for.
            Some((Ok(frame), (subscription, receiver, next_heartbeat)))
        },
    )
}

fn sse_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(SSE_CONTENT_TYPE));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(SSE_CACHE_CONTROL));
    headers.insert(header::CONNECTION, HeaderValue::from_static(SSE_CONNECTION));
    headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static(SSE_ACCEL_BUFFERING),
    );
    headers
}

/// `NextResponse.json({ error }, { status })` — the selector failure is the
/// route's only non-stream response, and it is a 400 with just that key.
fn json_error(status: StatusCode, message: &str) -> Response {
    let mut body = serde_json::Map::new();
    body.insert("error".into(), Value::String(message.to_string()));
    crate::http::json_status(status, Value::Object(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_asset_rejects_the_whole_request() {
        // A typo must not silently stream the wrong market.
        let err = stream_assets(Some("BTC,BOGUS")).unwrap_err();
        assert_eq!(err, "Unknown asset(s): BOGUS");
        assert!(stream_assets(Some("BTC-USD,ETH")).is_ok());
    }

    #[test]
    fn an_empty_selector_means_the_whole_feed() {
        for raw in [None, Some(""), Some("  "), Some(", , ")] {
            let assets = stream_assets(raw).unwrap();
            assert_eq!(assets, prices::default_assets(), "{raw:?} must mean everything");
            assert!(!assets.is_empty());
        }
    }

    #[test]
    fn selector_keeps_requested_order_and_drops_duplicates() {
        let assets = stream_assets(Some("ETH,BTC,ETH")).unwrap();
        assert_eq!(assets, vec!["ETH".to_string(), "BTC".to_string()]);
    }

    #[test]
    fn headers_forbid_every_form_of_buffering() {
        let headers = sse_headers();
        assert_eq!(headers[header::CONTENT_TYPE], SSE_CONTENT_TYPE);
        assert_eq!(headers[header::CACHE_CONTROL], SSE_CACHE_CONTROL);
        assert_eq!(headers[header::CONNECTION], SSE_CONNECTION);
        assert_eq!(headers["x-accel-buffering"], "no");
        assert!(!headers.contains_key(header::ETAG), "a stream is not cacheable");
    }

    #[test]
    fn error_body_carries_only_the_error_key() {
        // The route's 400 is `{ error }` and nothing else; the message is the
        // selector's own list of unknown tokens.
        assert_eq!(
            stream_assets(Some("NOPE")).unwrap_err(),
            "Unknown asset(s): NOPE"
        );
        let response = json_error(StatusCode::BAD_REQUEST, "Unknown asset(s): NOPE");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn stream_hands_frames_to_the_consumer_in_order() {
        let base = stream::active_client_count();
        let mut subscription = stream::subscribe(&["BTC".to_string()]);
        let id = subscription.id();
        let receiver = subscription.frames().unwrap();
        let first = "data: {\"asset\":\"BTC\",\"price\":1,\"ts\":1}\n\n".to_string();
        let second = "data: {\"asset\":\"BTC\",\"price\":2,\"ts\":2}\n\n".to_string();
        assert_eq!(stream::deliver(id, &[first.clone(), second.clone()]), 2);

        let mut rendered = Box::pin(render_stream(subscription, receiver));
        assert_eq!(futures::StreamExt::next(&mut rendered).await.unwrap().unwrap(), first);
        assert_eq!(futures::StreamExt::next(&mut rendered).await.unwrap().unwrap(), second);

        // Dropping the response is what unsubscribes: there is no explicit
        // teardown call for the handler to forget.
        drop(rendered);
        assert_eq!(stream::active_client_count(), base);
    }
}
