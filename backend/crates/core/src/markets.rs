//! Tokenized-stock markets: the real share price from Yahoo next to what each
//! wrapper token (bStocks, Ondo, xStocks on BNB Chain) actually costs to buy.
//!
//! Wrapper prices are executable quotes from the KyberSwap aggregator for a
//! fixed $100 USDT buy, so slippage is included. Nothing here signs or sends a
//! transaction; every call is a read.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::prices::now_millis;

use k256::ecdsa::SigningKey;

use crate::address::keccak256;
use crate::error::{ApiError, ApiResult};
use crate::eth::{hex_decode, normalize_low_s};

const SPARK_URL: &str = "https://query2.finance.yahoo.com/v7/finance/spark";
const KYBER_URL: &str = "https://aggregator-api.kyberswap.com/bsc/api/v1/routes";
const USDT_BSC: &str = "0x55d398326f99059fF775485246999027B3197955";
/// Every wrapper below uses 18 decimals, as does BSC USDT.
const DECIMALS: f64 = 1e18;
pub const QUOTE_USD: u32 = 100;
const TTL: Duration = Duration::from_secs(30);
/// After a failed Yahoo fetch the last good snapshot is served and Yahoo is tried
/// again this soon, instead of caching the failure for a full TTL.
const RETRY: Duration = Duration::from_secs(5);
/// A signed quote is never built on a snapshot older than this.
const MAX_QUOTE_AGE_MS: i64 = 5 * 60 * 1000;
/// The last EUR/USD rate still good enough when Yahoo is down.
const MAX_RATE_AGE: Duration = Duration::from_secs(15 * 60);
/// Per upstream call. With 6 quotes in flight, 17 wrappers finish in at most
/// three rounds, so a refresh never holds the cache lock past ~9s.
const CALL_TIMEOUT: Duration = Duration::from_secs(3);
/// A wrapper priced further than this from the stock is a wrong-decimals token
/// or a drained pool, not a deal, so it is shown as unquoted.
const MAX_PREMIUM_BPS: f64 = 2_000.0;

pub const TICKERS: &[&str] = &[
    "NVDA", "AAPL", "TSLA", "META", "SPY", "AMZN", "GOOGL", "MSFT", "AMD", "NFLX",
];

/// (issuer, ticker, token symbol, BSC contract). Public addresses, same book
/// OpenVenue (MIT) ships in `src/lib/venue/issuers.ts`.
const WRAPPERS: &[(&str, &str, &str, &str)] = &[
    (
        "bStocks",
        "NVDA",
        "NVDAB",
        "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
    ),
    (
        "bStocks",
        "AAPL",
        "AAPLB",
        "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A",
    ),
    (
        "bStocks",
        "TSLA",
        "TSLAB",
        "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
    ),
    (
        "bStocks",
        "META",
        "METAB",
        "0x7425889FE94F9d693E8daefE88BCCed6AcFEf4c0",
    ),
    (
        "bStocks",
        "SPY",
        "SPYB",
        "0x7138b48df7D98D7e3cc221BfE7192D0a178182D8",
    ),
    (
        "bStocks",
        "AMZN",
        "AMZNB",
        "0x1a4b499833A79A09ad7Cf1D42D7DacF71e92eb00",
    ),
    (
        "bStocks",
        "GOOGL",
        "GOOGLB",
        "0x3F53De71c126BdaBAe20f9cD64848d317f6C3238",
    ),
    (
        "bStocks",
        "MSFT",
        "MSFTB",
        "0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0",
    ),
    (
        "bStocks",
        "AMD",
        "AMDB",
        "0x75Fd4cF6f8392E41E70391D60c90C0D5211603a1",
    ),
    (
        "bStocks",
        "NFLX",
        "NFLXB",
        "0xD6829Ea836b6FA224d099D40E54B31262f874631",
    ),
    (
        "Ondo",
        "NVDA",
        "NVDAon",
        "0xA9eE28C80f960B889dFbd1902055218cBa016F75",
    ),
    (
        "Ondo",
        "AAPL",
        "AAPLon",
        "0x390a684EF9cADE28A7AD0DFa61AB1Eb3842618c4",
    ),
    (
        "Ondo",
        "TSLA",
        "TSLAon",
        "0x2494b603319d4D9F9715c9f4496d9E0364B59d93",
    ),
    (
        "Ondo",
        "SPY",
        "SPYon",
        "0x6a708EAD771238919D85930b5a0f10454E1C331a",
    ),
    (
        "Ondo",
        "AMZN",
        "AMZNon",
        "0x4553cFe1C09f37f38b12dC509F676964e392F8Fc",
    ),
    (
        "Ondo",
        "GOOGL",
        "GOOGLon",
        "0x091FC7778e6932d4009B087B191D1EE3bac5729A",
    ),
    (
        "xStocks",
        "NVDA",
        "NVDAx",
        "0xc845b2894dbddd03858fd2d643b4ef725fe0849d",
    ),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Venue {
    pub issuer: &'static str,
    pub symbol: &'static str,
    pub address: &'static str,
    pub chain: &'static str,
    /// USDT paid per share for a $100 buy, slippage included.
    pub price: Option<f64>,
    /// How far `price` sits from the stock's last price, in basis points.
    pub premium_bps: Option<f64>,
    pub route: Vec<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub ticker: &'static str,
    pub name: Option<String>,
    pub price: Option<f64>,
    pub prev_close: Option<f64>,
    pub change_pct: Option<f64>,
    pub volume: Option<f64>,
    /// Today's 5-minute closes, oldest first.
    pub points: Vec<f64>,
    pub venues: Vec<Venue>,
    /// Issuer of the cheapest venue, if any venue quoted.
    pub best: Option<&'static str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Markets {
    pub at: i64,
    /// `pre`, `open`, `post` or `closed`, from Yahoo's trading periods.
    pub session: &'static str,
    pub quote_usd: u32,
    pub assets: Vec<Asset>,
}

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(CALL_TIMEOUT)
        .user_agent("Mozilla/5.0")
        .build()
        .expect("markets reqwest client")
});

