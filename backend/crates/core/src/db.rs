use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value as Param, ValueRef};
use rusqlite::{config::DbConfig, params_from_iter, Connection, OpenFlags};
use serde_json::{Map, Number, Value};
use tokio::sync::{mpsc, oneshot, OnceCell, Semaphore};

use crate::config::config;
use crate::error::{ApiError, ApiResult};
use crate::money::{fixed_json, parse_decimal, to_fixed};
use crate::rpc;
use crate::schema::{decode_kind, numeric_scale, Decode};

pub const SCHEMA_SQL: &str = include_str!("../../../schema.sql");
const SEED_MARKER: &str = "-- SEED";
const MIGRATIONS: &[&str] = &[
    "DROP TABLE IF EXISTS user_profiles; DROP TABLE IF EXISTS access_codes; DROP TABLE IF EXISTS waitlist;",
    "CREATE TABLE agent_sessions (
       id             TEXT PRIMARY KEY,
       wallet         TEXT NOT NULL,
       asset          TEXT NOT NULL,
       mode           TEXT NOT NULL CHECK (mode IN ('normal', 'yolo')),
       budget         INTEGER NOT NULL,
       max_per_trade  INTEGER NOT NULL,
       stop_loss      INTEGER NOT NULL,
       starts_at      INTEGER NOT NULL,
       ends_at        INTEGER NOT NULL,
       nonce          TEXT NOT NULL UNIQUE,
       status         TEXT NOT NULL CHECK (status IN ('running', 'stopped')),
       stopped_reason TEXT,
       spent          INTEGER NOT NULL DEFAULT 0,
       realized_pnl   INTEGER NOT NULL DEFAULT 0,
       created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
     ) STRICT;
     CREATE UNIQUE INDEX agent_sessions_one_running ON agent_sessions(wallet) WHERE status = 'running';
     CREATE TABLE agent_decisions (
       id         TEXT PRIMARY KEY,
       session_id TEXT NOT NULL REFERENCES agent_sessions(id),
       created_at INTEGER NOT NULL,
       direction  TEXT CHECK (direction IN ('UP', 'DOWN')),
       stake      INTEGER,
       verdict    TEXT NOT NULL CHECK (verdict IN ('awaiting', 'placed', 'skipped', 'blocked', 'rejected')),
       reason     TEXT NOT NULL,
       skip_count INTEGER NOT NULL DEFAULT 1,
       confidence INTEGER,
       bet_id     TEXT,
       result     TEXT,
       pnl        INTEGER,
       expires_at INTEGER
     ) STRICT;
     CREATE INDEX agent_decisions_by_session ON agent_decisions(session_id, created_at);",
    "CREATE TABLE IF NOT EXISTS arkiv_seals ( \
       bet_id    TEXT PRIMARY KEY REFERENCES bet_rounds(bet_id), \
       tx        TEXT NOT NULL, \
       sent_at   INTEGER NOT NULL, \
       key       TEXT, \
       block     INTEGER \
     ) STRICT; \
     CREATE INDEX IF NOT EXISTS arkiv_seals_by_tx ON arkiv_seals (tx);",
    "CREATE TABLE world_attempts (
       id           TEXT PRIMARY KEY,
       wallet       TEXT NOT NULL,
       message      TEXT NOT NULL UNIQUE,
       nonce        TEXT NOT NULL,
       browser      TEXT NOT NULL,
       acr_allowed  TEXT NOT NULL,
       status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'mismatch', 'failed')),
       reason       TEXT,
       acr          TEXT,
       session_id   TEXT,
       expires_at   INTEGER NOT NULL,
       done_at      INTEGER,
       created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
     ) STRICT;
     CREATE TABLE world_links (
       wallet    TEXT PRIMARY KEY,
       iss       TEXT NOT NULL,
       sub       TEXT NOT NULL,
       acr       TEXT,
       linked_at INTEGER NOT NULL
     ) STRICT;
     CREATE INDEX world_links_by_human ON world_links(iss, sub);",
    "CREATE TABLE round_commits (
       epoch            INTEGER PRIMARY KEY,
       root             TEXT NOT NULL,
       rounds           INTEGER NOT NULL CHECK (rounds > 0),
       tx_hash          TEXT NOT NULL,
       created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
     ) STRICT;
     CREATE INDEX bet_rounds_by_end ON bet_rounds(end_time);",
    "ALTER TABLE world_attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'start' CHECK (kind IN ('start', 'checkpoint'));",
    "DROP TABLE IF EXISTS user_referrals;",
    "CREATE INDEX bet_rounds_open_by_wallet ON bet_rounds(user_address) WHERE outcome IS NULL;",
    "ALTER TABLE agent_decisions ADD COLUMN trace TEXT;",
    "CREATE TABLE signal_shadow (
       id           TEXT PRIMARY KEY,
       asset        TEXT NOT NULL,
       signal_at    INTEGER NOT NULL,
       direction    TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
       move_pct     REAL NOT NULL,
       range_share  REAL NOT NULL,
       range_pct    REAL NOT NULL,
       signal_price REAL NOT NULL,
       strike       REAL NOT NULL,
       jev_status   TEXT NOT NULL CHECK (jev_status IN ('off', 'passed', 'blocked', 'failed')),
       jev_score    REAL,
       jev_needed   REAL,
       jev_ms       INTEGER,
       end_at       INTEGER NOT NULL,
       outcome      TEXT CHECK (outcome IN ('win', 'loss', 'tie'))
     ) STRICT;
     CREATE INDEX signal_shadow_by_asset ON signal_shadow(asset, signal_at);",
    "CREATE TABLE arkiv_keys (
       key        TEXT PRIMARY KEY,
       wallet     TEXT NOT NULL,
       expires_ms INTEGER NOT NULL,
       fund_tx    TEXT NOT NULL,
       created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
     ) STRICT;
     CREATE INDEX arkiv_keys_by_wallet ON arkiv_keys(wallet, created_at);",
    "ALTER TABLE round_commits ADD COLUMN swarm_ref TEXT;
     ALTER TABLE round_commits ADD COLUMN arkiv_key TEXT;",
    // 14: the paper model's win chance for each signal.
    "ALTER TABLE signal_shadow ADD COLUMN model_p REAL;",
    // 15: World humans: one human per nullifier, its wallets, caps and Agent Pass step-ups.
    //     Replaces the YOLO-only world tables; everyone verifies again.
    "DROP TABLE world_links;
     DROP TABLE world_attempts;
     CREATE TABLE world_attempts (
       id           TEXT PRIMARY KEY,
       wallet       TEXT NOT NULL,
       message      TEXT NOT NULL UNIQUE,
       nonce        TEXT NOT NULL,
       browser      TEXT NOT NULL,
       acr_allowed  TEXT NOT NULL,
       status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'mismatch', 'failed')),
       reason       TEXT,
       acr          TEXT,
       expires_at   INTEGER NOT NULL,
       done_at      INTEGER,
       created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
       kind         TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human'))
     ) STRICT;
     CREATE TABLE humans (
       id         TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL
     ) STRICT;
     CREATE TABLE human_ids (
       iss       TEXT NOT NULL,
       sub       TEXT NOT NULL,
       human_id  TEXT NOT NULL,
       acr       TEXT,
       env       TEXT,
       linked_at INTEGER NOT NULL,
       PRIMARY KEY (iss, sub)
     ) STRICT;
     CREATE INDEX human_ids_by_human ON human_ids(human_id);
     CREATE TABLE human_wallets (
       wallet    TEXT PRIMARY KEY,
       human_id  TEXT NOT NULL REFERENCES humans(id),
       linked_at INTEGER NOT NULL
     ) STRICT;
     CREATE INDEX human_wallets_by_human ON human_wallets(human_id);
     CREATE TABLE human_limits (
       human_id      TEXT PRIMARY KEY,
       tier          TEXT NOT NULL CHECK (tier IN ('selfie', 'orb')),
       cooloff_until INTEGER
     ) STRICT;
     CREATE TABLE stepups (
       id                  TEXT PRIMARY KEY,
       human_id            TEXT NOT NULL,
       wallet              TEXT NOT NULL,
       kind                TEXT NOT NULL CHECK (kind IN ('yolo_start', 'agent_checkpoint', 'agent_chase', 'proposal', 'withdraw')),
       subject             TEXT NOT NULL,
       status              TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'mismatch', 'failed', 'used', 'cancelled')),
       reason              TEXT,
       device_code_hash    TEXT,
       device_code_enc     TEXT,
       user_code           TEXT,
       verify_uri          TEXT,
       verify_uri_complete TEXT,
       interval_ms         INTEGER,
       acr_required        TEXT,
       started_at          INTEGER NOT NULL,
       expires_at          INTEGER NOT NULL,
       approved_at         INTEGER,
       used_at             INTEGER,
       sub                 TEXT,
       acr                 TEXT,
       amr                 TEXT,
       session_id          TEXT
     ) STRICT;
     CREATE INDEX stepups_by_human ON stepups(human_id, status);
     CREATE INDEX stepups_by_session ON stepups(session_id);
     ALTER TABLE agent_sessions ADD COLUMN paused_until INTEGER;
     ALTER TABLE agent_sessions ADD COLUMN pause_stepup_id TEXT;
     ALTER TABLE agent_sessions ADD COLUMN checks_passed INTEGER NOT NULL DEFAULT 0;
     CREATE INDEX bet_rounds_settled_by_wallet ON bet_rounds(user_address, settled_at) WHERE outcome IS NOT NULL;",
];
const SCHEMA_VERSION: i64 = 1 + MIGRATIONS.len() as i64;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MMAP_BYTES: i64 = 256 * 1024 * 1024;
const CACHE_KIB: i64 = 64 * 1024;
const STATEMENT_CACHE: usize = 256;
const WRITE_QUEUE: usize = 4096;
const MAX_BATCH: usize = 256;
const PROGRESS_STEPS: i32 = 10_000;

