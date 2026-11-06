//! Epoch proofs of settled rounds. A round belongs to the 10 minute epoch its
//! `end_time` falls in. Once an epoch is closed, its rounds hash into a
//! sorted-pair Merkle root that [`run_committer`] writes to
//! `StrikeTreasury.commitRounds`, and the Chainlink CRE workflow in
//! `cre/round-attestor` re-settles every round from exchange data and writes its
//! verdict to `RoundAttestor`. The leaf is byte-identical in Rust, the workflow
//! and `verifyRound`.
//!
//! Nothing here runs on the bet path: it only reads rows that are already final.
//! The Chainlink verdict is never stored in our database, only read from Arc.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};

use crate::address::keccak256;
use crate::bets::now_ms;
use crate::config::config;
use crate::db::{db, Db};
use crate::error::{ApiError, ApiResult};
use crate::eth::{self, Attestation, Rpc, Treasury};

pub const EPOCH_MS: i64 = 600_000;
/// An epoch commits this long after it ends, so the sweeper has settled it.
pub const CLOSE_GRACE_MS: i64 = 60_000;
/// About 250 KB of epoch JSON, CRE's HTTP response cap.
pub const MAX_EPOCH_ROUNDS: usize = 1_000;
/// The largest epoch whose bounds still fit in microseconds.
pub const MAX_EPOCH: u64 = (i64::MAX / 1_000 / EPOCH_MS - 1) as u64;
const COMMIT_EVERY: Duration = Duration::from_secs(30);
const CHAIN_CACHE: Duration = Duration::from_secs(30);
/// Ledger money scale 10 down to USDC's 6 decimals.
const LEDGER_PER_USDC_UNIT: i64 = 10_000;
const ROUNDS_COMMITTED: &str = "RoundsCommitted(uint256,bytes32,uint256)";
const EPOCH_ATTESTED: &str = "EpochAttested(uint256,bytes32,uint32,uint32,uint32)";

pub fn epoch_of(end_time_us: i64) -> u64 {
    end_time_us.div_euclid(1_000).div_euclid(EPOCH_MS) as u64
}

/// `[start, end)` of epoch `n` in milliseconds. `n` is at most [`MAX_EPOCH`].
pub fn epoch_bounds(n: u64) -> (i64, i64) {
    let start = n as i64 * EPOCH_MS;
    (start, start + EPOCH_MS)
}

pub fn epoch_closed(n: u64, open_rounds: i64, now_ms: i64) -> bool {
    open_rounds == 0 && now_ms > epoch_bounds(n).1 + CLOSE_GRACE_MS
}

/// A settled `bet_rounds` row as the leaf commits it. Prices have 8 decimals,
/// money 10, the multiplier 4, and every time is in microseconds as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Round {
    pub bet_id: String,
    pub user: String,
    pub asset: String,
    pub mode: String,
    pub direction: String,
    pub stake: i64,
    pub multiplier: i64,
    pub strike: i64,
    pub strike_at: i64,
    pub strike_source: String,
    pub top: Option<i64>,
    pub bottom: Option<i64>,
    pub end_time: i64,
    pub end_price: Option<i64>,
    pub end_price_at: Option<i64>,
    pub end_source: Option<String>,
    pub outcome: String,
    pub payout: i64,
}

const ROUND_COLUMNS: &str = "bet_id, user_address, asset, mode, direction, stake, multiplier, \
     strike_price, strike_at, strike_source, price_top, price_bottom, end_time, end_price, \
     end_price_at, end_source, outcome, payout";

