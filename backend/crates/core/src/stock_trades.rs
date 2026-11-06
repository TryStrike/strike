//! Indexes TestStockMarket's `Bought` and `Sold` events into SQLite. Arc's RPC
//! serves 1,000 blocks per `eth_getLogs`, so history cannot be read on demand:
//! this follows the chain from a saved cursor and History reads the table.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use crate::address::{canonical, is_address_shape, keccak256};
use crate::config::{config, token_address};
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::eth::{hex_decode, parse_data_word, Rpc};

/// `contracts/deployments/arc-5042002.json`: nothing older can hold a trade.
const DEPLOY_BLOCK: u64 = 71_068_455;
const MAX_SPAN: u64 = 1_000;
const POLL: Duration = Duration::from_secs(3);
/// Serves `eth_getLogs` far more often than the other public host when both throttle.
const LOGS_RPC: &str = "https://rpc.testnet.arc.network";
const MAX_ROWS: i64 = 200;

fn topic(signature: &str) -> String {
    format!("0x{}", hex::encode(keccak256(signature.as_bytes())))
}

fn bought() -> String {
    topic("Bought(address,address,string,uint256,uint256,uint256)")
}

fn sold() -> String {
    topic("Sold(address,address,string,uint256,uint256,uint256)")
}

#[derive(Debug, PartialEq)]
struct Trade {
    tx_hash: String,
    log_index: u64,
    block: u64,
    wallet: String,
    token: String,
    side: &'static str,
    symbol: String,
    amount: u128,
    shares: u128,
    price: u128,
}

fn quantity(value: Option<&Value>) -> Option<u64> {
    u64::from_str_radix(value?.as_str()?.strip_prefix("0x")?, 16).ok()
}

/// Both events carry the string's offset, then three words: USDC in and shares
/// out for a buy, shares in and USDC out for a sell, then the price.
fn parse_log(log: &Value) -> Option<Trade> {
    let topics = log.get("topics")?.as_array()?;
    let event = topics.first()?.as_str()?;
    let side = if event.eq_ignore_ascii_case(&bought()) {
        "buy"
    } else if event.eq_ignore_ascii_case(&sold()) {
        "sell"
    } else {
        return None;
    };
    let address = |t: &Value| Some(canonical(&format!("0x{}", t.as_str()?.get(26..)?)));
    let data = log.get("data")?.as_str()?.strip_prefix("0x")?;
    let word = |i: usize| parse_data_word(&format!("0x{}", data.get(i * 64..(i + 1) * 64)?));
    let (first, second) = (word(1)?, word(2)?);
    let (amount, shares) = if side == "buy" {
        (first, second)
    } else {
        (second, first)
    };
    let start = usize::try_from(word(0)?).ok()? / 32;
    let length = usize::try_from(word(start)?).ok()?;
    let text = data.get((start + 1) * 64..(start + 1) * 64 + length * 2)?;
    Some(Trade {
        tx_hash: log.get("transactionHash")?.as_str()?.to_lowercase(),
        log_index: quantity(log.get("logIndex"))?,
        block: quantity(log.get("blockNumber"))?,
        wallet: address(topics.get(1)?)?,
        token: address(topics.get(2)?)?,
        side,
        symbol: String::from_utf8(hex_decode(text)?).ok()?,
        amount,
        shares,
        price: word(3)?,
    })
}

fn currency(token: &str) -> Option<&'static str> {
    ["USDC", "EURC"]
        .into_iter()
        .find(|c| token_address(c).is_some_and(|a| canonical(&a) == token))
}

async fn block_time(rpc: &Rpc, block: u64, seen: &mut HashMap<u64, u64>) -> ApiResult<u64> {
    if let Some(at) = seen.get(&block) {
        return Ok(*at);
    }
    let found = rpc
        .call(
            "eth_getBlockByNumber",
            json!([format!("0x{block:x}"), false]),
        )
        .await?;
    let at = quantity(found.get("timestamp"))
        .ok_or_else(|| ApiError::Other(format!("block {block} has no timestamp")))?;
    seen.insert(block, at);
    Ok(at)
}

async fn save(trade: &Trade, currency: &str, at: u64) -> ApiResult<()> {
    db::execute(
        "INSERT INTO stock_trades (tx_hash, log_index, block, traded_at, wallet, side, symbol, \
         currency, total, shares, quote) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
         ON CONFLICT (tx_hash, log_index) DO NOTHING",
        &[
            ("text", &json!(trade.tx_hash)),
            ("bigint", &json!(trade.log_index)),
            ("bigint", &json!(trade.block)),
            ("bigint", &json!(at)),
            ("text", &json!(trade.wallet)),
            ("text", &json!(trade.side)),
            ("text", &json!(trade.symbol)),
            ("text", &json!(currency)),
            ("bigint", &json!(trade.amount as u64)),
            ("bigint", &json!(trade.shares as u64)),
            ("bigint", &json!(trade.price as u64)),
        ],
    )
    .await?;
    Ok(())
}