struct Ran {
    ok: bool,
    answer: Box<dyn FnOnce(Result<(), String>) + Send>,
}

type WriteJob = Box<dyn FnOnce(&mut Connection) -> Ran + Send>;

#[derive(Default)]
struct WriterStats {
    batches: AtomicU64,
    jobs: AtomicU64,
}

struct Reader {
    conn: Connection,
    deadline_ms: Arc<AtomicI64>,
}

pub struct Db {
    path: Arc<str>,
    writer: mpsc::Sender<WriteJob>,
    stats: Arc<WriterStats>,
    readers: Arc<Mutex<Vec<Reader>>>,
    read_permits: Arc<Semaphore>,
    statement_timeout_ms: u64,
}

fn process_ms() -> i64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as i64
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "mmap_size", MMAP_BYTES)?;
    conn.pragma_update(None, "cache_size", -CACHE_KIB)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    register_like(conn)
}

fn open_writer(path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let fullfsync = if config().sqlite_fullfsync {
        "ON"
    } else {
        "OFF"
    };
    conn.pragma_update(None, "fullfsync", fullfsync)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    if version > SCHEMA_VERSION {
        return Err(rusqlite::Error::UserFunctionError(
            format!("database schema is version {version}, this build knows {SCHEMA_VERSION}")
                .into(),
        ));
    }
    let mut steps = String::new();
    if version == 0 {
        let tables: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table'",
            [],
            |r| r.get(0),
        )?;
        steps.push_str(if tables == 0 {
            SCHEMA_SQL
        } else {
            baseline_ddl()
        });
    }
    for step in &MIGRATIONS[version.max(1) as usize - 1..] {
        steps.push_str(step);
    }
    conn.execute_batch(&format!(
        "BEGIN IMMEDIATE;\n{steps}\nPRAGMA user_version = {SCHEMA_VERSION};\nCOMMIT;"
    ))
}

