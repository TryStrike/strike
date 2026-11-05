//! Live on-chain view of the treasury contract (`app/api/arc/treasury/route.ts`).
//!
//! The landing page polls this, so it is read straight from the Arc RPC and
//! CDN-cached briefly. Everything that can be decided without a socket — the
//! block window, the log filters, decoding a `Transfer` into a row, the ordering
//! and the cap — is a pure function below, so the shape of the panel is testable
//! without a node.

use serde_json::{json, Map, Value};

use crate::address::{is_address, to_checksum};
use crate::config::config;
use crate::error::ApiResult;
use crate::eth::{self, Rpc};

/// Arc's RPC caps `eth_getLogs` at a 5,000-block range (roughly the last hour),
/// so the window is one block shorter than the cap.
pub const LOOKBACK_BLOCKS: u64 = 4_900;

/// Rows the panel shows, newest block first.
pub const EVENT_LIMIT: usize = 6;

/// The route's CDN headers: short-lived, but revalidated in the background so a
/// slow RPC never blanks the landing page.
pub const TREASURY_CACHE_CONTROL: &str = "public, s-maxage=10, stale-while-revalidate=60";

pub const TREASURY_NOT_CONFIGURED_BODY: &str = "{\"error\":\"Treasury not configured\"}";
pub const RPC_UNAVAILABLE_BODY: &str = "{\"error\":\"Arc RPC unavailable\"}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferKind {
    /// Tokens arriving at the treasury: the player's deposit.
    Deposit,
    /// Tokens leaving the treasury: a payout.
    Payout,
}

impl TransferKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deposit => "deposit",
            Self::Payout => "payout",
        }
    }

    /// Which indexed topic holds the counterparty: `from` for an inflow, `to`
    /// for an outflow.
    fn counterparty_topic(self) -> usize {
        match self {
            Self::Deposit => 1,
            Self::Payout => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransferEvent {
    pub kind: TransferKind,
    pub amount: f64,
    pub counterparty: String,
    pub tx_hash: String,
    pub block: u64,
}

impl TransferEvent {
    fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), json!(self.kind.as_str()));
        map.insert("amount".into(), crate::prices::number_to_value(self.amount));
        map.insert("counterparty".into(), json!(self.counterparty));
        map.insert("txHash".into(), json!(self.tx_hash));
        map.insert("block".into(), json!(self.block));
        Value::Object(map)
    }
}

/// `Math.max(0, head - LOOKBACK_BLOCKS)` paired with the head itself.
pub fn block_range(head: u64) -> (u64, u64) {
    (head.saturating_sub(LOOKBACK_BLOCKS), head)
}

fn hex_quantity(value: u64) -> String {
    format!("0x{value:x}")
}

/// The `eth_getLogs` filter for one direction. A deposit read pins the
/// *recipient* topic and leaves the sender wildcarded; a payout pins the sender.
pub fn transfer_filter(usdc: &str, from: u64, to: u64, kind: TransferKind, padded: &str) -> Value {
    let topics = match kind {
        // `[TRANSFER, null, treasury]` — anything into the treasury.
        TransferKind::Deposit => json!([eth::transfer_topic_hex(), Value::Null, padded]),
        // `[TRANSFER, treasury]` — anything out of it (topic prefix match).
        TransferKind::Payout => json!([eth::transfer_topic_hex(), padded]),
    };
    json!({
        "address": to_checksum(usdc),
        "fromBlock": hex_quantity(from),
        "toBlock": hex_quantity(to),
        "topics": topics,
    })
}

/// A log's `data` field: a 32-byte left-padded word, not an `eth_getLogs`
/// quantity. `eth::parse_quantity` refuses 64 hex digits on purpose, so the
/// leading zeros come off first; a word with more significant digits than a
/// u128 cannot be a USDC amount and yields no row.
fn parse_data_word(raw: &str) -> Option<u128> {
    let trimmed = raw.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))?
        .trim_start_matches('0');
    if hex.is_empty() {
        return Some(0);
    }
    if hex.len() > 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u128::from_str_radix(hex, 16).ok()
}

