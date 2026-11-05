//! Server-side price aggregation.
//!
//! It answers `GET`/`POST /api/prices/latest` and feeds the `/api/prices/stream`
//! SSE ticker with exactly the JSON the browser already parses:
//!
//! ```text
//! { "prices": { "<ASSET>": <number>, ... } }
//! ```
//!
//! Crypto quotes come from Binance (a single batched
//! call), everything else from Yahoo's `spark` endpoint, and Yahoo doubles as the
//! crypto fallback if Binance returns nothing for an asset.
//!
//! Design notes carried through the whole module:
//!   * Timings are compile-time constants.
//!     The endpoints are constants too, overridable only through `crate::config`
//!     so tests can stand in for the market.
//!   * Every upstream error path is isolated per source and yields an empty
//!     quote list, never an `Err`: `fetch_latest_prices` is infallible so a
//!     dead upstream still returns whatever else succeeded (200).
//!   * Upstream HTTP plumbing returns `ApiResult` so `reqwest`/decode failures
//!     map onto the crate `ApiError`; the callers swallow them (per-source
//!     isolation).
//!   * Numbers are serialised the way `JSON.stringify` does it (see
//!     [`number_to_json`]) and object key order is made deterministic
//!     (alphabetical via `BTreeMap`), which the client never observes since it
//!     looks prices up by key.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde_json::Value;

use crate::config::config;
use crate::error::{ApiError, ApiResult};

// ---------------------------------------------------------------------------
// Constants mirrored from the TS
// ---------------------------------------------------------------------------

/// `SPARK_ENDPOINT` in marketPrices.ts.
pub const SPARK_ENDPOINT: &str = "https://query2.finance.yahoo.com/v7/finance/spark";
/// `BINANCE_ENDPOINT` in marketPrices.ts.
pub const BINANCE_ENDPOINT: &str = "https://api.binance.com/api/v3/ticker/price";

/// `CRYPTO_CACHE_MS`: clients poll once a second, so crypto stays live but
/// bounded. The aggregator *does* cache, so this TTL is mirrored, not invented.
pub const CRYPTO_CACHE_MS: i64 = 1_000;
/// `SLOW_CACHE_MS`: Yahoo quotes refresh every 15s+ at source.
pub const SLOW_CACHE_MS: i64 = 15_000;
/// `REQUEST_TIMEOUT_MS`: per upstream HTTP call, including body read
/// (`AbortSignal.timeout`).
pub const REQUEST_TIMEOUT_MS: u64 = 8_000;
/// `BATCH_SIZE`: Yahoo rejects oversized symbol lists.
pub const BATCH_SIZE: usize = 15;

/// `PRICE_TICK_MS` in priceStream.ts — the shared SSE pump cadence.
pub const PRICE_TICK_MS: u64 = 250;
/// `HEARTBEAT_MS` in priceStream.ts — SSE comment-line cadence.
pub const HEARTBEAT_MS: u64 = 15_000;

/// `PRICE_HEADERS['Cache-Control']` on the GET route.
pub const PRICE_LATEST_CACHE_CONTROL: &str =
    "public, s-maxage=1, stale-while-revalidate=5, stale-if-errors=10";
/// `PRICE_HEADERS['Vary']` on the GET route.
pub const PRICE_LATEST_VARY: &str = "Accept-Encoding";
/// `Cache-Control` on the route's 500 path.
pub const PRICE_ERROR_CACHE_CONTROL: &str = "no-store";

/// Yahoo answers 401 without a browser user agent (see the TS comment).
const YAHOO_USER_AGENT: &str = "Mozilla/5.0";

// ---------------------------------------------------------------------------
// Symbol mapping
// ---------------------------------------------------------------------------

/// `BINANCE_SYMBOLS`: app asset -> Binance symbol. Presence in this table is
/// also the crypto test.
const BINANCE_PAIRS: &[(&str, &str)] = &[
    ("BTC", "BTCUSDT"),
    ("ETH", "ETHUSDT"),
    ("SOL", "SOLUSDT"),
    ("SUI", "SUIUSDT"),
    ("TRX", "TRXUSDT"),
    ("XRP", "XRPUSDT"),
    ("DOGE", "DOGEUSDT"),
    ("ADA", "ADAUSDT"),
    ("BCH", "BCHUSDT"),
    ("BNB", "BNBUSDT"),
    ("XLM", "XLMUSDT"),
    ("XTZ", "XTZUSDT"),
    ("NEAR", "NEARUSDT"),
    ("APT", "APTUSDT"),
];

/// `YAHOO_SYMBOLS`: app asset -> Yahoo symbol (and crypto fallback source).
const YAHOO_PAIRS: &[(&str, &str)] = &[
    // Crypto
    ("BTC", "BTC-USD"),
    ("ETH", "ETH-USD"),
    ("SOL", "SOL-USD"),
    ("SUI", "SUI20947-USD"),
    ("TRX", "TRX-USD"),
    ("XRP", "XRP-USD"),
    ("DOGE", "DOGE-USD"),
    ("ADA", "ADA-USD"),
    ("BCH", "BCH-USD"),
    ("BNB", "BNB-USD"),
    ("XLM", "XLM-USD"),
    ("XTZ", "XTZ-USD"),
    ("NEAR", "NEAR-USD"),
    ("APT", "APT21794-USD"),
    // Metals
    ("GOLD", "GC=F"),
    ("SILVER", "SI=F"),
    // FX
    ("EUR", "EURUSD=X"),
    ("GBP", "GBPUSD=X"),
    ("JPY", "JPY=X"),
    ("AUD", "AUDUSD=X"),
    ("CAD", "CAD=X"),
    // Equities
    ("AAPL", "AAPL"),
    ("GOOGL", "GOOGL"),
    ("AMZN", "AMZN"),
    ("MSFT", "MSFT"),
    ("NVDA", "NVDA"),
    ("TSLA", "TSLA"),
    ("META", "META"),
    ("NFLX", "NFLX"),
    // Energy
    ("WTI", "CL=F"),
    ("BRENT", "BZ=F"),
    // Indices
    ("SPX", "^GSPC"),
    ("NDX", "^NDX"),
    ("DJI", "^DJI"),
];