fn baseline_ddl() -> &'static str {
    SCHEMA_SQL
        .split_once(SEED_MARKER)
        .map_or(SCHEMA_SQL, |(ddl, _)| ddl)
}

const JOB_SAVEPOINT: &str = "group_job";

fn run_batch(conn: &mut Connection, jobs: Vec<WriteJob>, stats: &WriterStats) {
    let mut ran: Vec<Ran> = Vec::with_capacity(jobs.len());
    stats.jobs.fetch_add(jobs.len() as u64, Ordering::Relaxed);
    let lost = |ran: &mut Vec<Ran>, why: &str| {
        for job in ran.drain(..) {
            (job.answer)(Err(why.to_string()));
        }
    };

    for job in jobs {
        if conn.is_autocommit() {
            if let Err(err) = conn.execute_batch("BEGIN IMMEDIATE") {
                tracing::error!("sqlite batch could not begin: {err}");
                return;
            }
        }
        if let Err(err) = conn.execute_batch(&format!("SAVEPOINT {JOB_SAVEPOINT}")) {
            tracing::error!("sqlite savepoint failed: {err}");
            let _ = conn.execute_batch("ROLLBACK");
            lost(&mut ran, "sqlite batch rolled back");
            return;
        }

        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| job(conn)));
        let ok = matches!(&outcome, Ok(job) if job.ok);
        if outcome.is_err() {
            tracing::error!("sqlite write job panicked");
        }
        if let Ok(job) = outcome {
            ran.push(job);
        }

        let kept = !conn.is_autocommit()
            && conn
                .execute_batch(&if ok {
                    format!("RELEASE {JOB_SAVEPOINT}")
                } else {
                    format!("ROLLBACK TO {JOB_SAVEPOINT}; RELEASE {JOB_SAVEPOINT}")
                })
                .is_ok();
        if !kept {
            tracing::error!("sqlite batch lost its transaction");
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            lost(&mut ran, "sqlite batch rolled back");
        }
    }

    if conn.is_autocommit() {
        return;
    }
    stats.batches.fetch_add(1, Ordering::Relaxed);
    if let Err(err) = conn.execute_batch("COMMIT") {
        tracing::error!("sqlite commit failed: {err}");
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        lost(&mut ran, &format!("sqlite commit failed: {err}"));
    }
    for job in ran {
        (job.answer)(Ok(()));
    }
}

fn open_reader(path: &str) -> rusqlite::Result<Reader> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )?;
    configure(&conn)?;
    conn.pragma_update(None, "query_only", "ON")?;
    let deadline_ms = Arc::new(AtomicI64::new(i64::MAX));
    let watched = deadline_ms.clone();
    conn.progress_handler(
        PROGRESS_STEPS,
        Some(move || process_ms() > watched.load(Ordering::Relaxed)),
    );
    Ok(Reader { conn, deadline_ms })
}

