//! Copies a Strike Postgres database into a new SQLite file.
//!
//!   PG_URL=postgres://... cargo run -p migrate_pg_to_sqlite -- /path/new.sqlite
//!
//! The URL comes only from `PG_URL`, never from a `.env` file. The source is read
//! in one REPEATABLE READ, READ ONLY transaction; stop writes first for a final
//! cut-over. The output file must not exist. Anything that cannot be represented
//! exactly aborts the run and deletes the partial file:
//!   * a table or column the schema does not know, or a different Postgres type;
//!   * a NUMERIC that is NaN, past i64 at its scale, or has more decimal places
//!     than its column (only possible if the column type differs);
//!   * a timestamp outside chrono's range, or `infinity`;
//!   * a row the SQLite constraints refuse: a negative balance that the Postgres
//!     `NOT VALID` CHECK tolerated, or a repeated transaction hash that made
//!     008_ledger_integrity.sql skip its unique index, or two withdrawal rows
//!     for one signed intent (the replay race on Postgres). Reconcile those first.
//!
//! After the copy it verifies, per table, the row count and the exact sum of every
//! NUMERIC column, then runs `integrity_check`. Sums are compared as scaled
//! integers in i128, so no float is ever involved.

use std::collections::HashMap;
use std::path::Path;

use strike_core::db::{parse_timestamp_us, SCHEMA_SQL};
use strike_core::money::{from_fixed, parse_decimal, to_fixed};
use strike_core::schema::{numeric_scale, COLUMNS, SQLITE_ONLY_TABLES};
use rusqlite::types::Value as Param;
use rusqlite::{params_from_iter, Connection};
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::{Connection as _, Row};

type Failure = String;

/// `COLUMNS` less what only SQLite has: `bet_rounds` starts empty in a new file.
fn copied_columns() -> impl Iterator<Item = &'static (&'static str, &'static str, &'static str)> {
    COLUMNS
        .iter()
        .filter(|(table, _, _)| !SQLITE_ONLY_TABLES.contains(table))
}

fn tables() -> Vec<&'static str> {
    let mut names: Vec<&str> = copied_columns().map(|(t, _, _)| *t).collect();
    names.dedup();
    names
}

fn columns_of(table: &str) -> Vec<(&'static str, &'static str)> {
    COLUMNS
        .iter()
        .filter(|(t, _, _)| *t == table)
        .map(|(_, c, ty)| (*c, *ty))
        .collect()
}

fn db_err(context: &str) -> impl Fn(sqlx::Error) -> Failure + '_ {
    move |e| format!("{context}: {e}")
}

/// Text of a numeric as an integer at `scale`, in i128: exact past `Decimal`'s
/// range, for the sums.
fn scaled_i128(text: &str, scale: u32) -> Result<i128, Failure> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if fraction.len() > scale as usize || fraction.bytes().any(|b| b != b'0' && !b.is_ascii_digit())
    {
        return Err(format!("sum {text} has more than {scale} decimal places"));
    }
    let padded = format!("{whole}{fraction:0<width$}", width = scale as usize);
    let value: i128 = padded
        .parse()
        .map_err(|_| format!("sum {text} is not a plain number"))?;
    Ok(if negative { -value } else { value })
}

/// Converts one Postgres text cell, or says exactly why it cannot be.
fn convert(ty: &str, text: Option<String>) -> Result<Param, Failure> {
    let Some(text) = text else {
        return Ok(Param::Null);
    };
    if let Some(scale) = numeric_scale(ty) {
        let value = parse_decimal(&text).map_err(|e| format!("{text}: {e}"))?;
        let fixed = to_fixed(value, scale).map_err(|e| format!("{text}: {e}"))?;
        if from_fixed(fixed, scale) != value {
            return Err(format!("{text}: not exact at scale {scale}"));
        }
        return Ok(Param::Integer(fixed));
    }
    match ty {
        "timestamp with time zone" => parse_timestamp_us(&text)
            .map(Param::Integer)
            .ok_or_else(|| format!("{text}: not a representable timestamp")),
        "boolean" => match text.as_str() {
            "true" => Ok(Param::Integer(1)),
            "false" => Ok(Param::Integer(0)),
            _ => Err(format!("{text}: not a boolean")),
        },
        "bigint" | "integer" => text
            .parse::<i64>()
            .map(Param::Integer)
            .map_err(|_| format!("{text}: not an integer")),
        "uuid" => uuid::Uuid::parse_str(&text)
            .map(|u| Param::Text(u.to_string()))
            .map_err(|_| format!("{text}: not a uuid")),
        "text" => Ok(Param::Text(text)),
        other => Err(format!("no conversion for type {other}")),
    }
}

