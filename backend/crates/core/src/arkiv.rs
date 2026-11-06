//! Seals every settled round on Arkiv as a read-only entity, off the bet path.
//!
//! Settled rounds with no `arkiv_seals` row are the outbox. One batch is in flight at
//! a time: its tx hash is written to `arkiv_seals` before broadcast, so a crash or a
//! timeout resolves that hash instead of sending the rounds twice.

use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use k256::ecdsa::SigningKey;
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use tokio::sync::{Mutex, Notify};

use crate::address::keccak256;
use crate::config::config;
use crate::db::{db, now_us};
use crate::error::{ApiError, ApiResult};
use crate::eth::{
    address_from_signing_key, build_eip1559_raw, hex_decode, parse_quantity, Broadcast, Rpc,
};

pub const DEFAULT_RPC: &str = "https://rpc.rabdi.db-chain.testnet.arkiv.network";
pub const CHAIN_ID: u64 = 7_794_095;
const SCHEMA: &str = "strike.rounds";
const ARKIV: &str = "0x4400000000000000000000000000000000000044";
const EXECUTE: [u8; 4] = [0x49, 0x65, 0x00, 0x44];
const OP_CREATE: u8 = 1;
const FLAG_READONLY: u8 = 1;
/// The protocol ceiling is 7,884,000 blocks of 2 s, about 182 days.
const LIFETIME_BLOCKS: u64 = 7_800_000;
// ponytail: one batch of 50 in flight per tick, pipeline nonces if seals lag behind settlement.
const BATCH: i64 = 50;
const TICK: Duration = Duration::from_secs(2);
const DROPPED_AFTER_US: i64 = 60_000_000;

const STR: u8 = 8;
const DEC: u8 = 5;
const U64: u8 = 3;
const ADDR: u8 = 9;
const INDEXED: u8 = 0x80;

static SEALED: LazyLock<Notify> = LazyLock::new(Notify::new);
static SHARED: OnceLock<Option<Arkiv>> = OnceLock::new();

/// Built once at startup by [`init`], so a bad key fails the boot, not a request.
pub fn init() -> ApiResult<Option<&'static Arkiv>> {
    let arkiv = Arkiv::from_config()?;
    Ok(SHARED.get_or_init(|| arkiv).as_ref())
}

pub fn shared() -> ApiResult<&'static Arkiv> {
    SHARED
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| ApiError::unavailable("ARKIV_PRIVATE_KEY is not configured"))
}

enum Abi {
    Word([u8; 32]),
    Bytes(Vec<u8>),
    Array(Vec<Abi>),
    Tuple(Vec<Abi>),
}

impl Abi {
    fn dynamic(&self) -> bool {
        match self {
            Abi::Word(_) => false,
            Abi::Bytes(_) | Abi::Array(_) => true,
            Abi::Tuple(items) => items.iter().any(Abi::dynamic),
        }
    }

    fn encode(&self) -> Vec<u8> {
        match self {
            Abi::Word(word) => word.to_vec(),
            Abi::Bytes(bytes) => {
                let mut out = uint(bytes.len() as u128).to_vec();
                out.extend_from_slice(bytes);
                out.resize(32 + bytes.len().div_ceil(32) * 32, 0);
                out
            }
            Abi::Array(items) => [uint(items.len() as u128).to_vec(), sequence(items)].concat(),
            Abi::Tuple(items) => sequence(items),
        }
    }
}

fn sequence(items: &[Abi]) -> Vec<u8> {
    let mut head = Vec::new();
    let mut tail = Vec::new();
    for item in items {
        if item.dynamic() {
            head.extend_from_slice(&uint((items.len() * 32 + tail.len()) as u128));
            tail.extend(item.encode());
        } else {
            head.extend(item.encode());
        }
    }
    [head, tail].concat()
}