impl Round {
    fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            bet_id: row.get(0)?,
            user: row.get(1)?,
            asset: row.get(2)?,
            mode: row.get(3)?,
            direction: row.get(4)?,
            stake: row.get(5)?,
            multiplier: row.get(6)?,
            strike: row.get(7)?,
            strike_at: row.get(8)?,
            strike_source: row.get(9)?,
            top: row.get(10)?,
            bottom: row.get(11)?,
            end_time: row.get(12)?,
            end_price: row.get(13)?,
            end_price_at: row.get(14)?,
            end_source: row.get(15)?,
            outcome: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
            payout: row.get::<_, Option<i64>>(17)?.unwrap_or_default(),
        })
    }

    fn to_json(&self, leaf: &[u8; 32]) -> Value {
        let text = |v: Option<i64>| v.map(|v| v.to_string());
        json!({
            "bet_id": self.bet_id,
            "user": self.user.to_lowercase(),
            "asset": self.asset,
            "mode": self.mode,
            "direction": self.direction,
            "stake": self.stake.to_string(),
            "multiplier": self.multiplier.to_string(),
            "strike": self.strike.to_string(),
            "strike_at": self.strike_at,
            "strike_source": self.strike_source,
            "top": text(self.top),
            "bottom": text(self.bottom),
            "end_time": self.end_time,
            "end_price": text(self.end_price),
            "end_price_at": self.end_price_at,
            "end_source": self.end_source,
            "outcome": self.outcome,
            "payout": self.payout.to_string(),
            "leaf": hex32(leaf),
        })
    }
}

pub fn hex32(word: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(word))
}

fn word_int(value: i64) -> [u8; 32] {
    let mut word = if value < 0 { [0xff; 32] } else { [0; 32] };
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn word_uint(value: i64, field: &str, bet_id: &str) -> ApiResult<[u8; 32]> {
    if value < 0 {
        return Err(ApiError::Other(format!(
            "round {bet_id} has a negative {field} ({value})"
        )));
    }
    Ok(word_int(value))
}

fn code(value: &str, codes: &[&str], field: &str, bet_id: &str) -> ApiResult<[u8; 32]> {
    let index = codes.iter().position(|c| *c == value).ok_or_else(|| {
        ApiError::Other(format!("round {bet_id} has an unknown {field} {value:?}"))
    })?;
    Ok(word_int(index as i64))
}

/// `keccak256(abi.encode(...))` of the 15 fields in docs order: 480 bytes, so a
/// leaf can never pass for a 64-byte inner node.
pub fn leaf(round: &Round) -> ApiResult<[u8; 32]> {
    let id = round.bet_id.as_str();
    let user = hex::decode(round.user.strip_prefix("0x").unwrap_or(&round.user))
        .ok()
        .filter(|bytes| bytes.len() == 20)
        .ok_or_else(|| {
            ApiError::Other(format!(
                "round {id} user {} is not an EVM address",
                round.user
            ))
        })?;
    let mut user_word = [0u8; 32];
    user_word[12..].copy_from_slice(&user);

    let words = [
        keccak256(round.bet_id.as_bytes()),
        user_word,
        keccak256(round.asset.as_bytes()),
        code(&round.mode, &["binomo", "box", "draw"], "mode", id)?,
        code(&round.direction, &["UP", "DOWN"], "direction", id)?,
        word_uint(round.stake, "stake", id)?,
        word_uint(round.multiplier, "multiplier", id)?,
        word_int(round.strike),
        word_int(round.top.unwrap_or(0)),
        word_int(round.bottom.unwrap_or(0)),
        word_uint(round.strike_at, "strike_at", id)?,
        word_uint(round.end_price_at.unwrap_or(0), "end_price_at", id)?,
        word_int(round.end_price.unwrap_or(0)),
        code(
            &round.outcome,
            &["win", "loss", "tie", "refund_no_price", "withheld"],
            "outcome",
            id,
        )?,
        word_uint(round.payout, "payout", id)?,
    ];
    Ok(keccak256(&words.concat()))
}

/// `verifyRound`'s parent: the smaller hash first.
fn parent(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (low, high) = if a <= b { (a, b) } else { (b, a) };
    keccak256(&[&low[..], &high[..]].concat())
}

/// One level up. An odd node is promoted unchanged.
fn level_up(level: &[[u8; 32]]) -> Vec<[u8; 32]> {
    level
        .chunks(2)
        .map(|pair| match pair {
            [a, b] => parent(a, b),
            [a] => *a,
            _ => unreachable!("chunks(2)"),
        })
        .collect()
}

/// Root of leaves already sorted by `bet_id`. `None` for an empty epoch.
pub fn root(leaves: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        level = level_up(&level);
    }
    level.first().copied()
}