/// Refuses a source whose tables or column types differ from the schema, so no
/// data is dropped silently.
async fn check_source_shape(pg: &mut PgConnection) -> Result<(), Failure> {
    let rows = sqlx::query(
        "SELECT c.relname::text AS table_name, a.attname::text AS column_name, \
                format_type(a.atttypid, a.atttypmod)::text AS data_type \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped",
    )
    .fetch_all(&mut *pg)
    .await
    .map_err(db_err("reading the catalog"))?;

    let mut source: HashMap<(String, String), String> = HashMap::new();
    for row in &rows {
        let key = (row.get::<String, _>(0), row.get::<String, _>(1));
        source.insert(key, row.get::<String, _>(2));
    }
    for (table, column, ty) in copied_columns() {
        let key = (table.to_string(), column.to_string());
        match source.remove(&key) {
            None => return Err(format!("source has no column {table}.{column}")),
            Some(found) if found != *ty => {
                return Err(format!("{table}.{column} is {found}, expected {ty}"))
            }
            Some(_) => {}
        }
    }
    if let Some(((table, column), _)) = source.into_iter().next() {
        return Err(format!(
            "{table}.{column} exists in Postgres but not in the SQLite schema"
        ));
    }
    Ok(())
}

async fn copy_table(
    pg: &mut PgConnection,
    sqlite: &Connection,
    table: &str,
) -> Result<i64, Failure> {
    let columns = columns_of(table);
    let names: Vec<&str> = columns.iter().map(|(c, _)| *c).collect();
    let select: Vec<String> = names.iter().map(|c| format!("\"{c}\"::text")).collect();
    let insert = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        names.join(", "),
        vec!["?"; names.len()].join(", ")
    );
    let rows: Vec<PgRow> = sqlx::query(&format!("SELECT {} FROM {table}", select.join(", ")))
        .fetch_all(&mut *pg)
        .await
        .map_err(db_err(table))?;

    let mut statement = sqlite
        .prepare(&insert)
        .map_err(|e| format!("{table}: {e}"))?;
    for row in &rows {
        let mut params = Vec::with_capacity(columns.len());
        for (idx, (column, ty)) in columns.iter().enumerate() {
            let text: Option<String> = row.get(idx);
            params.push(convert(ty, text).map_err(|e| format!("{table}.{column}: {e}"))?);
        }
        statement
            .execute(params_from_iter(params))
            .map_err(|e| format!("{table}: row refused: {e}"))?;
    }
    Ok(rows.len() as i64)
}

/// The next value AUTOINCREMENT would hand out must not reuse a deleted id.
async fn copy_sequences(pg: &mut PgConnection, sqlite: &Connection) -> Result<(), Failure> {
    for table in ["balance_audit_log", "withdrawal_requests"] {
        let last: Option<i64> =
            sqlx::query_scalar("SELECT last_value FROM pg_sequences WHERE sequencename = $1")
                .bind(format!("{table}_id_seq"))
                .fetch_optional(&mut *pg)
                .await
                .map_err(db_err(table))?
                .flatten();
        let Some(last) = last else { continue };
        sqlite
            .execute(
                "DELETE FROM sqlite_sequence WHERE name = ?1",
                rusqlite::params![table],
            )
            .and_then(|_| {
                sqlite.execute(
                    "INSERT INTO sqlite_sequence (name, seq) VALUES (?1, ?2)",
                    rusqlite::params![table, last],
                )
            })
            .map_err(|e| format!("{table}: {e}"))?;
    }
    Ok(())
}

async fn verify_table(
    pg: &mut PgConnection,
    sqlite: &Connection,
    table: &str,
    copied: i64,
) -> Result<(), Failure> {
    let source: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&mut *pg)
        .await
        .map_err(db_err(table))?;
    let target: i64 = sqlite
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| format!("{table}: {e}"))?;
    if source != target || source != copied {
        return Err(format!(
            "{table}: row counts differ: postgres {source}, copied {copied}, sqlite {target}"
        ));
    }
    print!("  {table}: {target} rows");

    for (column, ty) in columns_of(table) {
        let Some(scale) = numeric_scale(ty) else {
            continue;
        };
        let pg_sum: String = sqlx::query_scalar(&format!(
            "SELECT COALESCE(SUM(\"{column}\"), 0)::text FROM {table}"
        ))
        .fetch_one(&mut *pg)
        .await
        .map_err(db_err(table))?;
        let pg_sum = scaled_i128(&pg_sum, scale).map_err(|e| format!("{table}.{column}: {e}"))?;

        let mut statement = sqlite
            .prepare(&format!("SELECT \"{column}\" FROM {table}"))
            .map_err(|e| format!("{table}: {e}"))?;
        let mut sqlite_sum: i128 = 0;
        let mut rows = statement.query([]).map_err(|e| format!("{table}: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("{table}: {e}"))? {
            let cell: Option<i64> = row.get(0).map_err(|e| format!("{table}.{column}: {e}"))?;
            sqlite_sum += i128::from(cell.unwrap_or(0));
        }
        if pg_sum != sqlite_sum {
            return Err(format!(
                "{table}.{column}: sums differ at scale {scale}: postgres {pg_sum}, sqlite {sqlite_sum}"
            ));
        }
        print!(", sum({column}) ok");
    }
    println!();
    Ok(())
}

