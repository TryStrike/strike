//! `/api/db` browser query gateway.
//!
//! Port of `lib/db/browserAllowList.ts` (deny-by-default rules), `lib/db/query.ts`
//! (descriptor -> SQL compiler) and `app/api/db/route.ts` (normalisation,
//! invocation and the exact JSON response shape), so the existing client
//! bundle in `lib/db/browser.ts` keeps working unchanged.
//!
//! Layering (mirrors the TS files):
//!   * [`normalize`] - the route's shape coercion, so a hand-crafted body
//!     cannot smuggle extra fields or out-of-range limits.
//!   * [`check_allowed`] - the allow-list. Runs first; nothing outside the
//!     two `user_profiles` rules is ever compiled, let alone executed.
//!   * [`compile`] - pure, no database: SQL text plus the ordered, typed
//!     binds. Every identifier is re-validated with `db::is_identifier`
//!     before it is written literally; every value goes through a
//!     placeholder.
//!   * [`execute`] - thin async wrapper that turns the binds into
//!     `PgArguments` in placeholder order and runs the main and COUNT
//!     queries concurrently, like the TS `Promise.all` did.
//!   * [`handle`] - the POST body handler: the exact status/body shapes of
//!     `app/api/db/route.ts` (`{rows, count}` on success, object-shaped
//!     `{error: {message, code?}}` on failure; the real cause is logged
//!     server-side and never sent to the browser).
//!
//! Why the SQL differs textually from the TS compiler in one respect:
//! node-pg sends every parameter with an unspecified OID and Postgres infers
//! the type, sqlx cannot, so each bind carries the column's catalog type and
//! the placeholder is written `CAST($n AS <type>)` (see `crate::db` and
//! `crate::schema`). Everything else - clause layout, bind order, the
//! separate renumbered COUNT query - reproduces `query.ts` exactly.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use sqlx::postgres::PgArguments;
use sqlx::Row;

use crate::db::{
    is_identifier, is_safe_type_expression, pool, push_arg, push_typed_arg, rows_to_json,
    typed_placeholder,
};
use crate::error::{ApiError, ApiResult};
use crate::schema::Schema;

/// `MAX_GATEWAY_LIMIT` / `MAX_GATEWAY_OFFSET` from `app/api/db/route.ts`.
const MAX_GATEWAY_LIMIT: i64 = 50;
const MAX_GATEWAY_OFFSET: i64 = 100_000;
/// `MAX_LIMIT_ROWS` from `lib/db/query.ts`: last-resort ceiling for any LIMIT.
const MAX_LIMIT_ROWS: i64 = 1000;
/// `Number.MAX_SAFE_INTEGER`, the offset ceiling the TS compiler used.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

// ---------------------------------------------------------------------------
// Descriptor (QueryDescriptor in lib/db/query.ts)
// ---------------------------------------------------------------------------

/// One filter as the client sent it. `value` is `None` only when the JSON
/// member is absent; an explicit `null` deserialises to `Some(Value::Null)`,
/// which matters for `is` (undefined must fail, null means `IS NULL`).
#[derive(Debug, Clone, PartialEq)]
pub struct QueryFilter {
    pub op: String,
    pub column: String,
    pub value: Option<Value>,
}

/// The normalised gateway descriptor. Built only by [`normalize`], which
/// enforces the same field types and ranges the TS route did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Descriptor {
    pub table: String,
    pub op: String,
    pub columns: Option<String>,
    /// Rows for insert/upsert. Kept as raw values so non-object entries
    /// behave like the TS `Object.keys(row)` did (they contribute no keys).
    pub values: Option<Vec<Value>>,
    /// Patch for update (object or array; non-object treated as empty).
    pub patch: Option<Value>,
    pub on_conflict: Option<String>,
    pub filters: Vec<QueryFilter>,
    pub or_filter: Option<String>,
    pub order: Vec<Value>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub returning: bool,
    pub single: Option<String>,
    /// Only `"exact"` survives normalisation, exactly as in the TS route.
    pub count: Option<String>,
    pub head: bool,
}

/// JS `typeof v === 'number' || typeof v === 'string'` followed by `Number(v)`
/// and `Number.isInteger`: anything else, anything fractional, or anything
/// outside the range is dropped rather than rejected.
fn int_in_range(value: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    let n: f64 = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    if !n.is_finite() || n.fract() != 0.0 || n < min as f64 || n > max as f64 {
        return None;
    }
    Some(n as i64)
}

/// JS truthiness for the Boolean()/ternary checks in the TS route and
/// compiler (false, null, 0 and "" are falsy; everything else is truthy).
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None => false,
        Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn filter_from(value: &Value) -> QueryFilter {
    QueryFilter {
        op: value
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        column: value
            .get("column")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        value: value.get("value").cloned(),
    }
}

/// The TS route's normalisation. `None` means the "Malformed query" 400:
/// `table` and `op` must be strings, and the body must be a JSON value that
/// answers property lookups (anything else failed the same way in JS).
pub fn normalize(body: &Value) -> Option<Descriptor> {
    if !(body.is_object() || body.is_array() || body.is_string()) {
        return None;
    }
    let table = body.get("table").and_then(Value::as_str)?;
    let op = body.get("op").and_then(Value::as_str)?;
    let single = match body.get("single").and_then(Value::as_str) {
        Some("one") | Some("maybe") => body
            .get("single")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    };
    Some(Descriptor {
        table: table.to_string(),
        op: op.to_string(),
        columns: body.get("columns").and_then(Value::as_str).map(str::to_string),
        values: body.get("values").and_then(Value::as_array).cloned(),
        patch: body
            .get("patch")
            .filter(|v| v.is_object() || v.is_array())
            .cloned(),
        on_conflict: body
            .get("onConflict")
            .and_then(Value::as_str)
            .map(str::to_string),
        filters: body
            .get("filters")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(filter_from).collect())
            .unwrap_or_default(),
        or_filter: body.get("orFilter").and_then(Value::as_str).map(str::to_string),
        order: body
            .get("order")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        limit: int_in_range(body.get("limit"), 1, MAX_GATEWAY_LIMIT),
        offset: int_in_range(body.get("offset"), 0, MAX_GATEWAY_OFFSET),
        returning: js_truthy(body.get("returning")),
        single,
        count: (body.get("count").and_then(Value::as_str) == Some("exact"))
            .then(|| "exact".to_string()),
        head: js_truthy(body.get("head")),
    })
}

// ---------------------------------------------------------------------------
// Allow list (lib/db/browserAllowList.ts)
// ---------------------------------------------------------------------------

struct Rule {
    table: &'static str,
    op: &'static str,
    columns: &'static [&'static str],
    require_filter_on: &'static [&'static str],
    identity_columns: &'static [&'static str],
    max_limit: Option<i64>,
}

/// Keep this list minimal: adding a table here exposes it to the public.
/// Balances, bets and admin data go through purpose-built authenticated
/// routes, never through the gateway.
const RULES: &[Rule] = &[
    // Profile store: read own profile, check username availability, set username.
    // `access_code` is deliberately NOT here - it is a credential.
    Rule {
        table: "user_profiles",
        op: "select",
        columns: &["user_address", "username"],
        require_filter_on: &["user_address", "username"],
        identity_columns: &[],
        max_limit: Some(1),
    },
    Rule {
        table: "user_profiles",
        op: "upsert",
        columns: &["user_address", "username", "updated_at"],
        require_filter_on: &["user_address"],
        identity_columns: &["user_address"],
        max_limit: Some(1),
    },
];

