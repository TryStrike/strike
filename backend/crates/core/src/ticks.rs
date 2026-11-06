//! Recent prices: fixed-size in-memory rings, flushed to their own SQLite file.
//!
//! The rings are the price cache: `prices` records every upstream quote here and
//! reads the latest back, so a price read never touches disk. `prices::run_sampler`
//! quotes every tradable asset whether or not anyone is connected. Only those
//! upstream responses are recorded: no request body or query reaches [`TickBuffer::record`].
//!
//! Memory is bounded: one ring per asset the price tables know, each holding
//! `ring_capacity()` ticks of 32 bytes.
//!
//! A background task writes new ticks to `TICKS_SQLITE_PATH` every
//! `TICK_FLUSH_SECS`, a file that is never the ledger, with `synchronous=NORMAL`.
//! Raw ticks older than `TICK_RETENTION_DAYS` become 1-minute candles, in the same
//! transaction that deletes them, on whole minutes so no candle is split.
//!
//! Loss is accepted and bounded. Stopping the process for any reason loses the
//! ticks since the last flush, and a power cut can lose a little more because of
//! `NORMAL`. Nothing depends on them: no ledger path reads this store, and a flush
//! failure only logs and retries.
//!
//! Settlement reads the rings and never this file, so a restart loses the prices
//! it would have needed. `settlement` turns that into a refund. The prices that
//! did settle a round are permanent columns of `bet_rounds`.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};

use crate::config::config;
use crate::error::{ApiError, ApiResult};
use crate::prices::now_millis;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS ticks (
  symbol TEXT NOT NULL,
  ts     INTEGER NOT NULL, -- unix seconds
  price  REAL NOT NULL,
  PRIMARY KEY (symbol, ts)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ticks_by_time ON ticks (ts);
CREATE TABLE IF NOT EXISTS candles_1m (
  symbol TEXT NOT NULL,
  minute INTEGER NOT NULL, -- unix seconds at the start of the minute
  open   REAL NOT NULL,
  high   REAL NOT NULL,
  low    REAL NOT NULL,
  close  REAL NOT NULL,
  ticks  INTEGER NOT NULL,
  PRIMARY KEY (symbol, minute)
) STRICT, WITHOUT ROWID;
";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tick {
    pub at_ms: i64,
    pub price: f64,
    /// The upstream that quoted it, stored with any round it settles.
    pub source: &'static str,
}

#[derive(Default)]
struct Ring {
    ticks: VecDeque<Tick>,
    /// Newest `at_ms` known to be on disk.
    flushed_ms: i64,
}

pub struct TickBuffer {
    capacity: usize,
    rings: Mutex<HashMap<String, Ring>>,
}

