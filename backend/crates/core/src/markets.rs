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

const SPARK_URL: &str = "https://query2.finance.yahoo.com/v7/finance/spark";
const KYBER_URL: &str = "https://aggregator-api.kyberswap.com/bsc/api/v1/routes";
const USDT_BSC: &str = "0x55d398326f99059fF775485246999027B3197955";
/// Every wrapper below uses 18 decimals, as does BSC USDT.
const DECIMALS: f64 = 1e18;
pub const QUOTE_USD: u32 = 100;
const TTL: Duration = Duration::from_secs(30);
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

type Cached = Option<(Instant, Arc<Markets>)>;
static CACHE: Lazy<Mutex<Cached>> = Lazy::new(|| Mutex::new(None));

/// Cached for 30s. The lock is held through a refresh, so concurrent callers
/// share one upstream fetch instead of each firing 18 requests.
pub async fn snapshot() -> Arc<Markets> {
    let mut cache = CACHE.lock().await;
    if let Some((at, markets)) = cache.as_ref() {
        if at.elapsed() < TTL {
            return markets.clone();
        }
    }
    let markets = Arc::new(fetch().await);
    *cache = Some((Instant::now(), markets.clone()));
    markets
}

async fn fetch() -> Markets {
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
    Markets {
        at: now,
        session,
        quote_usd: QUOTE_USD,
        assets,
    }
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