/// `Object.keys(PRICE_FEED_IDS)` in declaration order: the default request set
/// for `/api/prices/latest` and the SSE selector domain. Assets after `DJI`
/// have no upstream in the aggregator and are therefore never quoted.
pub const VALID_ASSETS: &[&str] = &[
    "BTC", "ETH", "SOL", "SUI", "TRX", "XRP", "DOGE", "ADA", "BCH", "BNB", "XLM", "XTZ", "NEAR",
    "APT", "GOLD", "SILVER", "EUR", "GBP", "JPY", "AUD", "CAD", "AAPL", "GOOGL", "AMZN", "MSFT",
    "NVDA", "TSLA", "META", "NFLX", "WTI", "BRENT", "SPX", "NDX", "DJI", "LINK", "AVAX", "DOT",
    "LTC", "UNI", "PEPE", "SHIB", "ATOM", "RENDER", "TAO", "INJ", "KAS", "FET", "FIL", "AR", "STX",
    "HBAR", "ICP", "VET", "OP", "BONK", "ARB", "SNX", "AAVE", "GRT", "THETA", "ALGO", "EGLD",
    "FLOW", "AMD", "BABA", "DIS", "JPM", "V", "MA", "PYPL", "COIN", "MSTR", "UBER", "PLTR", "CRM",
    "INTC", "TSM",
];

static BINANCE_FWD: Lazy<HashMap<&'static str, &'static str>> =
    Lazy::new(|| BINANCE_PAIRS.iter().copied().collect());
static BINANCE_REV: Lazy<HashMap<&'static str, &'static str>> =
    Lazy::new(|| BINANCE_PAIRS.iter().map(|(a, s)| (*s, *a)).collect());
static YAHOO_FWD: Lazy<HashMap<&'static str, &'static str>> =
    Lazy::new(|| YAHOO_PAIRS.iter().copied().collect());

/// The Binance symbol for an asset, if it is a Binance-backed (crypto) asset.
pub fn binance_symbol(asset: &str) -> Option<&'static str> {
    BINANCE_FWD.get(asset).copied()
}

/// The Yahoo symbol for an asset, if Yahoo quotes it (also the crypto fallback).
pub fn yahoo_symbol(asset: &str) -> Option<&'static str> {
    YAHOO_FWD.get(asset).copied()
}

/// `BINANCE_SYMBOLS[asset]` truthiness — the crypto test.
pub fn is_crypto(asset: &str) -> bool {
    BINANCE_FWD.contains_key(asset)
}

/// An asset some upstream quotes, which is what makes it tradable.
pub fn is_quoted(asset: &str) -> bool {
    is_crypto(asset) || yahoo_symbol(asset).is_some()
}

/// The cache window (ms) that applies to an asset: crypto is held briefly, the
/// rest longer. Mirrors `cacheWindow`.
pub fn cache_window_ms(asset: &str) -> i64 {
    if is_crypto(asset) {
        CRYPTO_CACHE_MS
    } else {
        SLOW_CACHE_MS
    }
}

// ---------------------------------------------------------------------------
// Pure: JavaScript `Number(...)` coercion + JSON number formatting
// ---------------------------------------------------------------------------

/// `Number(x)` for a JSON value. Absent -> NaN, null -> 0, bool -> 0/1, number
/// -> itself, string -> trimmed parse (empty -> 0), object/array -> NaN.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// A usable quote: `Number.isFinite(price) && price > 0`.
fn valid_price(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

/// Format `f64` exactly the way `JSON.stringify` (V8 `Number::toString`) does:
/// whole numbers print without a decimal point (`100.0` -> `100`), `-0` prints
/// as `0`, and fractions print their shortest round-tripping digits. serde_json's
/// default float path would emit `100.0`, which is a *value*-identical but
/// byte-different number, so we bypass it. Outside V8's fixed-notation window
/// (|v| >= 1e21 or a tiny 0<|v|<1e-6) we still print fixed notation; no real
/// quote lands there and the value round-trips unchanged.
pub fn number_to_json(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    // Rust's `{}` is a shortest-round-trip decimal, matching V8 within the range
    // any price can occupy.
    format!("{v}")
}

/// `number_to_json` re-expressed as a `serde_json::Number`, so a value built
/// through `Value::Object` prints with V8's rules (`10`, not `10.0`) instead of
/// serde's float path.
pub fn number_to_value(v: f64) -> serde_json::Value {
    serde_json::from_str(&number_to_json(v)).unwrap_or(serde_json::Value::Number(0.into()))
}

// ---------------------------------------------------------------------------
// Pure: URL encoding (encodeURIComponent)
// ---------------------------------------------------------------------------

/// The unreserved set for `encodeURIComponent`: `A-Za-z0-9-_.~`. Everything
/// else is percent-encoded from its UTF-8 bytes with uppercase hex.
pub fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Pure: parsing a recorded upstream payload
// ---------------------------------------------------------------------------

/// `fetchBinance` row extraction: `[{symbol, price}] -> [(binance_symbol, price)]`,
/// dropping rows with no symbol or a non-finite / non-positive price. The symbol
/// is returned verbatim; the caller maps it back to an asset.
pub fn parse_binance_rows(rows: &Value) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    if let Some(arr) = rows.as_array() {
        for row in arr {
            let symbol = row.get("symbol").and_then(Value::as_str).unwrap_or("");
            if symbol.is_empty() {
                continue;
            }
            let price = js_number(row.get("price"));
            if valid_price(price) {
                out.push((symbol.to_string(), price));
            }
        }
    }
    out
}