impl TickBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            rings: Mutex::new(HashMap::new()),
        }
    }

    /// Keeps one tick per second per asset, the newest quote of that second.
    pub fn record(&self, asset: &str, price: f64, at_ms: i64, source: &'static str) {
        let Ok(mut rings) = self.rings.lock() else {
            return;
        };
        if !rings.contains_key(asset) {
            rings.insert(asset.to_string(), Ring::default());
        }
        let Some(ring) = rings.get_mut(asset) else {
            return;
        };
        let tick = Tick {
            at_ms,
            price,
            source,
        };
        match ring.ticks.back_mut() {
            Some(last) if at_ms.div_euclid(1000) == last.at_ms.div_euclid(1000) => *last = tick,
            Some(last) if at_ms < last.at_ms => {}
            _ => {
                if ring.ticks.len() == self.capacity {
                    ring.ticks.pop_front();
                }
                ring.ticks.push_back(tick);
            }
        }
    }

    pub fn latest(&self, asset: &str) -> Option<Tick> {
        self.rings.lock().ok()?.get(asset)?.ticks.back().copied()
    }

    /// The newest tick at or before `at_ms`. Rings are ordered, oldest first.
    pub fn at_or_before(&self, asset: &str, at_ms: i64) -> Option<Tick> {
        let rings = self.rings.lock().ok()?;
        let ticks = &rings.get(asset)?.ticks;
        ticks.iter().rev().find(|tick| tick.at_ms <= at_ms).copied()
    }

    /// Every tick at or after `since_ms`, oldest first.
    pub fn since(&self, asset: &str, since_ms: i64) -> Vec<Tick> {
        let Ok(rings) = self.rings.lock() else {
            return Vec::new();
        };
        rings.get(asset).map_or_else(Vec::new, |ring| {
            ring.ticks
                .iter()
                .filter(|t| t.at_ms >= since_ms)
                .copied()
                .collect()
        })
    }

    /// The oldest tick at or after `since_ms`.
    pub fn first_since(&self, asset: &str, since_ms: i64) -> Option<Tick> {
        let rings = self.rings.lock().ok()?;
        let ticks = &rings.get(asset)?.ticks;
        ticks.iter().find(|tick| tick.at_ms >= since_ms).copied()
    }

    /// High minus low of the ticks at or after `since_ms`; 0 with fewer than two.
    pub fn range(&self, asset: &str, since_ms: i64) -> f64 {
        let Ok(rings) = self.rings.lock() else {
            return 0.0;
        };
        let Some(ring) = rings.get(asset) else {
            return 0.0;
        };
        let recent = ring.ticks.iter().rev().take_while(|t| t.at_ms >= since_ms);
        let (low, high) = recent.fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), tick| {
            (low.min(tick.price), high.max(tick.price))
        });
        (high - low).max(0.0)
    }

    /// Writes everything newer than the last flush. The lock is not held across
    /// the write, and a failed write stays pending for the next call.
    pub fn flush_into(&self, conn: &mut Connection) -> ApiResult<usize> {
        let pending: Vec<(String, Vec<Tick>)> = {
            let rings = self.rings.lock().map_err(|_| poisoned())?;
            rings
                .iter()
                .map(|(asset, ring)| {
                    let new = ring.ticks.iter().filter(|t| t.at_ms > ring.flushed_ms);
                    (asset.clone(), new.copied().collect())
                })
                .collect()
        };

        let tx = conn.transaction()?;
        let mut written = 0;
        {
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO ticks (symbol, ts, price) VALUES (?1, ?2, ?3)",
            )?;
            for (asset, ticks) in &pending {
                for tick in ticks {
                    insert.execute(params![asset, tick.at_ms.div_euclid(1000), tick.price])?;
                    written += 1;
                }
            }
        }
        tx.commit()?;

        let mut rings = self.rings.lock().map_err(|_| poisoned())?;
        for (asset, ticks) in pending {
            if let (Some(ring), Some(last)) = (rings.get_mut(&asset), ticks.last()) {
                ring.flushed_ms = last.at_ms;
            }
        }
        Ok(written)
    }

    #[cfg(test)]
    fn len(&self, asset: &str) -> usize {
        self.rings.lock().unwrap()[asset].ticks.len()
    }
}

fn poisoned() -> ApiError {
    ApiError::Other("tick buffer lock poisoned".to_string())
}

/// Enough to hold a full flush interval, so a healthy flusher drops nothing.
fn ring_capacity() -> usize {
    let cfg = config();
    cfg.tick_ring_secs.max(cfg.tick_flush_secs as usize + 60)
}

static BUFFER: Lazy<TickBuffer> = Lazy::new(|| TickBuffer::new(ring_capacity()));

/// The process-wide rings.
pub fn buffer() -> &'static TickBuffer {
    &BUFFER
}

pub fn open_store(path: &Path) -> ApiResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Rolls raw ticks before `now_s - retention_days` into candles and deletes them.
/// Returns how many raw rows went. A row arriving for an already-rolled minute
/// widens that candle instead of replacing it.
pub fn roll_up(conn: &mut Connection, now_s: i64, retention_days: u64) -> ApiResult<usize> {
    let cutoff = (now_s - retention_days as i64 * 86_400).div_euclid(60) * 60;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO candles_1m (symbol, minute, open, high, low, close, ticks) \
         SELECT DISTINCT symbol, minute, \
                first_value(price) OVER w, max(price) OVER w, min(price) OVER w, \
                last_value(price) OVER w, count(*) OVER w \
         FROM (SELECT symbol, ts / 60 * 60 AS minute, ts, price FROM ticks WHERE ts < ?1) \
         WHERE true \
         WINDOW w AS (PARTITION BY symbol, minute ORDER BY ts \
                      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) \
         ON CONFLICT (symbol, minute) DO UPDATE SET \
           high = max(high, excluded.high), low = min(low, excluded.low), \
           close = excluded.close, ticks = ticks + excluded.ticks",
        params![cutoff],
    )?;
    let removed = tx.execute("DELETE FROM ticks WHERE ts < ?1", params![cutoff])?;
    tx.commit()?;
    Ok(removed)
}

/// One flush and rollup against the file at `path`.
fn flush_once(path: &Path, retention_days: u64) -> ApiResult<usize> {
    let mut conn = open_store(path)?;
    let written = buffer().flush_into(&mut conn)?;
    roll_up(&mut conn, now_millis().div_euclid(1000), retention_days)?;
    Ok(written)
}