/// When the snapshot stops being fresh, and the snapshot: the last good one.
type Cached = Option<(Instant, Arc<Markets>)>;
static CACHE: Lazy<Mutex<Cached>> = Lazy::new(|| Mutex::new(None));

/// Cached for 30s. The lock is held through a refresh, so concurrent callers
/// share one upstream fetch instead of each firing 18 requests. A failed Yahoo
/// fetch keeps the last good snapshot (its `at` shows the age) and retries soon.
pub async fn snapshot() -> Arc<Markets> {
    let mut cache = CACHE.lock().await;
    if let Some((until, markets)) = cache.as_ref() {
        if Instant::now() < *until {
            return markets.clone();
        }
    }
    let (fresh, ok) = fetch().await;
    let (markets, valid_for) = next_snapshot(cache.as_ref().map(|c| c.1.clone()), fresh, ok);
    *cache = Some((Instant::now() + valid_for, markets.clone()));
    markets
}

/// What to serve after a fetch, and for how long.
fn next_snapshot(prev: Option<Arc<Markets>>, fresh: Markets, ok: bool) -> (Arc<Markets>, Duration) {
    match (ok, prev) {
        (true, _) => (Arc::new(fresh), TTL),
        (false, Some(prev)) => (prev, RETRY),
        (false, None) => (Arc::new(fresh), RETRY),
    }
}

/// The snapshot, and whether Yahoo answered.
async fn fetch() -> (Markets, bool) {
    let (spark, quotes) = tokio::join!(fetch_spark(), fetch_quotes());
    let now = now_millis();
    let session = spark
        .as_ref()
        .map(|s| session_at(s, now / 1000))
        .unwrap_or("closed");
    let assets = TICKERS
        .iter()
        .map(|ticker| build_asset(ticker, spark.as_ref(), &quotes))
        .collect();
    let markets = Markets {
        at: now,
        session,
        quote_usd: QUOTE_USD,
        assets,
    };
    (markets, spark.is_some())
}

async fn fetch_spark() -> Option<Value> {
    let url = format!(
        "{SPARK_URL}?symbols={}&interval=5m&range=1d&_={}",
        TICKERS.join(","),
        now_millis()
    );
    match HTTP
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(res) => res.json().await.ok(),
        Err(err) => {
            tracing::warn!("[markets] yahoo failed: {}", err.without_url());
            None
        }
    }
}

/// Symbol -> (USDT per share, route exchanges) or the reason it has no quote.
async fn fetch_quotes() -> HashMap<&'static str, Result<(f64, Vec<String>), String>> {
    let jobs: Vec<_> = WRAPPERS.iter().map(|w| quote_one(w.2, w.3)).collect();
    stream::iter(jobs).buffer_unordered(6).collect().await
}