/// The siblings `verifyRound` folds to get from leaf `index` to the root.
pub fn proof(leaves: &[[u8; 32]], mut index: usize) -> Vec<[u8; 32]> {
    let mut level = leaves.to_vec();
    let mut siblings = Vec::new();
    while level.len() > 1 {
        if let Some(sibling) = level.get(index ^ 1) {
            siblings.push(*sibling);
        }
        level = level_up(&level);
        index /= 2;
    }
    siblings
}

/// The epoch's settled rounds sorted by `bet_id`, and how many are still open.
pub struct EpochRows {
    pub open: i64,
    pub rounds: Vec<Round>,
}

fn read_epoch_rows(conn: &Connection, n: u64) -> ApiResult<EpochRows> {
    let (start, end) = epoch_bounds(n);
    let range = params![start * 1_000, end * 1_000];
    let open = conn
        .prepare_cached(
            "SELECT count(*) FROM bet_rounds \
             WHERE end_time >= ?1 AND end_time < ?2 AND outcome IS NULL",
        )?
        .query_row(range, |r| r.get(0))?;
    let rounds = conn
        .prepare_cached(&format!(
            "SELECT {ROUND_COLUMNS} FROM bet_rounds \
             WHERE end_time >= ?1 AND end_time < ?2 AND outcome IS NOT NULL ORDER BY bet_id"
        ))?
        .query_map(range, Round::from_row)?
        .collect::<Result<_, _>>()?;
    Ok(EpochRows { open, rounds })
}

pub async fn epoch_rounds(database: &Db, n: u64) -> ApiResult<EpochRows> {
    database.read(move |conn| read_epoch_rows(conn, n)).await
}

/// USDC owed to players right now, in 6 decimals: every USDC balance plus the
/// stake of every open USDC round, rounded up so it never understates.
pub async fn liabilities_usdc(database: &Db) -> ApiResult<u128> {
    let ledger: i64 = database
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT (SELECT COALESCE(SUM(balance), 0) FROM user_balances WHERE currency = 'USDC') \
                      + (SELECT COALESCE(SUM(stake), 0) FROM bet_rounds \
                          WHERE outcome IS NULL AND currency = 'USDC')",
                [],
                |r| r.get(0),
            )?)
        })
        .await?;
    Ok(ledger.max(0).div_euclid(LEDGER_PER_USDC_UNIT) as u128
        + u128::from(ledger.rem_euclid(LEDGER_PER_USDC_UNIT) > 0))
}

/// A `round_commits` row.
pub struct Commit {
    pub root: String,
    pub rounds: i64,
    pub liabilities_usdc: String,
    pub tx_hash: String,
    pub created_at_us: i64,
}

fn read_commit(conn: &Connection, n: u64) -> ApiResult<Option<Commit>> {
    Ok(conn
        .prepare_cached(
            "SELECT root, rounds, liabilities_usdc, tx_hash, created_at \
             FROM round_commits WHERE epoch = ?1",
        )?
        .query_row([n as i64], |r| {
            Ok(Commit {
                root: r.get(0)?,
                rounds: r.get(1)?,
                liabilities_usdc: r.get(2)?,
                tx_hash: r.get(3)?,
                created_at_us: r.get(4)?,
            })
        })
        .optional()?)
}

fn leaves_of(rounds: &[Round]) -> ApiResult<Vec<[u8; 32]>> {
    rounds.iter().map(leaf).collect()
}

/// A recomputed root that is not the committed one means the ledger changed
/// after the commit. Served as is, so a checker sees it, and logged loudly.
fn flag_root_drift(n: u64, ours: &[u8; 32], commit: &Commit) {
    if hex32(ours) != commit.root {
        tracing::error!(
            "[proofs] epoch {n} rows hash to {} but {} was committed",
            hex32(ours),
            commit.root
        );
    }
}