impl Db {
    pub fn open(
        path: impl AsRef<Path>,
        readers: usize,
        statement_timeout_ms: u64,
    ) -> ApiResult<Self> {
        let path: Arc<str> = path
            .as_ref()
            .to_str()
            .ok_or_else(|| ApiError::Other("SQLITE_PATH is not valid UTF-8".to_string()))?
            .into();

        let mut conn = open_writer(&path)?;
        let (writer, mut jobs) = mpsc::channel::<WriteJob>(WRITE_QUEUE);
        let stats = Arc::new(WriterStats::default());
        let thread_stats = stats.clone();
        std::thread::Builder::new()
            .name("sqlite-writer".to_string())
            .spawn(move || {
                while let Some(first) = jobs.blocking_recv() {
                    let mut batch = vec![first];
                    while batch.len() < MAX_BATCH {
                        match jobs.try_recv() {
                            Ok(job) => batch.push(job),
                            Err(_) => break,
                        }
                    }
                    run_batch(&mut conn, batch, &thread_stats);
                }
            })
            .map_err(|e| ApiError::Other(format!("cannot start sqlite writer: {e}")))?;

        let readers = readers.max(1);
        let pool = (0..readers)
            .map(|_| open_reader(&path))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            path,
            writer,
            stats,
            readers: Arc::new(Mutex::new(pool)),
            read_permits: Arc::new(Semaphore::new(readers)),
            statement_timeout_ms,
        })
    }

    pub fn writer_stats(&self) -> (u64, u64) {
        (
            self.stats.batches.load(Ordering::Relaxed),
            self.stats.jobs.load(Ordering::Relaxed),
        )
    }

    pub async fn write<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
    ) -> ApiResult<T> {
        let (reply, answer) = oneshot::channel();
        self.writer
            .send(Box::new(move |conn| {
                let result = job(conn);
                Ran {
                    ok: result.is_ok(),
                    answer: Box::new(move |commit| {
                        let _ = reply.send(commit.map_err(ApiError::Other).and(result));
                    }),
                }
            }))
            .await
            .map_err(|_| ApiError::Other("sqlite writer has stopped".to_string()))?;
        answer
            .await
            .map_err(|_| ApiError::Other("sqlite write was not committed".to_string()))?
    }

    pub async fn read<T: Send + 'static>(
        &self,
        job: impl FnOnce(&Connection) -> ApiResult<T> + Send + 'static,
    ) -> ApiResult<T> {
        let permit = self
            .read_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ApiError::Other("sqlite read pool closed".to_string()))?;
        let pool = self.readers.clone();
        let path = self.path.clone();
        let timeout = self.statement_timeout_ms as i64;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let taken = pool.lock().map_err(|_| poisoned())?.pop();
            let reader = match taken {
                Some(reader) => reader,
                None => open_reader(&path)?,
            };
            reader
                .deadline_ms
                .store(process_ms() + timeout, Ordering::Relaxed);
            let result = job(&reader.conn);
            pool.lock().map_err(|_| poisoned())?.push(reader);
            result
        })
        .await
        .map_err(|e| ApiError::Other(format!("sqlite read task failed: {e}")))?
    }

    pub async fn run(&self, sql: &str, params: Vec<Param>) -> ApiResult<(Vec<Value>, u64)> {
        let sql = sqlite_sql(sql);
        if is_read(&sql) {
            self.read(move |conn| run_statement(conn, &sql, params, false))
                .await
        } else {
            self.write(move |conn| run_statement(conn, &sql, params, true))
                .await
        }
    }

    pub async fn fetch(&self, sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Vec<Value>> {
        let params = arguments(sql, binds)?;
        Ok(self.run(sql, params).await?.0)
    }

    pub async fn call_rpc(&self, fn_name: &str, params: &[(&str, &Value)]) -> ApiResult<Value> {
        if !is_identifier(fn_name) {
            return Err(ApiError::internal(format!(
                "Unsafe function name: {fn_name}"
            )));
        }
        for (name, _) in params {
            if !is_identifier(name) {
                return Err(ApiError::internal(format!("Unsafe parameter name: {name}")));
            }
        }
        let args = rpc::Args::new(fn_name, params)?;
        let function = fn_name.to_string();
        self.write(move |conn| rpc::dispatch(conn, &function, &args))
            .await
    }
}

fn poisoned() -> ApiError {
    ApiError::Other("sqlite read pool lock poisoned".to_string())
}

fn is_read(sql: &str) -> bool {
    sql.trim_start()
        .get(..6)
        .is_some_and(|head| head.eq_ignore_ascii_case("SELECT"))
}

pub fn query_rows(conn: &Connection, sql: &str, params: Vec<Param>) -> ApiResult<Vec<Value>> {
    Ok(run_statement(conn, sql, params, false)?.0)
}

fn run_statement(
    conn: &Connection,
    sql: &str,
    params: Vec<Param>,
    is_write: bool,
) -> ApiResult<(Vec<Value>, u64)> {
    let mut statement = conn.prepare_cached(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|n| n.to_string())
        .collect();
    let mut rows = statement.query(params_from_iter(params))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = Map::with_capacity(names.len());
        for (idx, name) in names.iter().enumerate() {
            map.insert(name.clone(), cell_json(name, row.get_ref(idx)?));
        }
        out.push(Value::Object(map));
    }
    drop(rows);
    let changed = if is_write { conn.changes() } else { 0 };
    Ok((out, changed))
}

static DB: OnceCell<Db> = OnceCell::const_new();

pub async fn db() -> ApiResult<&'static Db> {
    DB.get_or_try_init(|| async {
        let cfg = config();
        let path = cfg
            .sqlite_path
            .clone()
            .ok_or_else(|| ApiError::unavailable("SQLITE_PATH is not configured"))?;
        let (readers, timeout) = (cfg.read_pool, cfg.statement_timeout_ms);
        tokio::task::spawn_blocking(move || Db::open(path, readers, timeout))
            .await
            .map_err(|e| ApiError::Other(format!("sqlite open failed: {e}")))?
    })
    .await
}