/// `priceFromResponse`: `meta.regularMarketPrice`, else the last non-null close
/// in the spark series.
pub fn yahoo_price_from_response(response: &Value) -> Option<f64> {
    let direct = js_number(
        response
            .get("meta")
            .and_then(|m| m.get("regularMarketPrice")),
    );
    if valid_price(direct) {
        return Some(direct);
    }
    if let Some(closes) = response.get("close").and_then(Value::as_array) {
        for close in closes.iter().rev() {
            let value = js_number(Some(close));
            if valid_price(value) {
                return Some(value);
            }
        }
    }
    None
}

/// `fetchBatch` result extraction: walks `spark.result[].{symbol, response[0]}`
/// and returns `[(yahoo_symbol, price)]` for every result with a usable quote.
pub fn parse_yahoo_spark(data: &Value) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    if let Some(results) = data
        .get("spark")
        .and_then(|s| s.get("result"))
        .and_then(Value::as_array)
    {
        for result in results {
            let symbol = match result.get("symbol").and_then(Value::as_str) {
                Some(s) => s,
                None => continue,
            };
            let first = result
                .get("response")
                .and_then(Value::as_array)
                .and_then(|a| a.first());
            if let Some(price) = first.and_then(yahoo_price_from_response) {
                out.push((symbol.to_string(), price));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Pure: staleness decision
// ---------------------------------------------------------------------------

/// `Date.now() - hit.at < cacheWindow(asset)` — strictly less than, so a quote
/// exactly `window` old is already stale.
pub fn is_fresh(cached_at_ms: i64, now_ms: i64, window_ms: i64) -> bool {
    now_ms - cached_at_ms < window_ms
}

/// Wall clock in milliseconds since the epoch, the `Date.now()` equivalent used
/// for cache stamps and SSE frame timestamps.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// In-process cache (mirrors marketPrices.ts `cache: Map`)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct CacheEntry {
    price: f64,
    at: i64,
}

fn cache_get(asset: &str) -> Option<CacheEntry> {
    let tick = crate::ticks::buffer().latest(asset)?;
    Some(CacheEntry {
        price: tick.price,
        at: tick.at_ms,
    })
}

fn cache_set(asset: &str, price: f64, at: i64, source: &'static str) {
    crate::ticks::buffer().record(asset, price, at, source);
}

fn fresh(asset: &str, now: i64) -> Option<f64> {
    let entry = cache_get(asset)?;
    if is_fresh(entry.at, now, cache_window_ms(asset)) {
        Some(entry.price)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Network I/O (thin wrapper over the pure parsers above)
// ---------------------------------------------------------------------------

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .build()
        .expect("price aggregator reqwest client")
});

/// A short, URL-free description of a `reqwest::Error`. reqwest's `Display`
/// embeds the request URL (query params included), so we never forward it to a
/// log line.
fn describe_reqwest(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect error"
    } else if err.is_decode() {
        "decode error"
    } else if err.is_request() {
        "request error"
    } else {
        "transport error"
    }
}

/// A log-safe reason for a `get_json` failure — never the URL.
fn describe_err(err: &ApiError) -> &'static str {
    match err {
        ApiError::Http(e) => describe_reqwest(e),
        _ => "upstream error",
    }
}

/// GET a JSON document. A non-2xx is warned and answered with `Value::Null`
/// (parsed as no quotes), matching how the TS returns `[]` on a bad status;
/// transport/timeout/decode failures come back as `Err(ApiError::Http)`, which
/// each caller swallows. `status_label` reproduces the TS warn text.
async fn get_json(url: &str, status_label: &str, user_agent: Option<&str>) -> ApiResult<Value> {
    let mut request = CLIENT
        .get(url)
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS));
    if let Some(ua) = user_agent {
        request = request.header(reqwest::header::USER_AGENT, ua);
    }
    // TS sends `cache: 'no-store'`; no shared cache is configured here, and a
    // bare GET is idempotent, so no extra header is needed for parity.
    let response = request.send().await?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!("[prices] {status_label} returned {status}");
        return Ok(Value::Null);
    }
    Ok(response.json::<Value>().await?)
}

/// `fetchBinance`: one batched call for all crypto assets -> `[(asset, price)]`.
/// Symbols are sent as the whole JSON list, `encodeURIComponent`'d as a unit,
/// exactly like the TS.
async fn fetch_binance(crypto: &[String]) -> Vec<(String, f64)> {
    if crypto.is_empty() {
        return Vec::new();
    }
    let symbols_json = {
        let list: Vec<&str> = crypto.iter().filter_map(|a| binance_symbol(a)).collect();
        Value::Array(list.into_iter().map(Value::from).collect()).to_string()
    };
    let url = format!(
        "{}?symbols={}",
        config().binance_endpoint,
        encode_uri_component(&symbols_json)
    );

    let requested: HashSet<&str> = crypto.iter().map(|a| a.as_str()).collect();
    let rows = match get_json(&url, "binance", None).await {
        Ok(rows) => rows,
        Err(err) => {
            // URL-free reason only: the request line carries the symbol query.
            tracing::warn!("[prices] binance failed: {}", describe_err(&err));
            return Vec::new();
        }
    };

    parse_binance_rows(&rows)
        .into_iter()
        .filter_map(|(symbol, price)| {
            let asset = BINANCE_REV.get(symbol.as_str())?;
            requested
                .contains(asset)
                .then(|| (asset.to_string(), price))
        })
        .collect()
}