// ---------------------------------------------------------------------------
// committer
// ---------------------------------------------------------------------------

/// Commits every closed epoch from `PROOFS_START_EPOCH` on, one per pass, for the
/// life of the process. Empty epochs are never committed.
pub async fn run_committer() {
    let Some(start) = config().proofs_start_epoch else {
        tracing::error!("[proofs] PROOFS_START_EPOCH is not set, the round committer is off");
        return;
    };
    let treasury = match Treasury::from_config() {
        Ok(treasury) => treasury,
        Err(err) => {
            tracing::error!("[proofs] round committer is off: {err}");
            return;
        }
    };
    let mut next = start;
    let mut every = tokio::time::interval(COMMIT_EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        match commit_next(&treasury, next).await {
            Ok(after) => next = after,
            Err(err) => tracing::error!("[proofs] commit failed, will retry: {err}"),
        }
    }
}

/// The first epoch at or after `from` with any round in it.
async fn first_epoch_from(database: &Db, from: u64) -> ApiResult<Option<u64>> {
    let start_us = epoch_bounds(from).0 * 1_000;
    let first: Option<i64> = database
        .read(move |conn| {
            Ok(conn
                .prepare_cached("SELECT MIN(end_time) FROM bet_rounds WHERE end_time >= ?1")?
                .query_row([start_us], |r| r.get(0))?)
        })
        .await?;
    Ok(first.map(epoch_of))
}

/// Commits the oldest closed, uncommitted epoch at or after `from` and returns
/// where the next pass starts.
async fn commit_next(treasury: &Treasury, from: u64) -> ApiResult<u64> {
    let database = db().await?;
    let mut n = from;
    let rows = loop {
        let Some(found) = first_epoch_from(database, n).await? else {
            return Ok(n);
        };
        n = found;
        let (commit, rows) = database
            .read(move |conn| Ok((read_commit(conn, found)?, read_epoch_rows(conn, found)?)))
            .await?;
        if commit.is_none() {
            break rows;
        }
        n += 1;
    };
    if !epoch_closed(n, rows.open, now_ms()) {
        return Ok(n);
    }
    let leaves = leaves_of(&rows.rounds)?;
    let Some(ours) = root(&leaves) else {
        return Ok(n + 1);
    };
    let count = rows.rounds.len();
    if count > MAX_EPOCH_ROUNDS {
        tracing::warn!(
            "[proofs] epoch {n} has {count} rounds, over the {MAX_EPOCH_ROUNDS} its API serves"
        );
    }
    let liabilities = liabilities_usdc(database).await?;

    let cfg = config();
    let rpc = Rpc::from_config();
    let onchain = eth::round_root(&rpc, &cfg.treasury_address, n).await?;
    let tx = if onchain == [0; 32] {
        treasury.commit_rounds(n, ours, count as u64).await?
    } else if onchain == ours {
        match eth::epoch_event_tx(&rpc, &cfg.treasury_address, ROUNDS_COMMITTED, n).await? {
            Some(tx) => tx,
            None => {
                tracing::error!(
                    "[proofs] epoch {n} root {} is on chain but its commit tx is past the log \
                     window. Insert the round_commits row by hand.",
                    hex32(&ours)
                );
                return Ok(n + 1);
            }
        }
    } else {
        tracing::error!(
            "[proofs] epoch {n} has root {} on chain but the ledger hashes to {}. Not resending.",
            hex32(&onchain),
            hex32(&ours)
        );
        return Ok(n + 1);
    };

    let (root_hex, tx_hash) = (hex32(&ours), tx.clone());
    database
        .write(move |conn| {
            conn.execute(
                "INSERT INTO round_commits (epoch, root, rounds, liabilities_usdc, tx_hash) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    n as i64,
                    root_hex,
                    count as i64,
                    liabilities.to_string(),
                    tx_hash
                ],
            )?;
            Ok(())
        })
        .await?;
    tracing::info!("[proofs] committed epoch {n}, {count} rounds, tx {tx}");
    Ok(n + 1)
}