/// One RPC log entry decoded. Anything the chain did not actually record (a
/// short topic list, a missing transaction hash, an unparsable block) yields no
/// row rather than a row of zeros: the panel would otherwise display a transfer
/// that never happened.
pub fn parse_transfer_log(log: &Value, kind: TransferKind, decimals: u32) -> Option<TransferEvent> {    let topics = log.get("topics")?.as_array()?;
    let needed = kind.counterparty_topic();
    if topics.len() <= needed {
        return None;
    }
    let counterparty_topic = topics[needed].as_str()?;
    let counterparty = eth::topic_to_address(counterparty_topic);
    if counterparty.is_empty() {
        return None;
    }
    let raw_data = log.get("data").and_then(Value::as_str).unwrap_or("0x0");
    let amount_raw = parse_data_word(raw_data)?;
    let tx_hash = log.get("transactionHash").and_then(Value::as_str)?;
    let block = eth::parse_quantity(
        log.get("blockNumber").and_then(Value::as_str).unwrap_or_default(),
    )? as u64;

    Some(TransferEvent {
        kind,
        amount: eth::format_units(amount_raw, decimals),
        counterparty,
        tx_hash: tx_hash.to_string(),
        block,
    })
}

pub fn parse_transfer_logs(logs: &[Value], kind: TransferKind, decimals: u32) -> Vec<TransferEvent> {
    logs.iter()
        .filter_map(|log| parse_transfer_log(log, kind, decimals))
        .collect()
}

/// Deposits first, then payouts, ordered by descending block and truncated.
/// The sort is stable, so two events in the same block keep that order — the
/// TypeScript relied on the same property of `Array.prototype.sort`.
pub fn top_events(deposits: &[TransferEvent], payouts: &[TransferEvent], limit: usize) -> Vec<TransferEvent> {
    let mut all = deposits.to_vec();
    all.extend_from_slice(payouts);
    all.sort_by(|a, b| b.block.cmp(&a.block));
    all.truncate(limit);
    all
}

/// The whole panel as the route serialises it. `address` is the configured
/// string, not a re-derived checksum: the page compares it with what it already
/// knows and a re-cased copy would read as a different treasury.
pub fn treasury_view_json(treasury: &str, balance: f64, events: &[TransferEvent]) -> String {
    let rows: Vec<Value> = events.iter().map(TransferEvent::to_value).collect();
    let mut map = Map::new();
    map.insert("address".into(), json!(treasury));
    map.insert("chainId".into(), json!(config().arc_chain_id));
    map.insert("explorer".into(), json!(config().arc_explorer));
    map.insert("balance".into(), crate::prices::number_to_value(balance));
    map.insert("events".into(), Value::Array(rows));
    Value::Object(map).to_string()
}

/// `balanceOf(treasury)` calldata on the USDC token.
pub fn balance_of_calldata(contract: &str) -> String {
    let addr_hex = contract.strip_prefix("0x").unwrap_or(contract).to_lowercase();
    let mut data = eth::selector("balanceOf(address)").to_vec();
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&hex::decode(&addr_hex).unwrap_or_default());
    format!("0x{}", hex::encode(data))
}