fn cell_json(column: &str, cell: ValueRef<'_>) -> Value {
    match cell {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => match decode_kind(column) {
            Some(Decode::Numeric(scale)) => fixed_json(i, scale),
            Some(Decode::Bool) => Value::Bool(i != 0),
            Some(Decode::Timestamp) => timestamp_json(i),
            None => Value::Number(Number::from(i)),
        },
        ValueRef::Real(f) => Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::String(hex::encode(bytes)),
    }
}

fn timestamp_json(micros: i64) -> Value {
    chrono::DateTime::from_timestamp_micros(micros)
        .map(|dt| Value::String(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}

pub fn now_us() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

pub fn parse_timestamp_us(text: &str) -> Option<i64> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime};
    let text = text.trim();
    let zoned = DateTime::parse_from_rfc3339(text)
        .or_else(|_| DateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f%#z"))
        .map(|dt| dt.timestamp_micros());
    zoned.ok().or_else(|| {
        ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"]
            .iter()
            .find_map(|format| NaiveDateTime::parse_from_str(text, format).ok())
            .or_else(|| {
                NaiveDate::parse_from_str(text, "%Y-%m-%d")
                    .ok()?
                    .and_hms_opt(0, 0, 0)
            })
            .map(|dt| dt.and_utc().timestamp_micros())
    })
}

enum LikeToken {
    AnyRun,
    AnyChar,
    Literal(char),
}

fn like_match(value: &str, pattern: &str, fold_case: bool) -> Result<bool, &'static str> {
    let (value, pattern) = if fold_case {
        (value.to_lowercase(), pattern.to_lowercase())
    } else {
        (value.to_string(), pattern.to_string())
    };

    let mut tokens = Vec::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        tokens.push(match c {
            '%' => LikeToken::AnyRun,
            '_' => LikeToken::AnyChar,
            '\\' => LikeToken::Literal(
                chars
                    .next()
                    .ok_or("LIKE pattern must not end with escape character")?,
            ),
            other => LikeToken::Literal(other),
        });
    }

    let text: Vec<char> = value.chars().collect();
    let (mut t, mut p) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while t < text.len() {
        match tokens.get(p) {
            Some(LikeToken::AnyRun) => {
                backtrack = Some((p, t));
                p += 1;
            }
            Some(LikeToken::AnyChar) => {
                t += 1;
                p += 1;
            }
            Some(LikeToken::Literal(c)) if *c == text[t] => {
                t += 1;
                p += 1;
            }
            _ => match backtrack {
                Some((run, start)) => {
                    backtrack = Some((run, start + 1));
                    p = run + 1;
                    t = start + 1;
                }
                None => return Ok(false),
            },
        }
    }
    Ok(tokens[p..].iter().all(|t| matches!(t, LikeToken::AnyRun)))
}

fn register_like(conn: &Connection) -> rusqlite::Result<()> {
    for (name, fold_case) in [("pg_like", false), ("pg_ilike", true)] {
        conn.create_scalar_function(
            name,
            2,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            move |ctx| {
                let value = ctx.get_raw(0).as_str_or_null()?;
                let pattern = ctx.get_raw(1).as_str_or_null()?;
                let (Some(value), Some(pattern)) = (value, pattern) else {
                    return Ok(None);
                };
                like_match(value, pattern, fold_case)
                    .map(Some)
                    .map_err(|e| rusqlite::Error::UserFunctionError(e.into()))
            },
        )?;
    }
    Ok(())
}

pub type TypedBind<'a> = (&'a str, &'a Value);

pub fn highest_placeholder(sql: &str) -> usize {
    let bytes = sql.as_bytes();
    let mut idx = 0;
    let mut highest = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'$' {
            let start = idx + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end > start {
                if let Ok(n) = sql[start..end].parse::<usize>() {
                    highest = highest.max(n);
                }
                idx = end;
                continue;
            }
        }
        idx += 1;
    }
    highest
}