fn uint(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

fn int(value: i128) -> [u8; 32] {
    let mut word = [if value < 0 { 0xff } else { 0 }; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// A fixed-point integer at `scale` as Arkiv's `dec`, which is the value times 10^18.
fn dec(value: i64, scale: u32) -> Vec<u8> {
    int(value as i128 * 10i128.pow(18 - scale)).to_vec()
}

fn address_word(address: &str) -> ApiResult<Vec<u8>> {
    let bytes = hex_decode(address.strip_prefix("0x").unwrap_or(address))
        .filter(|b| b.len() == 20)
        .ok_or_else(|| ApiError::Other(format!("not an address: {address}")))?;
    Ok([vec![0u8; 12], bytes].concat())
}

struct Attribute {
    name: &'static str,
    type_id: u8,
    value: Vec<u8>,
}

fn attr(name: &'static str, type_id: u8, value: Vec<u8>) -> Attribute {
    Attribute {
        name,
        type_id,
        value,
    }
}

/// One settled round as it is sealed.
pub struct Sealed {
    pub bet_id: String,
    pub wallet: String,
    pub currency: String,
    pub asset: String,
    pub mode: String,
    pub direction: String,
    pub stake: i64,
    pub multiplier: i64,
    pub strike_price: i64,
    pub end_price: Option<i64>,
    pub outcome: String,
    pub payout: i64,
    pub settled_at_us: i64,
}

impl Sealed {
    fn attributes(&self) -> ApiResult<Vec<Attribute>> {
        use crate::money::MONEY_SCALE;
        use crate::settlement::{MULTIPLIER_SCALE, PRICE_SCALE};
        let text = |s: &str| s.as_bytes().to_vec();
        let mut attrs = vec![
            attr("arkiv.schema", STR | INDEXED, text(SCHEMA)),
            attr("asset", STR | INDEXED, text(&self.asset)),
            attr("betId", STR | INDEXED, text(&self.bet_id)),
            attr("currency", STR | INDEXED, text(&self.currency)),
            attr("direction", STR | INDEXED, text(&self.direction)),
            attr("mode", STR | INDEXED, text(&self.mode)),
            attr("multiplier", DEC, dec(self.multiplier, MULTIPLIER_SCALE)),
            attr("outcome", STR | INDEXED, text(&self.outcome)),
            attr("payout", DEC, dec(self.payout, MONEY_SCALE)),
            attr(
                "settledAt",
                U64 | INDEXED,
                uint((self.settled_at_us / 1000) as u128).to_vec(),
            ),
            attr("stake", DEC, dec(self.stake, MONEY_SCALE)),
            attr("strikePrice", DEC, dec(self.strike_price, PRICE_SCALE)),
            attr("wallet", ADDR | INDEXED, address_word(&self.wallet)?),
        ];
        if let Some(end) = self.end_price {
            attrs.push(attr("endPrice", DEC, dec(end, PRICE_SCALE)));
        }
        attrs.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
        Ok(attrs)
    }

    fn create(&self, salt: u128) -> ApiResult<Abi> {
        let attributes = self
            .attributes()?
            .into_iter()
            .map(|a| {
                let mut name = [0u8; 32];
                name[..a.name.len()].copy_from_slice(a.name.as_bytes());
                Abi::Tuple(vec![
                    Abi::Word(name),
                    Abi::Word(uint(a.type_id as u128)),
                    Abi::Bytes(a.value),
                ])
            })
            .collect();
        let data = sequence(&[Abi::Tuple(vec![
            Abi::Word(uint(salt)),
            Abi::Word(uint(0)),
            Abi::Word(uint(LIFETIME_BLOCKS as u128)),
            Abi::Word(uint(FLAG_READONLY as u128)),
            Abi::Array(attributes),
        ])]);
        Ok(Abi::Tuple(vec![
            Abi::Word(uint(OP_CREATE as u128)),
            Abi::Bytes(data),
        ]))
    }
}

/// `execute(ops)` calldata creating one entity per round, in order.
fn calldata(rounds: &[Sealed], salt: impl Fn(usize) -> u128) -> ApiResult<Vec<u8>> {
    let ops = rounds
        .iter()
        .enumerate()
        .map(|(i, r)| r.create(salt(i)))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok([EXECUTE.to_vec(), sequence(&[Abi::Array(ops)])].concat())
}

fn entity_created_topic() -> String {
    format!(
        "0x{}",
        hex::encode(keccak256(b"EntityCreated(bytes32,address,uint64,uint8)"))
    )
}

pub struct Arkiv {
    rpc: Rpc,
    signer: SigningKey,
    operator: String,
    /// Seal batches and key funding share the operator's nonce; one send at a time.
    sending: Mutex<()>,
}

/// Gas sent once to each browser key: about 30 bet entities at Rabdi's gas price.
pub const KEY_FUNDING_WEI: u128 = 20_000_000_000_000_000;

/// What a wallet signs to let one browser key write its bets on Arkiv. The signature
/// is stored on every entity that key writes, so the link checks out without us.
pub fn delegation_message(wallet: &str, key: &str, expires_ms: i64) -> String {
    format!(
        "Strike: let this browser key record my bets on Arkiv\nWallet: {}\nKey: {}\nExpires: {expires_ms}",
        wallet.to_lowercase(),
        key.to_lowercase()
    )
}

impl Arkiv {
    /// `None` when `ARKIV_PRIVATE_KEY` is unset.
    pub fn from_config() -> ApiResult<Option<Self>> {
        let cfg = config();
        let Some(key) = cfg.arkiv_secret_key.as_deref() else {
            return Ok(None);
        };
        let signer = hex_decode(key.strip_prefix("0x").unwrap_or(key))
            .and_then(|b| SigningKey::from_slice(&b).ok())
            .ok_or_else(|| ApiError::unavailable("ARKIV_PRIVATE_KEY is not a valid key"))?;
        Ok(Some(Self {
            rpc: Rpc::new(cfg.arkiv_rpc.clone(), CHAIN_ID),
            operator: address_from_signing_key(&signer).to_lowercase(),
            signer,
            sending: Mutex::new(()),
        }))
    }

    /// Sends [`KEY_FUNDING_WEI`] of Arkiv gas to a browser key. Returns the tx hash.
    pub async fn fund_key(&self, key: &str) -> ApiResult<String> {
        let _sending = self.sending.lock().await;
        let nonce = self
            .rpc
            .quantity("eth_getTransactionCount", json!([self.operator, "pending"]))
            .await? as u64;
        let gas_price = self.rpc.quantity("eth_gasPrice", json!([])).await?;
        let raw = build_eip1559_raw(
            &self.signer,
            CHAIN_ID,
            nonce,
            21_000,
            gas_price * 2,
            gas_price / 10,
            key,
            KEY_FUNDING_WEI,
            &[],
        )?;
        match self.rpc.broadcast(&raw).await {
            Broadcast::Refused(reason) => Err(ApiError::Other(format!(
                "arkiv refused key funding: {reason}"
            ))),
            Broadcast::Accepted(hash) => Ok(hash),
            Broadcast::Unknown(reason) => Err(ApiError::Other(format!(
                "key funding may not have been sent: {reason}"
            ))),
        }
    }

    async fn tick(&self) -> ApiResult<()> {
        let inflight = db()
            .await?
            .read(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT tx, sent_at FROM arkiv_seals WHERE key IS NULL LIMIT 1",
                        [],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .optional()?)
            })
            .await?;
        match inflight {
            Some((hash, sent_at)) => self.resolve(&hash, sent_at).await,
            None => self.send().await,
        }
    }

    async fn send(&self) -> ApiResult<()> {
        let rounds = db().await?.read(pending).await?;
        if rounds.is_empty() {
            return Ok(());
        }
        let _sending = self.sending.lock().await;
        let data = calldata(&rounds, |_| uuid::Uuid::new_v4().as_u128())?;
        let data_hex = format!("0x{}", hex::encode(&data));
        let nonce = self
            .rpc
            .quantity("eth_getTransactionCount", json!([self.operator, "pending"]))
            .await? as u64;
        let gas_price = self.rpc.quantity("eth_gasPrice", json!([])).await?;
        let gas = self
            .rpc
            .quantity(
                "eth_estimateGas",
                json!([{ "from": self.operator, "to": ARKIV, "data": data_hex }]),
            )
            .await? as u64;
        let raw = build_eip1559_raw(
            &self.signer,
            CHAIN_ID,
            nonce,
            gas + gas / 5,
            gas_price * 2,
            gas_price / 10,
            ARKIV,
            0,
            &data,
        )?;
        let raw_bytes = hex_decode(raw.trim_start_matches("0x"))
            .ok_or_else(|| ApiError::Other("signed tx is not hex".into()))?;
        let hash = format!("0x{}", hex::encode(keccak256(&raw_bytes)));

        let ids: Vec<String> = rounds.iter().map(|r| r.bet_id.clone()).collect();
        let marked = hash.clone();
        db().await?
            .write(move |conn| {
                let mut st = conn.prepare_cached(
                    "INSERT INTO arkiv_seals (bet_id, tx, sent_at) VALUES (?1, ?2, ?3)",
                )?;
                let now = now_us();
                for id in &ids {
                    st.execute(params![id, marked, now])?;
                }
                Ok(())
            })
            .await?;

        match self.rpc.broadcast(&raw).await {
            Broadcast::Refused(reason) => {
                self.release(&hash).await?;
                Err(ApiError::Other(format!(
                    "arkiv refused batch {hash}: {reason}"
                )))
            }
            Broadcast::Accepted(_) => {
                tracing::info!("[arkiv] sent {} rounds in {hash}", rounds.len());
                Ok(())
            }
            Broadcast::Unknown(reason) => {
                tracing::warn!("[arkiv] batch {hash} may have been sent: {reason}");
                Ok(())
            }
        }
    }

    async fn resolve(&self, hash: &str, sent_at: i64) -> ApiResult<()> {
        let Some(receipt) = self.rpc.receipt(hash).await? else {
            let dropped = now_us() - sent_at > DROPPED_AFTER_US
                && self.rpc.transaction(hash).await?.is_none();
            if dropped {
                tracing::warn!("[arkiv] batch {hash} was dropped, sending again");
                self.release(hash).await?;
            }
            return Ok(());
        };
        if receipt["status"] != json!("0x1") {
            self.release(hash).await?;
            return Err(ApiError::Other(format!("arkiv batch {hash} reverted")));
        }
        let block = receipt["blockNumber"]
            .as_str()
            .and_then(parse_quantity)
            .ok_or_else(|| ApiError::Other(format!("receipt {hash} has no block")))?
            as i64;
        let topic = entity_created_topic();
        let keys: Vec<String> = receipt["logs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|log| {
                log["address"]
                    .as_str()
                    .is_some_and(|a| a.eq_ignore_ascii_case(ARKIV))
                    && log["topics"][0].as_str() == Some(topic.as_str())
            })
            .filter_map(|log| log["topics"][1].as_str().map(str::to_string))
            .collect();
        let hash = hash.to_string();
        let sealed = db()
            .await?
            .write(move |conn| {
                let ids: Vec<String> = conn
                    .prepare_cached("SELECT bet_id FROM arkiv_seals WHERE tx = ?1 ORDER BY bet_id")?
                    .query_map([&hash], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                if ids.len() != keys.len() {
                    return Err(ApiError::Other(format!(
                        "batch {hash} carried {} rounds but created {} entities",
                        ids.len(),
                        keys.len()
                    )));
                }
                let mut st = conn.prepare_cached(
                    "UPDATE arkiv_seals SET key = ?1, block = ?2 WHERE bet_id = ?3",
                )?;
                for (id, key) in ids.iter().zip(&keys) {
                    st.execute(params![key, block, id])?;
                }
                Ok(ids.len())
            })
            .await?;
        tracing::info!("[arkiv] sealed {sealed} rounds in block {block}");
        SEALED.notify_waiters();
        Ok(())
    }

    async fn release(&self, hash: &str) -> ApiResult<()> {
        let hash = hash.to_string();
        db().await?
            .write(move |conn| {
                conn.execute(
                    "DELETE FROM arkiv_seals WHERE tx = ?1 AND key IS NULL",
                    [hash],
                )?;
                Ok(())
            })
            .await
    }
}

// ponytail: anti-join scans every settled round each tick, add a sealed-up-to watermark if history grows large.
fn pending(conn: &rusqlite::Connection) -> ApiResult<Vec<Sealed>> {
    let mut st = conn.prepare_cached(
        "SELECT bet_id, user_address, currency, asset, mode, direction, stake, multiplier, \
                strike_price, end_price, outcome, payout, settled_at \
         FROM bet_rounds r \
         WHERE outcome IS NOT NULL \
           AND NOT EXISTS (SELECT 1 FROM arkiv_seals s WHERE s.bet_id = r.bet_id) \
           AND length(user_address) = 42 AND lower(user_address) NOT LIKE '0xdemo%' \
           AND lower(bet_id) NOT LIKE 'demo-%' \
         ORDER BY bet_id LIMIT ?1",
    )?;
    let rows = st
        .query_map([BATCH], |r| {
            Ok(Sealed {
                bet_id: r.get(0)?,
                wallet: r.get(1)?,
                currency: r.get(2)?,
                asset: r.get(3)?,
                mode: r.get(4)?,
                direction: r.get(5)?,
                stake: r.get(6)?,
                multiplier: r.get(7)?,
                strike_price: r.get(8)?,
                end_price: r.get(9)?,
                outcome: r.get(10)?,
                payout: r.get(11)?,
                settled_at_us: r.get(12)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Where a bet stands on Arkiv.
pub struct Seal {
    pub settled_at_us: Option<i64>,
    pub key: Option<String>,
    pub block: Option<i64>,
}

async fn seal_of(bet_id: &str) -> ApiResult<Option<Seal>> {
    let bet_id = bet_id.to_string();
    db().await?
        .read(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT r.settled_at, s.key, s.block \
                     FROM bet_rounds r LEFT JOIN arkiv_seals s USING (bet_id) WHERE r.bet_id = ?1",
                    [bet_id],
                    |r| {
                        Ok(Seal {
                            settled_at_us: r.get(0)?,
                            key: r.get(1)?,
                            block: r.get(2)?,
                        })
                    },
                )
                .ok())
        })
        .await
}

/// Holds one request until the bet is sealed or `wait` runs out, so the client
/// asks once instead of polling.
pub async fn wait_for_seal(bet_id: &str, wait: Duration) -> ApiResult<Option<Seal>> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let notified = SEALED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let seal = seal_of(bet_id).await?;
        let done = match &seal {
            None => true,
            Some(s) => s.key.is_some(),
        };
        if done || tokio::time::Instant::now() >= deadline {
            return Ok(seal);
        }
        let _ = tokio::time::timeout_at(deadline, notified).await;
    }
}

pub async fn run_sealer(arkiv: &'static Arkiv) {
    tracing::info!("[arkiv] sealing settled rounds as {}", arkiv.operator);
    loop {
        if let Err(err) = arkiv.tick().await {
            tracing::error!("[arkiv] {err}");
        }
        tokio::time::sleep(TICK).await;
    }
}

/// The funding tx of `key` if we already funded it, and how many keys `wallet` set up in 24h.
pub async fn key_status(key: &str, wallet: &str) -> ApiResult<(Option<String>, i64)> {
    let (k, w) = (key.to_string(), wallet.to_string());
    db().await?
        .read(move |conn| {
            let known: Option<String> = conn
                .query_row("SELECT fund_tx FROM arkiv_keys WHERE key = ?1", [&k], |r| {
                    r.get(0)
                })
                .optional()?;
            let recent: i64 = conn.query_row(
                "SELECT COUNT(*) FROM arkiv_keys WHERE wallet = ?1 AND created_at > ?2",
                params![w, now_us() - 86_400_000_000],
                |r| r.get(0),
            )?;
            Ok((known, recent))
        })
        .await
}

pub async fn record_key(key: &str, wallet: &str, expires_ms: i64, fund_tx: &str) -> ApiResult<()> {
    let (k, w, t) = (key.to_string(), wallet.to_string(), fund_tx.to_string());
    db().await?
        .write(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO arkiv_keys (key, wallet, expires_ms, fund_tx) VALUES (?1, ?2, ?3, ?4)",
                params![k, w, expires_ms, t],
            )?;
            Ok(())
        })
        .await
}
