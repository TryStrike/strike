//! Postgres transport: one pooled sqlx connection set replaces the
//! `node-postgres` pool in `lib/db/server.ts`.
//!
//! Wire-compatibility with the TS layer, which the browser still sees:
//!   * NUMERIC  -> JSON number (house balances stay far below 2^53);
//!   * BIGINT   -> JSON number;
//!   * TIMESTAMP/TIMESTAMPTZ -> ISO-8601 string with millisecond precision,
//!     the shape PostgREST served and every call site parses. TIMESTAMP is read
//!     as UTC rather than the server's local zone, fixing the drift the old
//!     `new Date(value)` parser had.

use std::str::FromStr;
use std::time::Duration;

use rust_decimal::Decimal;
use serde_json::{Map, Number, Value};
use sqlx::postgres::{PgArguments, PgPool, PgPoolOptions};
use sqlx::{Arguments, Column, Row};

use crate::config::config;
use crate::error::{ApiError, ApiResult};

static POOL: tokio::sync::OnceCell<PgPool> = tokio::sync::OnceCell::const_new();

pub async fn pool() -> ApiResult<&'static PgPool> {
    POOL.get_or_try_init(build_pool).await
}

async fn build_pool() -> Result<PgPool, ApiError> {
    let cfg = config();
    let url = cfg
        .database_url
        .as_deref()
        .ok_or_else(|| ApiError::unavailable("DATABASE_URL is not configured"))?;
    let opts = sqlx::postgres::PgConnectOptions::from_str(url)
        .map_err(|e| ApiError::Other(format!("invalid DATABASE_URL: {e}")))?
        .application_name("strike-backend");

    let pool = PgPoolOptions::new()
        // Serverless-era default from the TS pool (PGPOOL_MAX ?? 5): Neon caps
        // concurrent connections, so keep it small and let it queue.
        .max_connections(cfg.pool_max)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(10))
        .test_before_acquire(true)
        // Kill runaway reads so one slow query cannot pin a pooled connection,
        // and release a connection held open by a stalled transaction.
        // `set_config` rather than `SET`: the statement form takes a literal,
        // so the only parameterised option is this function.
        .after_connect(move |conn, _meta| {
            let statement_timeout = cfg.statement_timeout_ms.to_string();
            Box::pin(async move {
                sqlx::query("SELECT set_config('statement_timeout', $1, false)")
                    .bind(&statement_timeout)
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("SELECT set_config('idle_in_transaction_session_timeout', '10000', false)")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await
        .map_err(|e| ApiError::Other(format!("database connection failed: {e}")))?;

    Ok(pool)
}

/// Renders a row with the same JSON shapes the TS type parsers produced.
pub fn row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let mut map = Map::new();
    for (idx, column) in row.columns().iter().enumerate() {
        let value = decode_column(row, idx, &column.type_info().to_string());
        map.insert(column.name().to_string(), value);
    }
    Value::Object(map)
}

pub fn rows_to_json(rows: &[sqlx::postgres::PgRow]) -> Vec<Value> {
    rows.iter().map(row_to_json).collect()
}

fn decode_column(row: &sqlx::postgres::PgRow, idx: usize, type_name: &str) -> Value {
    match type_name {
        "BOOL" => get::<bool>(row, idx).map(Value::Bool).unwrap_or(Value::Null),
        "INT2" | "INT4" | "INT8" | "OID" => get::<i64>(row, idx)
            .map(|v| Value::Number(Number::from(v)))
            .unwrap_or(Value::Null),
        "FLOAT4" | "FLOAT8" => get::<f64>(row, idx)
            .and_then(|v| Number::from_f64(v).map(Value::Number))
            .unwrap_or(Value::Null),
        // NUMERIC arrives as a float in the TS pool; NaN/infinite decimals have
        // no JSON representation, so they become null rather than poisoning a
        // whole response.
        "NUMERIC" => row
            .try_get::<Decimal, usize>(idx)
            .ok()
            .and_then(|d| d.to_string().parse::<f64>().ok())
            .and_then(|f| if f.is_finite() { Number::from_f64(f) } else { None })
            .map(Value::Number)
            .unwrap_or(Value::Null),
        "JSON" | "JSONB" => get::<Value>(row, idx).unwrap_or(Value::Null),
        "BYTEA" => get::<Vec<u8>>(row, idx)
            .map(|b| Value::String(hex::encode(b)))
            .unwrap_or(Value::Null),
        "TIMESTAMPTZ" => get::<chrono::DateTime<chrono::Utc>>(row, idx)
            .map(|dt| Value::String(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
            .unwrap_or_else(|| string_column(row, idx)),
        "TIMESTAMP" => get::<chrono::NaiveDateTime>(row, idx)
            .map(|dt| Value::String(format!("{}Z", dt.format("%Y-%m-%dT%H:%M:%S%.3f"))))
            .unwrap_or_else(|| string_column(row, idx)),
        "DATE" => get::<chrono::NaiveDate>(row, idx)
            .map(|d| Value::String(d.format("%Y-%m-%d").to_string()))
            .unwrap_or(Value::Null),
        "UUID" => get::<uuid::Uuid>(row, idx)
            .map(|u| Value::String(u.to_string()))
            .unwrap_or_else(|| string_column(row, idx)),
        _ => string_column(row, idx),
    }
}

fn get<'a, T>(row: &'a sqlx::postgres::PgRow, idx: usize) -> Option<T>
where
    T: sqlx::Decode<'a, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get::<Option<T>, usize>(idx).ok().flatten()
}

fn string_column(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
    get::<String>(row, idx)
        .or_else(|| get::<chrono::NaiveDateTime>(row, idx).map(|dt| format!("{}Z", dt.format("%Y-%m-%dT%H:%M:%S%.3f"))))
        .map(Value::String)
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Hand-written SQL with typed binds
// ---------------------------------------------------------------------------

/// `(postgres type of the cast, value)`, one entry per `$n`.
pub type TypedBind<'a> = (&'a str, &'a Value);

/// The highest `$n` placeholder in a statement.
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

fn arguments(sql: &str, binds: &[TypedBind]) -> ApiResult<PgArguments> {
    let highest = highest_placeholder(sql);
    if highest != binds.len() {
        // A mismatch would bind the wrong column or leave a placeholder
        // unbound; fail loudly at the call site instead.
        return Err(ApiError::internal(format!(
            "query has {highest} placeholders but {} binds",
            binds.len()
        )));
    }
    let mut args = PgArguments::default();
    for (ty, value) in binds {
        push_typed_arg(&mut args, ty, value)?;
    }
    Ok(args)
}

pub async fn fetch(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Vec<Value>> {
    let args = arguments(sql, binds)?;
    let rows = sqlx::query_with(sql, args).fetch_all(pool().await?).await?;
    Ok(rows_to_json(&rows))
}

pub async fn fetch_one(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Option<Value>> {
    let args = arguments(sql, binds)?;
    let row = sqlx::query_with(sql, args).fetch_optional(pool().await?).await?;
    Ok(row.as_ref().map(row_to_json))
}

/// Rows affected, for UPDATE/DELETE/INSERT.
pub async fn execute(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<u64> {
    let args = arguments(sql, binds)?;
    let result = sqlx::query_with(sql, args).execute(pool().await?).await?;
    Ok(result.rows_affected())
}

/// A single scalar, e.g. `SELECT count(*)`.
pub async fn fetch_scalar(sql: &str, binds: &[TypedBind<'_>]) -> ApiResult<Value> {
    let first = fetch_one(sql, binds)
        .await?
        .and_then(|row| row.as_object().and_then(|m| m.values().next().cloned()));
    Ok(first.unwrap_or(Value::Null))
}

/// `callRpc()` from the TS layer: named-argument SELECT of a stored function.
///
/// Every argument is bound as text and cast by the server to the parameter type
/// read from the catalog (see `crate::schema`). This is what replaces the
/// "Postgres infers the type of an unspecified parameter" behaviour the TS
/// service got for free from node-pg: an explicit `CAST($1 AS numeric)` is
/// accepted for a numeric parameter where a bare text-typed parameter is not.
/// Neither the type name nor the value is ever concatenated from client input -
/// the name comes from `pg_catalog` and is re-validated, the value is bound.
pub async fn call_rpc(fn_name: &str, params: &[(&str, &Value)]) -> ApiResult<Value> {
    if !is_identifier(fn_name) {
        return Err(ApiError::internal(format!("Unsafe function name: {fn_name}")));
    }
    for (name, _) in params {
        if !is_identifier(name) {
            return Err(ApiError::internal(format!("Unsafe parameter name: {name}")));
        }
    }

    let schema = crate::schema::get().await?;
    let mut args = PgArguments::default();
    let mut named = Vec::with_capacity(params.len());

    for (i, (name, value)) in params.iter().enumerate() {
        let ty = schema.rpc_param_type(fn_name, name).ok_or_else(|| {
            ApiError::internal(format!(
                "Function {fn_name} has no parameter {name} in the public schema"
            ))
        })?;
        if !is_safe_type_expression(ty) {
            return Err(ApiError::internal(format!("Unusable type for {fn_name}.{name}")));
        }
        named.push(format!("\"{name}\" => CAST(${} AS {ty})", i + 1));
        push_typed_arg(&mut args, ty, value)?;
    }

    let sql = format!("SELECT * FROM \"{fn_name}\"({})", named.join(", "));

    let rows = sqlx::query_with(sql.as_str(), args)
        .fetch_all(pool().await?)
        .await?;

    if rows.len() == 1 && rows[0].columns().len() == 1 {
        if let Some(map) = row_to_json(&rows[0]).as_object() {
            if let Some(v) = map.values().next() {
                return Ok(v.clone());
            }
        }
    }
    Ok(Value::Array(rows_to_json(&rows)))
}

/// JSON value -> the text a CAST-from-text bind needs. `None` is SQL NULL.
pub fn json_bind_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { "true" } else { "false" }.to_string()),
        // serde_json prints integers exactly and floats in round-trip form,
        // which Postgres accepts for numeric, int, float and even exponent
        // inputs like 1e-8.
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Bind `value` so that `CAST($n AS type_name)` yields `type_name`.
///
/// `bytea` is the one type that must not go through text, because its binary
/// format is the raw byte string; arrays are refused rather than guessed at,
/// since a wrong guess here silently changes the money math.
pub fn push_typed_arg(args: &mut PgArguments, type_name: &str, value: &Value) -> ApiResult<()> {
    let added = if type_name == "bytea" {
        let hexed = value
            .as_str()
            .ok_or_else(|| ApiError::internal("bytea parameter requires a hex string".to_string()))?;
        let bytes = hex::decode(hexed.strip_prefix("0x").unwrap_or(hexed))
            .map_err(|e| ApiError::internal(format!("bytea parameter is not hex: {e}")))?;
        args.add(bytes)
    } else if type_name.ends_with("[]") {
        return Err(ApiError::internal(format!(
            "Array bind parameters are not supported (got {type_name})"
        )));
    } else {
        args.add(json_bind_text(value))
    };
    added.map(|_| ()).map_err(|e| ApiError::Other(format!("bind failed: {e}")))
}

/// `CAST($idx AS <type>)` when the type is known and safe to write, otherwise a
/// bare placeholder. Used by the /api/db gateway, where filters must be compared
/// in the column's own type.
pub fn typed_placeholder(idx: usize, type_name: Option<&str>) -> String {
    match type_name.filter(|t| is_safe_type_expression(t)) {
        Some(t) => format!("CAST(${idx} AS {t})"),
        None => format!("${idx}"),
    }
}

/// Types reach SQL only from `pg_catalog`, never from a client. Still: allow
/// only the characters a real type expression can contain, so a catalog entry
/// (or a future code path) cannot smuggle SQL through a type name.
pub fn is_safe_type_expression(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() < 128
        && bytes.iter().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'_' | b' ' | b'.' | b',' | b'(' | b')' | b'[' | b']')
        })
}

/// Untyped fallback for callers that already know the Rust type of a value.
/// Numbers keep their integer/float identity; objects and arrays go out as JSONB.
pub fn push_arg(args: &mut PgArguments, value: &Value) -> ApiResult<()> {
    let added = match value {
        Value::Null => args.add(Option::<String>::None),
        Value::Bool(b) => args.add(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                args.add(i)
            } else if let Some(f) = n.as_f64() {
                args.add(f.to_string())
            } else {
                args.add(n.to_string())
            }
        }
        Value::String(s) => args.add(s.clone()),
        other => args.add(other.clone()),
    };
    added.map(|_| ()).map_err(|e| ApiError::Other(format!("bind failed: {e}")))
}

/// The ledger functions answer `{"success": bool, ...}`; scalars get wrapped so
/// handlers can read one shape.
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
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// Postgres error code, e.g. "23505" for unique violations. Handlers branch on
/// this to turn a duplicate insert into a 409.
pub fn pg_error_code(err: &sqlx::Error) -> Option<String> {
    err.as_database_error()
        .and_then(|db| db.code().map(|c| c.to_string()))
}

pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    pg_error_code(err).as_deref() == Some("23505")
}

pub async fn ping() -> ApiResult<()> {
    sqlx::query("SELECT 1").execute(pool().await?).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(json_bind_text(&Value::Bool(false)).as_deref(), Some("false"));
        assert_eq!(json_bind_text(&serde_json::json!(5)).as_deref(), Some("5"));
        assert_eq!(json_bind_text(&serde_json::json!(7.25)).as_deref(), Some("7.25"));
        assert_eq!(json_bind_text(&serde_json::json!(i64::MAX)).as_deref(), Some("9223372036854775807"));
        assert_eq!(json_bind_text(&serde_json::json!("0xabc")).as_deref(), Some("0xabc"));
        assert_eq!(
            json_bind_text(&serde_json::json!({"success": true})).as_deref(),
            Some(r#"{"success":true}"#)
        );
    }

    #[test]
    fn type_expressions_are_revalidated() {
        for ok in ["numeric", "integer", "timestamp with time zone", "character varying", "public.status", "jsonb"] {
            assert!(is_safe_type_expression(ok), "rejected {ok}");
        }
        for bad in ["", "numeric; DROP TABLE x", "int) => 1", "a' OR '1'='1", &"x".repeat(200)] {
            assert!(!is_safe_type_expression(bad), "accepted {bad}");
        }
    }

    #[test]
    fn placeholder_casts_only_when_the_type_is_known() {
        assert_eq!(typed_placeholder(1, Some("numeric")), "CAST($1 AS numeric)");
        assert_eq!(typed_placeholder(3, None), "$3");
        assert_eq!(typed_placeholder(2, Some("bad; type")), "$2");
    }

    #[test]
    fn typed_binds_reject_shapes_they_cannot_encode() {
        let mut args = PgArguments::default();
        push_typed_arg(&mut args, "numeric", &serde_json::json!(1.5)).unwrap();
        push_typed_arg(&mut args, "bytea", &serde_json::json!("0xdeadbeef")).unwrap();
        assert!(push_typed_arg(&mut args, "bytea", &serde_json::json!("not-hex")).is_err());
        assert!(push_typed_arg(&mut args, "text[]", &serde_json::json!(["a"])).is_err());
        // NULL is bindable for every cast target.
        push_typed_arg(&mut args, "uuid", &Value::Null).unwrap();
    }

    #[test]
    fn arguments_can_be_pushed_for_every_json_shape() {
        let mut args = PgArguments::default();
        for value in [
            Value::Null,
            Value::Bool(true),
            Value::Number(serde_json::json!(5).as_i64().unwrap().into()),
            Value::Number(Number::from_f64(1.25).unwrap()),
            Value::String("0xabc".into()),
            serde_json::json!({"a": 1}),
            serde_json::json!([1, 2]),
        ] {
            push_arg(&mut args, &value).unwrap();
        }
    }
}
