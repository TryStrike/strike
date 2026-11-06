//! Epoch proofs of settled rounds. A round belongs to the 10 minute epoch its
//! `end_time` falls in. Once an epoch is closed, its rounds hash into a
//! sorted-pair Merkle root that [`run_committer`] writes to
//! `StrikeTreasury.commitRounds`. The leaf is byte-identical in Rust and
//! `verifyRound`.
//!
//! Nothing here runs on the bet path: it only reads rows that are already final.

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};

use crate::address::keccak256;
use crate::bets::now_ms;
use crate::config::config;
use crate::db::{db, Db};
use crate::error::{ApiError, ApiResult};
use crate::eth::{self, Rpc, Treasury};

pub const EPOCH_MS: i64 = 600_000;
/// An epoch commits this long after it ends, so the sweeper has settled it.
pub const CLOSE_GRACE_MS: i64 = 60_000;
const COMMIT_EVERY: Duration = Duration::from_secs(30);
/// A failing commit waits 30 s, doubling to about an hour, so a revert can't burn gas every pass.
const MAX_BACKOFF_DOUBLINGS: u32 = 7;
const ROUNDS_COMMITTED: &str = "RoundsCommitted(uint256,bytes32,uint256)";

pub fn epoch_of(end_time_us: i64) -> u64 {
    end_time_us.div_euclid(1_000).div_euclid(EPOCH_MS) as u64
}

/// `[start, end)` of epoch `n` in milliseconds.
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
            user: evm_user(row.get(1)?),
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
}

/// `0x` and lowercase, the one spelling the leaf and the API share.
fn evm_user(raw: String) -> String {
    let lower = raw.to_lowercase();
    if lower.starts_with("0x") {
        lower
    } else {
        format!("0x{lower}")
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

/// `keccak256(abi.encode(...))` of the 17 fields in docs order: 544 bytes, so a
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
        keccak256(round.strike_source.as_bytes()),
        round
            .end_source
            .as_ref()
            .map_or([0; 32], |source| keccak256(source.as_bytes())),
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

/// A `round_commits` row.
pub struct Commit {
    pub root: String,
    pub tx_hash: String,
}

fn read_commit(conn: &Connection, n: u64) -> ApiResult<Option<Commit>> {
    Ok(conn
        .prepare_cached("SELECT root, tx_hash FROM round_commits WHERE epoch = ?1")?
        .query_row([n as i64], |r| {
            Ok(Commit {
                root: r.get(0)?,
                tx_hash: r.get(1)?,
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
    let mut failures = 0;
    loop {
        tokio::time::sleep(COMMIT_EVERY * 2u32.pow(failures)).await;
        match commit_next(&treasury, next).await {
            Ok(after) => (next, failures) = (after, 0),
            Err(err) => {
                failures = (failures + 1).min(MAX_BACKOFF_DOUBLINGS);
                tracing::error!(
                    "[proofs] commit failed, retrying in {}s: {err}",
                    (COMMIT_EVERY * 2u32.pow(failures)).as_secs()
                );
            }
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
                "INSERT INTO round_commits (epoch, root, rounds, tx_hash) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![n as i64, root_hex, count as i64, tx_hash],
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
            "status": "pending",
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
    Ok(Some(json!({
        "epoch": n,
        "end_ms": epoch_bounds(n).1,
        "leaf": hex32(&leaves[index]),
        "proof": proof(&leaves, index).iter().map(hex32).collect::<Vec<_>>(),
        "house_root": commit.root,
        "commit_tx": commit.tx_hash,
        "status": "committed",
    })))
}

/// `GET /api/proofs/epochs?limit=`: the newest committed epochs.
pub async fn recent_epochs(database: &Db, limit: u32) -> ApiResult<Value> {
    let epochs: Vec<Value> = database
        .read(move |conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT epoch, rounds, tx_hash FROM round_commits ORDER BY epoch DESC LIMIT ?1",
                )?
                .query_map([limit], |r| {
                    Ok(json!({
                        "epoch": r.get::<_, i64>(0)?,
                        "count": r.get::<_, i64>(1)?,
                        "commit_tx": r.get::<_, String>(2)?,
                    }))
                })?
                .collect::<Result<_, _>>()?)
        })
        .await?;
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

    /// A pinned 3-leaf vector.
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
        "0xbcf4aa3a5aea30d352dbbdf86a012c4eda08243c91178ffa7f62c5be17e825ae",
        "0xfca6f393c3bbed8b9cc1dd6a4c2725e402ff40251204392b3b99f05bd63e904f",
        "0xf8c275059a7ff4bb2dc617d39e186abb8e510ca68b63382c56539953d96fa871",
    ];
    const ROOT: &str = "0xb4262fe9dad22b5ead0b31c3ba3bbc4584ad5514485346d93c4bc622c4d1ec54";

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
            Round {
                strike_source: "yahoo".into(),
                ..base.clone()
            },
            Round {
                end_source: Some("yahoo".into()),
                ..base.clone()
            },
            Round {
                end_source: None,
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
        assert_eq!(evm_user(base.user.to_uppercase()), base.user);
        assert_eq!(evm_user(base.user[2..].into()), base.user);
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
    }

    #[test]
    fn an_epoch_closes_after_the_grace_with_nothing_open() {
        let end = epoch_bounds(5).1;
        assert!(!epoch_closed(5, 0, end + CLOSE_GRACE_MS));
        assert!(epoch_closed(5, 0, end + CLOSE_GRACE_MS + 1));
        assert!(!epoch_closed(5, 1, end + CLOSE_GRACE_MS + 1));
    }
}
