//! Live trades from Binance's combined streams, one socket each for spot and perps.
//!
//! This is a speed layer over the REST sampler, not a replacement. REST keeps
//! running, and fills in for any pair without a recent trade, so a quiet pair
//! stays bettable and a dropped or blocked socket falls back to REST on its own.
//! Both record under the `binance` source, so a round never refunds because the
//! transport changed.
//!
//! A trade is stamped on arrival, like a REST quote. A tick dated before a round's
//! end therefore can't appear after it, so a claim's timing can't change the end
//! price. Exchange time is only used to drop a backlog, past [`MAX_TRADE_AGE_MS`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures::StreamExt;
use once_cell::sync::Lazy;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use crate::config::config;
use crate::prices::{self, binance_symbol};

const MAX_TRADE_AGE_MS: i64 = 1_000;
/// Silence longer than this means the socket is dead, and REST takes over.
const LIVE_WINDOW_MS: i64 = 3_000;
/// A pair with no trade for this long gets its price from REST.
const PAIR_WINDOW_MS: i64 = 2_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Binance closes a connection at 24 hours, so leave first.
const MAX_SESSION: Duration = Duration::from_secs(23 * 60 * 60);
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

static SPOT_FRAME_MS: AtomicI64 = AtomicI64::new(0);
static PERP_FRAME_MS: AtomicI64 = AtomicI64::new(0);
static LAST_TRADE_MS: Lazy<Mutex<HashMap<&'static str, i64>>> = Lazy::new(Mutex::default);

fn streams_url(
    endpoint: &str,
    channel: &str,
    symbol_of: fn(&str) -> Option<&'static str>,
) -> String {
    let streams: Vec<String> = prices::VALID_ASSETS
        .iter()
        .filter_map(|asset| symbol_of(asset))
        .map(|symbol| format!("{}@{channel}", symbol.to_lowercase()))
        .collect();
    format!("{endpoint}?streams={}", streams.join("/"))
}

fn spot_url() -> String {
    streams_url(&config().binance_ws_endpoint, "trade", binance_symbol)
}

/// Perps carry only aggregate trades, in the same shape.
fn perp_url() -> String {
    streams_url(
        &config().binance_perp_ws_endpoint,
        "aggTrade",
        prices::perp_symbol,
    )
}

/// `(asset, price, traded_at_ms)` from one stream frame.
fn parse_trade(frame: &str) -> Option<(&'static str, f64, i64)> {
    let value: Value = serde_json::from_str(frame).ok()?;
    let trade = value.get("data")?;
    let asset = prices::binance_asset(trade.get("s")?.as_str()?)?;
    let price = trade.get("p")?.as_str()?.parse().ok()?;
    let traded_at = trade.get("T")?.as_i64()?;
    Some((asset, price, traded_at))
}

fn is_backlog(traded_at: i64, now_ms: i64) -> bool {
    now_ms - traded_at > MAX_TRADE_AGE_MS
}

fn is_live(frames: &AtomicI64, now_ms: i64) -> bool {
    now_ms - frames.load(Ordering::Relaxed) <= LIVE_WINDOW_MS
}

/// `true` when the stream has a recent trade for this asset, so REST need not
/// quote it. A quiet pair is not covered and keeps its REST tick every sample.
pub fn covers(asset: &str, now_ms: i64) -> bool {
    let frames = if prices::perp_symbol(asset).is_some() {
        &PERP_FRAME_MS
    } else {
        &SPOT_FRAME_MS
    };
    is_live(frames, now_ms)
        && LAST_TRADE_MS.lock().is_ok_and(|trades| {
            trades
                .get(asset)
                .is_some_and(|at| now_ms - at <= PAIR_WINDOW_MS)
        })
}

fn on_frame(frame: &str, frames: &AtomicI64) {
    let now = prices::now_millis();
    frames.store(now, Ordering::Relaxed);
    let Some((asset, price, traded_at)) = parse_trade(frame) else {
        return;
    };
    if is_backlog(traded_at, now) {
        return;
    }
    if let Ok(mut trades) = LAST_TRADE_MS.lock() {
        trades.insert(asset, now);
    }
    prices::record_trade(asset, price, now);
}

