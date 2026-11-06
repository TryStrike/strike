//! Live crypto trades from Binance's combined stream.
//!
//! This is a speed layer over the REST sampler, not a replacement. REST keeps
//! running, and fills in for any pair without a recent trade, so a quiet pair
//! stays bettable and a dropped or blocked socket falls back to REST on its own.
//! Both record under the `binance` source, so a round never refunds because the
//! transport changed.
//!
//! A trade is stamped with its exchange time, never its arrival, so a backlog
//! can't record old prices as fresh, and a trade older than [`MAX_TRADE_AGE_MS`]
//! is dropped.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use crate::config::config;
use crate::prices::{self, binance_symbol};
use crate::ticks;

const MAX_TRADE_AGE_MS: i64 = 2_000;
/// Silence longer than this means the socket is dead, and REST takes over.
const LIVE_WINDOW_MS: i64 = 3_000;
/// A pair with no trade for this long gets its price from REST.
const PAIR_WINDOW_MS: i64 = 2_000;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Binance closes a connection at 24 hours, so leave first.
const MAX_SESSION: Duration = Duration::from_secs(23 * 60 * 60);
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

static LAST_FRAME_MS: AtomicI64 = AtomicI64::new(0);

fn streams_url() -> String {
    let streams: Vec<String> = prices::VALID_ASSETS
        .iter()
        .filter_map(|asset| binance_symbol(asset))
        .map(|symbol| format!("{}@trade", symbol.to_lowercase()))
        .collect();
    format!(
        "{}?streams={}",
        config().binance_ws_endpoint,
        streams.join("/")
    )
}

/// The asset for an upper-case Binance symbol.
fn asset_of(symbol: &str) -> Option<&'static str> {
    prices::VALID_ASSETS
        .iter()
        .copied()
        .find(|asset| binance_symbol(asset) == Some(symbol))
}

/// `(asset, price, traded_at_ms)` from one stream frame.
fn parse_trade(frame: &str) -> Option<(&'static str, f64, i64)> {
    let value: Value = serde_json::from_str(frame).ok()?;
    let trade = value.get("data")?;
    let asset = asset_of(trade.get("s")?.as_str()?)?;
    let price = trade.get("p")?.as_str()?.parse().ok()?;
    let traded_at = trade.get("T")?.as_i64()?;
    Some((asset, price, traded_at))
}

/// When to record a trade, `None` if it is too old. A clock behind the exchange
/// can't stamp a trade in the future.
fn trade_stamp(traded_at: i64, now_ms: i64) -> Option<i64> {
    (now_ms - traded_at <= MAX_TRADE_AGE_MS).then_some(traded_at.min(now_ms))
}

fn is_live(now_ms: i64) -> bool {
    now_ms - LAST_FRAME_MS.load(Ordering::Relaxed) <= LIVE_WINDOW_MS
}

/// `true` when the stream already has this asset, so REST must not record over it.
pub fn covers(asset: &str, now_ms: i64) -> bool {
    is_live(now_ms)
        && binance_symbol(asset).is_some()
        && ticks::buffer()
            .latest(asset)
            .is_some_and(|tick| now_ms - tick.at_ms <= PAIR_WINDOW_MS)
}

fn on_frame(frame: &str) {
    let now = prices::now_millis();
    LAST_FRAME_MS.store(now, Ordering::Relaxed);
    let Some((asset, price, traded_at)) = parse_trade(frame) else {
        return;
    };
    if let Some(at_ms) = trade_stamp(traded_at, now) {
        prices::record_trade(asset, price, at_ms);
    }
}

/// One connection, until it fails or reaches [`MAX_SESSION`].
async fn session(url: &str) -> Result<(), String> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
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
            Ok(Some(Ok(Message::Text(frame)))) => on_frame(frame.as_str()),
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// Runs for the life of the process, and only ever logs a failure: REST is
/// already covering whatever this misses.
pub async fn run() {
    let url = streams_url();
    let mut backoff = MIN_BACKOFF;
    loop {
        let outcome = session(&url).await;
        if is_live(prices::now_millis()) {
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
            parse_trade(&TRADE.replace("BTCUSDT", "LINKUSDT")),
            None,
            "a pair the app does not trade"
        );
        assert_eq!(parse_trade(&TRADE.replace("67123.45000000", "abc")), None);
    }

    #[test]
    fn an_old_trade_is_dropped_and_a_future_one_is_clamped() {
        assert_eq!(trade_stamp(10_000, 11_000), Some(10_000));
        assert_eq!(trade_stamp(10_000, 12_000), Some(10_000));
        assert_eq!(trade_stamp(10_000, 12_001), None, "a backlog is not fresh");
        assert_eq!(trade_stamp(10_500, 10_000), Some(10_000));
    }

    #[test]
    fn every_binance_pair_is_subscribed_and_nothing_else() {
        let url = streams_url();
        assert!(url.contains("btcusdt@trade/"));
        assert!(url.contains("dogeusdt@trade"));
        assert_eq!(url.matches("@trade").count(), 14);
        assert!(!url.contains("gold"));
    }

    #[test]
    fn a_silent_socket_hands_every_pair_back_to_rest() {
        assert!(!is_live(i64::MAX / 2));
        assert!(!covers("BTC", i64::MAX / 2));
        assert!(!covers("GOLD", 0), "a slow asset is never the stream's");
    }
}