// ---------------------------------------------------------------------------
// public reads
// ---------------------------------------------------------------------------

pub enum EpochRead {
    /// Not closed, or closed and not committed yet.
    Open,
    Empty,
    TooLarge(usize),
    Ready(Value),
}

/// `GET /api/proofs/epoch/{n}`: immutable once committed, liabilities included,
/// so every CRE node reads the same bytes.
pub async fn epoch_json(database: &Db, n: u64) -> ApiResult<EpochRead> {
    let (commit, rows) = database
        .read(move |conn| Ok((read_commit(conn, n)?, read_epoch_rows(conn, n)?)))
        .await?;
    let Some(commit) = commit else {
        let closed = epoch_closed(n, rows.open, now_ms());
        return Ok(if closed && rows.rounds.is_empty() {
            EpochRead::Empty
        } else {
            EpochRead::Open
        });
    };
    if rows.rounds.len() > MAX_EPOCH_ROUNDS {
        return Ok(EpochRead::TooLarge(rows.rounds.len()));
    }
    let leaves = leaves_of(&rows.rounds)?;
    let ours = root(&leaves).unwrap_or([0; 32]);
    flag_root_drift(n, &ours, &commit);
    let (start_ms, end_ms) = epoch_bounds(n);
    let rounds: Vec<Value> = rows
        .rounds
        .iter()
        .zip(&leaves)
        .map(|(round, leaf)| round.to_json(leaf))
        .collect();
    Ok(EpochRead::Ready(json!({
        "epoch": n,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "root": hex32(&ours),
        "count": rounds.len(),
        "commit_tx": commit.tx_hash,
        "liabilities_usdc": commit.liabilities_usdc,
        "liabilities_at_ms": commit.created_at_us.div_euclid(1_000),
        "rounds": rounds,
    })))
}

/// A verdict and the transaction that wrote it.
type Verdict = (Attestation, Option<String>);

type VerdictCache = Mutex<HashMap<u64, (Option<Verdict>, Instant)>>;

static VERDICTS: LazyLock<VerdictCache> = LazyLock::new(Mutex::default);

/// The Chainlink verdict for epoch `n`, read from Arc. A verdict is write-once,
/// so a complete one is cached for good and anything else for 30 s. `None` when
/// no attestor is configured or nothing is attested yet.
pub async fn verdict(n: u64) -> ApiResult<Option<Verdict>> {
    let Some(attestor) = config().round_attestor_address.clone() else {
        return Ok(None);
    };
    if !crate::address::is_address_shape(&attestor) {
        return Err(ApiError::internal(
            "NEXT_PUBLIC_ROUND_ATTESTOR_ADDRESS is not a valid address",
        ));
    }
    if let Some((cached, at)) = VERDICTS.lock().expect("verdict cache").get(&n) {
        let complete = matches!(cached, Some((_, Some(_))));
        if complete || at.elapsed() < CHAIN_CACHE {
            return Ok(cached.clone());
        }
    }
    let rpc = Rpc::from_config();
    let unavailable = |err: ApiError| {
        tracing::error!("[proofs] attestation read for epoch {n} failed: {err}");
        ApiError::json(
            axum::http::StatusCode::BAD_GATEWAY,
            "attestation_read_failed",
        )
    };
    let found = match eth::attestation(&rpc, &attestor, n)
        .await
        .map_err(unavailable)?
    {
        Some(attestation) => {
            let tx = eth::epoch_event_tx(&rpc, &attestor, EPOCH_ATTESTED, n)
                .await
                .map_err(unavailable)?;
            Some((attestation, tx))
        }
        None => None,
    };
    VERDICTS
        .lock()
        .expect("verdict cache")
        .insert(n, (found.clone(), Instant::now()));
    Ok(found)
}

/// `verified` only when Chainlink's root is the house root and nothing mismatched.
pub fn status(house_root: &str, verdict: Option<&Verdict>) -> &'static str {
    match verdict {
        None => "committed",
        Some((a, _)) if a.mismatches == 0 && hex32(&a.root) == house_root => "verified",
        Some(_) => "mismatch",
    }
}