/// `fetchBatch`: one Yahoo `spark` call for at most `BATCH_SIZE` symbols. Each
/// symbol is encoded but the commas stay literal — Yahoo will not split on an
/// encoded comma.
async fn fetch_yahoo_batch(symbols: &[&str]) -> Vec<(String, f64)> {
    let query = symbols
        .iter()
        .map(|s| encode_uri_component(s))
        .collect::<Vec<_>>()
        .join(",");
    let url = format!(
        "{}?symbols={query}&interval=1d&range=1d",
        config().yahoo_spark_endpoint
    );

    let data = match get_json(&url, "upstream", Some(YAHOO_USER_AGENT)).await {
        Ok(data) => data,
        Err(err) => {
            tracing::warn!("[prices] fetch failed: {}", describe_err(&err));
            return Vec::new();
        }
    };
    parse_yahoo_spark(&data)
}

/// `fetchYahoo`: assets -> batches Yahoo accepts -> concurrent fetches ->
/// `[(asset, price)]`, mapping symbols back through the *requested* subset only.
async fn fetch_yahoo(assets: &[String]) -> Vec<(String, f64)> {
    let pairs: Vec<(&str, &str)> = assets
        .iter()
        .filter_map(|a| yahoo_symbol(a).map(|s| (a.as_str(), s)))
        .collect();
    if pairs.is_empty() {
        return Vec::new();
    }
    let asset_by_symbol: HashMap<&str, &str> = pairs.iter().map(|(a, s)| (*s, *a)).collect();

    // Split into batches Yahoo will accept, then fetch them concurrently:
    // at most ceil(symbols / BATCH_SIZE) requests in flight, all joined before
    // this returns, so nothing outlives the request.
    let batches: Vec<Vec<&str>> = pairs
        .iter()
        .map(|(_, s)| *s)
        .collect::<Vec<&str>>()
        .chunks(BATCH_SIZE)
        .map(|chunk| chunk.to_vec())
        .collect();
    let results =
        futures::future::join_all(batches.iter().map(|batch| fetch_yahoo_batch(batch))).await;

    let mut out = Vec::new();
    for batch in results {
        for (symbol, price) in batch {
            if let Some(asset) = asset_by_symbol.get(symbol.as_str()) {
                out.push((asset.to_string(), price));
            }
        }
    }
    out
}

/// `fetchLatestPrices`: dedup/upper-case the request, serve what the cache
/// already holds, quote crypto (Binance) and slow (Yahoo) concurrently, fall
/// back to Yahoo for crypto Binance missed, then to the last price we ever saw.
/// Infallible: a dead upstream yields fewer prices, never an error.
pub async fn fetch_latest_prices(
    assets: &[String],
    bypass_crypto_cache: bool,
) -> BTreeMap<String, f64> {
    // Normalise: `Array.from(new Set(assets.filter(Boolean).map(upper)))`,
    // preserving first-seen order.
    let mut wanted: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for asset in assets {
        let trimmed = asset.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_uppercase();
        if seen.insert(key.clone()) {
            wanted.push(key);
        }
    }

    let now = now_millis();
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    let mut crypto: Vec<String> = Vec::new();
    let mut slow: Vec<String> = Vec::new();

    for asset in &wanted {
        let crypto_asset = is_crypto(asset);
        // The SSE ticker re-quotes crypto every tick; slow quotes refresh every
        // 15s+ at source, so the bypass never applies to them.
        let cached = if crypto_asset && bypass_crypto_cache {
            None
        } else {
            fresh(asset, now)
        };
        if let Some(price) = cached {
            out.insert(asset.clone(), price);
        } else if crypto_asset {
            crypto.push(asset.clone());
        } else if yahoo_symbol(asset).is_some() {
            slow.push(asset.clone());
        }
        // Anything in neither table (e.g. LINK) is dropped, as the TS does.
    }

    if crypto.is_empty() && slow.is_empty() {
        return out;
    }

    let record =
        |pairs: Vec<(String, f64)>, source: &'static str, out: &mut BTreeMap<String, f64>| {
            let stamp = now_millis();
            for (asset, price) in pairs {
                out.insert(asset.clone(), price);
                cache_set(&asset, price, stamp, source);
            }
        };

    // Binance and Yahoo run concurrently; each carries its own request timeout.
    let binance_fut = fetch_binance(&crypto);
    let yahoo_fut = fetch_yahoo(&slow);
    let (binance, yahoo) = futures::future::join(binance_fut, yahoo_fut).await;
    record(binance, "binance", &mut out);
    record(yahoo, "yahoo", &mut out);

    // Crypto Binance did not return still gets a Yahoo quote (just slower).
    let crypto_missing: Vec<String> = crypto
        .iter()
        .filter(|a| !out.contains_key(a.as_str()))
        .cloned()
        .collect();
    if !crypto_missing.is_empty() {
        let fallback = fetch_yahoo(&crypto_missing).await;
        record(fallback, "yahoo", &mut out);
    }

    // Anything still missing falls back to the last price we saw for it.
    let mut missing: Vec<&str> = Vec::new();
    for asset in crypto.iter().chain(slow.iter()) {
        if out.contains_key(asset.as_str()) {
            continue;
        }
        match cache_get(asset) {
            Some(entry) => {
                out.insert(asset.clone(), entry.price);
            }
            None => missing.push(asset.as_str()),
        }
    }
    if !missing.is_empty() {
        tracing::warn!("[prices] no quote for {}", missing.join(", "));
    }

    out
}