/// One connection, until it fails or reaches [`MAX_SESSION`].
async fn session(url: &str, frames: &AtomicI64) -> Result<(), String> {
    let (mut socket, _) =
        tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| "connect timed out".to_string())?
            .map_err(|err| format!("connect: {err}"))?;
    let deadline = tokio::time::Instant::now() + MAX_SESSION;
    loop {
        let read = tokio::time::timeout_at(
            deadline.min(tokio::time::Instant::now() + READ_TIMEOUT),
            socket.next(),
        );
        match read.await {
            Err(_) if tokio::time::Instant::now() >= deadline => return Ok(()),
            Err(_) => return Err("no frame in time".to_string()),
            Ok(None) => return Err("closed".to_string()),
            Ok(Some(Err(err))) => return Err(format!("read: {err}")),
            Ok(Some(Ok(Message::Text(frame)))) => on_frame(frame.as_str(), frames),
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// Runs for the life of the process, and only ever logs a failure: REST is
/// already covering whatever this misses.
pub async fn run() {
    futures::future::join(
        stream(spot_url(), &SPOT_FRAME_MS),
        stream(perp_url(), &PERP_FRAME_MS),
    )
    .await;
}

async fn stream(url: String, frames: &AtomicI64) {
    let mut backoff = MIN_BACKOFF;
    loop {
        let outcome = session(&url, frames).await;
        if is_live(frames, prices::now_millis()) {
            backoff = MIN_BACKOFF;
        }
        if let Err(err) = outcome {
            tracing::warn!("[binance-ws] {err}, REST is covering, retrying in {backoff:?}");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRADE: &str = r#"{"stream":"btcusdt@trade","data":{"e":"trade","E":1700000000123,"s":"BTCUSDT","t":1,"p":"67123.45000000","q":"0.1","T":1700000000120,"m":true}}"#;

    #[test]
    fn a_stream_frame_becomes_an_asset_price_and_exchange_time() {
        assert_eq!(
            parse_trade(TRADE),
            Some(("BTC", 67123.45, 1_700_000_000_120))
        );
    }

    #[test]
    fn a_frame_that_is_not_a_known_trade_records_nothing() {
        assert_eq!(parse_trade("not json"), None);
        assert_eq!(parse_trade(r#"{"result":null,"id":1}"#), None);
        assert_eq!(
            parse_trade(&TRADE.replace("BTCUSDT", "NOPEUSDT")),
            None,
            "a pair the app does not trade"
        );
        assert_eq!(parse_trade(&TRADE.replace("67123.45000000", "abc")), None);
    }

    #[test]
    fn only_a_trade_past_the_age_limit_is_a_backlog() {
        assert!(!is_backlog(10_000, 11_000));
        assert!(is_backlog(10_000, 11_001), "a backlog is not fresh");
        assert!(!is_backlog(10_500, 10_000), "a clock behind the exchange");
    }

    #[test]
    fn every_binance_pair_is_subscribed_and_nothing_else() {
        let url = spot_url();
        assert!(url.contains("btcusdt@trade/"));
        assert!(url.contains("dogeusdt@trade"));
        assert_eq!(url.matches("@trade").count(), 42);
        assert!(!url.contains("xau"));
        let perps = perp_url();
        assert!(perps.contains("xauusdt@aggTrade"));
        assert_eq!(perps.matches("@aggTrade").count(), 5);
    }

    #[test]
    fn rest_keeps_a_quiet_pair_and_a_silent_socket() {
        let now = prices::now_millis();
        SPOT_FRAME_MS.store(now, Ordering::Relaxed);
        LAST_TRADE_MS.lock().unwrap().insert("ADA", now - 100);
        LAST_TRADE_MS
            .lock()
            .unwrap()
            .insert("XLM", now - PAIR_WINDOW_MS - 1);
        assert!(covers("ADA", now));
        assert!(!covers("XLM", now), "a quiet pair stays with REST");
        assert!(!covers("GOLD", now), "a slow asset is never the stream's");
        assert!(!covers("ADA", now + LIVE_WINDOW_MS + 1), "a silent socket");
    }
}