fn verdict_json(verdict: &Verdict) -> Value {
    let (a, tx) = verdict;
    json!({
        "root": hex32(&a.root),
        "checked": a.checked,
        "mismatches": a.mismatches,
        "skipped": a.skipped,
        "usdc_balance": a.usdc_balance.to_string(),
        "liabilities": a.liabilities.to_string(),
        "attested_at": a.attested_at,
        "tx": tx,
    })
}

/// `GET /api/proofs/bet/{id}`. `None` for an unknown bet.
pub async fn bet_proof(database: &Db, bet_id: &str) -> ApiResult<Option<Value>> {
    let id = bet_id.to_string();
    let found = database
        .read(move |conn| {
            let Some(round) = conn
                .prepare_cached(&format!(
                    "SELECT {ROUND_COLUMNS} FROM bet_rounds WHERE bet_id = ?1"
                ))?
                .query_row([&id], Round::from_row)
                .optional()?
            else {
                return Ok(None);
            };
            let n = epoch_of(round.end_time);
            let commit = read_commit(conn, n)?;
            let rows = commit
                .is_some()
                .then(|| read_epoch_rows(conn, n))
                .transpose()?;
            Ok(Some((round, n, commit, rows)))
        })
        .await?;
    let Some((round, n, commit, rows)) = found else {
        return Ok(None);
    };
    let (Some(commit), Some(rows)) = (commit, rows) else {
        let leaf = (!round.outcome.is_empty())
            .then(|| leaf(&round))
            .transpose()?;
        return Ok(Some(json!({
            "epoch": n,
            "end_ms": epoch_bounds(n).1,
            "leaf": leaf.as_ref().map(hex32),
            "proof": null,
            "house_root": null,
            "commit_tx": null,
            "attestation": null,
            "status": "pending",
            "strike_source": round.strike_source,
        })));
    };
    let leaves = leaves_of(&rows.rounds)?;
    let index = rows
        .rounds
        .binary_search_by(|r| r.bet_id.as_str().cmp(bet_id))
        .map_err(|_| {
            ApiError::Other(format!("bet {bet_id} is missing from committed epoch {n}"))
        })?;
    let ours = root(&leaves).unwrap_or([0; 32]);
    flag_root_drift(n, &ours, &commit);
    let verdict = verdict(n).await?;
    Ok(Some(json!({
        "epoch": n,
        "end_ms": epoch_bounds(n).1,
        "leaf": hex32(&leaves[index]),
        "proof": proof(&leaves, index).iter().map(hex32).collect::<Vec<_>>(),
        "house_root": commit.root,
        "commit_tx": commit.tx_hash,
        "attestation": verdict.as_ref().map(verdict_json),
        "status": status(&commit.root, verdict.as_ref()),
        "strike_source": round.strike_source,
    })))
}