/// Samples every tradable asset for the life of the process, so a round's prices
/// never depend on a client being connected. Crypto skips the cache to get a tick
/// per sample; slow assets refresh on their own 15 s window. During an outage this
/// records nothing, which is what the staleness and refund rules read.
pub async fn run_sampler() {
    let assets: Vec<String> = VALID_ASSETS
        .iter()
        .filter(|asset| is_quoted(asset))
        .map(|asset| asset.to_string())
        .collect();
    let mut every = tokio::time::interval(Duration::from_millis(config().price_sample_ms.max(1)));
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        fetch_latest_prices(&assets, true).await;
    }
}

/// Everything `/api/prices/latest` requests by default: `Object.keys(PRICE_FEED_IDS)`.
pub fn default_assets() -> Vec<String> {
    VALID_ASSETS.iter().map(|s| s.to_string()).collect()
}

/// The `{"prices":{...}}` document, byte-for-byte in the shape the browser
/// parses (`NextResponse.json({ prices })`), with JS-formatted numbers and
/// deterministic (alphabetical) key order.
pub fn prices_body_json(prices: &BTreeMap<String, f64>) -> String {
    let mut out = String::from("{\"prices\":{");
    for (index, (asset, price)) in prices.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&json_escape(asset));
        out.push_str("\":");
        out.push_str(&number_to_json(*price));
    }
    out.push_str("}}");
    out
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The exact JSON body the route's `catch` returns on failure (kept for parity
/// even though `fetch_latest_prices` is infallible).
pub const PRICE_ERROR_BODY: &str = "{\"prices\":{},\"error\":\"Failed to load prices\"}";

// ---------------------------------------------------------------------------
// SSE stream primitives (parsing / framing)
// ---------------------------------------------------------------------------

/// `parseAssetSelector`: accepts bare codes (`BTC`) and pair-style (`BTC-USD`);
/// empty/absent means "everything the latest route serves". Any unknown token
/// rejects the whole request.
pub fn parse_asset_selector(raw: Option<&str>) -> Result<Vec<String>, String> {
    let tokens: Vec<String> = raw
        .unwrap_or("")
        .split(',')
        .map(|t| t.trim().to_uppercase())
        .filter(|t| !t.is_empty())
        .collect();

    if tokens.is_empty() {
        return Ok(default_assets());
    }

    let valid: HashSet<&str> = VALID_ASSETS.iter().copied().collect();
    let mut assets: Vec<String> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    for token in tokens {
        let candidate = token
            .strip_suffix("-USD")
            .unwrap_or(token.as_str())
            .to_string();
        if valid.contains(candidate.as_str()) {
            if !assets.contains(&candidate) {
                assets.push(candidate);
            }
        } else {
            unknown.push(token);
        }
    }
    if !unknown.is_empty() {
        return Err(format!("Unknown asset(s): {}", unknown.join(", ")));
    }
    Ok(assets)
}

/// `dataFrame({ asset, price, ts })` for a market move. Key order and the
/// integer millisecond `ts` match the route exactly.
pub fn tick_frame(asset: &str, price: f64, ts_ms: i64) -> String {
    format!(
        "data: {{\"asset\":\"{}\",\"price\":{},\"ts\":{}}}\n\n",
        json_escape(asset),
        number_to_json(price),
        ts_ms
    )
}

/// `dataFrame({ asset, price, ts, snapshot: true })` for the connect-time prime.
pub fn snapshot_frame(asset: &str, price: f64, ts_ms: i64) -> String {
    format!(
        "data: {{\"asset\":\"{}\",\"price\":{},\"ts\":{},\"snapshot\":true}}\n\n",
        json_escape(asset),
        number_to_json(price),
        ts_ms
    )
}

// ---------------------------------------------------------------------------
// Handler-facing response builders
// ---------------------------------------------------------------------------

/// A built response: status, JSON body, and the headers the route sets.
#[derive(Debug, Clone)]
pub struct PricesResponse {
    pub status: u16,
    pub body: String,
    pub cache_control: String,
    pub vary: Option<String>,
}

/// GET `/api/prices/latest` — body plus the CDN-friendly `PRICE_HEADERS`.
pub async fn latest_get(assets: &[String]) -> ApiResult<PricesResponse> {
    let prices = fetch_latest_prices(assets, false).await;
    Ok(PricesResponse {
        status: 200,
        body: prices_body_json(&prices),
        cache_control: PRICE_LATEST_CACHE_CONTROL.to_string(),
        vary: Some(PRICE_LATEST_VARY.to_string()),
    })
}

/// POST `/api/prices/latest` — same body, but the TS sets no cache headers here.
pub async fn latest_post(assets: &[String]) -> ApiResult<PricesResponse> {
    let prices = fetch_latest_prices(assets, false).await;
    Ok(PricesResponse {
        status: 200,
        body: prices_body_json(&prices),
        cache_control: String::new(),
        vary: None,
    })
}