async fn quote_one(
    symbol: &'static str,
    token: &'static str,
) -> (&'static str, Result<(f64, Vec<String>), String>) {
    (symbol, quote(token).await)
}

async fn quote(token: &'static str) -> Result<(f64, Vec<String>), String> {
    let amount_in = format!("{QUOTE_USD}000000000000000000");
    let res = HTTP
        .get(KYBER_URL)
        .header("x-client-id", "strike")
        .query(&[
            ("tokenIn", USDT_BSC),
            ("tokenOut", token),
            ("amountIn", &amount_in),
        ])
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let body: Value = res
        .json()
        .await
        .map_err(|_| "unreadable quote".to_string())?;
    parse_quote(&body)
}

fn parse_quote(body: &Value) -> Result<(f64, Vec<String>), String> {
    let summary = body.pointer("/data/routeSummary").ok_or_else(|| {
        body.get("message")
            .and_then(Value::as_str)
            .unwrap_or("no route")
            .to_string()
    })?;
    let out = summary
        .get("amountOut")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| *v > 0.0)
        .ok_or("no liquidity")?;
    let route = summary
        .get("route")
        .and_then(Value::as_array)
        .map(|legs| {
            legs.iter()
                .filter_map(|leg| {
                    leg.pointer("/0/exchange")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((QUOTE_USD as f64 / (out / DECIMALS), route))
}

fn spark_meta<'a>(spark: &'a Value, ticker: &str) -> Option<&'a Value> {
    spark
        .pointer("/spark/result")?
        .as_array()?
        .iter()
        .find(|r| r.get("symbol").and_then(Value::as_str) == Some(ticker))?
        .pointer("/response/0")
}

fn session_at(spark: &Value, now_s: i64) -> &'static str {
    let Some(periods) = spark.pointer("/spark/result/0/response/0/meta/currentTradingPeriod")
    else {
        return "closed";
    };
    for (key, label) in [("pre", "pre"), ("regular", "open"), ("post", "post")] {
        let bound = |edge: &str| {
            periods
                .pointer(&format!("/{key}/{edge}"))
                .and_then(Value::as_i64)
        };
        if let (Some(start), Some(end)) = (bound("start"), bound("end")) {
            if now_s >= start && now_s < end {
                return label;
            }
        }
    }
    "closed"
}