/// Reads up to the chain head. The cursor moves only after a span is saved, and
/// a saved trade is ignored the second time, so a failure just repeats the span.
async fn catch_up(rpc: &Rpc, market: &str) -> ApiResult<()> {
    let cursor = db::fetch_one("SELECT block FROM stock_trade_cursor WHERE id = 1", &[])
        .await?
        .and_then(|row| row.get("block").and_then(Value::as_u64));
    let mut from = cursor.map_or(DEPLOY_BLOCK, |b| b + 1);
    let head = rpc.call("eth_blockNumber", json!([])).await?;
    let head = quantity(Some(&head)).ok_or_else(|| ApiError::Other("bad block number".into()))?;
    let mut seen = HashMap::new();
    while from <= head {
        let to = (from + MAX_SPAN - 1).min(head);
        let logs = rpc
            .get_logs(json!({
                "address": market,
                "fromBlock": format!("0x{from:x}"),
                "toBlock": format!("0x{to:x}"),
                "topics": [[bought(), sold()]],
            }))
            .await?;
        for log in &logs {
            let trade = parse_log(log)
                .ok_or_else(|| ApiError::Other(format!("unreadable stock trade log: {log}")))?;
            let currency = currency(&trade.token)
                .ok_or_else(|| ApiError::Other(format!("unknown token {}", trade.token)))?;
            let at = block_time(rpc, trade.block, &mut seen).await?;
            save(&trade, currency, at).await?;
        }
        db::execute(
            "INSERT INTO stock_trade_cursor (id, block) VALUES (1, $1) \
             ON CONFLICT (id) DO UPDATE SET block = excluded.block",
            &[("bigint", &json!(to))],
        )
        .await?;
        from = to + 1;
    }
    Ok(())
}

pub async fn run() {
    let Some(market) = config().stock_market_address.clone() else {
        tracing::info!("[stock trades] no market address, nothing to index");
        return;
    };
    let hosts = [
        Rpc::new(LOGS_RPC.to_string(), config().arc_chain_id),
        Rpc::from_config(),
    ];
    let mut host = 0;
    loop {
        if let Err(err) = catch_up(&hosts[host], &market).await {
            tracing::debug!("[stock trades] retrying on the next host: {err}");
            host = (host + 1) % hosts.len();
        }
        tokio::time::sleep(POLL).await;
    }
}

pub async fn for_wallet(wallet: &str) -> ApiResult<Vec<Value>> {
    let wallet = canonical(wallet);
    if !is_address_shape(&wallet) {
        return Err(ApiError::bad_request("wallet must be a 0x address"));
    }
    db::fetch(
        "SELECT tx_hash AS \"txHash\", block, traded_at AS \"tradedAt\", side, symbol, currency, \
         total, shares, quote AS price FROM stock_trades WHERE wallet = $1 \
         ORDER BY block DESC, log_index DESC LIMIT $2",
        &[("text", &json!(wallet)), ("bigint", &json!(MAX_ROWS))],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(v: u128) -> String {
        format!("{v:064x}")
    }

    fn log(event: String, first: u128, second: u128) -> Value {
        let symbol = hex::encode("NVDA");
        let data = format!(
            "0x{}{}{}{}{}{symbol:0<64}",
            word(128),
            word(first),
            word(second),
            word(188_150_000),
            word(4),
        );
        json!({
            "topics": [event, format!("0x{:0>64}", "ab".repeat(20)), format!("0x{:0>64}", "cd".repeat(20))],
            "data": data,
            "transactionHash": "0xABC",
            "logIndex": "0x2",
            "blockNumber": "0x10",
        })
    }

    #[test]
    fn buys_and_sells_read_their_words_in_the_right_order() {
        let buy = parse_log(&log(bought(), 5_000_000, 26_574)).unwrap();
        assert_eq!(buy.side, "buy");
        assert_eq!(buy.symbol, "NVDA");
        assert_eq!((buy.amount, buy.shares), (5_000_000, 26_574));
        assert_eq!(buy.wallet, format!("0x{}", "ab".repeat(20)));
        assert_eq!(buy.price, 188_150_000);
        assert_eq!((buy.block, buy.log_index), (16, 2));

        let sell = parse_log(&log(sold(), 26_574, 5_000_000)).unwrap();
        assert_eq!(sell.side, "sell");
        assert_eq!((sell.amount, sell.shares), (5_000_000, 26_574));
    }

    #[test]
    fn a_foreign_event_or_short_data_is_not_a_trade() {
        assert!(parse_log(&log(topic("Other()"), 1, 1)).is_none());
        let mut cut = log(bought(), 1, 1);
        cut["data"] = json!("0x00");
        assert!(parse_log(&cut).is_none());
    }
}