/// The ledger must never share a file with data that is allowed to be lost.
pub fn is_ledger_file(ticks: &str, ledger: Option<&str>) -> bool {
    let resolved = |path: &str| {
        let path = Path::new(path);
        // The file may not exist yet; its directory does.
        match (path.parent(), path.file_name()) {
            (Some(dir), Some(name)) => {
                let dir = if dir.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    dir
                };
                dir.canonicalize().ok().map(|dir| dir.join(name))
            }
            _ => None,
        }
    };
    ledger.is_some_and(|ledger| {
        ticks == ledger
            || matches!((resolved(ticks), resolved(ledger)), (Some(a), Some(b)) if a == b)
    })
}

/// Runs for the life of the process. With no `TICKS_SQLITE_PATH` the rings still
/// serve prices and nothing is written.
pub async fn run_flusher() {
    let cfg = config();
    let Some(path) = cfg.ticks_sqlite_path.clone() else {
        tracing::info!("TICKS_SQLITE_PATH is not set: price ticks stay in memory only");
        return;
    };
    if is_ledger_file(&path, cfg.sqlite_path.as_deref()) {
        tracing::error!("TICKS_SQLITE_PATH is the ledger file: tick history is disabled");
        return;
    }
    let retention = cfg.tick_retention_days;
    let mut every = tokio::time::interval(Duration::from_secs(cfg.tick_flush_secs.max(1)));
    every.tick().await; // The first tick is immediate and there is nothing to write.
    loop {
        every.tick().await;
        let target = path.clone();
        match tokio::task::spawn_blocking(move || flush_once(Path::new(&target), retention)).await {
            Ok(Ok(written)) => tracing::debug!("flushed {written} ticks"),
            Ok(Err(err)) => tracing::warn!("tick flush failed, will retry: {err}"),
            Err(err) => tracing::warn!("tick flush task failed, will retry: {err}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "binance";

    #[test]
    fn at_or_before_never_reads_ahead() {
        let buffer = TickBuffer::new(60);
        buffer.record("BTC", 1.0, 1_000, SOURCE);
        buffer.record("BTC", 2.0, 2_000, SOURCE);
        assert_eq!(buffer.at_or_before("BTC", 999), None);
        assert_eq!(buffer.at_or_before("BTC", 1_999).unwrap().price, 1.0);
        assert_eq!(buffer.at_or_before("BTC", 2_000).unwrap().price, 2.0);
        assert_eq!(buffer.at_or_before("BTC", 9_000).unwrap().price, 2.0);
        assert_eq!(buffer.at_or_before("ETH", 9_000), None);
    }

    #[test]
    fn the_range_only_counts_the_window() {
        let buffer = TickBuffer::new(60);
        for (second, price) in [(1, 50.0), (2, 10.0), (3, 12.0), (4, 11.0)] {
            buffer.record("BTC", price, second * 1000, SOURCE);
        }
        assert_eq!(buffer.range("BTC", 3_000), 1.0);
        assert_eq!(buffer.range("BTC", 0), 40.0);
        assert_eq!(buffer.range("BTC", 4_000), 0.0);
        assert_eq!(buffer.range("BTC", 9_000), 0.0);
        assert_eq!(buffer.range("ETH", 0), 0.0);
    }

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_ring_never_grows_past_its_capacity() {
        let buffer = TickBuffer::new(60);
        for second in 0..10_000 {
            buffer.record("BTC", 1.0 + second as f64, second * 1000, SOURCE);
        }
        assert_eq!(buffer.len("BTC"), 60);
        assert_eq!(buffer.latest("BTC").unwrap().price, 10_000.0);
    }

    #[test]
    fn one_tick_per_second_the_newest_quote_of_it() {
        let buffer = TickBuffer::new(60);
        buffer.record("BTC", 1.0, 5_000, SOURCE);
        buffer.record("BTC", 2.0, 5_250, SOURCE);
        buffer.record("BTC", 3.0, 5_750, SOURCE);
        assert_eq!(buffer.len("BTC"), 1);
        assert_eq!(
            buffer.latest("BTC"),
            Some(Tick {
                at_ms: 5_750,
                price: 3.0,
                source: SOURCE
            })
        );
        // A quote that arrives late does not rewind the feed.
        buffer.record("BTC", 9.0, 3_000, SOURCE);
        assert_eq!(buffer.latest("BTC").unwrap().price, 3.0);
        assert_eq!(buffer.latest("ETH"), None);
    }

    #[test]
    fn a_flush_writes_only_what_is_new() {
        let buffer = TickBuffer::new(60);
        let mut conn = memory();
        buffer.record("BTC", 1.0, 1_000, SOURCE);
        buffer.record("BTC", 2.0, 2_000, SOURCE);
        buffer.record("ETH", 3.0, 2_000, SOURCE);
        assert_eq!(buffer.flush_into(&mut conn).unwrap(), 3);
        assert_eq!(buffer.flush_into(&mut conn).unwrap(), 0);

        buffer.record("BTC", 4.0, 3_000, SOURCE);
        assert_eq!(buffer.flush_into(&mut conn).unwrap(), 1);
        assert_eq!(count(&conn, "ticks"), 4);
    }

    #[test]
    fn a_second_flushed_early_is_corrected_by_its_later_quote() {
        let buffer = TickBuffer::new(60);
        let mut conn = memory();
        buffer.record("BTC", 1.0, 1_100, SOURCE);
        buffer.flush_into(&mut conn).unwrap();
        buffer.record("BTC", 2.0, 1_900, SOURCE);
        buffer.flush_into(&mut conn).unwrap();
        let price: f64 = conn
            .query_row("SELECT price FROM ticks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(price, 2.0);
        assert_eq!(count(&conn, "ticks"), 1);
    }

    #[test]
    fn a_failed_flush_stays_pending() {
        let buffer = TickBuffer::new(60);
        let mut conn = memory();
        conn.execute_batch("DROP TABLE ticks").unwrap();
        buffer.record("BTC", 1.0, 1_000, SOURCE);
        assert!(buffer.flush_into(&mut conn).is_err());

        conn.execute_batch(SCHEMA).unwrap();
        assert_eq!(buffer.flush_into(&mut conn).unwrap(), 1);
    }

    #[test]
    fn old_ticks_become_candles_and_only_they_go() {
        const DAY: i64 = 86_400;
        let mut conn = memory();
        let now = 100 * DAY;
        let old = now - 4 * DAY; // a whole minute, past a 3-day retention
        let insert = |symbol: &str, ts: i64, price: f64| {
            conn.execute(
                "INSERT INTO ticks VALUES (?1, ?2, ?3)",
                params![symbol, ts, price],
            )
            .unwrap();
        };
        for (offset, price) in [(0, 10.0), (20, 30.0), (40, 5.0), (59, 20.0)] {
            insert("BTC", old + offset, price);
        }
        insert("BTC", old + 60, 40.0);
        insert("ETH", old, 7.0);
        insert("BTC", now - 60, 99.0); // inside retention

        assert_eq!(roll_up(&mut conn, now, 3).unwrap(), 6);
        assert_eq!(count(&conn, "ticks"), 1);
        assert_eq!(count(&conn, "candles_1m"), 3);
        let candle: (f64, f64, f64, f64, i64) = conn
            .query_row(
                "SELECT open, high, low, close, ticks FROM candles_1m \
                 WHERE symbol = 'BTC' AND minute = ?1",
                params![old],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(candle, (10.0, 30.0, 5.0, 20.0, 4));

        // Running again with nothing old changes nothing.
        assert_eq!(roll_up(&mut conn, now, 3).unwrap(), 0);
        assert_eq!(count(&conn, "candles_1m"), 3);

        // A straggler for a rolled minute merges into its candle.
        conn.execute(
            "INSERT INTO ticks VALUES ('BTC', ?1, 50.0)",
            params![old + 30],
        )
        .unwrap();
        roll_up(&mut conn, now, 3).unwrap();
        let (high, ticks): (f64, i64) = conn
            .query_row(
                "SELECT high, ticks FROM candles_1m WHERE symbol = 'BTC' AND minute = ?1",
                params![old],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((high, ticks), (50.0, 5));
    }

    #[test]
    fn a_minute_on_the_retention_boundary_stays_whole() {
        const DAY: i64 = 86_400;
        let mut conn = memory();
        let now = 100 * DAY + 30; // half way through a minute
        let boundary = now - 30 - 3 * DAY;
        for ts in [boundary, boundary + 10, boundary + 50] {
            conn.execute("INSERT INTO ticks VALUES ('BTC', ?1, 1.0)", params![ts])
                .unwrap();
        }
        assert_eq!(roll_up(&mut conn, now, 3).unwrap(), 0);
        assert_eq!(count(&conn, "ticks"), 3);
    }

    #[test]
    fn the_store_is_a_normal_durability_wal_file() {
        let dir = std::env::temp_dir().join(format!("ticks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open_store(&dir.join("t.sqlite")).unwrap();
        let synchronous: i64 = conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .unwrap();
        let journal: String = conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!((synchronous, journal.as_str()), (1, "wal"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_ledger_file_is_refused_under_any_spelling() {
        let dir = std::env::temp_dir().join(format!("ticks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let ledger = dir.join("ledger.sqlite").display().to_string();
        let same = dir.join("sub/../ledger.sqlite").display().to_string();
        let other = dir.join("ticks.sqlite").display().to_string();
        assert!(is_ledger_file(&ledger, Some(&ledger)));
        assert!(is_ledger_file(&same, Some(&ledger)));
        assert!(!is_ledger_file(&other, Some(&ledger)));
        assert!(!is_ledger_file(&other, None));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