/// The same priming with the quotes and the clock supplied, so the pairing is
/// testable without a network. Zipping a filtered price list against the asset
/// list would silently relabel every asset after the first missing quote, so the
/// asset travels with its own price.
pub fn snapshot_frames_at(
    assets: &[String],
    prices: &BTreeMap<String, f64>,
    ts_ms: i64,
) -> Vec<String> {
    assets
        .iter()
        .filter_map(|asset| {
            prices
                .get(asset)
                .copied()
                .filter(|p| p.is_finite() && *p > 0.0)
                .map(|price| snapshot_frame(asset, price, ts_ms))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- recorded fixtures (string literals; no network anywhere) ----------

    const BINANCE_OK: &str = r#"[
        {"symbol":"BTCUSDT","price":"67123.45000000"},
        {"symbol":"ETHUSDT","price":"3500.12000000"},
        {"symbol":"SOLUSDT","price":"149.50000000"}
    ]"#;

    // A missing price field (Number(undefined)=NaN), zero and negative quotes
    // must all be dropped at the parse layer. An *unrecognised* symbol
    // (NOPEUSDT) survives parsing — dropping it is the symbol->asset step's job
    // (see `unrecognised_binance_symbol_resolves_to_no_asset`).
    const BINANCE_PARTIAL: &str = r#"[
        {"symbol":"BTCUSDT","price":"67000.00000000"},
        {"symbol":"NOPEUSDT","price":"1.00000000"},
        {"symbol":"ETHUSDT"},
        {"symbol":"XRPUSDT","price":"0.00000000"},
        {"symbol":"DOGEUSDT","price":"0.12340000"},
        {"symbol":"ADAUSDT","price":"-5.00000000"}
    ]"#;

    const BINANCE_ERROR: &str = r#"{"code":-1121,"msg":"Invalid symbol."}"#;

    // Two symbols: one answers via meta.regularMarketPrice, one only via the
    // trailing close series (meta price is null). A leading null close must be
    // skipped.
    const YAHOO_OK: &str = r#"{
        "spark": { "result": [
            {
                "symbol": "AAPL",
                "response": [{
                    "meta": { "regularMarketPrice": 232.63 },
                    "close": [230.1, 231.0, null, 232.63]
                }]
            },
            {
                "symbol": "GC=F",
                "response": [{
                    "meta": { "regularMarketPrice": null },
                    "close": [2650.0, 2651.5, null]
                }]
            }
        ] }
    }"#;

    // Every close is null: no usable price, so the result must be skipped.
    const YAHOO_NO_PRICE: &str = r#"{
        "spark": { "result": [
            {"symbol": "CL=F", "response": [{"meta": {}, "close": [null, null]}]}
        ] }
    }"#;

    const YAHOO_MALFORMED: &str = r#"{"quoteResponse": {"result": []}}"#;

    // -----------------------------------------------------------------------
    // symbol mapping / coverage
    // -----------------------------------------------------------------------

    #[test]
    fn maps_known_symbols_both_directions() {
        assert_eq!(binance_symbol("BTC"), Some("BTCUSDT"));
        assert_eq!(binance_symbol("APT"), Some("APTUSDT"));
        assert_eq!(yahoo_symbol("BTC"), Some("BTC-USD"));
        // The two colliding crypto tickers use Yahoo's id-suffixed form.
        assert_eq!(yahoo_symbol("SUI"), Some("SUI20947-USD"));
        assert_eq!(yahoo_symbol("APT"), Some("APT21794-USD"));
        assert_eq!(yahoo_symbol("GOLD"), Some("GC=F"));
        assert_eq!(yahoo_symbol("JPY"), Some("JPY=X"));
        assert_eq!(yahoo_symbol("SPX"), Some("^GSPC"));
        assert_eq!(yahoo_symbol("DJI"), Some("^DJI"));
        // Assets the aggregator has no source for.
        assert_eq!(binance_symbol("LINK"), None);
        assert_eq!(yahoo_symbol("LINK"), None);
    }

    #[test]
    fn crypto_detection_drives_the_source_choice() {
        for asset in [
            "BTC", "ETH", "SOL", "SUI", "TRX", "XRP", "DOGE", "ADA", "BCH", "BNB", "XLM", "XTZ",
            "NEAR", "APT",
        ] {
            assert!(is_crypto(asset), "{asset} must be crypto-backed");
        }
        assert!(!is_crypto("AAPL"));
        assert!(!is_crypto("GOLD"));
        assert!(!is_crypto("EUR"));
    }

    #[test]
    fn covered_assets_are_the_quoteable_subset_of_valid_assets() {
        let valid: HashSet<&str> = VALID_ASSETS.iter().copied().collect();
        for (asset, _) in BINANCE_PAIRS.iter().chain(YAHOO_PAIRS.iter()) {
            assert!(valid.contains(*asset), "{asset} missing from VALID_ASSETS");
        }
        assert_eq!(default_assets().len(), VALID_ASSETS.len());
    }

    // -----------------------------------------------------------------------
    // Binance payload parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parses_binance_success() {
        let rows: Value = serde_json::from_str(BINANCE_OK).unwrap();
        let parsed = parse_binance_rows(&rows);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].0, "BTCUSDT");
        assert_eq!(parsed[0].1, 67123.45);
        assert_eq!(parsed[2].1, 149.5);
    }

    #[test]
    fn binance_drops_missing_and_non_positive_prices() {
        let rows: Value = serde_json::from_str(BINANCE_PARTIAL).unwrap();
        let parsed = parse_binance_rows(&rows);
        // Keeps BTCUSDT, DOGEUSDT and the still-unmapped NOPEUSDT; drops the
        // missing-price, zero and negative rows.
        let symbols: Vec<&str> = parsed.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(symbols, vec!["BTCUSDT", "NOPEUSDT", "DOGEUSDT"]);
    }

    #[test]
    fn unrecognised_binance_symbol_resolves_to_no_asset() {
        // The requested-subset mapping in `fetch_binance` is what actually drops
        // NOPEUSDT: it is not a known Binance symbol and so maps to no asset.
        assert!(BINANCE_REV.get("NOPEUSDT").is_none());
        assert_eq!(BINANCE_REV.get("BTCUSDT").copied(), Some("BTC"));
        assert_eq!(BINANCE_REV.get("APTUSDT").copied(), Some("APT"));
    }

    #[test]
    fn binance_error_object_and_non_string_input_yield_nothing() {
        let rows: Value = serde_json::from_str(BINANCE_ERROR).unwrap();
        assert!(parse_binance_rows(&rows).is_empty());
        assert!(parse_binance_rows(&Value::Null).is_empty());
    }

    #[test]
    fn binance_price_accepts_numeric_and_whitespace_string_forms() {
        let rows: Value = serde_json::from_str(
            r#"[{"symbol":"BTCUSDT","price":" 100.00000000 "},{"symbol":"ETHUSDT","price":50.25}]"#,
        )
        .unwrap();
        let parsed = parse_binance_rows(&rows);
        assert_eq!(
            parsed,
            vec![
                ("BTCUSDT".to_string(), 100.0),
                ("ETHUSDT".to_string(), 50.25)
            ]
        );
    }

    // -----------------------------------------------------------------------
    // Yahoo payload parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parses_yahoo_meta_and_close_fallback() {
        let data: Value = serde_json::from_str(YAHOO_OK).unwrap();
        let parsed = parse_yahoo_spark(&data);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("AAPL".to_string(), 232.63));
        // GC=F meta price was null, so the last non-null close (2651.5) wins.
        assert_eq!(parsed[1], ("GC=F".to_string(), 2651.5));
    }

    #[test]
    fn yahoo_skips_results_with_no_usable_price() {
        let data: Value = serde_json::from_str(YAHOO_NO_PRICE).unwrap();
        assert!(parse_yahoo_spark(&data).is_empty());
        let malformed: Value = serde_json::from_str(YAHOO_MALFORMED).unwrap();
        assert!(parse_yahoo_spark(&malformed).is_empty());
        assert!(parse_yahoo_spark(&Value::Null).is_empty());
    }

    #[test]
    fn yahoo_price_prefers_meta_then_last_positive_close() {
        let with_meta: Value =
            serde_json::from_str(r#"{"meta":{"regularMarketPrice":10.5},"close":[9,12]}"#).unwrap();
        assert_eq!(yahoo_price_from_response(&with_meta), Some(10.5));
        let close_only: Value =
            serde_json::from_str(r#"{"meta":{},"close":[5,0,null,7.25,1.0]}"#).unwrap();
        assert_eq!(yahoo_price_from_response(&close_only), Some(1.0)); // last non-null positive
    }

    // -----------------------------------------------------------------------
    // JS Number() coercion parity
    // -----------------------------------------------------------------------

    #[test]
    fn js_number_matches_number_coercion() {
        let value = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert_eq!(js_number(Some(&value("250.5"))), 250.5);
        assert_eq!(js_number(Some(&value("\"149.50\""))), 149.5);
        assert_eq!(js_number(Some(&value("\"  12 \""))), 12.0); // trims
        assert_eq!(js_number(Some(&value("\"\""))), 0.0); // Number("") = 0
        assert_eq!(js_number(Some(&value("true"))), 1.0);
        assert_eq!(js_number(Some(&value("null"))), 0.0); // Number(null) = 0
        assert!(js_number(Some(&value("\"abc\""))).is_nan());
        assert!(js_number(None).is_nan()); // Number(undefined) = NaN
        assert!(js_number(Some(&value("[1,2]"))).is_nan());
    }

    // -----------------------------------------------------------------------
    // JS-compatible number serialisation
    // -----------------------------------------------------------------------

    #[test]
    fn number_to_json_matches_json_stringify() {
        assert_eq!(number_to_json(100.0), "100"); // whole -> no ".0"
        assert_eq!(number_to_json(250.5), "250.5");
        assert_eq!(number_to_json(67123.45), "67123.45");
        assert_eq!(number_to_json(0.5), "0.5");
        assert_eq!(number_to_json(-0.0), "0"); // JSON.stringify(-0) === "0"
        assert_eq!(number_to_json(0.0), "0");
        assert_eq!(number_to_json(1.0), "1");
        // Shortest round-trip digits, same as V8.
        assert_eq!(number_to_json(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_to_json(149.5), "149.5");
    }

    // -----------------------------------------------------------------------
    // encodeURIComponent parity (Yahoo splits only on literal commas)
    // -----------------------------------------------------------------------

    #[test]
    fn encodes_like_encodeuri_component() {
        assert_eq!(encode_uri_component("BTC-USD"), "BTC-USD"); // hyphen unreserved
        assert_eq!(encode_uri_component("GC=F"), "GC%3DF");
        assert_eq!(encode_uri_component("^GSPC"), "%5EGSPC");
        assert_eq!(encode_uri_component("EURUSD=X"), "EURUSD%3DX");
        assert_eq!(encode_uri_component("SUI20947-USD"), "SUI20947-USD");
        // The whole Binance JSON list, encoded as one unit.
        assert_eq!(
            encode_uri_component(r#"["BTCUSDT","ETHUSDT"]"#),
            "%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D"
        );
    }

    #[test]
    fn yahoo_batch_query_keeps_commas_literal() {
        let symbols = ["AAPL", "GC=F", "^GSPC"];
        let query = symbols
            .iter()
            .map(|s| encode_uri_component(s))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(query, "AAPL,GC%3DF,%5EGSPC");
    }

    // -----------------------------------------------------------------------
    // staleness windows
    // -----------------------------------------------------------------------

    #[test]
    fn cache_windows_match_the_ts() {
        assert_eq!(cache_window_ms("BTC"), 1_000);
        assert_eq!(cache_window_ms("APT"), 1_000);
        assert_eq!(cache_window_ms("AAPL"), 15_000);
        assert_eq!(cache_window_ms("GOLD"), 15_000);
    }

    #[test]
    fn freshness_is_strictly_under_the_window() {
        // At t=1000, a quote stamped at 0 is exactly the window old -> stale.
        assert!(is_fresh(0, 999, 1_000));
        assert!(!is_fresh(0, 1_000, 1_000));
        assert!(!is_fresh(0, 1_001, 1_000));
        // Slow assets live 15s.
        assert!(is_fresh(0, 14_999, 15_000));
        assert!(!is_fresh(0, 15_000, 15_000));
    }

    #[test]
    fn cache_fresh_and_stale_fallback_semantics() {
        let asset = "AAPL";
        cache_set(asset, 123.4, 500, "yahoo");
        // Inside the window -> served from cache.
        assert_eq!(fresh(asset, 500 + 14_000), Some(123.4));
        // Past the window -> not fresh...
        assert_eq!(fresh(asset, 500 + 15_000), None);
        // ...but the stale fallback still returns the last-seen price.
        assert_eq!(cache_get(asset).map(|e| e.price), Some(123.4));
    }

    // -----------------------------------------------------------------------
    // response body assembly
    // -----------------------------------------------------------------------

    #[test]
    fn assembles_prices_body_with_js_numbers() {
        let mut prices = BTreeMap::new();
        prices.insert("BTC".to_string(), 67123.45_f64);
        prices.insert("AAPL".to_string(), 100.0_f64);
        prices.insert("JPY".to_string(), 149.5_f64);
        assert_eq!(
            prices_body_json(&prices),
            "{\"prices\":{\"AAPL\":100,\"BTC\":67123.45,\"JPY\":149.5}}"
        );
        // Empty map -> the "prices":{} shape the client reads on a cold cache.
        assert_eq!(prices_body_json(&BTreeMap::new()), "{\"prices\":{}}");
    }

    // -----------------------------------------------------------------------
    // SSE selector + frame parity
    // -----------------------------------------------------------------------

    #[test]
    fn selector_normalizes_and_defaults() {
        assert_eq!(
            parse_asset_selector(Some("BTC,ETH")).unwrap(),
            vec!["BTC", "ETH"]
        );
        // pair-style collapses to the bare code, case-insensitively
        assert_eq!(
            parse_asset_selector(Some("btc-usd, ETH-USD")).unwrap(),
            vec!["BTC", "ETH"]
        );
        // dedup, preserving first-seen order
        assert_eq!(
            parse_asset_selector(Some("BTC,BTC-USD,BTC")).unwrap(),
            vec!["BTC"]
        );
        // empty selector = everything the latest route serves
        assert_eq!(parse_asset_selector(Some("")).unwrap(), default_assets());
        assert_eq!(parse_asset_selector(None).unwrap(), default_assets());
    }

    #[test]
    fn selector_rejects_unknown_tokens_entirely() {
        let err = parse_asset_selector(Some("FAKECOIN-USD")).unwrap_err();
        assert_eq!(err, "Unknown asset(s): FAKECOIN-USD");
        // Mixed valid + unknown still rejects the whole request.
        let err = parse_asset_selector(Some("BTC,NOPE")).unwrap_err();
        assert_eq!(err, "Unknown asset(s): NOPE");
    }

    #[test]
    fn tick_frame_matches_route_shape() {
        assert_eq!(
            tick_frame("BTC", 111111.5, 1_700_000_000_000),
            "data: {\"asset\":\"BTC\",\"price\":111111.5,\"ts\":1700000000000}\n\n"
        );
        // snapshot frame adds the flag last, key order preserved
        assert_eq!(
            snapshot_frame("BTC", 100.0, 1_700_000_000_000),
            "data: {\"asset\":\"BTC\",\"price\":100,\"ts\":1700000000000,\"snapshot\":true}\n\n"
        );
    }

    #[test]
    fn tick_stream_dedup_uses_exact_price_equality() {
        // priceStream.ts skips a push when the price is unchanged; mirror that
        // predicate here so the server ticker can reuse it verbatim.
        let last_sent: Option<f64> = Some(100.0);
        let unchanged = 100.0_f64;
        let moved = 100.01_f64;
        assert!(last_sent == Some(unchanged));
        assert!(!(last_sent == Some(moved)));
    }

    #[test]
    fn only_positive_finite_prices_are_pushed_as_ticks() {
        // The stream filters to `Number.isFinite(price) && price > 0` before
        // framing; assert the pure guard we rely on.
        assert!(valid_price(1.0));
        assert!(!valid_price(0.0));
        assert!(!valid_price(-1.0));
        assert!(!valid_price(f64::NAN));
        assert!(!valid_price(f64::INFINITY));
    }

    #[test]
    fn snapshot_frames_never_relabel_a_missing_asset() {
        // A gap in the middle of the requested list used to shift every later
        // price onto the next asset's name, which paints one market as another.
        let assets: Vec<String> = ["BTC", "ETH", "SOL"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut prices = BTreeMap::new();
        prices.insert("BTC".to_string(), 100_000.0_f64);
        prices.insert("SOL".to_string(), 150.0_f64);

        let frames = snapshot_frames_at(&assets, &prices, 1_700_000_000_000);
        assert_eq!(
            frames,
            vec![
                snapshot_frame("BTC", 100_000.0, 1_700_000_000_000),
                snapshot_frame("SOL", 150.0, 1_700_000_000_000),
            ]
        );

        // A zero or negative quote is "no quote", not a price of nothing.
        prices.insert("ETH".to_string(), 0.0);
        let frames = snapshot_frames_at(&assets, &prices, 1_700_000_000_000);
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| !f.contains("\"ETH\"")));
    }
}