#[derive(Debug, Clone, PartialEq)]
pub struct AllowResult {
    pub allowed: bool,
    /// Server-side log text only; the browser sees the generic 403 body.
    pub reason: Option<String>,
    /// For a read: the request's columns intersected with the rule. The
    /// gateway rewrites the descriptor with this before compiling.
    pub columns: Option<Vec<String>>,
}

fn denied(reason: impl Into<String>) -> AllowResult {
    AllowResult {
        allowed: false,
        reason: Some(reason.into()),
        columns: None,
    }
}

/// Splits a comma list, trimming and dropping blanks.
fn split_list(raw: &str) -> Vec<String> {
    raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// PostgREST column list; `'*'` / empty means "every column" -> `None`.
fn requested_columns(columns: Option<&str>) -> Option<Vec<String>> {
    let trimmed = columns.unwrap_or("").trim();
    if trimmed.is_empty() || trimmed == "*" {
        return None;
    }
    Some(split_list(trimmed))
}

/// `String(a).trim().toLowerCase()` - identity comparisons ignore EVM
/// checksum casing. `None` models JS `undefined` like the TS String() did.
fn ts_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(other) => other.to_string(),
    }
}

fn same_scalar(a: Option<&Value>, b: Option<&Value>) -> bool {
    ts_string(a).trim().to_lowercase() == ts_string(b).trim().to_lowercase()
}

/// `Object.keys(row)` equivalent: objects yield their keys, arrays their
/// indices, anything else contributes nothing.
fn row_keys(row: &Value) -> Vec<String> {
    match row {
        Value::Object(map) => map.keys().cloned().collect(),
        Value::Array(items) => (0..items.len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    }
}

fn row_value<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    match row {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    }
}

pub fn check_allowed(desc: &Descriptor) -> AllowResult {
    let Some(rule) = RULES.iter().find(|r| r.table == desc.table && r.op == desc.op) else {
        return denied(format!(
            "{} on \"{}\" is not available to the browser",
            desc.op, desc.table
        ));
    };

    // Columns being read. `'*'` (explicit or omitted) is refused for every
    // operation: a write with RETURNING must say which columns.
    let requested = requested_columns(desc.columns.as_deref());
    let read_columns = match requested {
        None => {
            if desc.op == "select" || desc.returning {
                return denied("listing the columns explicitly is required; \"*\" is not allowed");
            }
            None
        }
        Some(cols) => {
            let unknown: Vec<&String> =
                cols.iter().filter(|c| !rule.columns.contains(&c.as_str())).collect();
            let readable: Vec<&String> =
                cols.iter().filter(|c| rule.columns.contains(&c.as_str())).collect();
            if desc.op == "select" || desc.returning {
                if readable.is_empty() {
                    return denied(format!(
                        "columns not readable: {}",
                        unknown.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ")
                    ));
                }
                // Anything outside the rule is dropped rather than rejected.
                return validate_rest(
                    desc,
                    rule,
                    Some(readable.iter().map(|c| c.to_string()).collect()),
                );
            }
            if !unknown.is_empty() {
                return denied(format!(
                    "columns not readable: {}",
                    unknown.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ")
                ));
            }
            Some(cols)
        }
    };

    validate_rest(desc, rule, read_columns)
}