/// `GET /api/arc/treasury`. Errors are the route's two fixed bodies; nothing
/// about the RPC is echoed to the browser.
pub async fn treasury_view() -> ApiResult<(u16, String)> {
    let cfg = config();
    let treasury = cfg.treasury_address.clone();
    if !is_address(&treasury) {
        return Ok((503, TREASURY_NOT_CONFIGURED_BODY.to_string()));
    }

    let padded = eth::pad_topic(&treasury);
    if padded.is_empty() {
        return Ok((503, TREASURY_NOT_CONFIGURED_BODY.to_string()));
    }

    let rpc = Rpc::from_config();
    let usdc = cfg.arc_usdc.clone();
    let decimals = crate::config::USDC_DECIMALS;

    let result: ApiResult<String> = async {
        let head = rpc.latest_block_number().await?;
        let (from, to) = block_range(head);
        let balance_calldata = balance_of_calldata(&treasury);
        let balance_call = rpc.call_uint256(&usdc, &balance_calldata);
        let deposits_call =
            rpc.get_logs(transfer_filter(&usdc, from, to, TransferKind::Deposit, &padded));
        let payouts_call =
            rpc.get_logs(transfer_filter(&usdc, from, to, TransferKind::Payout, &padded));
        // One round trip for all three reads, as the route's `Promise.all` did:
        // the panel is on the landing page and a serial walk would triple its
        // worst-case latency.
        let (balance, deposit_logs, payout_logs) =
            tokio::join!(balance_call, deposits_call, payouts_call);

        let events = top_events(
            &parse_transfer_logs(&deposit_logs?, TransferKind::Deposit, decimals),
            &parse_transfer_logs(&payout_logs?, TransferKind::Payout, decimals),
            EVENT_LIMIT,
        );
        Ok(treasury_view_json(
            &treasury,
            eth::format_units(balance?, decimals),
            &events,
        ))
    }
    .await;

    match result {
        Ok(body) => Ok((200, body)),
        Err(err) => {
            tracing::warn!("[arc/treasury] RPC read failed: {err}");
            Ok((502, RPC_UNAVAILABLE_BODY.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TREASURY: &str = "0xd1220A0Cf47c7B9be7A2E6Ba89F429762B72dB5B";

    fn log(topics: Vec<&str>, data: &str, hash: &str, block: &str) -> Value {
        json!({
            "address": "0x3600000000000000000000000000000000000000",
            "topics": topics,
            "data": data,
            "transactionHash": hash,
            "blockNumber": block,
        })
    }

    fn topic(addr: &str) -> String {
        eth::pad_topic(addr)
    }

    #[test]
    fn window_is_capped_and_never_negative() {
        assert_eq!(block_range(100_000), (95_100, 100_000));
        assert_eq!(block_range(10), (0, 10), "a chain younger than the lookback");
        assert_eq!(LOOKBACK_BLOCKS, 4_900);
        assert_eq!(EVENT_LIMIT, 6);
    }

    #[test]
    fn filters_wildcard_the_unknown_side_of_the_transfer() {
        let deposits = transfer_filter("0x3600000000000000000000000000000000000000", 900, 1_000, TransferKind::Deposit, "0xpadded");
        assert_eq!(deposits["topics"].as_array().unwrap().len(), 3);
        assert!(deposits["topics"][1].is_null(), "the sender is any address");
        assert_eq!(deposits["fromBlock"], "0x384");
        assert_eq!(deposits["toBlock"], "0x3e8");

        let payouts = transfer_filter("0x3600000000000000000000000000000000000000", 900, 1_000, TransferKind::Payout, "0xpadded");
        assert_eq!(payouts["topics"].as_array().unwrap().len(), 2, "recipient stays wildcarded");
        assert_eq!(payouts["topics"][1], "0xpadded");
    }

    #[test]
    fn padding_is_a_left_padded_lowercase_word() {
        let padded = topic(TREASURY);
        assert_eq!(padded.len(), 66);
        assert!(padded.starts_with("0x000000000000000000000000"));
        assert_eq!(padded, format!("0x{}{}", "0".repeat(24), TREASURY[2..].to_lowercase()));
        assert_eq!(topic("not-an-address"), "");
    }

    #[test]
    fn a_deposit_reads_the_sender_and_a_payout_the_recipient() {
        let player = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
        let deposit = log(
            vec!["t0", &topic(player), &topic(TREASURY)],
            "0x0000000000000000000000000000000000000000000000000000000000989680",
            "0xabc",
            "0x64",
        );
        let events = parse_transfer_logs(&[deposit], TransferKind::Deposit, 6);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].counterparty, to_checksum(player));
        assert_eq!(events[0].amount, 10.0, "1_000_000 units at 6 decimals");
        assert_eq!(events[0].block, 100);
        assert_eq!(events[0].kind, TransferKind::Deposit);

        let payout = log(
            vec!["t0", &topic(TREASURY), &topic(player)],
            "0x00000000000000000000000000000000000000000000000000000000000f4240",
            "0xdef",
            "0x1",
        );
        let events = parse_transfer_logs(&[payout], TransferKind::Payout, 6);
        assert_eq!(events[0].counterparty, to_checksum(player));
        assert_eq!(events[0].amount, 1.0);
    }

    #[test]
    fn malformed_logs_produce_no_row() {
        // A log missing the counterparty topic, the hash, or a parsable block
        // must not be shown as a transfer of zero at block zero.
        let missing_topic = log(vec!["t0", "0xshort"], "0x1", "0xabc", "0x1");
        assert!(parse_transfer_logs(&[missing_topic], TransferKind::Deposit, 6).is_empty());

        let no_hash = log(
            vec!["t0", &topic(TREASURY), &topic(TREASURY)],
            "0x1",
            "",
            "0x1",
        );
        // An empty hash is still a hash field; a missing one is not a log.
        assert_eq!(parse_transfer_logs(&[no_hash], TransferKind::Deposit, 6).len(), 1);
        let absent = json!({ "topics": [&topic(TREASURY), &topic(TREASURY)], "data": "0x1", "blockNumber": "0x1" });
        assert!(parse_transfer_logs(&[absent], TransferKind::Deposit, 6).is_empty());

        let no_block = log(vec!["t0", "0x0", "0x0"], "0x1", "0xabc", "not-hex");
        assert!(parse_transfer_logs(&[no_block], TransferKind::Deposit, 6).is_empty());
    }

    #[test]
    fn newest_blocks_win_and_deposits_lead_within_a_block() {
        let player = &topic("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
        let treasury = &topic(TREASURY);
        let deposits = parse_transfer_logs(
            &[
                log(vec!["t0", player, treasury], "0x1", "0xd1", "0x5"),
                log(vec!["t0", player, treasury], "0x2", "0xd2", "0xa"),
            ],
            TransferKind::Deposit,
            6,
        );
        let payouts = parse_transfer_logs(
            &[log(vec!["t0", treasury, player], "0x3", "0xp1", "0xa")],
            TransferKind::Payout,
            6,
        );

        let top = top_events(&deposits, &payouts, 6);
        assert_eq!(
            top.iter().map(|e| e.tx_hash.as_str()).collect::<Vec<_>>(),
            vec!["0xd2", "0xp1", "0xd1"],
            "block 10 first, and the deposit listed before the payout inside it"
        );

        assert_eq!(top_events(&deposits, &payouts, 2).len(), 2, "the cap is enforced");
        assert!(top_events(&[], &[], 6).is_empty());
    }

    #[test]
    fn panel_keys_match_the_ts_response() {
        let body = treasury_view_json(TREASURY, 1234.5, &[]);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["address"], TREASURY, "never re-cased");
        assert_eq!(parsed["balance"], 1234.5);
        assert!(parsed["events"].is_array());
        for key in ["address", "chainId", "explorer", "balance", "events"] {
            assert!(parsed.get(key).is_some(), "missing {key}");
        }
        // The keys the player sees for a row.
        let events = vec![TransferEvent {
            kind: TransferKind::Deposit,
            amount: 10.0,
            counterparty: to_checksum(TREASURY),
            tx_hash: "0xabc".into(),
            block: 3,
        }];
        let parsed: Value =
            serde_json::from_str(&treasury_view_json(TREASURY, 0.0, &events)).unwrap();
        let row = &parsed["events"][0];
        for key in ["type", "amount", "counterparty", "txHash", "block"] {
            assert!(row.get(key).is_some(), "missing row key {key}");
        }
        assert_eq!(row["type"], "deposit");
    }

    #[test]
    fn cache_and_error_bodies_are_the_routes_own() {
        assert_eq!(TREASURY_CACHE_CONTROL, "public, s-maxage=10, stale-while-revalidate=60");
        assert_eq!(TREASURY_NOT_CONFIGURED_BODY, "{\"error\":\"Treasury not configured\"}");
        assert_eq!(RPC_UNAVAILABLE_BODY, "{\"error\":\"Arc RPC unavailable\"}");
    }
}
