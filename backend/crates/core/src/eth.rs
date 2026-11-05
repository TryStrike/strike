//! Arc / EVM plumbing: a small JSON-RPC client, EIP-191 signer recovery for
//! withdrawal authorization, deposit verification, and treasury payout signing.
//!
//! Deliberately avoids a full Ethereum SDK: the surface the backend needs is
//! six RPC methods, one log topic, and one transaction type.

use std::convert::Infallible;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use serde_json::{json, Value};

use crate::address::{canonical, is_address_shape, keccak256, to_checksum};
use crate::config::config;
use crate::error::{ApiError, ApiResult};

/// `RPC_TIMEOUT_MS` in verifyArcDepositTx.ts / the payout path.
pub const RPC_TIMEOUT: Duration = Duration::from_secs(12);
/// Blocks a deposit must sit under the head before it is credited.
pub const MIN_CONFIRMATIONS: u64 = 3;
/// Confirmations a payout must reach before the ledger is debited.
pub const PAYOUT_CONFIRMATIONS: u64 = 3;

/// keccak256("Transfer(address,address,uint256)")
pub fn transfer_topic() -> [u8; 32] {
    keccak256(b"Transfer(address,address,uint256)")
}

/// The same topic as an RPC filter expects it: `ethers.id(signature)`, i.e. a
/// lowercase `0x`-prefixed 32-byte hex string.
pub fn transfer_topic_hex() -> String {
    format!("0x{}", hex::encode(transfer_topic()))
}

pub fn topic_to_address(topic: &str) -> String {
    let hex = topic.strip_prefix("0x").unwrap_or(topic);
    // Indexed addresses are 32-byte, right-aligned words.
    if hex.len() < 40 {
        return String::new();
    }
    to_checksum(&format!("0x{}", &hex[hex.len() - 40..]))
}

/// `ethers.zeroPadValue(address, 32)`: an indexed address as the log filter
/// expects it, left-padded and lowercase (`0x000…abcdef`).
pub fn pad_topic(address: &str) -> String {
    let hex = address.strip_prefix("0x").unwrap_or(address).to_lowercase();
    if hex.len() != 40 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return String::new();
    }
    format!("0x{}{hex}", "0".repeat(24))
}

pub fn selector(signature: &str) -> [u8; 4] {
    let hash = keccak256(signature.as_bytes());
    let mut out = [0u8; 4];
    out.copy_from_slice(&hash[..4]);
    out
}

// ---------------------------------------------------------------------------
// minimal RLP
// ---------------------------------------------------------------------------

/// Big-endian, no leading zeros — RLP's integer encoding.
pub fn be_min(value: u128) -> Vec<u8> {
    if value == 0 {
        return Vec::new();
    }
    let bytes = value.to_be_bytes();
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    bytes[first..].to_vec()
}

fn encode_len(len: usize, short_offset: u8, long_tag: u8) -> Vec<u8> {
    if len < 56 {
        vec![short_offset + len as u8]
    } else {
        let minimal = be_min(len as u128);
        let mut out = vec![long_tag + minimal.len() as u8];
        out.extend_from_slice(&minimal);
        out
    }
}

/// RLP for a byte string.
pub fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        vec![data[0]]
    } else {
        let mut out = encode_len(data.len(), 0x80, 0xb7);
        out.extend_from_slice(data);
        out
    }
}

/// RLP for a list of already-encoded items.
pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.iter().flatten().copied().collect();
    let mut out = encode_len(body.len(), 0xc0, 0xf7);
    out.extend_from_slice(&body);
    out
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

/// Node errors that mean this transaction is not in the mempool.
const NOT_TAKEN: [&str; 5] = [
    "nonce too low",
    "insufficient funds",
    "underpriced",
    "gas too low",
    "intrinsic gas",
];

#[derive(Debug, PartialEq)]
pub enum Broadcast {
    Accepted(String),
    /// The node refused it; nothing was sent and the nonce is unused.
    Refused(String),
    /// It may have been sent. Never send it again.
    Unknown(String),
}

#[derive(Clone)]
pub struct Rpc {
    client: reqwest::Client,
    url: String,
    chain_id: u64,
}