pub fn sqlite_sql(sql: &str) -> String {
    const CAST: &str = "CAST($";
    let mut out = String::with_capacity(sql.len());
    let mut rest = sql;
    while let Some(start) = rest.find(['$', 'C']) {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let is_cast = rest.starts_with(CAST);
        let digits_at = if is_cast { CAST.len() } else { 1 };
        let digits = rest[digits_at..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if (!is_cast && !rest.starts_with('$')) || digits == 0 {
            let width = rest.chars().next().map_or(1, char::len_utf8);
            out.push_str(&rest[..width]);
            rest = &rest[width..];
            continue;
        }
        out.push('?');
        out.push_str(&rest[digits_at..digits_at + digits]);
        rest = &rest[digits_at + digits..];
        if is_cast {
            let mut depth = 1;
            let end = rest.char_indices().find_map(|(i, c)| {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                (depth == 0).then_some(i)
            });
            rest = &rest[end.map_or(rest.len(), |i| i + 1)..];
        }
    }
    out.push_str(rest);
    out
}

fn arguments(sql: &str, binds: &[TypedBind]) -> ApiResult<Vec<Param>> {
    let highest = highest_placeholder(sql);
    if highest != binds.len() {
        return Err(ApiError::internal(format!(
            "query has {highest} placeholders but {} binds",
            binds.len()
        )));
    }
    binds.iter().map(|(ty, v)| typed_param(ty, v)).collect()
}

pub async fn fetch(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Vec<Value>> {
    let params = arguments(sql, binds)?;
    Ok(db().await?.run(sql, params).await?.0)
}

pub async fn fetch_one(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Option<Value>> {
    Ok(fetch(sql, binds).await?.into_iter().next())
}

pub async fn execute(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<u64> {
    let params = arguments(sql, binds)?;
    Ok(db().await?.run(sql, params).await?.1)
}

pub async fn fetch_scalar(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Value> {
    let first = fetch_one(sql, binds)
        .await?
        .and_then(|row| row.as_object().and_then(|m| m.values().next().cloned()));
    Ok(first.unwrap_or(Value::Null))
}

pub async fn call_rpc(fn_name: &str, params: &[(&str, &Value)]) -> ApiResult<Value> {
    db().await?.call_rpc(fn_name, params).await
}

pub fn json_bind_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { "true" } else { "false" }.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn bad_input(type_name: &str, text: &str) -> ApiError {
    ApiError::Other(format!(
        "invalid input syntax for type {type_name}: \"{text}\""
    ))
}

fn integer_param(type_name: &str, text: &str, min: i64, max: i64) -> ApiResult<Param> {
    let parsed = text
        .trim()
        .parse::<i64>()
        .map_err(|_| bad_input(type_name, text))?;
    if !(min..=max).contains(&parsed) {
        return Err(ApiError::Other(format!("value \"{text}\" is out of range")));
    }
    Ok(Param::Integer(parsed))
}

fn boolean_param(text: &str) -> ApiResult<Param> {
    match text.trim().to_lowercase().as_str() {
        "t" | "tr" | "tru" | "true" | "y" | "ye" | "yes" | "on" | "1" => Ok(Param::Integer(1)),
        "f" | "fa" | "fal" | "fals" | "false" | "n" | "no" | "of" | "off" | "0" => {
            Ok(Param::Integer(0))
        }
        _ => Err(bad_input("boolean", text)),
    }
}

pub fn typed_param(type_name: &str, value: &Value) -> ApiResult<Param> {
    if type_name.ends_with("[]") {
        return Err(ApiError::internal(format!(
            "Array bind parameters are not supported (got {type_name})"
        )));
    }
    if type_name == "bytea" {
        let hexed = value.as_str().ok_or_else(|| {
            ApiError::internal("bytea parameter requires a hex string".to_string())
        })?;
        let bytes = hex::decode(hexed.strip_prefix("0x").unwrap_or(hexed))
            .map_err(|e| ApiError::internal(format!("bytea parameter is not hex: {e}")))?;
        return Ok(Param::Blob(bytes));
    }
    let Some(text) = json_bind_text(value) else {
        return Ok(Param::Null);
    };
    if let Some(scale) = numeric_scale(type_name) {
        return Ok(Param::Integer(to_fixed(parse_decimal(&text)?, scale)?));
    }
    match type_name {
        "boolean" | "bool" => boolean_param(&text),
        "smallint" | "int2" => integer_param(type_name, &text, i16::MIN.into(), i16::MAX.into()),
        "integer" | "int" | "int4" => {
            integer_param(type_name, &text, i32::MIN.into(), i32::MAX.into())
        }
        "bigint" | "int8" => integer_param(type_name, &text, i64::MIN, i64::MAX),
        "timestamp with time zone" | "timestamptz" => parse_timestamp_us(&text)
            .map(Param::Integer)
            .ok_or_else(|| bad_input(type_name, &text)),
        "uuid" => uuid::Uuid::parse_str(text.trim())
            .map(|u| Param::Text(u.to_string()))
            .map_err(|_| bad_input(type_name, &text)),
        _ => Ok(Param::Text(text)),
    }
}

pub fn is_safe_type_expression(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() < 128
        && bytes.iter().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'_' | b' ' | b'.' | b',' | b'(' | b')' | b'[' | b']')
        })
}

pub fn untyped_param(value: &Value) -> Param {
    match value {
        Value::Null => Param::Null,
        Value::Bool(b) => Param::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Param::Integer(i),
            None => Param::Text(n.to_string()),
        },
        Value::String(s) => Param::Text(s.clone()),
        other => Param::Text(other.to_string()),
    }
}

pub fn rpc_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => {
            let mut map = Map::new();
            map.insert("value".to_string(), other);
            map
        }
    }
}

pub fn rpc_success(map: &Map<String, Value>) -> bool {
    map.get("success").and_then(Value::as_bool).unwrap_or(false)
}

pub fn is_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

pub fn pg_error_code(err: &rusqlite::Error) -> Option<String> {
    use rusqlite::ffi;
    let code = err.sqlite_error()?.extended_code;
    Some(
        match code {
            ffi::SQLITE_CONSTRAINT_UNIQUE | ffi::SQLITE_CONSTRAINT_PRIMARYKEY => "23505",
            ffi::SQLITE_CONSTRAINT_CHECK => "23514",
            ffi::SQLITE_CONSTRAINT_NOTNULL => "23502",
            ffi::SQLITE_CONSTRAINT_FOREIGNKEY => "23503",
            other => return Some(format!("sqlite:{other}")),
        }
        .to_string(),
    )
}

pub fn is_unique_violation(err: &rusqlite::Error) -> bool {
    pg_error_code(err).as_deref() == Some("23505")
}