fn validate_rest(desc: &Descriptor, rule: &Rule, read_columns: Option<Vec<String>>) -> AllowResult {
    // Columns being written: values rows plus the update patch.
    let written: Vec<String> = desc
        .values
        .iter()
        .flat_map(|rows| rows.iter())
        .flat_map(row_keys)
        .chain(desc.patch.iter().flat_map(row_keys))
        .collect();
    let bad_write: Vec<&String> = written
        .iter()
        .filter(|c| !rule.columns.contains(&c.as_str()))
        .collect();
    if !bad_write.is_empty() {
        return denied(format!(
            "columns not writable: {}",
            bad_write.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }

    // Every filter column must be one the rule exposes; otherwise the
    // endpoint is a blind probe for arbitrary columns.
    for f in &desc.filters {
        if !rule.columns.contains(&f.column.as_str()) {
            return denied(format!(
                "filtering on \"{}\" is not available to the browser",
                f.column
            ));
        }
        if rule.identity_columns.contains(&f.column.as_str()) && f.op != "eq" {
            return denied(format!("filter on \"{}\" must be an equality", f.column));
        }
    }

    if !rule.identity_columns.is_empty() {
        let identity = rule.identity_columns;
        for row in desc.values.iter().flat_map(|rows| rows.iter()) {
            let missing: Vec<&str> = identity
                .iter()
                .copied()
                .filter(|c| matches!(row_value(row, c), None | Some(Value::Null)))
                .collect();
            if !missing.is_empty() {
                return denied(format!("a value for {} is required", missing.join(" / ")));
            }
        }

        // The ON CONFLICT target decides which row a DO UPDATE rewrites, so
        // it may only be the identity column.
        let conflict = split_list(desc.on_conflict.as_deref().unwrap_or(""));
        for c in &conflict {
            if !identity.contains(&c.as_str()) {
                return denied(format!("\"{c}\" cannot be used as the conflict target"));
            }
        }
        // With a conflict target the write becomes an UPDATE, scoped to the
        // very row the caller is standing behind.
        if !conflict.is_empty() {
            for column in &conflict {
                let eq_filters: Vec<&QueryFilter> = desc
                    .filters
                    .iter()
                    .filter(|f| f.op == "eq" && &f.column == column)
                    .collect();
                if eq_filters.is_empty() {
                    return denied(format!("a filter on {column} is required"));
                }
                for row in desc.values.iter().flat_map(|rows| rows.iter()) {
                    let Some(written_value) = row_value(row, column) else {
                        continue;
                    };
                    if !eq_filters
                        .iter()
                        .any(|f| same_scalar(f.value.as_ref(), Some(written_value)))
                    {
                        return denied(format!("{column} may only be written for itself"));
                    }
                }
            }
        }
    }

    // Reads must be scoped.
    if !rule.require_filter_on.is_empty() {
        let scoped = desc
            .filters
            .iter()
            .any(|f| rule.require_filter_on.contains(&f.column.as_str()));
        if !scoped {
            // A write that only inserts (no conflict target) cannot touch an
            // existing row, so it is exempt from the scoping requirement.
            let write_only = desc.op != "select"
                && desc.on_conflict.as_deref().unwrap_or("").trim().is_empty();
            if !write_only {
                return denied(format!(
                    "a filter on one of {} is required",
                    rule.require_filter_on.join(" / ")
                ));
            }
        }
    }

    // Reads must be finite; writes must stay within the row ceiling.
    if let Some(max) = rule.max_limit {
        if desc.op == "select" {
            let limit = if desc.single.is_some() { Some(1) } else { desc.limit };
            if !matches!(limit, Some(l) if l >= 1 && l <= max) {
                return denied(format!("limit must be an integer between 1 and {max}"));
            }
        }
        let rows = desc.values.as_ref().map_or(0, Vec::len);
        if rows > max as usize {
            return denied(format!("at most {max} row may be written"));
        }
    }

    if desc.or_filter.as_deref().unwrap_or("").is_empty() {
        AllowResult {
            allowed: true,
            reason: None,
            columns: read_columns,
        }
    } else {
        denied(".or() is not available to the browser")
    }
}

// ---------------------------------------------------------------------------
// Compiler (lib/db/query.ts)
// ---------------------------------------------------------------------------

/// A pending bind: the value plus the catalog type the SQL casts `$n` to
/// (`None` = bare placeholder, bound like node-pg would have inferred).
#[derive(Debug, Clone, PartialEq)]
pub struct Bind {
    pub type_name: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledQuery {
    pub sql: String,
    pub binds: Vec<Bind>,
    /// A separate COUNT query when the caller asked for one; its binds are
    /// collected independently and numbered from `$1`, like TS `countValues`.
    pub count_sql: Option<String>,
    pub count_binds: Vec<Bind>,
}

/// The slice of `Schema` the compiler needs. `crate::schema::Schema` is the
/// production implementation; tests supply a static map so the typed CAST
/// paths are covered without a database.
pub trait ColumnTypes {
    fn column_type(&self, table: &str, column: &str) -> Option<&str>;
}

impl ColumnTypes for Schema {
    fn column_type(&self, table: &str, column: &str) -> Option<&str> {
        Schema::column_type(self, table, column)
    }
}

/// Rejects anything that is not a plain identifier before it reaches SQL,
/// then quotes it. Client-supplied names only ever get this treatment.
fn quoted_identifier(name: &str) -> Result<String, ApiError> {
    if !is_identifier(name) {
        return Err(ApiError::internal(format!("Unsafe identifier: {name}")));
    }
    Ok(format!("\"{name}\""))
}

struct Sink {
    binds: Vec<Bind>,
}

impl Sink {
    /// Emits the placeholder for the next bind, typed by the column's
    /// catalog type exactly as `db::typed_placeholder` renders it.
    fn push(&mut self, type_name: Option<&str>, value: Value) -> String {
        let idx = self.binds.len() + 1;
        let placeholder = typed_placeholder(idx, type_name);
        let stored = type_name
            .filter(|t| is_safe_type_expression(t))
            .map(str::to_string);
        self.binds.push(Bind { type_name: stored, value });
        placeholder
    }
}

/// `columnList()` from query.ts: `'*'`/empty/omitted means every column -
/// the gateway never lets that through the allow-list, but the pure compiler
/// keeps the behaviour for direct callers.
fn column_list(columns: Option<&str>) -> Result<String, ApiError> {
    let trimmed = columns.unwrap_or("").trim();
    if trimmed.is_empty() || trimmed == "*" {
        return Ok("*".to_string());
    }
    let parts = split_list(trimmed);
    if parts.is_empty() {
        return Ok("*".to_string());
    }
    let quoted: Vec<String> = parts
        .iter()
        .map(|c| quoted_identifier(c))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(quoted.join(", "))
}

fn build_where<S: ColumnTypes + ?Sized>(
    desc: &Descriptor,
    schema: &S,
    sink: &mut Sink,
) -> Result<String, ApiError> {
    let mut clauses: Vec<String> = Vec::new();

    for f in &desc.filters {
        let col = quoted_identifier(&f.column)?;
        let ty = schema.column_type(&desc.table, &f.column);
        let value = f.value.clone().unwrap_or(Value::Null);
        let clause = match f.op.as_str() {
            "eq" => format!("{col} = {}", sink.push(ty, value)),
            "neq" => format!("{col} <> {}", sink.push(ty, value)),
            "gt" => format!("{col} > {}", sink.push(ty, value)),
            "gte" => format!("{col} >= {}", sink.push(ty, value)),
            "lt" => format!("{col} < {}", sink.push(ty, value)),
            "lte" => format!("{col} <= {}", sink.push(ty, value)),
            "like" => format!("{col} LIKE {}", sink.push(ty, value)),
            "ilike" => format!("{col} ILIKE {}", sink.push(ty, value)),
            "in" => {
                // TS sent one array parameter and let Postgres infer the
                // element type. sqlx cannot declare an inferred array, so
                // expand to ANY(ARRAY[...]) with one typed bind per element.
                let items = match &f.value {
                    Some(Value::Array(items)) => items.clone(),
                    _ => {
                        return Err(ApiError::internal(format!(
                            "Unsupported in filter: {}",
                            ts_string(f.value.as_ref())
                        )))
                    }
                };
                let any = if items.is_empty() {
                    match ty.filter(|t| is_safe_type_expression(t)) {
                        Some(t) => format!("ARRAY[]::{t}"),
                        None => "ARRAY[]::text".to_string(),
                    }
                } else {
                    let parts: Vec<String> =
                        items.iter().map(|item| sink.push(ty, item.clone())).collect();
                    format!("ARRAY[{}]", parts.join(", "))
                };
                format!("{col} = ANY({any})")
            }
            // PostgREST .is() is only ever used for null / boolean checks.
            "is" => match &f.value {
                None => {
                    return Err(ApiError::internal(
                        "Unsupported .is() value: undefined".to_string(),
                    ))
                }
                Some(Value::Null) => format!("{col} IS NULL"),
                Some(Value::Bool(true)) => format!("{col} IS TRUE"),
                Some(Value::Bool(false)) => format!("{col} IS FALSE"),
                Some(other) => {
                    return Err(ApiError::internal(format!(
                        "Unsupported .is() value: {}",
                        ts_string(Some(other))
                    )))
                }
            },
            "contains" => {
                // JSON.stringify(value) -> a jsonb-cast bind, the ::jsonb of TS.
                format!("{col} @> {}", sink.push(Some("jsonb"), value))
            }
            other => return Err(ApiError::internal(format!("Unsupported filter: {other}"))),
        };
        clauses.push(clause);
    }

    if let Some(expr) = desc.or_filter.as_deref().filter(|s| !s.is_empty()) {
        clauses.push(compile_or(expr, desc, schema, sink)?);
    }

    Ok(if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    })
}

/// PostgREST `.or("a.eq.1,b.ilike.%x%")`. Only the flat comma form; the
/// gateway allow-list rejects `.or()` outright, so this exists to keep the
/// ported compiler whole for direct (server-side) use.
fn compile_or<S: ColumnTypes + ?Sized>(
    expr: &str,
    desc: &Descriptor,
    schema: &S,
    sink: &mut Sink,
) -> Result<String, ApiError> {
    let parts = split_list(expr);
    let mut compiled: Vec<String> = Vec::new();
    for part in parts {
        let mut segments = part.splitn(3, '.');
        let column = segments.next().unwrap_or("");
        let op = segments.next();
        let raw = segments.next().unwrap_or("");
        let col = quoted_identifier(column)?;
        let ty = schema.column_type(&desc.table, column);
        let value = Value::String(raw.to_string());
        let clause = match op {
            Some("eq") => format!("{col} = {}", sink.push(ty, value)),
            Some("neq") => format!("{col} <> {}", sink.push(ty, value)),
            Some("gt") => format!("{col} > {}", sink.push(ty, value)),
            Some("gte") => format!("{col} >= {}", sink.push(ty, value)),
            Some("lt") => format!("{col} < {}", sink.push(ty, value)),
            Some("lte") => format!("{col} <= {}", sink.push(ty, value)),
            Some("like") => format!("{col} LIKE {}", sink.push(ty, value)),
            Some("ilike") => format!("{col} ILIKE {}", sink.push(ty, value)),
            Some("is") => match raw {
                "null" => format!("{col} IS NULL"),
                "true" => format!("{col} IS TRUE"),
                "false" => format!("{col} IS FALSE"),
                _ => {
                    return Err(ApiError::internal(format!(
                        "Unsupported .or() is-value: {raw}"
                    )))
                }
            },
            Some(other) => {
                return Err(ApiError::internal(format!(
                    "Unsupported .or() operator: {other}"
                )))
            }
            None => {
                return Err(ApiError::internal(
                    "Unsupported .or() operator: undefined".to_string(),
                ))
            }
        };
        compiled.push(clause);
    }
    Ok(format!("({})", compiled.join(" OR ")))
}

/// `orderLimit()`: identifiers validated, limits clamped to whole numbers in
/// [1, 1000] and offsets to [0, MAX_SAFE_INTEGER]; they are written as
/// literals, exactly as the TS compiler did after its own `intLiteral` guard.
fn order_limit(desc: &Descriptor) -> Result<String, ApiError> {
    let mut sql = String::new();
    if !desc.order.is_empty() {
        let mut parts: Vec<String> = Vec::new();
        for o in &desc.order {
            let col = quoted_identifier(o.get("column").and_then(Value::as_str).unwrap_or(""))?;
            let dir = if js_truthy(o.get("ascending")) { "ASC" } else { "DESC" };
            let nulls = match o.get("nullsFirst") {
                None => "",
                Some(v) if js_truthy(Some(v)) => " NULLS FIRST",
                Some(_) => " NULLS LAST",
            };
            parts.push(format!("{col} {dir}{nulls}"));
        }
        sql.push_str(&format!(" ORDER BY {}", parts.join(", ")));
    }
    if let Some(limit) = desc.limit {
        if limit < 0 {
            return Err(ApiError::internal(format!("Unsafe limit: {limit}")));
        }
        sql.push_str(&format!(" LIMIT {}", limit.clamp(1, MAX_LIMIT_ROWS)));
    }
    if let Some(offset) = desc.offset {
        if offset < 0 {
            return Err(ApiError::internal(format!("Unsafe offset: {offset}")));
        }
        sql.push_str(&format!(" OFFSET {}", offset.min(MAX_SAFE_INTEGER)));
    }
    Ok(sql)
}

/// Pure descriptor -> SQL compiler. No database access: the caller supplies
/// the catalog (`crate::schema::get()` in production, a fixture in tests).
pub fn compile<S: ColumnTypes + ?Sized>(
    desc: &Descriptor,
    schema: &S,
) -> Result<CompiledQuery, ApiError> {
    let table = quoted_identifier(&desc.table)?;
    let mut sink = Sink { binds: Vec::new() };

    match desc.op.as_str() {
        "select" => {
            let cols = if desc.head { "1".to_string() } else { column_list(desc.columns.as_deref())? };
            let where_sql = build_where(desc, schema, &mut sink)?;
            let sql = format!("SELECT {cols} FROM {table}{where_sql}{}", order_limit(desc)?);
            let (count_sql, count_binds) = if desc.count.is_some() {
                let mut count_sink = Sink { binds: Vec::new() };
                let count_where = build_where(desc, schema, &mut count_sink)?;
                (
                    Some(format!("SELECT COUNT(*)::bigint AS count FROM {table}{count_where}")),
                    count_sink.binds,
                )
            } else {
                (None, Vec::new())
            };
            Ok(CompiledQuery { sql, binds: sink.binds, count_sql, count_binds })
        }
        "insert" | "upsert" => {
            let rows = desc.values.clone().unwrap_or_default();
            if rows.is_empty() {
                return Err(ApiError::internal("insert/upsert requires at least one row"));
            }
            // Union of keys so rows with differing shapes still line up.
            let mut keys: Vec<String> = Vec::new();
            for row in &rows {
                for k in row_keys(row) {
                    if !keys.contains(&k) {
                        keys.push(k);
                    }
                }
            }
            if keys.is_empty() {
                return Err(ApiError::internal("insert/upsert requires at least one column"));
            }

            let mut tuples: Vec<String> = Vec::new();
            for row in &rows {
                let mut placeholders: Vec<String> = Vec::new();
                for k in &keys {
                    let ty = schema.column_type(&desc.table, k);
                    let value = row_value(row, k).cloned().unwrap_or(Value::Null);
                    placeholders.push(sink.push(ty, value));
                }
                tuples.push(format!("({})", placeholders.join(", ")));
            }

            let column_names: Vec<String> = keys
                .iter()
                .map(|k| quoted_identifier(k))
                .collect::<Result<Vec<_>, _>>()?;
            let mut sql =
                format!("INSERT INTO {table} ({}) VALUES {}", column_names.join(", "), tuples.join(", "));

            if desc.op == "upsert" {
                let conflict = split_list(desc.on_conflict.as_deref().unwrap_or(""));
                if conflict.is_empty() {
                    sql.push_str(" ON CONFLICT DO NOTHING");
                } else {
                    let targets: Vec<String> = conflict
                        .iter()
                        .map(|c| quoted_identifier(c))
                        .collect::<Result<Vec<_>, _>>()?;
                    let updatable: Vec<String> = keys
                        .iter()
                        .filter(|k| !conflict.contains(k))
                        .map(|k| {
                            let q = quoted_identifier(k)?;
                            Ok(format!("{q} = EXCLUDED.{q}"))
                        })
                        .collect::<Result<Vec<_>, ApiError>>()?;
                    sql.push_str(&format!(
                        " ON CONFLICT ({}) DO UPDATE SET {}",
                        targets.join(", "),
                        updatable.join(", ")
                    ));
                }
            }

            if desc.returning {
                sql.push_str(&format!(" RETURNING {}", column_list(desc.columns.as_deref())?));
            }
            Ok(CompiledQuery { sql, binds: sink.binds, count_sql: None, count_binds: Vec::new() })
        }
        "update" => {
            // Non-object patches contribute no keys, like Object.keys() did.
            let patch = desc.patch.clone().unwrap_or(Value::Null);
            let keys = row_keys(&patch);
            if keys.is_empty() {
                return Err(ApiError::internal("update requires at least one column"));
            }
            let sets: Vec<String> = keys
                .iter()
                .map(|k| {
                    let q = quoted_identifier(k)?;
                    let ty = schema.column_type(&desc.table, k);
                    let value = row_value(&patch, k).cloned().unwrap_or(Value::Null);
                    Ok(format!("{q} = {}", sink.push(ty, value)))
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            let where_sql = build_where(desc, schema, &mut sink)?;
            // A filterless UPDATE would rewrite the whole table; PostgREST refuses too.
            if where_sql.is_empty() {
                return Err(ApiError::internal(format!(
                    "Refusing to UPDATE {} without a filter",
                    desc.table
                )));
            }
            let mut sql = format!("UPDATE {table} SET {}{where_sql}", sets.join(", "));
            if desc.returning {
                sql.push_str(&format!(" RETURNING {}", column_list(desc.columns.as_deref())?));
            }
            Ok(CompiledQuery { sql, binds: sink.binds, count_sql: None, count_binds: Vec::new() })
        }
        "delete" => {
            let where_sql = build_where(desc, schema, &mut sink)?;
            if where_sql.is_empty() {
                return Err(ApiError::internal(format!(
                    "Refusing to DELETE FROM {} without a filter",
                    desc.table
                )));
            }
            let mut sql = format!("DELETE FROM {table}{where_sql}");
            if desc.returning {
                sql.push_str(&format!(" RETURNING {}", column_list(desc.columns.as_deref())?));
            }
            Ok(CompiledQuery { sql, binds: sink.binds, count_sql: None, count_binds: Vec::new() })
        }
        other => Err(ApiError::internal(format!("Unsupported operation: {other}"))),
    }
}

// ---------------------------------------------------------------------------
// Execution + HTTP surface (lib/db/server.ts + app/api/db/route.ts)
// ---------------------------------------------------------------------------

/// Binds must be pushed in the same order the placeholders were numbered;
/// typed binds go through `db::push_typed_arg` (text encoding feeding the
/// `CAST($n AS ...)`), untyped ones through `db::push_arg`.
pub fn build_arguments(binds: &[Bind]) -> ApiResult<PgArguments> {
    let mut args = PgArguments::default();
    for bind in binds {
        match bind.type_name.as_deref() {
            Some(type_name) => push_typed_arg(&mut args, type_name, &bind.value)?,
            None => push_arg(&mut args, &bind.value)?,
        }
    }
    Ok(args)
}

/// Runs the main query and, when present, the COUNT query concurrently -
/// one round trip each, like the TS `Promise.all` in `serverExecutor`.
/// The count defaults to zero when the COUNT query returned no row
/// (`Number(rows[0]?.count ?? 0)`), and is `None` only when not requested.
pub async fn execute(compiled: &CompiledQuery) -> ApiResult<(Vec<Value>, Option<i64>)> {
    let pool = pool().await?;
    let main = sqlx::query_with(compiled.sql.as_str(), build_arguments(&compiled.binds)?);

    match &compiled.count_sql {
        Some(count_sql) => {
            let count_args = build_arguments(&compiled.count_binds)?;
            let count = sqlx::query_with(count_sql.as_str(), count_args);
            let (rows_result, count_result) =
                futures::future::join(main.fetch_all(pool), count.fetch_optional(pool)).await;
            let rows = rows_result?;
            let count = count_result?
                .and_then(|row| row.try_get::<i64, _>("count").ok())
                .unwrap_or(0);
            Ok((rows_to_json(&rows), Some(count)))
        }
        None => {
            let rows = main.fetch_all(pool).await?;
            Ok((rows_to_json(&rows), None))
        }
    }
}

/// The HTTP response: status plus the exact JSON body `route.ts` produced.
/// The browser transport (`lib/db/browser.ts`) reads
/// `body.error.message` / `body.error.code` on failure and
/// `body.rows ?? [] / body.count ?? null` on success.
#[derive(Debug, Clone, PartialEq)]
pub struct GatewayResponse {
    pub status: StatusCode,
    pub body: Value,
}

impl IntoResponse for GatewayResponse {
    fn into_response(self) -> Response {
        (self.status, axum::Json(self.body)).into_response()
    }
}

fn success_body(rows: Vec<Value>, count: Option<i64>) -> GatewayResponse {
    GatewayResponse {
        status: StatusCode::OK,
        body: json!({
            "rows": rows,
            "count": count.map(|c| json!(c)).unwrap_or(Value::Null),
        }),
    }
}

/// `{"error": {"message": "Invalid JSON body"}}` - deliberately no `code`,
/// matching the TS route.
fn invalid_json() -> GatewayResponse {
    GatewayResponse {
        status: StatusCode::BAD_REQUEST,
        body: json!({"error": {"message": "Invalid JSON body"}}),
    }
}

fn malformed_query() -> GatewayResponse {
    GatewayResponse {
        status: StatusCode::BAD_REQUEST,
        body: json!({"error": {"message": "Malformed query"}}),
    }
}

fn not_permitted() -> GatewayResponse {
    GatewayResponse {
        status: StatusCode::FORBIDDEN,
        body: json!({"error": {"message": "Not permitted", "code": "NOT_ALLOWED"}}),
    }
}

/// The real error stays server-side; SQL details must not leak to the browser.
fn db_error() -> GatewayResponse {
    GatewayResponse {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        body: json!({"error": {"message": "Database request failed", "code": "DB_ERROR"}}),
    }
}

/// POST /api/db. Allow-list check first (deny-by-default), then compile,
/// then execute, then the TS route's JSON shape.
pub async fn handle(body: &[u8]) -> GatewayResponse {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!("[api/db] invalid JSON body: {err}");
            return invalid_json();
        }
    };

    let Some(mut desc) = normalize(&parsed) else {
        return malformed_query();
    };

    let verdict = check_allowed(&desc);
    if !verdict.allowed {
        tracing::warn!(
            "[api/db] rejected {{ table: {}, op: {}, reason: {:?} }}",
            desc.table,
            desc.op,
            verdict.reason.unwrap_or_default()
        );
        return not_permitted();
    }

    // Read with the column list the allow-list actually permits: anything
    // outside it (including credentials a stale client still asks for)
    // never reaches SQL.
    if let Some(columns) = verdict.columns.filter(|c| !c.is_empty()) {
        desc.columns = Some(columns.join(", "));
    }

    let compiled = match schema_and_compile(&desc).await {
        Ok(compiled) => compiled,
        Err(err) => {
            tracing::error!("[api/db] {err}");
            return db_error();
        }
    };

    match execute(&compiled).await {
        Ok((rows, count)) => success_body(rows, count),
        Err(err) => {
            tracing::error!("[api/db] {err}");
            db_error()
        }
    }
}

async fn schema_and_compile(desc: &Descriptor) -> ApiResult<CompiledQuery> {
    let schema = crate::schema::get().await?;
    compile(desc, schema)
}

// ---------------------------------------------------------------------------
// Tests: pure, no database (CI has no Postgres).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Arguments;
    use std::collections::HashMap;

    /// Test catalog: the compiler is exercised with the types the real
    /// `user_profiles` table has (`text`, `timestamp with time zone`) plus a
    /// mixed-type table covering every CAST shape.
    struct Fixture(HashMap<(String, String), String>);

    impl Fixture {
        fn get(&self, table: &str, column: &str) -> Option<&str> {
            self.0
                .get(&(table.to_string(), column.to_string()))
                .map(String::as_str)
        }
    }

    impl ColumnTypes for Fixture {
        fn column_type(&self, table: &str, column: &str) -> Option<&str> {
            Fixture::get(self, table, column)
        }
    }

    fn fixture() -> Fixture {
        let entries: &[(&str, &str, &str)] = &[
            ("user_profiles", "user_address", "text"),
            ("user_profiles", "username", "text"),
            ("user_profiles", "updated_at", "timestamp with time zone"),
            ("things", "id", "bigint"),
            ("things", "amount", "numeric"),
            ("things", "is_live", "boolean"),
            ("things", "public_id", "uuid"),
            ("things", "name", "character varying"),
            ("things", "payload", "jsonb"),
        ];
        Fixture(
            entries
                .iter()
                .map(|(t, c, ty)| ((t.to_string(), c.to_string()), ty.to_string()))
                .collect(),
        )
    }

    fn filter(op: &str, column: &str, value: Option<Value>) -> QueryFilter {
        QueryFilter { op: op.to_string(), column: column.to_string(), value }
    }

    fn select_desc() -> Descriptor {
        Descriptor {
            table: "user_profiles".into(),
            op: "select".into(),
            columns: Some("user_address, username".into()),
            filters: vec![filter("eq", "user_address", Some(json!("0xabc")))],
            limit: Some(1),
            ..Default::default()
        }
    }

    fn upsert_desc() -> Descriptor {
        Descriptor {
            table: "user_profiles".into(),
            op: "upsert".into(),
            columns: Some("user_address, username".into()),
            values: Some(vec![json!({
                "user_address": "0xabc",
                "username": "bob",
                "updated_at": "2026-01-01T00:00:00Z"
            })]),
            on_conflict: Some("user_address".into()),
            filters: vec![filter("eq", "user_address", Some(json!("0xabc")))],
            returning: true,
            ..Default::default()
        }
    }

    // -- normalization (route.ts) -------------------------------------------

    #[test]
    fn normalize_coerces_and_clamps_every_field() {
        let body = json!({
            "table": "user_profiles",
            "op": "select",
            "columns": 12,
            "values": "not-an-array",
            "patch": "not-an-object",
            "onConflict": 5,
            "filters": {"not": "an array"},
            "orFilter": 7,
            "order": "nope",
            "limit": "2",
            "offset": true,
            "returning": 1,
            "single": "both",
            "count": "planned",
            "head": "yes",
            "smuggled": {"should": "be dropped"}
        });
        let desc = normalize(&body).expect("table/op strings survive");
        assert_eq!(desc.columns, None);
        assert_eq!(desc.values, None);
        assert_eq!(desc.patch, None);
        assert_eq!(desc.on_conflict, None);
        assert!(desc.filters.is_empty());
        assert_eq!(desc.or_filter, None);
        assert!(desc.order.is_empty());
        assert_eq!(desc.limit, Some(2)); // "2" -> Number -> integer
        assert_eq!(desc.offset, None); // booleans are neither number nor string
        assert!(desc.returning);
        assert_eq!(desc.single, None);
        assert_eq!(desc.count, None); // only "exact" is forwarded
        assert!(desc.head);

        let strict = normalize(&json!({
            "table": "user_profiles", "op": "select",
            "limit": 51, "offset": "0", "single": "maybe", "count": "exact"
        }))
        .unwrap();
        assert_eq!(strict.limit, None); // over MAX_GATEWAY_LIMIT
        assert_eq!(strict.offset, Some(0));
        assert_eq!(strict.single.as_deref(), Some("maybe"));
        assert_eq!(strict.count.as_deref(), Some("exact"));

        // Non-integer / fractional / NaN-ish values are dropped, not rejected.
        let dropped = normalize(&json!({"table": "t", "op": "select", "limit": 1.5, "offset": "x"}))
            .unwrap();
        assert_eq!(dropped.limit, None);
        assert_eq!(dropped.offset, None);
    }

    #[test]
    fn normalize_requires_string_table_and_op() {
        assert!(normalize(&json!({"op": "select"})).is_none());
        assert!(normalize(&json!({"table": "user_profiles"})).is_none());
        assert!(normalize(&json!({"table": 7, "op": "select"})).is_none());
        assert!(normalize(&json!(null)).is_none());
        assert!(normalize(&json!(5)).is_none());
    }

    // -- allow list ----------------------------------------------------------

    #[test]
    fn unknown_table_or_op_is_denied() {
        let desc = Descriptor {
            table: "house_balances".into(),
            op: "select".into(),
            ..Default::default()
        };
        let verdict = check_allowed(&desc);
        assert!(!verdict.allowed);
        assert_eq!(
            verdict.reason.as_deref(),
            Some("select on \"house_balances\" is not available to the browser")
        );

        let delete = Descriptor {
            op: "delete".into(),
            ..select_desc()
        };
        assert_eq!(
            check_allowed(&delete).reason.as_deref(),
            Some("delete on \"user_profiles\" is not available to the browser")
        );
    }

    #[test]
    fn star_columns_are_refused_for_reads_and_returning_writes() {
        for columns in [None, Some("*"), Some("  ")] {
            let desc = Descriptor { columns: columns.map(str::to_string), ..select_desc() };
            assert!(!check_allowed(&desc).allowed, "accepted {columns:?}");
        }
        let returning = Descriptor {
            columns: None,
            ..upsert_desc()
        };
        let verdict = check_allowed(&returning);
        assert!(!verdict.allowed);
        assert_eq!(
            verdict.reason.as_deref(),
            Some("listing the columns explicitly is required; \"*\" is not allowed")
        );
    }

    #[test]
    fn select_narrows_the_column_list_instead_of_rejecting() {
        let desc = Descriptor {
            columns: Some("access_code, username".into()),
            ..select_desc()
        };
        let verdict = check_allowed(&desc);
        assert!(verdict.allowed);
        assert_eq!(verdict.columns.as_deref(), Some(&["username".to_string()][..]));

        // Nothing readable left -> the whole read is refused.
        let only_secret = Descriptor {
            columns: Some("access_code".into()),
            ..select_desc()
        };
        let verdict = check_allowed(&only_secret);
        assert!(!verdict.allowed);
        assert_eq!(verdict.reason.as_deref(), Some("columns not readable: access_code"));

        // A write without RETURNING is strict about unknown columns.
        let write_probe = Descriptor {
            returning: false,
            columns: Some("user_address, access_code".into()),
            ..upsert_desc()
        };
        let verdict = check_allowed(&write_probe);
        assert!(!verdict.allowed);
        assert_eq!(verdict.reason.as_deref(), Some("columns not readable: access_code"));
    }

    #[test]
    fn writes_and_filters_respect_the_rule_columns() {
        let unwritable = Descriptor {
            values: Some(vec![json!({"user_address": "0xabc", "access_code": "s"})]),
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&unwritable).reason.as_deref(),
            Some("columns not writable: access_code")
        );

        let probe = Descriptor {
            filters: vec![filter("eq", "access_code", Some(json!("s")))],
            ..select_desc()
        };
        assert_eq!(
            check_allowed(&probe).reason.as_deref(),
            Some("filtering on \"access_code\" is not available to the browser")
        );

        let identity_range = Descriptor {
            filters: vec![filter("gt", "user_address", Some(json!("0xabc")))],
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&identity_range).reason.as_deref(),
            Some("filter on \"user_address\" must be an equality")
        );
    }

    #[test]
    fn reads_must_be_scoped_writes_must_be_bounded() {
        let unscoped = Descriptor {
            filters: vec![],
            ..select_desc()
        };
        assert_eq!(
            check_allowed(&unscoped).reason.as_deref(),
            Some("a filter on one of user_address / username is required")
        );

        let unlimit = Descriptor { limit: None, ..select_desc() };
        assert_eq!(
            check_allowed(&unlimit).reason.as_deref(),
            Some("limit must be an integer between 1 and 1")
        );
        let too_many = Descriptor { limit: Some(2), ..select_desc() };
        assert!(!check_allowed(&too_many).allowed);
        // single() implies one row even without an explicit limit.
        let single = Descriptor {
            limit: None,
            single: Some("one".into()),
            ..select_desc()
        };
        assert!(check_allowed(&single).allowed);

        let two_rows = Descriptor {
            values: Some(vec![
                json!({"user_address": "0xabc", "username": "a"}),
                json!({"user_address": "0xabc", "username": "b"}),
            ]),
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&two_rows).reason.as_deref(),
            Some("at most 1 row may be written")
        );
    }

    #[test]
    fn upsert_identity_guard_retargeting() {
        // A pure insert (no conflict target) may skip the scope filter and
        // needs no eq filter, but the identity column must still be present.
        let bare_insert = Descriptor {
            filters: vec![],
            on_conflict: None,
            ..upsert_desc()
        };
        assert!(check_allowed(&bare_insert).allowed);

        let missing_identity = Descriptor {
            values: Some(vec![json!({"username": "bob"})]),
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&missing_identity).reason.as_deref(),
            Some("a value for user_address is required")
        );

        let wrong_target = Descriptor {
            on_conflict: Some("username".into()),
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&wrong_target).reason.as_deref(),
            Some("\"username\" cannot be used as the conflict target")
        );

        let no_filter = Descriptor {
            filters: vec![],
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&no_filter).reason.as_deref(),
            Some("a filter on user_address is required")
        );

        // Retargeting another wallet is refused...
        let retarget = Descriptor {
            filters: vec![filter("eq", "user_address", Some(json!("0xOTHER")))],
            ..upsert_desc()
        };
        assert_eq!(
            check_allowed(&retarget).reason.as_deref(),
            Some("user_address may only be written for itself")
        );
        // ...while EVM checksum casing differences still match.
        let checksummed = Descriptor {
            filters: vec![filter("eq", "user_address", Some(json!("0XABC")))],
            values: Some(vec![json!({"user_address": "0xabc", "username": "bob"})]),
            ..upsert_desc()
        };
        assert!(check_allowed(&checksummed).allowed);
    }

    #[test]
    fn or_filter_is_denied_after_the_other_checks() {
        // The .or() check runs last, so the earliest real violation wins.
        let bad_or = Descriptor {
            or_filter: Some("user_address.eq.1".into()),
            ..select_desc()
        };
        assert_eq!(
            check_allowed(&bad_or).reason.as_deref(),
            Some(".or() is not available to the browser")
        );
        let unscoped_or = Descriptor {
            or_filter: Some("user_address.eq.1".into()),
            filters: vec![],
            ..select_desc()
        };
        assert_eq!(
            check_allowed(&unscoped_or).reason.as_deref(),
            Some("a filter on one of user_address / username is required")
        );
        // The empty string is falsy in JS, and stayed allowed there.
        let empty_or = Descriptor {
            or_filter: Some(String::new()),
            ..select_desc()
        };
        assert!(check_allowed(&empty_or).allowed);
    }

    // -- compiler: SELECT -----------------------------------------------------

    #[test]
    fn select_filters_are_cast_to_the_column_type() {
        let desc = Descriptor {
            table: "things".into(),
            op: "select".into(),
            columns: Some("id, name".into()),
            filters: vec![
                filter("eq", "id", Some(json!(7))),
                filter("neq", "name", Some(json!("bob"))),
                filter("gt", "amount", Some(json!(1.5))),
                filter("is", "is_live", Some(json!(true))),
                filter("gte", "public_id", Some(json!("8f1b-uuid"))),
            ],
            limit: Some(1),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT \"id\", \"name\" FROM \"things\" WHERE \"id\" = CAST($1 AS bigint) \
             AND \"name\" <> CAST($2 AS character varying) \
             AND \"amount\" > CAST($3 AS numeric) AND \"is_live\" IS TRUE \
             AND \"public_id\" >= CAST($4 AS uuid) LIMIT 1"
        );
        // "is" consumed no placeholder; the remaining binds stay in order.
        assert_eq!(
            compiled.binds,
            vec![
                Bind { type_name: Some("bigint".into()), value: json!(7) },
                Bind { type_name: Some("character varying".into()), value: json!("bob") },
                Bind { type_name: Some("numeric".into()), value: json!(1.5) },
                Bind { type_name: Some("uuid".into()), value: json!("8f1b-uuid") },
            ]
        );
    }

    #[test]
    fn unknown_columns_fall_back_to_bare_placeholders() {
        let desc = Descriptor {
            table: "things".into(),
            op: "select".into(),
            filters: vec![filter("eq", "mystery", Some(json!("x")))],
            limit: Some(1),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT * FROM \"things\" WHERE \"mystery\" = $1 LIMIT 1"
        );
        assert_eq!(compiled.binds[0].type_name, None);
    }

    #[test]
    fn in_contains_like_and_ilike_compile_to_typed_forms() {
        let desc = Descriptor {
            table: "things".into(),
            op: "select".into(),
            filters: vec![
                filter("in", "name", Some(json!(["a", "b"]))),
                filter("contains", "payload", Some(json!({"success": true}))),
                filter("like", "name", Some(json!("bo%"))),
                filter("ilike", "name", Some(json!("%x%"))),
            ],
            limit: Some(1),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT * FROM \"things\" WHERE \"name\" = ANY(ARRAY[CAST($1 AS character varying), \
             CAST($2 AS character varying)]) AND \"payload\" @> CAST($3 AS jsonb) \
             AND \"name\" LIKE CAST($4 AS character varying) \
             AND \"name\" ILIKE CAST($5 AS character varying) LIMIT 1"
        );
        assert_eq!(compiled.binds[2].type_name.as_deref(), Some("jsonb"));
        assert_eq!(compiled.binds[2].value, json!({"success": true}));

        // Empty list: a typed empty array literal, no binds.
        let empty = Descriptor {
            filters: vec![filter("in", "name", Some(json!([])))],
            ..desc.clone()
        };
        let compiled = compile(&empty, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT * FROM \"things\" WHERE \"name\" = ANY(ARRAY[]::character varying) LIMIT 1"
        );
        assert!(compiled.binds.is_empty());
    }

    #[test]
    fn count_query_reuses_the_where_clause_with_its_own_binds() {
        let desc = Descriptor {
            table: "user_profiles".into(),
            op: "select".into(),
            columns: Some("username".into()),
            filters: vec![filter("eq", "username", Some(json!("bob")))],
            limit: Some(1),
            count: Some("exact".into()),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT \"username\" FROM \"user_profiles\" \
             WHERE \"username\" = CAST($1 AS text) LIMIT 1"
        );
        assert_eq!(
            compiled.count_sql.as_deref(),
            Some(
                "SELECT COUNT(*)::bigint AS count FROM \"user_profiles\" \
                 WHERE \"username\" = CAST($1 AS text)"
            )
        );
        assert_eq!(compiled.count_binds, compiled.binds);
    }

    #[test]
    fn head_select_isolates_count_and_order_limit_clamps() {
        let desc = Descriptor {
            table: "things".into(),
            op: "select".into(),
            head: true,
            count: Some("exact".into()),
            order: vec![
                json!({"column": "id", "ascending": false, "nullsFirst": true}),
                json!({"column": "name", "nullsFirst": false}),
            ],
            limit: Some(5000),
            offset: Some(20),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT 1 FROM \"things\" ORDER BY \"id\" DESC NULLS FIRST, \
             \"name\" DESC NULLS LAST LIMIT 1000 OFFSET 20"
        );
        assert_eq!(
            compiled.count_sql.as_deref(),
            Some("SELECT COUNT(*)::bigint AS count FROM \"things\"")
        );
    }

    #[test]
    fn bad_identifiers_and_unsupported_filters_never_reach_sql() {
        let inject = Descriptor {
            filters: vec![filter("eq", "x\"; DROP TABLE things; --", Some(json!(1)))],
            ..select_desc()
        };
        assert!(compile(&inject, &fixture()).is_err());

        let bad_table = Descriptor { table: "things; SELECT 1".into(), ..select_desc() };
        assert!(compile(&bad_table, &fixture()).is_err());

        let bad_is = Descriptor {
            filters: vec![filter("is", "is_live", Some(json!("yes")))],
            ..select_desc()
        };
        assert!(compile(&bad_is, &fixture()).is_err());

        let missing_is_value = Descriptor {
            filters: vec![filter("is", "is_live", None)],
            ..select_desc()
        };
        assert!(compile(&missing_is_value, &fixture()).is_err());

        let unknown_op = Descriptor {
            filters: vec![filter("matches", "name", Some(json!("x")))],
            ..select_desc()
        };
        assert!(compile(&unknown_op, &fixture()).is_err());
    }

    // -- compiler: writes ------------------------------------------------------

    #[test]
    fn insert_unions_keys_and_nulls_missing_cells() {
        let desc = Descriptor {
            table: "things".into(),
            op: "insert".into(),
            values: Some(vec![json!({"id": 1, "name": "a"}), json!({"id": 2, "amount": 3})]),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        // The key union follows first-appearance across rows, like TS
        // `Array.from(new Set(rows.flatMap(Object.keys)))`; the member order
        // inside one row is whatever serde_json's map iteration gives.
        assert_eq!(
            compiled.sql,
            "INSERT INTO \"things\" (\"id\", \"name\", \"amount\") VALUES \
             (CAST($1 AS bigint), CAST($2 AS character varying), CAST($3 AS numeric)), \
             (CAST($4 AS bigint), CAST($5 AS character varying), CAST($6 AS numeric))"
        );
        assert_eq!(compiled.binds[0].value, json!(1));
        assert_eq!(compiled.binds[0].type_name.as_deref(), Some("bigint"));
        assert_eq!(compiled.binds[2].value, Value::Null);
        assert_eq!(compiled.binds[2].type_name.as_deref(), Some("numeric"));
        assert_eq!(compiled.binds[4].value, Value::Null);
        assert_eq!(compiled.binds[5].value, json!(3));
    }

    #[test]
    fn upsert_targets_the_identity_and_excludes_it_from_the_update() {
        let desc = Descriptor {
            table: "user_profiles".into(),
            op: "upsert".into(),
            columns: Some("user_address, username".into()),
            values: Some(vec![json!({"user_address": "0xabc", "username": "bob", "updated_at": null})]),
            on_conflict: Some("user_address".into()),
            returning: true,
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "INSERT INTO \"user_profiles\" (\"updated_at\", \"user_address\", \"username\") \
             VALUES (CAST($1 AS timestamp with time zone), CAST($2 AS text), CAST($3 AS text)) \
             ON CONFLICT (\"user_address\") DO UPDATE SET \
             \"updated_at\" = EXCLUDED.\"updated_at\", \"username\" = EXCLUDED.\"username\" \
             RETURNING \"user_address\", \"username\""
        );

        let plain = Descriptor {
            on_conflict: None,
            returning: false,
            ..desc.clone()
        };
        let compiled = compile(&plain, &fixture()).unwrap();
        assert!(compiled.sql.ends_with("ON CONFLICT DO NOTHING"));

        let no_rows = Descriptor { values: Some(vec![]), ..desc.clone() };
        assert!(compile(&no_rows, &fixture()).is_err());
    }

    #[test]
    fn update_binds_the_patch_before_the_filter_and_refuses_bare_writes() {
        let desc = Descriptor {
            table: "user_profiles".into(),
            op: "update".into(),
            patch: Some(json!({"username": "new"})),
            filters: vec![filter("eq", "user_address", Some(json!("0xabc")))],
            returning: true,
            columns: Some("username".into()),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "UPDATE \"user_profiles\" SET \"username\" = CAST($1 AS text) \
             WHERE \"user_address\" = CAST($2 AS text) RETURNING \"username\""
        );
        assert_eq!(compiled.binds[0].value, json!("new"));
        assert_eq!(compiled.binds[1].value, json!("0xabc"));

        let unscoped = Descriptor { filters: vec![], ..desc.clone() };
        let err = compile(&unscoped, &fixture()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "Refusing to UPDATE user_profiles without a filter"
        );

        let empty_patch = Descriptor { patch: Some(json!({})), ..desc };
        assert!(compile(&empty_patch, &fixture()).is_err());
    }

    #[test]
    fn delete_refuses_bare_reads_and_returns_requested_columns() {
        let desc = Descriptor {
            table: "user_profiles".into(),
            op: "delete".into(),
            filters: vec![filter("eq", "user_address", Some(json!("0xabc")))],
            returning: true,
            columns: Some("user_address".into()),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "DELETE FROM \"user_profiles\" WHERE \"user_address\" = CAST($1 AS text) \
             RETURNING \"user_address\""
        );

        let unscoped = Descriptor { filters: vec![], ..desc };
        assert!(compile(&unscoped, &fixture()).is_err());
        assert!(compile(
            &Descriptor { op: "bogus".into(), ..select_desc() },
            &fixture()
        )
        .is_err());
    }

    #[test]
    fn or_expression_compiles_flat_parts() {
        // Unreachable through the gateway (the allow-list rejects .or()), but
        // the compiler port keeps query.ts's behaviour.
        let desc = Descriptor {
            table: "things".into(),
            op: "select".into(),
            or_filter: Some("name.eq.bob,amount.gt.5,id.is.null".into()),
            limit: Some(1),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(
            compiled.sql,
            "SELECT * FROM \"things\" WHERE (\"name\" = CAST($1 AS character varying) \
             OR \"amount\" > CAST($2 AS numeric) OR \"id\" IS NULL) LIMIT 1"
        );
        assert_eq!(compiled.binds.len(), 2);

        let bad = Descriptor { or_filter: Some("name.eq.bob,amount.bogus.5".into()), ..desc };
        assert!(compile(&bad, &fixture()).is_err());
    }

    // -- execution plumbing (no DB needed) -------------------------------------

    #[test]
    fn bind_types_match_the_placeholders_written_in_sql() {
        // The same filter value bound for a bigint column and for a text one:
        // this is the typing that node-pg got by inference and sqlx needs
        // spelled out, or `operator does not exist: text = bigint`.
        let desc = Descriptor {
            table: "things".into(),
            op: "select".into(),
            filters: vec![
                filter("eq", "id", Some(json!("12"))),
                filter("eq", "name", Some(json!("12"))),
            ],
            limit: Some(1),
            ..Default::default()
        };
        let compiled = compile(&desc, &fixture()).unwrap();
        assert_eq!(compiled.binds[0].type_name.as_deref(), Some("bigint"));
        assert_eq!(compiled.binds[1].type_name.as_deref(), Some("character varying"));

        let args = build_arguments(&compiled.binds).unwrap();
        assert_eq!(args.len(), compiled.binds.len());

        let typed = vec![
            Bind { type_name: Some("numeric".into()), value: json!(7.5) },
            Bind { type_name: Some("boolean".into()), value: json!(true) },
            Bind { type_name: Some("text".into()), value: Value::Null },
            Bind { type_name: None, value: json!("raw") },
        ];
        let args = build_arguments(&typed).unwrap();
        assert_eq!(args.len(), 4);
        assert_eq!(build_arguments(&[Bind { type_name: Some("text[]".into()), value: json!(["a"])}])
            .is_err(), true);
    }

    // -- HTTP response shapes (route.ts) ---------------------------------------

    #[test]
    fn response_bodies_match_the_ts_route() {
        assert_eq!(invalid_json().status, StatusCode::BAD_REQUEST);
        assert_eq!(
            invalid_json().body,
            json!({"error": {"message": "Invalid JSON body"}})
        );
        // No `code` key on the 400s, exactly like NextResponse.json there.
        assert!(invalid_json().body["error"].get("code").is_none());

        assert_eq!(
            malformed_query().body,
            json!({"error": {"message": "Malformed query"}})
        );

        assert_eq!(not_permitted().status, StatusCode::FORBIDDEN);
        assert_eq!(
            not_permitted().body,
            json!({"error": {"message": "Not permitted", "code": "NOT_ALLOWED"}})
        );

        assert_eq!(db_error().status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            db_error().body,
            json!({"error": {"message": "Database request failed", "code": "DB_ERROR"}})
        );

        // Success: empty result is [] not null; count is null unless asked
        // for; the TS route never omits either key.
        let empty = success_body(vec![], None);
        assert_eq!(empty.status, StatusCode::OK);
        assert_eq!(empty.body, json!({"rows": [], "count": null}));
        assert_eq!(
            success_body(vec![json!({"username": "bob"})], Some(0)).body,
            json!({"rows": [{"username": "bob"}], "count": 0})
        );
    }
}