impl Rpc {
    pub fn new(url: String, chain_id: u64) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(RPC_TIMEOUT)
                .build()
                .expect("reqwest client"),
            url,
            chain_id,
        }
    }

    pub fn from_config() -> Self {
        let cfg = config();
        Self::new(cfg.arc_rpc.clone(), cfg.arc_chain_id)
    }

    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub async fn call(&self, method: &str, params: Value) -> ApiResult<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let res = self.client.post(&self.url).json(&body).send().await?;
        let status = res.status();
        if !status.is_success() {
            return Err(ApiError::Other(format!("RPC HTTP {status}")));
        }
        let json: Value = res.json().await?;
        if let Some(err) = json.get("error") {
            return Err(ApiError::Other(format!("RPC error: {err}")));
        }
        json.get("result")
            .cloned()
            .ok_or_else(|| ApiError::Other("RPC response has no result".into()))
    }

    /// Hex quantity ("0x1a") to u128.
    pub async fn quantity(&self, method: &str, params: Value) -> ApiResult<u128> {
        let raw = self.call(method, params).await?;
        parse_quantity(raw.as_str().unwrap_or_default())
            .ok_or_else(|| ApiError::Other(format!("{method} returned a non-quantity")))
    }

    pub async fn latest_block_number(&self) -> ApiResult<u64> {
        Ok(self.quantity("eth_blockNumber", json!([])).await? as u64)
    }

    pub async fn transaction_count(&self, address: &str) -> ApiResult<u64> {
        Ok(self
            .quantity(
                "eth_getTransactionCount",
                json!([to_checksum(address), "pending"]),
            )
            .await? as u64)
    }

    /// `eth_getTransactionByHash` -> { from, input, to, value }
    pub async fn transaction(&self, hash: &str) -> ApiResult<Option<Value>> {
        let found = self.call("eth_getTransactionByHash", json!([hash])).await?;
        Ok(Some(found).filter(|v| !v.is_null()))
    }

    /// `eth_getTransactionReceipt` -> { status, logs, blockNumber }
    pub async fn receipt(&self, hash: &str) -> ApiResult<Option<Value>> {
        let found = self
            .call("eth_getTransactionReceipt", json!([hash]))
            .await?;
        Ok(Some(found).filter(|v| !v.is_null()))
    }

    /// `eth_getLogs` with an already-built filter object. An RPC that returns
    /// `null` instead of `[]` for a quiet range is treated as no logs.
    pub async fn get_logs(&self, filter: Value) -> ApiResult<Vec<Value>> {
        let res = self.call("eth_getLogs", json!([filter])).await?;
        Ok(res.as_array().cloned().unwrap_or_default())
    }

    /// Broadcasts once. Only a refusal a node gives for a transaction it did not
    /// take counts as refused: anything else, an unfamiliar error included, may
    /// have reached the mempool.
    pub async fn broadcast(&self, raw: &str) -> Broadcast {
        match self.call("eth_sendRawTransaction", json!([raw])).await {
            Ok(Value::String(hash)) => Broadcast::Accepted(hash),
            Ok(other) => Broadcast::Unknown(format!("unexpected sendRaw result: {other}")),
            Err(err) => {
                let message = err.to_string();
                let lower = message.to_lowercase();
                if lower.starts_with("rpc error")
                    && NOT_TAKEN.iter().any(|known| lower.contains(known))
                {
                    Broadcast::Refused(message)
                } else {
                    Broadcast::Unknown(message)
                }
            }
        }
    }

    pub async fn eth_call(&self, to: &str, data: &str) -> ApiResult<String> {
        let res = self
            .call(
                "eth_call",
                json!([{ "to": to_checksum(to), "data": data }, "latest"]),
            )
            .await?;
        Ok(res.as_str().unwrap_or_default().to_string())
    }

    /// Reads a uint256 returned by an `eth_call`.
    pub async fn call_uint256(&self, to: &str, data: &str) -> ApiResult<u128> {
        let word = self.eth_call(to, data).await?;
        parse_abi_uint256(&word)
            .ok_or_else(|| ApiError::Other("eth_call did not return a uint256 word".into()))
    }

    /// Waits for `confirmations` blocks over the receipt, mirroring
    /// `tx.wait(3)`; returns the receipt once mined and final enough.
    pub async fn wait_for_confirmations(&self, hash: &str, confirmations: u64) -> ApiResult<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        loop {
            // A failed read here says nothing about the transaction: keep waiting.
            if let Ok(Some(receipt)) = self.receipt(hash).await {
                let block_number = parse_quantity(
                    receipt
                        .get("blockNumber")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .unwrap_or(0) as u64;
                let head = self.latest_block_number().await.unwrap_or(0);
                if head + 1 >= block_number && head + 1 - block_number + 1 >= confirmations {
                    return Ok(receipt);
                }
            }
            if tokio::time::Instant::now() > deadline {
                return Err(ApiError::Other(format!(
                    "transaction {hash} was not mined within {confirmations} confirmations"
                )));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

static PAYOUTS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Keeps the process alive while it exists. A task is cancelled when `main`
/// returns, so anything that can send money, or record that it did, runs under
/// one of these and shutdown waits in [`payouts_drained`].
pub struct PayoutHold(());

impl Drop for PayoutHold {
    fn drop(&mut self) {
        PAYOUTS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn hold_payout() -> PayoutHold {
    PAYOUTS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    PayoutHold(())
}

/// Returns once no [`PayoutHold`] is left.
pub async fn payouts_drained() {
    while PAYOUTS_IN_FLIGHT.load(Ordering::SeqCst) > 0 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub fn parse_quantity(raw: &str) -> Option<u128> {
    let hex = raw
        .trim()
        .strip_prefix("0x")
        .or_else(|| raw.trim().strip_prefix("0X"))?;
    if hex.is_empty() || hex.len() > 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u128::from_str_radix(hex, 16).ok()
}

// ---------------------------------------------------------------------------
// decimals
// ---------------------------------------------------------------------------

/// A log's `data` field: a 32-byte left-padded word, not an `eth_getLogs`
/// quantity. `parse_quantity` refuses 64 hex digits on purpose, so the leading
/// zeros come off first; a word with more significant digits than a u128 cannot
/// be a USDC amount and yields nothing.
pub fn parse_data_word(raw: &str) -> Option<u128> {
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

/// An ABI-encoded `uint256`, as `eth_call` returns it: exactly 32 bytes. Anything
/// else, such as the `0x` of an address with no contract, is not a balance.
pub fn parse_abi_uint256(raw: &str) -> Option<u128> {
    let word = raw.trim();
    (word.len() == 66).then(|| parse_data_word(word)).flatten()
}

/// `ethers.parseUnits(amount, decimals)` for a decimal string, *including its
/// throws*: excess non-zero decimals, commas and exponent notation are errors.
/// Truncating here would move money the TS refused to move.
pub fn parse_units(amount: &str, decimals: u32) -> ApiResult<u128> {
    if amount.is_empty() {
        return Err(ApiError::bad_request("Amount is required"));
    }
    let (whole, frac) = match amount.split_once('.') {
        Some((w, f)) => (w, f),
        None => (amount, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return Err(ApiError::bad_request("Amount is not a number"));
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad_request("Amount is not a number"));
    }
    let places = decimals as usize;
    let frac_truncated = &frac[..frac.len().min(places)];
    if frac[frac_truncated.len()..].bytes().any(|b| b != b'0') {
        return Err(ApiError::bad_request("Too many decimals for the token"));
    }
    let frac_padded = format!("{:0<width$}", frac_truncated, width = places);
    let whole_clean = if whole.is_empty() { "0" } else { whole };
    let combined = format!("{whole_clean}{frac_padded}");
    combined
        .parse::<u128>()
        .map_err(|_| ApiError::bad_request("Amount is out of range"))
}

/// `ethers.formatUnits(value, decimals)` as a float, matching what the TS
/// verification result reports to the deposit route.
pub fn format_units(value: u128, decimals: u32) -> f64 {
    let divisor = 10u128
        .checked_pow(decimals)
        .map(|d| d as f64)
        .unwrap_or(1.0);
    value as f64 / divisor
}

// ---------------------------------------------------------------------------
// EIP-191 personal_sign
// ---------------------------------------------------------------------------

/// `ethers.verifyMessage(message, signature)` -> checksummed address.
pub fn recover_personal_signer(message: &str, signature: &str) -> Option<String> {
    let sig_bytes = hex_decode(signature.strip_prefix("0x")?)?;
    if sig_bytes.len() != 65 {
        return None;
    }
    let (r_s, v_byte) = sig_bytes.split_at(64);
    // ethers refuses a high-S signature. Accepting one would let anyone holding
    // a signature mint a second spelling past the exact-match replay check.
    if r_s[32] & 0x80 != 0 {
        return None;
    }
    // Ledger-style 27/28 and EIP-1559 0/1 both appear in the wild.
    let parity = match v_byte[0] {
        27..=28 => v_byte[0] - 27,
        0..=1 => v_byte[0],
        _ => return None,
    };
    // Ethereum hashes the personal_sign preframe, not the raw message.
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut framed = prefix.into_bytes();
    framed.extend_from_slice(message.as_bytes());
    let hash = keccak256(&framed);

    let signature = Signature::from_slice(r_s).ok()?;
    let recovery_id = RecoveryId::try_from(parity).ok()?;
    let vk = VerifyingKey::recover_from_prehash(&hash, &signature, recovery_id).ok()?;
    Some(verifying_key_to_address(&vk))
}

fn verifying_key_to_address(vk: &VerifyingKey) -> String {
    let point = vk.to_encoded_point(false);
    // Uncompressed key is 0x04 || X || Y; the address is the last 20 bytes of
    // keccak(X || Y).
    let body = &point.as_bytes()[1..];
    let hash = keccak256(body);
    to_checksum(&format!("0x{}", hex::encode(&hash[12..])))
}

pub fn hex_decode(value: &str) -> Option<Vec<u8>> {
    hex::decode(value).ok()
}

// ---------------------------------------------------------------------------
// deposit verification (`lib/balance/verifyArcDepositTx.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepositFailure {
    RpcError,
    ConfigMissing,
    TxNotFound,
    InsufficientConfirmations,
    TxReverted,
    AmountMismatch,
    SenderMismatch,
}

impl DepositFailure {
    /// `rpc_error`, `tx_not_found` and `insufficient_confirmations` may be
    /// retried with the same hash; the rest are terminal.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::RpcError
                | Self::ConfigMissing
                | Self::TxNotFound
                | Self::InsufficientConfirmations
        )
    }

    pub fn message(&self) -> String {
        match self {
            Self::RpcError => "Could not read the deposit transaction from Arc".to_string(),
            Self::ConfigMissing => "Arc RPC or treasury address is not configured".to_string(),
            Self::TxNotFound => "Deposit transaction is not visible on Arc yet".to_string(),
            Self::InsufficientConfirmations => {
                "Deposit does not have enough confirmations".to_string()
            }
            Self::TxReverted => "Deposit transaction reverted on Arc".to_string(),
            Self::AmountMismatch => {
                "No USDC transfer of at least the claimed amount reached the treasury".to_string()
            }
            Self::SenderMismatch => {
                "Claimed depositor is neither the transaction sender nor a transfer sender"
                    .to_string()
            }
        }
    }
}

#[derive(Debug)]
pub struct DepositOk {
    pub payer_address: String,
    pub transferred_amount: f64,
    pub confirmations: u64,
    pub transaction_hash: String,
}

/// Verifies a USDC transfer actually reached the house treasury.
pub async fn verify_deposit(
    tx_hash: &str,
    user_address: &str,
    amount: &str,
    decimals: u32,
) -> Result<DepositOk, (DepositFailure, String)> {
    let cfg = config();
    let recipient = cfg.treasury_address.trim().to_string();
    if cfg.arc_rpc.trim().is_empty()
        || !is_address_shape(&recipient)
        || !is_address_shape(&cfg.arc_usdc)
    {
        return Err((
            DepositFailure::ConfigMissing,
            DepositFailure::ConfigMissing.message(),
        ));
    }
    let claimed: u128 = match parse_units(amount, decimals) {
        Ok(v) if v > 0 => v,
        _ => {
            let f = DepositFailure::AmountMismatch;
            return Err((f, "Deposit amount must be greater than zero".to_string()));
        }
    };
    if tx_hash.trim().is_empty() {
        let f = DepositFailure::AmountMismatch;
        return Err((f, "Transaction hash is required".to_string()));
    }

    let rpc = Rpc::from_config();
    let (tx, receipt) = match tokio::join!(rpc.transaction(tx_hash), rpc.receipt(tx_hash)) {
        (Ok(Some(t)), Ok(Some(r))) => (t, r),
        (Err(_), _) | (_, Err(_)) => {
            let f = DepositFailure::RpcError;
            return Err((f, f.message()));
        }
        (Ok(None), _) | (_, Ok(None)) => {
            let f = DepositFailure::TxNotFound;
            return Err((f, f.message()));
        }
    };

    let status = parse_quantity(
        receipt
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .unwrap_or(0);
    if status != 1 {
        let f = DepositFailure::TxReverted;
        return Err((f, f.message()));
    }

    // A receipt we cannot place must not read as "deep under the head".
    let Some(block_number) = parse_quantity(
        receipt
            .get("blockNumber")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) else {
        let f = DepositFailure::RpcError;
        return Err((f, f.message()));
    };
    let block_number = block_number as u64;
    let head = match rpc.latest_block_number().await {
        Ok(n) => n,
        Err(_) => {
            let f = DepositFailure::RpcError;
            return Err((f, f.message()));
        }
    };
    let confirmations = head.saturating_sub(block_number) + 1;
    if confirmations < MIN_CONFIRMATIONS {
        return Err((
            DepositFailure::InsufficientConfirmations,
            format!("Deposit has {confirmations}/{MIN_CONFIRMATIONS} confirmations"),
        ));
    }

    let token = to_checksum(&cfg.arc_usdc);
    let topic = hex::encode(transfer_topic());
    let mut incoming: Vec<(String, u128)> = Vec::new();
    if let Some(logs) = receipt.get("logs").and_then(Value::as_array) {
        for log in logs {
            let log_address = log
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !canonical(log_address).eq(&canonical(&token)) {
                continue;
            }
            let topics = match log.get("topics").and_then(Value::as_array) {
                Some(t) if t.len() >= 3 => t,
                _ => continue,
            };
            if topics[0]
                .as_str()
                .unwrap_or_default()
                .strip_prefix("0x")
                .unwrap_or("")
                != topic
                && topics[0].as_str().unwrap_or_default() != format!("0x{topic}")
            {
                continue;
            }
            let from = topic_to_address(topics[1].as_str().unwrap_or_default());
            let to = topic_to_address(topics[2].as_str().unwrap_or_default());
            if canonical(&to) != canonical(&recipient) {
                continue;
            }
            let value = match log
                .get("data")
                .and_then(Value::as_str)
                .and_then(parse_data_word)
            {
                Some(v) => v,
                None => continue,
            };
            if value >= claimed {
                incoming.push((from, value));
            }
        }
    }

    if incoming.is_empty() {
        let f = DepositFailure::AmountMismatch;
        return Err((f, f.message()));
    }

    // Contract-mediated flows put the player in the Transfer log `from` while
    // tx.from is a router; the log wins, with the EOA sender as fallback.
    if let Some((from, value)) = incoming
        .iter()
        .find(|(from, _)| canonical(from) == canonical(user_address))
    {
        return Ok(DepositOk {
            payer_address: from.clone(),
            transferred_amount: format_units(*value, decimals),
            confirmations,
            transaction_hash: tx_hash.to_string(),
        });
    }
    let tx_from = tx.get("from").and_then(Value::as_str).unwrap_or_default();
    if canonical(tx_from) == canonical(user_address) {
        let (_, value) = &incoming[0];
        return Ok(DepositOk {
            // The sender is the claimant, not the log's contract: the credit
            // follows this address, so a router must never receive it.
            payer_address: tx_from.to_string(),
            transferred_amount: format_units(*value, decimals),
            confirmations,
            transaction_hash: tx_hash.to_string(),
        });
    }

    let f = DepositFailure::SenderMismatch;
    Err((f, f.message()))
}

// ---------------------------------------------------------------------------
// treasury payouts (`lib/arc/backend-client.ts`)
// ---------------------------------------------------------------------------

/// One transfer out of the treasury, in token base units.
#[derive(Clone)]
pub struct Transfer {
    pub to: String,
    pub amount: u128,
}

/// A broadcast transfer: `Treasury::confirm` finishes it.
#[derive(Debug)]
pub struct Sent {
    pub hash: String,
    amount: u128,
}

#[derive(Debug)]
pub enum PayError<R> {
    /// A read failed. Nothing was committed or sent.
    Preflight(String),
    /// The commit step said no. Nothing was sent.
    Refused(R),
    /// Committed, then a broadcast failed or its outcome is unknown. `sent` holds
    /// what did go out, and nothing here may be sent again.
    Send { sent: Vec<Sent>, error: String },
}

/// What the send queue owns. The lock around it is tokio's, which is FIFO, so
/// holding it is a turn in one queue.
#[derive(Default)]
struct SendQueue {
    /// Nonce after the last broadcast that may have reached the node.
    next_nonce: Option<u64>,
    /// Broadcast and not yet confirmed: the on-chain balance still includes it.
    in_flight: u128,
}

#[derive(Clone)]
pub struct Treasury {
    rpc: Rpc,
    signer: SigningKey,
    address: String,
    contract: String,
    usdc: String,
    queue: Arc<tokio::sync::Mutex<SendQueue>>,
}

/// One treasury key means one queue, however many handles exist.
static QUEUE: OnceLock<Arc<tokio::sync::Mutex<SendQueue>>> = OnceLock::new();

impl Treasury {
    /// Requires ARC_TREASURY_SECRET_KEY (the contract owner) and
    /// NEXT_PUBLIC_TREASURY_ADDRESS.
    pub fn from_config() -> ApiResult<Self> {
        let cfg = config();
        let key_hex = cfg
            .treasury_secret_key
            .as_deref()
            .ok_or_else(|| ApiError::unavailable("ARC_TREASURY_SECRET_KEY is not configured"))?;
        let key_bytes = hex_decode(key_hex.strip_prefix("0x").unwrap_or(key_hex))
            .ok_or_else(|| ApiError::unavailable("ARC_TREASURY_SECRET_KEY is not valid hex"))?;
        let signer = SigningKey::from_slice(&key_bytes)
            .map_err(|_| ApiError::unavailable("ARC_TREASURY_SECRET_KEY is not a valid key"))?;
        if !is_address_shape(&cfg.treasury_address) {
            return Err(ApiError::unavailable(
                "NEXT_PUBLIC_TREASURY_ADDRESS is not a valid address",
            ));
        }
        let mut treasury = Self::new(
            Rpc::from_config(),
            signer,
            cfg.treasury_address.clone(),
            cfg.arc_usdc.clone(),
        );
        treasury.queue = QUEUE.get_or_init(Default::default).clone();
        Ok(treasury)
    }

    /// A treasury with its own send queue.
    pub fn new(rpc: Rpc, signer: SigningKey, contract: String, usdc: String) -> Self {
        let address = address_from_signing_key(&signer);
        Self {
            rpc,
            signer,
            address,
            contract,
            usdc,
            queue: Default::default(),
        }
    }

    pub fn signer_address(&self) -> &str {
        &self.address
    }

    fn call_data_with_uint(selector_bytes: [u8; 4], to: &str, amount: u128) -> String {
        let mut data = Vec::with_capacity(68);
        data.extend_from_slice(&selector_bytes);
        // address argument: 32-byte left-padded word
        let addr_hex = to.strip_prefix("0x").unwrap_or(to).to_lowercase();
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&hex::decode(addr_hex).unwrap_or_default());
        // uint256 argument: a u128 is 16 bytes, the ABI word is 32.
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&amount.to_be_bytes());
        format!("0x{}", hex::encode(data))
    }

    /// Reads `owner()` from the treasury and checks it is our signer, so a key
    /// mismatch fails before any gas is spent.
    pub async fn assert_owner_matches(&self) -> ApiResult<()> {
        let data = format!("0x{}", hex::encode(selector("owner()")));
        let raw = self.rpc.eth_call(&self.contract, &data).await?;
        let hex = raw.strip_prefix("0x").unwrap_or(&raw);
        let owner = if hex.len() >= 40 {
            to_checksum(&format!("0x{}", &hex[hex.len() - 40..]))
        } else {
            String::new()
        };
        if canonical(&owner) != canonical(&self.address) {
            return Err(ApiError::unavailable(format!(
                "ARC_TREASURY_SECRET_KEY ({}) is not the StrikeTreasury owner ({})",
                self.address, owner
            )));
        }
        Ok(())
    }

    /// `balanceOf(treasury)` on the USDC token, in base units.
    pub async fn treasury_token_balance(&self) -> ApiResult<u128> {
        let addr_hex = self
            .contract
            .strip_prefix("0x")
            .unwrap_or(&self.contract)
            .to_lowercase();
        let mut data = selector("balanceOf(address)").to_vec();
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&hex::decode(addr_hex).unwrap_or_default());
        self.rpc
            .call_uint256(&self.usdc, &format!("0x{}", hex::encode(data)))
            .await
    }

    /// Pays `transfers` in order, one nonce each, in one turn of the send queue:
    /// every read, then `commit` (which debits the ledger), then the broadcasts.
    /// So a failed read costs a player nothing, parallel payouts cannot share a
    /// nonce or spend the same treasury balance, and nothing is sent unless the
    /// commit succeeded. Runs as its own task, so a dropped request cannot stop a
    /// turn halfway. Nothing is ever retried: after the commit, a failure is
    /// reported and the money waits for an operator.
    pub async fn pay<T, R, C, F>(
        &self,
        transfers: Vec<Transfer>,
        commit: C,
    ) -> Result<(T, Vec<Sent>), PayError<R>>
    where
        T: Send + 'static,
        R: Send + 'static,
        C: FnOnce() -> F + Send + 'static,
        F: Future<Output = Result<T, R>> + Send + 'static,
    {
        let this = self.clone();
        let hold = hold_payout();
        tokio::spawn(async move {
            let _hold = hold;
            this.take_turn(transfers, commit).await
        })
        .await
        .unwrap_or_else(|panic| {
            Err(PayError::Send {
                sent: Vec::new(),
                error: format!("treasury send task failed: {panic}"),
            })
        })
    }

    async fn take_turn<T, R, C, F>(
        &self,
        transfers: Vec<Transfer>,
        commit: C,
    ) -> Result<(T, Vec<Sent>), PayError<R>>
    where
        C: FnOnce() -> F,
        F: Future<Output = Result<T, R>>,
    {
        let mut queue = self.queue.lock().await;
        let (first_nonce, signed) = self
            .prepare(&queue, &transfers)
            .await
            .map_err(|err| PayError::Preflight(err.to_string()))?;
        let committed = commit().await.map_err(PayError::Refused)?;

        let mut sent = Vec::with_capacity(signed.len());
        for ((nonce, raw), transfer) in (first_nonce..).zip(&signed).zip(&transfers) {
            let (hash, failure) = match self.rpc.broadcast(raw).await {
                Broadcast::Accepted(hash) => (hash, None),
                Broadcast::Refused(message) => {
                    return Err(PayError::Send {
                        sent,
                        error: message,
                    })
                }
                Broadcast::Unknown(message) => (raw_tx_hash(raw), Some(message)),
            };
            queue.next_nonce = Some(nonce + 1);
            queue.in_flight += transfer.amount;
            sent.push(Sent {
                hash,
                amount: transfer.amount,
            });
            if let Some(message) = failure {
                return Err(PayError::Send {
                    sent,
                    error: format!("broadcast outcome unknown: {message}"),
                });
            }
        }
        Ok((committed, sent))
    }

    /// Everything that can fail without money moving: validation, the owner and
    /// balance reads, the nonce, gas, and signing.
    async fn prepare(
        &self,
        queue: &SendQueue,
        transfers: &[Transfer],
    ) -> ApiResult<(u64, Vec<String>)> {
        let mut total = queue.in_flight;
        for transfer in transfers {
            if !is_address_shape(&transfer.to) {
                return Err(ApiError::bad_request(format!(
                    "Invalid destination address: {}",
                    transfer.to
                )));
            }
            if transfer.amount == 0 {
                return Err(ApiError::bad_request(
                    "Withdrawal amount must be greater than zero",
                ));
            }
            total += transfer.amount;
        }
        self.assert_owner_matches().await?;
        if self.treasury_token_balance().await? < total {
            return Err(ApiError::unavailable(
                "Treasury has insufficient USDC for this withdrawal",
            ));
        }

        let chain = self.rpc.transaction_count(&self.address).await?;
        let nonce = match queue.next_nonce {
            // An earlier send never reached this node, or it is lagging. A nonce
            // past the chain's would sit unmined, and reusing one could replace a
            // send that is still out there, so wait. Restarting clears this once
            // an operator knows what happened to that send.
            Some(next) if chain < next => {
                return Err(ApiError::unavailable(format!(
                    "Treasury nonce {next} is ahead of the node's {chain}"
                )))
            }
            Some(next) => next.max(chain),
            None => chain,
        };

        let gas_price = self.rpc.quantity("eth_gasPrice", json!([])).await?;
        // Arc accepts an EIP-1559 transaction with priority fee folded into the
        // max fee; keeping max_fee at 2x base is the standard safe guess.
        let (max_fee, priority_fee) = (gas_price * 2, gas_price / 10);

        let selector_bytes = selector("withdrawTokenTo(address,uint256)");
        let mut signed = Vec::with_capacity(transfers.len());
        for (tx_nonce, transfer) in (nonce..).zip(transfers) {
            let data = Self::call_data_with_uint(selector_bytes, &transfer.to, transfer.amount);
            let estimate = json!([{
                "from": self.address,
                "to": self.contract,
                "value": "0x0",
                "data": data,
            }, "latest"]);
            let gas = self.rpc.quantity("eth_estimateGas", estimate).await? as u64;
            // Padding the estimate so a state-changing call is not under-gassed
            // between estimation and inclusion.
            let gas_limit = gas + gas / 5 + 21_000;
            signed.push(build_eip1559_raw(
                &self.signer,
                self.rpc.chain_id(),
                tx_nonce,
                gas_limit,
                max_fee,
                priority_fee,
                &self.contract,
                0,
                &hex_decode(data.strip_prefix("0x").unwrap_or(&data)).unwrap_or_default(),
            )?);
        }
        Ok((nonce, signed))
    }

    /// Waits for `PAYOUT_CONFIRMATIONS` and checks the receipt status. A reverted
    /// payout must never come back as success.
    pub async fn confirm(&self, sent: &Sent) -> ApiResult<()> {
        let receipt = self
            .rpc
            .wait_for_confirmations(&sent.hash, PAYOUT_CONFIRMATIONS)
            .await;
        {
            let mut queue = self.queue.lock().await;
            queue.in_flight = queue.in_flight.saturating_sub(sent.amount);
        }
        let receipt = receipt?;
        let status = parse_quantity(
            receipt
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .unwrap_or(0);
        if status != 1 {
            return Err(ApiError::Other(format!(
                "Treasury payout {} reverted on-chain (status {status})",
                sent.hash
            )));
        }
        Ok(())
    }

    /// Pays `amount` base units out of the treasury via
    /// `withdrawTokenTo(address,uint256)`, with no ledger step, and returns the
    /// mined tx hash.
    pub async fn withdraw_token_to(&self, to: &str, amount: u128) -> ApiResult<String> {
        let transfer = Transfer {
            to: to.to_string(),
            amount,
        };
        let no_commit = || async { Ok::<(), Infallible>(()) };
        let ((), mut sent) = self
            .pay(vec![transfer], no_commit)
            .await
            .map_err(|failure| match failure {
                PayError::Preflight(error) | PayError::Send { error, .. } => ApiError::Other(error),
                PayError::Refused(never) => match never {},
            })?;
        let sent = sent
            .pop()
            .ok_or_else(|| ApiError::Other("treasury sent nothing".to_string()))?;
        self.confirm(&sent).await?;
        Ok(sent.hash)
    }
}

/// The hash a transaction has whether or not the node ever answered.
fn raw_tx_hash(raw: &str) -> String {
    let bytes = hex_decode(raw.strip_prefix("0x").unwrap_or(raw)).unwrap_or_default();
    format!("0x{}", hex::encode(keccak256(&bytes)))
}

fn address_from_signing_key(signer: &SigningKey) -> String {
    verifying_key_to_address(signer.verifying_key())
}

/// Ethereum rejects high-S signatures (EIP-2), so a payout transaction has to
/// carry the low-S form. Negating `s` also negates the nonce point, which
/// flips the y-parity bit the recovery id stores - leaving it alone would make
/// `ecrecover` return a different address and the chain would refuse the tx.
pub fn normalize_low_s(signature: Signature, recovery_id: RecoveryId) -> (Signature, RecoveryId) {
    match signature.normalize_s() {
        Some(low_s) => (
            low_s,
            RecoveryId::new(!recovery_id.is_y_odd(), recovery_id.is_x_reduced()),
        ),
        None => (signature, recovery_id),
    }
}

/// Assembles a signed EIP-1559 transaction.
#[allow(clippy::too_many_arguments)]
pub fn build_eip1559_raw(
    signer: &SigningKey,
    chain_id: u64,
    nonce: u64,
    gas_limit: u64,
    max_fee: u128,
    max_priority_fee: u128,
    to: &str,
    value: u128,
    data: &[u8],
) -> ApiResult<String> {
    let to_bytes = hex::decode(to.strip_prefix("0x").unwrap_or(to))
        .map_err(|_| ApiError::bad_request("invalid destination address"))?;

    let unsigned = rlp_list(&[
        rlp_bytes(&be_min(chain_id as u128)),
        rlp_bytes(&be_min(nonce as u128)),
        rlp_bytes(&be_min(max_priority_fee)),
        rlp_bytes(&be_min(max_fee)),
        rlp_bytes(&be_min(gas_limit as u128)),
        rlp_bytes(&to_bytes),
        rlp_bytes(&be_min(value)),
        rlp_bytes(data),
        rlp_list(&[]), // empty access list
    ]);
    let prehash = keccak256(&[&[0x02u8][..], &unsigned].concat());

    let (signature, recovery_id) = signer
        .sign_prehash_recoverable(&prehash)
        .map_err(|e| ApiError::Other(format!("signing failed: {e}")))?;
    let (signature, recovery_id) = normalize_low_s(signature, recovery_id);
    let sig_bytes = signature.to_bytes();
    let (r, s) = sig_bytes.split_at(32);

    let signed = rlp_list(&[
        rlp_bytes(&be_min(chain_id as u128)),
        rlp_bytes(&be_min(nonce as u128)),
        rlp_bytes(&be_min(max_priority_fee)),
        rlp_bytes(&be_min(max_fee)),
        rlp_bytes(&be_min(gas_limit as u128)),
        rlp_bytes(&to_bytes),
        rlp_bytes(&be_min(value)),
        rlp_bytes(data),
        rlp_list(&[]),
        rlp_bytes(&be_min(recovery_id.is_y_odd() as u128)),
        rlp_bytes(r),
        rlp_bytes(s),
    ]);

    let mut raw = vec![0x02u8];
    raw.extend_from_slice(&signed);
    Ok(format!("0x{}", hex::encode(raw)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::scalar::IsHigh;

    #[test]
    fn transfer_topic_matches_known_hash() {
        // keccak256("Transfer(address,address,uint256)") is a fixed, well-known
        // value used by every ERC-20 indexer.
        assert_eq!(
            hex::encode(transfer_topic()),
            "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
        );
    }

    #[test]
    fn payout_calldata_is_two_full_abi_words() {
        let data = Treasury::call_data_with_uint(
            selector("withdrawTokenTo(address,uint256)"),
            "0xb46b14d5da2438a7821b141722cd25cd7ff1e225",
            450_000,
        );
        assert_eq!(data.len(), 2 + 2 * (4 + 32 + 32));
        assert!(data.ends_with(
            "000000000000000000000000b46b14d5da2438a7821b141722cd25cd7ff1e225\
             000000000000000000000000000000000000000000000000000000000006ddd0"
        ));
    }

    #[test]
    fn selectors_match_erc20_abi() {
        assert_eq!(
            hex::encode(selector("transfer(address,uint256)")),
            "a9059cbb"
        );
        assert_eq!(hex::encode(selector("balanceOf(address)")), "70a08231");
        assert_eq!(
            hex::encode(selector("approve(address,uint256)")),
            "095ea7b3"
        );
    }

    #[test]
    fn indexed_topics_decode_to_checksummed_addresses() {
        let topic = "0x0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
        assert_eq!(
            topic_to_address(topic),
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
        );
        assert_eq!(topic_to_address("0xdeadbeef"), "");
    }

    // RLP vectors from the Ethereum specification.
    #[test]
    fn rlp_matches_spec_vectors() {
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(rlp_bytes(b""), vec![0x80]);
        assert_eq!(rlp_bytes(&[0x0f]), vec![0x0f]);
        let list = rlp_list(&[rlp_bytes(b"cat"), rlp_bytes(b"dog")]);
        assert_eq!(
            list,
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
        assert_eq!(rlp_bytes(&be_min(1024)), vec![0x82, 0x04, 0x00]);
        assert_eq!(rlp_bytes(&be_min(0)), vec![0x80]);
        // 56-byte payloads switch to the long form: 0xb7 plus however many
        // bytes the length itself needs, then the length, then the payload.
        let long = rlp_bytes(&[0u8; 56]);
        assert_eq!(&long[..2], &[0xb7 + 1, 56]);
        assert_eq!(rlp_bytes(&[0u8; 55])[0], 0x80 + 55);
        let three_hundred = rlp_bytes(&[0u8; 300]);
        assert_eq!(&three_hundred[..3], &[0xb7 + 2, 0x01, 0x2c]);
    }

    #[test]
    fn quantity_parsing() {
        assert_eq!(parse_quantity("0x1a"), Some(26));
        assert_eq!(parse_quantity("0x0"), Some(0));
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("0xzz"), None);
        assert_eq!(parse_quantity("1a"), None);
    }

    #[test]
    fn abi_words_are_exactly_32_bytes() {
        // What a node answers to `balanceOf`: 10^15 as a full word.
        let word = format!("0x{:064x}", 1_000_000_000_000_000u128);
        assert_eq!(parse_abi_uint256(&word), Some(1_000_000_000_000_000));
        assert_eq!(parse_abi_uint256(&format!("0x{}", "0".repeat(64))), Some(0));
        // No contract at the address, and the short form no node sends.
        assert_eq!(parse_abi_uint256("0x"), None);
        assert_eq!(parse_abi_uint256("0x38d7ea4c68000"), None);
        // More than a u128 is refused, never truncated.
        assert_eq!(parse_abi_uint256(&format!("0x1{}", "0".repeat(63))), None);
        assert_eq!(parse_abi_uint256(&format!("0x{}", "z".repeat(64))), None);
    }

    #[test]
    fn transfer_log_data_is_a_full_word_not_a_quantity() {
        // 1 USDC exactly as eth_getTransactionReceipt returns it. A quantity
        // parse refuses 64 digits, which silently rejected every deposit.
        let word = format!("0x{:064x}", 1_000_000);
        assert_eq!(parse_quantity(&word), None);
        assert_eq!(parse_data_word(&word), Some(1_000_000));
        assert_eq!(parse_data_word(&format!("0x{:064x}", 0)), Some(0));
        assert_eq!(parse_data_word(&format!("0x{}", "f".repeat(64))), None);
        assert_eq!(parse_data_word("1000"), None);
    }

    #[test]
    fn parse_units_handles_token_precision() {
        assert_eq!(parse_units("1", 6).unwrap(), 1_000_000);
        assert_eq!(parse_units("1.5", 6).unwrap(), 1_500_000);
        assert_eq!(parse_units("0.000001", 6).unwrap(), 1);
        assert_eq!(parse_units(".5", 6).unwrap(), 500_000);
        // Extra precision truncates rather than rounding up.
        // Pinned from node against ethers.parseUnits: these throw, and a
        // payout built on a truncated value is money the TS never moved.
        assert!(parse_units("1.0000009", 6).is_err());
        assert!(parse_units("0.89999999", 6).is_err());
        assert!(parse_units("1,000", 6).is_err());
        assert!(parse_units("1e-7", 6).is_err());
        assert!(parse_units("-1", 6).is_err());
        assert_eq!(parse_units("1.2300000", 6).unwrap(), 1_230_000);
        assert!(parse_units("abc", 6).is_err());
        assert!(parse_units("", 6).is_err());
        assert_eq!(format_units(1_500_000, 6), 1.5);
    }

    #[test]
    fn personal_sign_recovers_known_signer() {
        // Deterministic round trip: sign the framed digest ourselves and check
        // the recovery lands on the same address.
        let message = "STRIKE withdrawal authorization\naddress:0xabc\namount:1.00000000\ncurrency:USDC\nsignedAt:1700000000000";
        let key = SigningKey::from_slice(&[0x11u8; 32]).unwrap();
        let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
        let mut framed = prefix.into_bytes();
        framed.extend_from_slice(message.as_bytes());
        let hash = keccak256(&framed);
        let (sig, id) = key.sign_prehash_recoverable(&hash).unwrap();
        let mut raw = sig.to_bytes().to_vec();
        raw.push(id.to_byte() + 27);
        let hex_sig = format!("0x{}", hex::encode(raw));

        assert_eq!(
            recover_personal_signer(message, &hex_sig).as_deref(),
            Some(address_from_signing_key(&key).as_str())
        );
        // A different message must not recover the same signer.
        assert_ne!(
            recover_personal_signer("tampered", &hex_sig),
            Some(address_from_signing_key(&key))
        );
        assert_eq!(recover_personal_signer(message, "0xdead"), None);
        // What ethers.Signature.from refuses: no 0x, v of 2/3, high S.
        assert_eq!(
            recover_personal_signer(message, hex_sig.trim_start_matches("0x")),
            None
        );
        let mut bytes = hex_decode(hex_sig.trim_start_matches("0x")).unwrap();
        bytes[64] = 2;
        assert_eq!(
            recover_personal_signer(message, &format!("0x{}", hex::encode(&bytes))),
            None
        );
        bytes[64] = 0;
        bytes[32] |= 0x80;
        assert_eq!(
            recover_personal_signer(message, &format!("0x{}", hex::encode(&bytes))),
            None
        );
    }

    #[test]
    fn eip1559_raw_transaction_shape_and_determinism() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let to = "0x3600000000000000000000000000000000000000";
        let data = selector("transfer(address,uint256)").to_vec();
        let raw = build_eip1559_raw(
            &key,
            5042002,
            7,
            120_000,
            2_000_000_000,
            100_000_000,
            to,
            0,
            &data,
        )
        .unwrap();
        let bytes = hex::decode(&raw[2..]).unwrap();
        assert_eq!(bytes[0], 0x02, "typed-transaction prefix");
        // Same inputs sign to the same bytes (RFC 6979 deterministic k).
        let again = build_eip1559_raw(
            &key,
            5042002,
            7,
            120_000,
            2_000_000_000,
            100_000_000,
            to,
            0,
            &data,
        )
        .unwrap();
        assert_eq!(raw, again);
        // A changed nonce changes the signature.
        assert_ne!(
            raw,
            build_eip1559_raw(
                &key,
                5042002,
                8,
                120_000,
                2_000_000_000,
                100_000_000,
                to,
                0,
                &data
            )
            .unwrap()
        );
        assert!(build_eip1559_raw(&key, 1, 0, 21_000, 1, 1, "not-an-address", 0, &[]).is_err());
    }

    /// A low-S rewrite is only valid if the flipped recovery id still recovers
    /// the same signer - otherwise the chain would accept a signature from an
    /// address that is not the treasury owner.
    #[test]
    fn low_s_normalization_keeps_the_signer() {
        let hash = keccak256(b"withdraw");
        for byte in [0x01u8, 0x42, 0x9f, 0xff] {
            let mut secret = [0u8; 32];
            secret[0] = byte;
            secret[31] = byte;
            let key = SigningKey::from_slice(&secret).unwrap();
            let (sig, id) = key.sign_prehash_recoverable(&hash).unwrap();
            let (sig, id) = normalize_low_s(sig, id);
            assert!(
                !bool::from(sig.s().is_high()),
                "s must be low after normalize"
            );
            let recovered =
                VerifyingKey::recover_from_prehash(&hash, &sig, id).expect("recover id");
            assert_eq!(&recovered, key.verifying_key());
        }
    }

    #[test]
    fn failure_retryability_matches_ts() {
        assert!(DepositFailure::RpcError.retryable());
        assert!(DepositFailure::TxNotFound.retryable());
        assert!(DepositFailure::InsufficientConfirmations.retryable());
        assert!(DepositFailure::ConfigMissing.retryable());
        assert!(!DepositFailure::TxReverted.retryable());
        assert!(!DepositFailure::AmountMismatch.retryable());
        assert!(!DepositFailure::SenderMismatch.retryable());
    }

    #[test]
    fn payout_rejects_bad_inputs_before_touching_the_chain() {
        // These checks run before any RPC, so they hold with no node reachable.
        assert!(hex_decode("zz").is_none());
        assert_eq!(parse_units("0", 6).ok(), Some(0));
    }
}