fn build_asset(
    ticker: &'static str,
    spark: Option<&Value>,
    quotes: &HashMap<&'static str, Result<(f64, Vec<String>), String>>,
) -> Asset {
    let row = spark.and_then(|s| spark_meta(s, ticker));
    let meta = row.and_then(|r| r.get("meta"));
    let num = |key: &str| meta.and_then(|m| m.get(key)).and_then(Value::as_f64);
    let price = num("regularMarketPrice");
    let prev_close = num("chartPreviousClose").or_else(|| num("previousClose"));
    let points = row
        .and_then(|r| r.pointer("/indicators/quote/0/close"))
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();

    let venues: Vec<Venue> = WRAPPERS
        .iter()
        .filter(|w| w.1 == ticker)
        .map(|&(issuer, _, symbol, address)| {
            let (quoted, error) = match quotes.get(symbol) {
                Some(Ok((p, _)))
                    if price
                        .is_some_and(|r| ((p / r - 1.0) * 10_000.0).abs() > MAX_PREMIUM_BPS) =>
                {
                    (None, Some("quote too far from the stock price".into()))
                }
                Some(Ok((p, route))) => (Some((*p, route.clone())), None),
                Some(Err(e)) => (None, Some(e.clone())),
                None => (None, Some("not quoted".into())),
            };
            let price_ps = quoted.as_ref().map(|q| q.0);
            Venue {
                issuer,
                symbol,
                address,
                chain: "bsc",
                price: price_ps,
                premium_bps: price_ps
                    .zip(price)
                    .map(|(p, r)| ((p / r - 1.0) * 10_000.0).round()),
                route: quoted.map(|q| q.1).unwrap_or_default(),
                error,
            }
        })
        .collect();
    let best = venues
        .iter()
        .filter_map(|v| v.price.map(|p| (v.issuer, p)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(issuer, _)| issuer);

    Asset {
        ticker,
        name: meta
            .and_then(|m| m.get("shortName"))
            .and_then(Value::as_str)
            .map(str::to_string),
        price,
        prev_close,
        change_pct: num("regularMarketChangePercent")
            .or_else(|| price.zip(prev_close).map(|(p, c)| (p / c - 1.0) * 100.0)),
        volume: num("regularMarketVolume"),
        points,
        venues,
        best,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_cheapest_venue_and_reads_session() {
        let spark = json!({"spark":{"result":[{"symbol":"NVDA","response":[{
            "meta":{"regularMarketPrice":180.0,"chartPreviousClose":200.0,"shortName":"NVIDIA",
                "currentTradingPeriod":{"pre":{"start":0,"end":10},"regular":{"start":10,"end":20},"post":{"start":20,"end":30}}},
            "indicators":{"quote":[{"close":[1.0,null,2.0]}]}}]}]}});
        let quote = |shares: &str| {
            parse_quote(
                &json!({"data":{"routeSummary":{"amountOut":shares,"route":[[{"exchange":"pancake-v3"}]]}}}),
            )
        };
        let mut quotes = HashMap::new();
        quotes.insert("NVDAB", quote("500000000000000000")); // 0.5 share -> $200
        quotes.insert("NVDAon", quote("555555555555555555")); // ~$180
        quotes.insert("NVDAx", parse_quote(&json!({"message":"route not found"})));

        let a = build_asset("NVDA", Some(&spark), &quotes);
        assert_eq!(a.best, Some("Ondo"));
        let mut drained = quotes.clone();
        drained.insert("NVDAon", quote("1000000000000")); // $100 for a dust amount
        let d = build_asset("NVDA", Some(&spark), &drained);
        assert_eq!(d.best, Some("bStocks"));
        assert_eq!(
            d.venues[1].error.as_deref(),
            Some("quote too far from the stock price")
        );
        assert_eq!(a.points, vec![1.0, 2.0]);
        assert_eq!(a.change_pct.map(f64::round), Some(-10.0));
        assert_eq!(
            a.venues
                .iter()
                .find(|v| v.issuer == "bStocks")
                .unwrap()
                .premium_bps,
            Some(1111.0)
        );
        assert_eq!(
            a.venues
                .iter()
                .find(|v| v.issuer == "xStocks")
                .unwrap()
                .error
                .as_deref(),
            Some("route not found")
        );
        assert_eq!(a.venues[1].route, vec!["pancake-v3"]);

        assert_eq!(session_at(&spark, 5), "pre");
        assert_eq!(session_at(&spark, 15), "open");
        assert_eq!(session_at(&spark, 25), "post");
        assert_eq!(session_at(&spark, 40), "closed");
    }
}

// ---------------------------------------------------------------------------
// TestStockMarket quotes: the live price, signed so the contract can trust it
// for a minute without any price ever being posted onchain.
// ---------------------------------------------------------------------------

/// How long a signed price is good for.
pub const QUOTE_TTL_SECS: u64 = 120;

fn word_u(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn address_word(address: &str) -> ApiResult<[u8; 32]> {
    let bytes = hex_decode(address.trim_start_matches("0x"))
        .filter(|b| b.len() == 20)
        .ok_or_else(|| ApiError::Other(format!("{address} is not an address")))?;
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(&bytes);
    Ok(word)
}

/// `TestStockMarket.quoteDigest`:
/// keccak256(abi.encode(chainid, market, token, keccak256(symbol), price, deadline)).
pub fn quote_digest(
    chain_id: u64,
    market: &str,
    token: &str,
    symbol: &str,
    price: u128,
    deadline: u64,
) -> ApiResult<[u8; 32]> {
    Ok(keccak256(
        &[
            word_u(chain_id as u128),
            address_word(market)?,
            address_word(token)?,
            keccak256(symbol.as_bytes()),
            word_u(price),
            word_u(deadline as u128),
        ]
        .concat(),
    ))
}

/// EIP-191 signature (r, s, v with v = 27/28) over [`quote_digest`], as 0x hex.
pub fn sign_quote(key: &SigningKey, digest: &[u8; 32]) -> ApiResult<String> {
    let prehash = keccak256(&[b"\x19Ethereum Signed Message:\n32".as_slice(), digest].concat());
    let (sig, rec) = key
        .sign_prehash_recoverable(&prehash)
        .map_err(|e| ApiError::Other(format!("quote signing failed: {e}")))?;
    let (sig, rec) = normalize_low_s(sig, rec);
    Ok(format!(
        "0x{}{:02x}",
        hex::encode(sig.to_bytes()),
        rec.to_byte() + 27
    ))
}

type RateCache = Option<(Instant, f64)>;
static EUR_USD: Lazy<Mutex<RateCache>> = Lazy::new(|| Mutex::new(None));

/// USD per EUR from Yahoo (EURUSD=X), cached for a minute. When Yahoo fails the
/// last rate is used for up to 15 minutes, so one hiccup does not stop EURC quotes.
async fn eur_usd() -> ApiResult<f64> {
    let mut cache = EUR_USD.lock().await;
    if let Some((at, rate)) = *cache {
        if at.elapsed() < Duration::from_secs(60) {
            return Ok(rate);
        }
    }
    let fetched = fetch_eur_usd().await;
    let last = cache.map(|(at, rate)| (at.elapsed(), rate));
    if let Ok(rate) = fetched {
        *cache = Some((Instant::now(), rate));
    }
    rate_or_last(last, fetched)
}

async fn fetch_eur_usd() -> ApiResult<f64> {
    let body: Value = HTTP
        .get("https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=1d&interval=5m")
        .send()
        .await?
        .json()
        .await?;
    body["chart"]["result"][0]["meta"]["regularMarketPrice"]
        .as_f64()
        .filter(|r| r.is_finite() && *r > 0.5 && *r < 2.0)
        .ok_or_else(|| ApiError::unavailable("No EUR/USD rate right now"))
}

/// The fresh rate, else the last one if it is younger than [`MAX_RATE_AGE`].
fn rate_or_last(last: Option<(Duration, f64)>, fetched: ApiResult<f64>) -> ApiResult<f64> {
    match (fetched, last) {
        (Ok(rate), _) => Ok(rate),
        (Err(err), Some((age, rate))) if age < MAX_RATE_AGE => {
            tracing::warn!(
                "[markets] EUR/USD fetch failed ({err}), using the rate from {age:?} ago"
            );
            Ok(rate)
        }
        (Err(err), _) => Err(err),
    }
}

/// The live price of `symbol` in `currency` (USDC or EURC) as a quote TestStockMarket
/// accepts until `deadline`, signed by the treasury operator key.
pub async fn signed_quote(symbol: &str, currency: &str) -> ApiResult<Value> {
    let cfg = crate::config::config();
    let market = cfg
        .stock_market_address
        .clone()
        .ok_or_else(|| ApiError::unavailable("NEXT_PUBLIC_STOCK_MARKET_ADDRESS is not set"))?;
    let key = cfg
        .treasury_secret_key
        .as_deref()
        .and_then(|k| hex_decode(k.trim_start_matches("0x")))
        .and_then(|b| SigningKey::from_slice(&b).ok())
        .ok_or_else(|| ApiError::unavailable("ARC_TREASURY_SECRET_KEY is missing or invalid"))?;
    let snapshot = snapshot().await;
    if now_millis() - snapshot.at > MAX_QUOTE_AGE_MS {
        return Err(ApiError::unavailable(
            "No live price for this stock right now",
        ));
    }
    let symbol = symbol.trim().to_uppercase();
    let asset = snapshot
        .assets
        .iter()
        .find(|a| a.ticker == symbol)
        .ok_or_else(|| ApiError::json(axum::http::StatusCode::NOT_FOUND, "Unknown stock"))?;
    let price = asset
        .price
        .filter(|p| p.is_finite() && *p > 0.0)
        .ok_or_else(|| ApiError::unavailable("No live price for this stock right now"))?;
    let currency = currency.trim().to_uppercase();
    let token = crate::config::token_address(&currency)
        .ok_or_else(|| ApiError::bad_request("currency must be USDC or EURC"))?;
    let price = if currency == "EURC" {
        price / eur_usd().await?
    } else {
        price
    };
    let price_units = (price * 1e6).round() as u128;
    let deadline = (now_millis() / 1000) as u64 + QUOTE_TTL_SECS;
    let digest = quote_digest(
        cfg.arc_chain_id,
        &market,
        &token,
        &symbol,
        price_units,
        deadline,
    )?;
    Ok(serde_json::json!({
        "symbol": symbol,
        "currency": currency,
        "token": token,
        "price": price_units.to_string(),
        "deadline": deadline,
        "signature": sign_quote(&key, &digest)?,
        "market": market,
        "chainId": cfg.arc_chain_id,
        "session": snapshot.session,
    }))
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn markets(at: i64) -> Markets {
        Markets {
            at,
            session: "open",
            quote_usd: QUOTE_USD,
            assets: Vec::new(),
        }
    }

    #[test]
    fn a_failed_fetch_keeps_the_last_good_snapshot_and_retries_soon() {
        let good = Arc::new(markets(1));
        let (kept, valid_for) = next_snapshot(Some(good.clone()), markets(2), false);
        assert!(Arc::ptr_eq(&kept, &good));
        assert_eq!(valid_for, RETRY);

        let (fresh, valid_for) = next_snapshot(Some(good), markets(3), true);
        assert_eq!((fresh.at, valid_for), (3, TTL));
        let (first, valid_for) = next_snapshot(None, markets(4), false);
        assert_eq!((first.at, valid_for), (4, RETRY));
    }

    #[test]
    fn a_failed_rate_fetch_uses_a_recent_rate_only() {
        let err = || Err(ApiError::unavailable("down"));
        let recent = Some((Duration::from_secs(120), 1.08));
        assert_eq!(rate_or_last(recent, err()).unwrap(), 1.08);
        assert_eq!(rate_or_last(recent, Ok(1.1)).unwrap(), 1.1);
        let old = Some((MAX_RATE_AGE + Duration::from_secs(1), 1.08));
        assert!(rate_or_last(old, err()).is_err());
        assert!(rate_or_last(None, err()).is_err());
    }
}

#[cfg(test)]
mod quote_tests {
    use super::*;
    use crate::eth::address_from_signing_key;
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    #[test]
    fn a_signed_quote_recovers_to_the_signer() {
        let key = SigningKey::from_slice(&[0x42u8; 32]).unwrap();
        let digest = quote_digest(
            5_042_002,
            "0x53f4cd4d13358a5d8b2e47f0bdc169c7ba9a9911",
            "0x3600000000000000000000000000000000000000",
            "GOOGL",
            285_210_000,
            1_793_990_000,
        )
        .unwrap();
        let sig = hex_decode(sign_quote(&key, &digest).unwrap().trim_start_matches("0x")).unwrap();
        let prehash =
            keccak256(&[b"\x19Ethereum Signed Message:\n32".as_slice(), &digest].concat());
        let recovered = VerifyingKey::recover_from_prehash(
            &prehash,
            &Signature::from_slice(&sig[..64]).unwrap(),
            RecoveryId::from_byte(sig[64] - 27).unwrap(),
        )
        .unwrap();
        let addr = format!(
            "0x{}",
            hex::encode(&keccak256(&recovered.to_encoded_point(false).as_bytes()[1..])[12..])
        );
        assert_eq!(
            addr.to_lowercase(),
            address_from_signing_key(&key).to_lowercase()
        );
        // A USDC price can't be paid in EURC.
        assert_ne!(
            digest,
            quote_digest(
                5_042_002,
                "0x53f4cd4d13358a5d8b2e47f0bdc169c7ba9a9911",
                "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
                "GOOGL",
                285_210_000,
                1_793_990_000
            )
            .unwrap()
        );
        // A different symbol is a different digest, so a GOOGL price can't buy NVDA.
        assert_ne!(
            digest,
            quote_digest(
                5_042_002,
                "0x53f4cd4d13358a5d8b2e47f0bdc169c7ba9a9911",
                "0x3600000000000000000000000000000000000000",
                "NVDA",
                285_210_000,
                1_793_990_000
            )
            .unwrap()
        );
    }
}

// ---------------------------------------------------------------------------
// Stock page: price history per range and company stats. Both are cached per
// stock, so one slow upstream call never holds up another stock or range.
// ---------------------------------------------------------------------------

const CHART_URL: &str = "https://query1.finance.yahoo.com/v8/finance/chart";
const NASDAQ_URL: &str = "https://api.nasdaq.com/api/quote";
/// Nasdaq answered in 1.4s to 3.4s when probed, past the 3s `CALL_TIMEOUT`.
const NASDAQ_TIMEOUT: Duration = Duration::from_secs(6);
/// The refresher keeps this cache full, so no click ever waits on Nasdaq.
const STATS_REFRESH: Duration = Duration::from_secs(3600);
const STATS_TTL: Duration = Duration::from_secs(2 * 3600);

type Slot<T> = Arc<Mutex<Option<(Instant, Arc<T>)>>>;
type Slots<K, T> = Lazy<std::sync::Mutex<HashMap<K, Slot<T>>>>;

static HISTORY: Slots<(&'static str, &'static str), History> = Lazy::new(Default::default);
static STATS: Slots<&'static str, StockStats> = Lazy::new(Default::default);

fn slot_for<K: std::hash::Hash + Eq, T>(slots: &Slots<K, T>, key: K) -> Slot<T> {
    slots
        .lock()
        .expect("markets cache lock")
        .entry(key)
        .or_default()
        .clone()
}

async fn cached<K, T, F>(slots: &Slots<K, T>, key: K, ttl: Duration, fetch: F) -> ApiResult<Arc<T>>
where
    K: std::hash::Hash + Eq,
    F: std::future::Future<Output = ApiResult<T>>,
{
    let slot = slot_for(slots, key);
    let mut entry = slot.lock().await;
    if let Some((at, value)) = entry.as_ref() {
        if at.elapsed() < ttl {
            return Ok(value.clone());
        }
    }
    let value = Arc::new(fetch.await?);
    *entry = Some((Instant::now(), value.clone()));
    Ok(value)
}

fn known_ticker(symbol: &str) -> ApiResult<&'static str> {
    let symbol = symbol.trim().to_uppercase();
    TICKERS
        .iter()
        .find(|t| **t == symbol)
        .copied()
        .ok_or_else(|| ApiError::json(axum::http::StatusCode::NOT_FOUND, "Unknown stock"))
}

/// (range, Yahoo range, Yahoo interval, cache). Yahoo serves `max` as monthly
/// bars even when asked for weekly.
const RANGES: &[(&str, &str, &str, u64)] = &[
    ("1D", "1d", "5m", 60),
    ("1W", "5d", "30m", 300),
    ("1M", "1mo", "1d", 900),
    ("1Y", "1y", "1d", 900),
    ("ALL", "max", "1mo", 3600),
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Point {
    pub t: i64,
    pub c: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub ticker: &'static str,
    pub range: &'static str,
    pub price: f64,
    /// The close before the range starts, so 1D change is against yesterday.
    pub base: f64,
    pub change_pct: f64,
    pub day_high: Option<f64>,
    pub day_low: Option<f64>,
    pub year_high: Option<f64>,
    pub year_low: Option<f64>,
    pub volume: Option<f64>,
    pub points: Vec<Point>,
}

fn positive(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
}

fn parse_history(body: &Value, ticker: &'static str, range: &'static str) -> Option<History> {
    let result = body.pointer("/chart/result/0")?;
    let meta = result.get("meta")?;
    let price = positive(meta.get("regularMarketPrice"))?;
    let empty = Vec::new();
    let times = result
        .get("timestamp")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let closes = result
        .pointer("/indicators/quote/0/close")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let points: Vec<Point> = times
        .iter()
        .zip(closes)
        .filter_map(|(t, c)| {
            Some(Point {
                t: t.as_i64()?,
                c: positive(Some(c))?,
            })
        })
        .collect();
    let base = positive(meta.get("chartPreviousClose"))
        .or_else(|| points.first().map(|p| p.c))
        .unwrap_or(price);
    Some(History {
        ticker,
        range,
        price,
        base,
        change_pct: (price / base - 1.0) * 100.0,
        day_high: positive(meta.get("regularMarketDayHigh")),
        day_low: positive(meta.get("regularMarketDayLow")),
        year_high: positive(meta.get("fiftyTwoWeekHigh")),
        year_low: positive(meta.get("fiftyTwoWeekLow")),
        volume: positive(meta.get("regularMarketVolume")),
        points,
    })
}

/// `range` is one of `RANGES`. Failures are not cached, so the next call retries.
pub async fn history(symbol: &str, range: &str) -> ApiResult<Arc<History>> {
    let ticker = known_ticker(symbol)?;
    let range = range.trim().to_uppercase();
    let &(range, yahoo_range, interval, ttl) = RANGES
        .iter()
        .find(|r| r.0 == range)
        .ok_or_else(|| ApiError::bad_request("range must be 1D, 1W, 1M, 1Y or ALL"))?;
    cached(
        &HISTORY,
        (ticker, range),
        Duration::from_secs(ttl),
        async move {
            let unavailable = || ApiError::unavailable(format!("No {ticker} chart right now"));
            let res = HTTP
                .get(format!("{CHART_URL}/{ticker}"))
                .query(&[("range", yahoo_range), ("interval", interval)])
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|err| {
                    tracing::warn!(
                        "[markets] {ticker} {range} chart failed: {}",
                        err.without_url()
                    );
                    unavailable()
                })?;
            let body: Value = res.json().await.map_err(|_| unavailable())?;
            parse_history(&body, ticker, range).ok_or_else(unavailable)
        },
    )
    .await
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StockStats {
    pub sector: Option<String>,
    pub industry: Option<String>,
    pub market_cap: Option<f64>,
    pub average_volume: Option<f64>,
    pub dividend_yield: Option<String>,
    pub ex_dividend_date: Option<String>,
    pub expense_ratio: Option<String>,
}

fn parse_stats(body: &Value) -> Option<StockStats> {
    let data = body.pointer("/data/summaryData")?.as_object()?;
    let text = |key: &str| {
        data.get(key)?
            .get("value")?
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty() && *v != "N/A")
            .map(str::to_string)
    };
    let number = |key: &str| text(key)?.replace(',', "").parse::<f64>().ok();
    Some(StockStats {
        sector: text("Sector"),
        industry: text("Industry"),
        market_cap: number("MarketCap"),
        average_volume: number("AverageVolume").or_else(|| number("AvgDailyVol65Days")),
        dividend_yield: text("Yield"),
        ex_dividend_date: text("ExDividendDate"),
        expense_ratio: text("ExpenseRatio"),
    })
}

async fn fetch_stats(ticker: &'static str) -> ApiResult<StockStats> {
    let unavailable = || ApiError::unavailable(format!("No {ticker} stats right now"));
    let class = if ticker == "SPY" { "etf" } else { "stocks" };
    let res = HTTP
        .get(format!("{NASDAQ_URL}/{ticker}/summary"))
        .query(&[("assetclass", class)])
        .header("Accept", "application/json")
        .header("Origin", "https://www.nasdaq.com")
        .header("Referer", "https://www.nasdaq.com/")
        .timeout(NASDAQ_TIMEOUT)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|err| {
            tracing::warn!("[markets] {ticker} stats failed: {}", err.without_url());
            unavailable()
        })?;
    let body: Value = res.json().await.map_err(|_| unavailable())?;
    parse_stats(&body).ok_or_else(unavailable)
}

pub async fn stats(symbol: &str) -> ApiResult<Arc<StockStats>> {
    let ticker = known_ticker(symbol)?;
    cached(&STATS, ticker, STATS_TTL, fetch_stats(ticker)).await
}

/// One stock at a time, so Nasdaq sees a browser's worth of traffic. A failed
/// refresh keeps the old value until `STATS_TTL`, then `stats` reports the error.
pub async fn run_stats_refresher() {
    loop {
        for &ticker in TICKERS {
            if let Ok(fresh) = fetch_stats(ticker).await {
                *slot_for(&STATS, ticker).lock().await = Some((Instant::now(), Arc::new(fresh)));
            }
        }
        tokio::time::sleep(STATS_REFRESH).await;
    }
}

#[cfg(test)]
mod stock_page_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_drops_bad_bars_and_measures_from_the_previous_close() {
        let body = json!({"chart":{"result":[{
            "meta":{"regularMarketPrice":110.0,"chartPreviousClose":100.0,"fiftyTwoWeekHigh":120.0},
            "timestamp":[1,2,3,4],
            "indicators":{"quote":[{"close":[105.0,null,-1.0,110.0]}]}}]}});
        let h = parse_history(&body, "NVDA", "1D").unwrap();
        assert_eq!(
            h.points,
            vec![Point { t: 1, c: 105.0 }, Point { t: 4, c: 110.0 }]
        );
        assert_eq!(h.base, 100.0);
        assert_eq!(h.change_pct.round(), 10.0);
        assert_eq!(h.year_high, Some(120.0));
        assert_eq!(h.year_low, None);
        assert!(parse_history(&json!({"chart":{"result":null}}), "NVDA", "1D").is_none());
    }

    #[test]
    fn stats_read_nasdaq_values_and_treat_na_as_missing() {
        let body = json!({"data":{"summaryData":{
            "Sector":{"value":"Technology"},
            "MarketCap":{"value":"4,511,279,000,000"},
            "AvgDailyVol65Days":{"value":"42,332,371"},
            "Yield":{"value":"N/A"}}}});
        let s = parse_stats(&body).unwrap();
        assert_eq!(s.sector.as_deref(), Some("Technology"));
        assert_eq!(s.market_cap, Some(4_511_279_000_000.0));
        assert_eq!(s.average_volume, Some(42_332_371.0));
        assert_eq!(s.dividend_yield, None);
    }

    #[test]
    fn unknown_stocks_are_rejected_before_any_upstream_call() {
        assert!(known_ticker("../../etc").is_err());
        assert_eq!(known_ticker(" nvda ").unwrap(), "NVDA");
    }
}