/// `GET /api/proofs/epochs?limit=`: the newest committed epochs with their verdicts.
pub async fn recent_epochs(database: &Db, limit: u32) -> ApiResult<Value> {
    let commits: Vec<(u64, i64, String, String)> = database
        .read(move |conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT epoch, rounds, tx_hash, root FROM round_commits \
                     ORDER BY epoch DESC LIMIT ?1",
                )?
                .query_map([limit], |r| {
                    Ok((r.get::<_, i64>(0)? as u64, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<_, _>>()?)
        })
        .await?;
    let verdicts = futures::future::try_join_all(commits.iter().map(|(n, ..)| verdict(*n))).await?;
    let epochs: Vec<Value> = commits
        .iter()
        .zip(&verdicts)
        .map(|((n, count, tx, house_root), verdict)| {
            let a = verdict.as_ref().map(|(a, _)| a);
            json!({
                "epoch": n,
                "count": count,
                "commit_tx": tx,
                "status": status(house_root, verdict.as_ref()),
                "checked": a.map(|a| a.checked),
                "mismatches": a.map(|a| a.mismatches),
                "skipped": a.map(|a| a.skipped),
                "solvency_bps": a
                    .filter(|a| a.liabilities > 0)
                    .map(|a| {
                        u64::try_from(a.usdc_balance.saturating_mul(10_000) / a.liabilities)
                            .unwrap_or(u64::MAX)
                    }),
            })
        })
        .collect();
    Ok(Value::Array(epochs))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// verifyRound, line for line.
    fn verify(root: &[u8; 32], leaf: &[u8; 32], proof: &[[u8; 32]]) -> bool {
        let node = proof
            .iter()
            .fold(*leaf, |node, sibling| parent(&node, sibling));
        node == *root
    }

    /// The shared 3-leaf vector: Foundry and the CRE workflow assert the same
    /// leaves and root.
    pub(super) fn vector() -> Vec<Round> {
        let base = Round {
            bet_id: "bet-a".into(),
            user: "0x1111111111111111111111111111111111111111".into(),
            asset: "BTC".into(),
            mode: "binomo".into(),
            direction: "UP".into(),
            stake: 100_000_000_000,
            multiplier: 17_500,
            strike: 10_000_000_000_000,
            strike_at: 1_800_000_000_000_000,
            strike_source: "binance".into(),
            top: None,
            bottom: None,
            end_time: 1_800_000_005_000_000,
            end_price: Some(10_000_100_000_000),
            end_price_at: Some(1_800_000_004_900_000),
            end_source: Some("binance".into()),
            outcome: "win".into(),
            payout: 175_000_000_000,
        };
        vec![
            base.clone(),
            Round {
                bet_id: "bet-b".into(),
                user: "0x2222222222222222222222222222222222222222".into(),
                asset: "ETH".into(),
                mode: "box".into(),
                direction: "DOWN".into(),
                stake: 50_000_000_000,
                multiplier: 30_000,
                strike: 300_000_000_000,
                top: Some(301_000_000_000),
                bottom: Some(300_500_000_000),
                end_price: Some(299_900_000_000),
                outcome: "loss".into(),
                payout: 0,
                ..base.clone()
            },
            Round {
                bet_id: "bet-c".into(),
                user: "0x3333333333333333333333333333333333333333".into(),
                asset: "SOL".into(),
                direction: "DOWN".into(),
                multiplier: 18_000,
                strike: 15_000_000_000,
                end_price: None,
                end_price_at: None,
                end_source: None,
                outcome: "refund_no_price".into(),
                payout: 100_000_000_000,
                ..base
            },
        ]
    }

    const LEAVES: [&str; 3] = [
        "0xe99632a99ff3254fa7702d6542e436e810b70664df4fdcacb0448e3a021e6c36",
        "0x1baeabcd9c9fe3979e68597d35028c6044047223f3068977594c26122f5cf69e",
        "0xa6e81ab1280f51c9ee42cce43ac14c46996c43926dc6e7cd41726724b989c257",
    ];
    const ROOT: &str = "0x360651e991f69e45477db9f7ef08e7ff9a6a993a107557f192cc8ba645d9b93e";

    #[test]
    fn the_shared_vector_hashes_to_its_pinned_root() {
        let leaves = leaves_of(&vector()).unwrap();
        let hexes: Vec<String> = leaves.iter().map(hex32).collect();
        let root = hex32(&root(&leaves).unwrap());
        assert_eq!(hexes, LEAVES);
        assert_eq!(root, ROOT);
    }

    #[test]
    fn every_leaf_proves_into_the_root_odd_node_included() {
        for size in 1..=9 {
            let leaves: Vec<[u8; 32]> = (0..size).map(|i| keccak256(&[i as u8])).collect();
            let top = root(&leaves).unwrap();
            for (i, leaf) in leaves.iter().enumerate() {
                assert!(
                    verify(&top, leaf, &proof(&leaves, i)),
                    "size {size} leaf {i}"
                );
                assert!(!verify(&top, &keccak256(b"other"), &proof(&leaves, i)));
            }
        }
        assert_eq!(root(&[]), None);
        let one = keccak256(b"one");
        assert_eq!(root(&[one]), Some(one));
        assert!(proof(&[one], 0).is_empty());
    }

    #[test]
    fn three_leaves_promote_the_odd_one() {
        let leaves = leaves_of(&vector()).unwrap();
        let expected = parent(&parent(&leaves[0], &leaves[1]), &leaves[2]);
        assert_eq!(root(&leaves).unwrap(), expected);
        assert_eq!(proof(&leaves, 2), vec![parent(&leaves[0], &leaves[1])]);
    }

    #[test]
    fn a_leaf_commits_every_field() {
        let base = &vector()[0];
        let original = leaf(base).unwrap();
        let changed = [
            Round {
                payout: base.payout - 1,
                ..base.clone()
            },
            Round {
                end_price: Some(1),
                ..base.clone()
            },
            Round {
                outcome: "loss".into(),
                ..base.clone()
            },
            Round {
                direction: "DOWN".into(),
                ..base.clone()
            },
            Round {
                user: "0x1111111111111111111111111111111111111112".into(),
                ..base.clone()
            },
        ];
        for round in changed {
            assert_ne!(leaf(&round).unwrap(), original);
        }
        // Address case is spelling, not identity.
        let upper = Round {
            user: base.user.to_uppercase().replace("0X", "0x"),
            ..base.clone()
        };
        assert_eq!(leaf(&upper).unwrap(), original);
    }

    #[test]
    fn a_malformed_round_is_refused_not_hashed() {
        let base = &vector()[0];
        for round in [
            Round {
                user: "Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4".into(),
                ..base.clone()
            },
            Round {
                mode: "spin".into(),
                ..base.clone()
            },
            Round {
                outcome: String::new(),
                ..base.clone()
            },
            Round {
                stake: -1,
                ..base.clone()
            },
        ] {
            assert!(leaf(&round).is_err());
        }
    }

    #[test]
    fn negative_ints_are_sign_extended() {
        assert_eq!(word_int(-1), [0xff; 32]);
        assert_eq!(word_int(1)[31], 1);
    }

    #[test]
    fn epochs_follow_end_time_in_microseconds() {
        assert_eq!(epoch_of(0), 0);
        assert_eq!(epoch_of(EPOCH_MS * 1_000 - 1), 0);
        assert_eq!(epoch_of(EPOCH_MS * 1_000), 1);
        assert_eq!(epoch_bounds(3), (3 * EPOCH_MS, 4 * EPOCH_MS));
        let (_, end) = epoch_bounds(MAX_EPOCH);
        assert!(end.checked_mul(1_000).is_some());
    }

    #[test]
    fn an_epoch_closes_after_the_grace_with_nothing_open() {
        let end = epoch_bounds(5).1;
        assert!(!epoch_closed(5, 0, end + CLOSE_GRACE_MS));
        assert!(epoch_closed(5, 0, end + CLOSE_GRACE_MS + 1));
        assert!(!epoch_closed(5, 1, end + CLOSE_GRACE_MS + 1));
    }

    #[test]
    fn only_an_agreeing_clean_verdict_is_verified() {
        let leaves = leaves_of(&vector()).unwrap();
        let house = hex32(&root(&leaves).unwrap());
        let attestation = Attestation {
            root: root(&leaves).unwrap(),
            checked: 3,
            mismatches: 0,
            skipped: 0,
            usdc_balance: 2,
            liabilities: 1,
            attested_at: 1,
        };
        assert_eq!(status(&house, None), "committed");
        assert_eq!(
            status(&house, Some(&(attestation.clone(), None))),
            "verified"
        );
        let dirty = Attestation {
            mismatches: 1,
            ..attestation.clone()
        };
        assert_eq!(status(&house, Some(&(dirty, None))), "mismatch");
        let other = Attestation {
            root: [1; 32],
            ..attestation
        };
        assert_eq!(status(&house, Some(&(other, None))), "mismatch");
    }
}