pub async fn ping() -> ApiResult<()> {
    db().await?
        .read(|conn| {
            conn.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifier_guard() {
        assert!(is_identifier("update_balance_for_deposit"));
        assert!(is_identifier("_x1"));
        assert!(!is_identifier("1bad"));
        assert!(!is_identifier("drop table"));
        assert!(!is_identifier(""));
        assert!(!is_identifier("a-b"));
        assert!(!is_identifier("a;--"));
    }

    #[test]
    fn rpc_object_wraps_scalars() {
        let map = rpc_object(Value::Bool(true));
        assert_eq!(map.get("value"), Some(&Value::Bool(true)));
        assert_eq!(rpc_object(Value::Null).get("value"), Some(&Value::Null));
    }

    #[test]
    fn rpc_success_reads_missing_flag_as_false() {
        assert!(!rpc_success(&Map::new()));
        let mut map = Map::new();
        map.insert("success".into(), Value::Bool(true));
        assert!(rpc_success(&map));
    }

    #[test]
    fn bind_text_covers_every_json_shape() {
        assert_eq!(json_bind_text(&Value::Null), None);
        assert_eq!(json_bind_text(&Value::Bool(true)).as_deref(), Some("true"));
        assert_eq!(
            json_bind_text(&Value::Bool(false)).as_deref(),
            Some("false")
        );
        assert_eq!(json_bind_text(&json!(5)).as_deref(), Some("5"));
        assert_eq!(json_bind_text(&json!(7.25)).as_deref(), Some("7.25"));
        assert_eq!(
            json_bind_text(&json!(i64::MAX)).as_deref(),
            Some("9223372036854775807")
        );
        assert_eq!(json_bind_text(&json!("0xabc")).as_deref(), Some("0xabc"));
        assert_eq!(
            json_bind_text(&json!({"success": true})).as_deref(),
            Some(r#"{"success":true}"#)
        );
    }

    #[test]
    fn type_expressions_are_revalidated() {
        for ok in [
            "numeric",
            "numeric(30,10)",
            "integer",
            "timestamp with time zone",
            "character varying",
            "public.status",
            "jsonb",
        ] {
            assert!(is_safe_type_expression(ok), "rejected {ok}");
        }
        for bad in [
            "",
            "numeric; DROP TABLE x",
            "int) => 1",
            "a' OR '1'='1",
            &"x".repeat(200),
        ] {
            assert!(!is_safe_type_expression(bad), "accepted {bad}");
        }
    }

    #[test]
    fn typed_binds_reject_shapes_they_cannot_encode() {
        assert_eq!(
            typed_param("numeric", &json!(1.5)).unwrap(),
            Param::Integer(15_000_000_000)
        );
        assert!(matches!(
            typed_param("bytea", &json!("0xdeadbeef")).unwrap(),
            Param::Blob(_)
        ));
        assert!(typed_param("bytea", &json!("not-hex")).is_err());
        assert!(typed_param("text[]", &json!(["a"])).is_err());
        assert_eq!(typed_param("uuid", &Value::Null).unwrap(), Param::Null);
    }

    #[test]
    fn typed_binds_convert_to_storage_form() {
        assert_eq!(
            typed_param("numeric(10,4)", &json!(1.23456)).unwrap(),
            Param::Integer(12_346)
        );
        assert_eq!(
            typed_param("numeric(20,8)", &json!("0.00000001")).unwrap(),
            Param::Integer(1)
        );
        assert!(typed_param("numeric", &json!(1e30)).is_err());
        assert!(typed_param("numeric", &json!("NaN")).is_err());
        assert_eq!(
            typed_param("bigint", &json!("42")).unwrap(),
            Param::Integer(42)
        );
        assert!(typed_param("bigint", &json!(1.5)).is_err());
        assert!(typed_param("integer", &json!(3_000_000_000i64)).is_err());
        assert_eq!(
            typed_param("boolean", &json!(true)).unwrap(),
            Param::Integer(1)
        );
        assert_eq!(
            typed_param("boolean", &json!("f")).unwrap(),
            Param::Integer(0)
        );
        assert!(typed_param("boolean", &json!("maybe")).is_err());
        assert_eq!(
            typed_param("timestamp with time zone", &json!("1970-01-01T00:00:01.5Z")).unwrap(),
            Param::Integer(1_500_000)
        );
        assert!(typed_param("timestamp with time zone", &json!("yesterday")).is_err());
        assert_eq!(
            typed_param("uuid", &json!("8F1B0000-0000-4000-8000-000000000000")).unwrap(),
            Param::Text("8f1b0000-0000-4000-8000-000000000000".into())
        );
        assert!(typed_param("uuid", &json!("not-a-uuid")).is_err());
        assert_eq!(
            typed_param("character varying", &json!(12)).unwrap(),
            Param::Text("12".into())
        );
    }

    #[test]
    fn arguments_can_be_built_for_every_json_shape() {
        for value in [
            Value::Null,
            Value::Bool(true),
            json!(5),
            json!(1.25),
            Value::String("0xabc".into()),
            json!({"a": 1}),
            json!([1, 2]),
        ] {
            let _ = untyped_param(&value);
        }
        assert_eq!(untyped_param(&json!(5)), Param::Integer(5));
        assert_eq!(untyped_param(&json!(1.25)), Param::Text("1.25".into()));
    }

    #[test]
    fn placeholders_become_sqlite_numbered_params() {
        assert_eq!(
            sqlite_sql("SELECT a FROM t WHERE a = CAST($1 AS text) AND b = $2"),
            "SELECT a FROM t WHERE a = ?1 AND b = ?2"
        );
        assert_eq!(
            sqlite_sql(
                "VALUES (CAST($12 AS numeric(30,10)), CAST($3 AS timestamp with time zone))"
            ),
            "VALUES (?12, ?3)"
        );
        assert_eq!(
            sqlite_sql("(code LIKE CAST($1 AS text) OR w LIKE CAST($1 AS text))"),
            "(code LIKE ?1 OR w LIKE ?1)"
        );
        assert_eq!(sqlite_sql("SELECT COUNT(*) AS c"), "SELECT COUNT(*) AS c");
        assert_eq!(sqlite_sql("CASE WHEN x"), "CASE WHEN x");
        assert_eq!(
            sqlite_sql("Müller $ CAST(x AS text)"),
            "Müller $ CAST(x AS text)"
        );
    }

    #[test]
    fn like_follows_postgres() {
        let like = |v, p| like_match(v, p, false).unwrap();
        let ilike = |v, p| like_match(v, p, true).unwrap();
        assert!(like("0xAbC", "0xA%"));
        assert!(!like("0xAbC", "0xa%"));
        assert!(ilike("0xAbC", "0xa%"));
        assert!(ilike("0XABC", "%abc"));
        assert!(ilike("ÄPFEL", "äpfel"), "non-ASCII folds too");
        assert!(ilike("abc", "a_c"));
        assert!(!ilike("abc", "a_"));
        assert!(ilike("abc", "%%%"));
        assert!(ilike("", "%"));
        assert!(!ilike("", "_"));
        assert!(ilike("aXbXc", "a%b%c"));
        assert!(ilike("50%", "50\\%"));
        assert!(!ilike("500", "50\\%"));
        assert!(ilike("a_b", "a\\_b"));
        assert!(!ilike("axb", "a\\_b"));
        assert!(like_match("x", "x\\", true).is_err());
    }

    #[test]
    fn cells_decode_by_column_name() {
        assert_eq!(
            cell_json("balance", ValueRef::Integer(15_000_000_000)).to_string(),
            "1.5"
        );
        assert_eq!(cell_json("won", ValueRef::Integer(1)), json!(true));
        assert_eq!(
            cell_json("created_at", ValueRef::Integer(1_500_999)),
            json!("1970-01-01T00:00:01.500Z")
        );
        assert_eq!(cell_json("count", ValueRef::Integer(3)), json!(3));
        assert_eq!(cell_json("signed_at", ValueRef::Integer(3)), json!(3));
        assert_eq!(cell_json("balance", ValueRef::Null), Value::Null);
    }

    const SEEDED: &str = "Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4";

    fn banned(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM banned_wallets WHERE wallet_address = ?1",
            [SEEDED],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_new_database_is_seeded_once_and_a_restart_keeps_the_unban() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert_eq!((banned(&conn), version(&conn)), (1, SCHEMA_VERSION));

        conn.execute("DELETE FROM banned_wallets", []).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(banned(&conn), 0, "an admin's unban survives a restart");
    }

    #[test]
    fn a_file_from_before_versioning_is_never_reseeded_but_gets_new_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(baseline_ddl()).unwrap();
        conn.execute_batch("DROP TABLE deposit_locks").unwrap();
        assert_eq!(version(&conn), 0);

        migrate(&conn).unwrap();
        assert_eq!((banned(&conn), version(&conn)), (0, SCHEMA_VERSION));
        let table: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name = 'deposit_locks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table, 1);
    }

    #[test]
    fn a_file_made_by_the_sql_alone_counts_as_seeded() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        assert_eq!((banned(&conn), version(&conn)), (1, 1));
        conn.execute("DELETE FROM banned_wallets", []).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(banned(&conn), 0);
    }

    #[test]
    fn a_file_from_a_newer_build_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        assert!(migrate(&conn).is_err());
    }

    #[test]
    fn schema_matches_the_sql_file() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

        let mut actual = Vec::new();
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for table in &tables {
            let mut info = conn
                .prepare(&format!(
                    "SELECT name, type FROM pragma_table_info('{table}')"
                ))
                .unwrap();
            let columns = info
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap();
            for column in columns {
                let (name, storage) = column.unwrap();
                actual.push((table.clone(), name, storage));
            }
        }

        let expected: Vec<(String, String, String)> = crate::schema::COLUMNS
            .iter()
            .map(|(table, column, ty)| {
                let storage = match *ty {
                    "text" | "uuid" => "TEXT",
                    "double precision" => "REAL",
                    _ => "INTEGER",
                };
                (table.to_string(), column.to_string(), storage.to_string())
            })
            .collect();
        let sorted = |mut v: Vec<(String, String, String)>| {
            v.sort();
            v
        };
        assert_eq!(sorted(actual), sorted(expected));

        let not_strict: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_list \
                 WHERE schema = 'main' AND type = 'table' AND strict = 0 \
                   AND name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(not_strict, 0, "every table is STRICT");
    }
}