async fn migrate(url: &str, out: &str) -> Result<(), Failure> {
    let mut pg = PgConnection::connect(url)
        .await
        .map_err(db_err("connecting to Postgres"))?;
    sqlx::query("SET TIME ZONE 'UTC'")
        .execute(&mut pg)
        .await
        .map_err(db_err("setting the time zone"))?;
    sqlx::query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut pg)
        .await
        .map_err(db_err("opening the snapshot"))?;
    check_source_shape(&mut pg).await?;

    let mut sqlite = Connection::open(out).map_err(|e| format!("{out}: {e}"))?;
    sqlite
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
        .and_then(|_| sqlite.execute_batch(SCHEMA_SQL))
        // The schema seeds one ban; the source's own row replaces it.
        .and_then(|_| sqlite.execute_batch("DELETE FROM banned_wallets"))
        .map_err(|e| format!("creating the schema: {e}"))?;

    let tx = sqlite.transaction().map_err(|e| e.to_string())?;
    let mut copied = Vec::new();
    for table in tables() {
        copied.push((table, copy_table(&mut pg, &tx, table).await?));
    }
    copy_sequences(&mut pg, &tx).await?;
    println!("verifying");
    for (table, count) in &copied {
        verify_table(&mut pg, &tx, table, *count).await?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;

    let integrity: String = sqlite
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err(format!("integrity_check: {integrity}"));
    }
    sqlite
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(out) = std::env::args().nth(1) else {
        eprintln!("usage: PG_URL=postgres://... migrate_pg_to_sqlite <new-file.sqlite>");
        std::process::exit(2);
    };
    let Ok(url) = std::env::var("PG_URL") else {
        eprintln!("PG_URL is not set");
        std::process::exit(2);
    };
    if Path::new(&out).exists() {
        eprintln!("{out} already exists; refusing to overwrite it");
        std::process::exit(2);
    }
    if let Err(failure) = migrate(&url, &out).await {
        eprintln!("ABORTED, nothing kept: {failure}");
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{out}{suffix}"));
        }
        std::process::exit(1);
    }
    println!("ok: {out}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_compare_past_decimal_range() {
        assert_eq!(scaled_i128("1.5", 10).unwrap(), 15_000_000_000);
        assert_eq!(scaled_i128("-0.0000000001", 10).unwrap(), -1);
        assert_eq!(scaled_i128("0", 8).unwrap(), 0);
        assert_eq!(
            scaled_i128("99999999999999999999.9999999999", 10).unwrap(),
            999_999_999_999_999_999_999_999_999_999i128
        );
        assert!(scaled_i128("1.123", 2).is_err());
    }

    #[test]
    fn lossy_cells_are_refused() {
        let money = "numeric(30,10)";
        assert_eq!(
            convert(money, Some("0.0000000100".into())).unwrap(),
            Param::Integer(100)
        );
        assert!(convert(money, Some("NaN".into())).is_err());
        assert!(convert(money, Some("922337203.6854775808".into())).is_err());
        // More places than the column holds would have to round.
        assert!(convert("numeric(10,4)", Some("1.23456".into())).is_err());
        assert!(convert("timestamp with time zone", Some("infinity".into())).is_err());
        assert_eq!(convert("text", None).unwrap(), Param::Null);
        assert!(convert("jsonb", Some("{}".into())).is_err());
    }

    #[test]
    fn postgres_timestamp_text_keeps_microseconds() {
        assert_eq!(
            convert(
                "timestamp with time zone",
                Some("1970-01-01 00:00:01.000001+00".into())
            )
            .unwrap(),
            Param::Integer(1_000_001)
        );
    }

    #[test]
    fn every_table_is_listed_once() {
        let names = tables();
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(names.len(), unique.len());
        assert_eq!(names.len(), 11);
    }
}
