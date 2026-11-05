//! Postgres type introspection, loaded once at boot.
//!
//! Why this exists: the TypeScript service used `node-postgres`, which sends
//! every parameter with an *unspecified* type OID and lets the server infer the
//! type from the column. sqlx cannot do that - it declares a concrete OID and
//! always sends the binary format, so `WHERE id = $1` with a text-typed
//! parameter fails with `operator does not exist: text = integer` (verified
//! against the live database). The port therefore asks Postgres for the real
//! type of every column and every stored-function parameter, and binds values
//! in that type's binary encoding.
//!
//! Two consumers:
//!   * `db::call_rpc` resolves `p_amount` to `numeric` and writes
//!     `"p_amount" => CAST($1 AS numeric)`;
//!   * the `/api/db` gateway compares browser-supplied filters in the column's
//!     own type, which is what makes arbitrary literals unable to reach SQL.

use std::collections::HashMap;

use sqlx::postgres::PgRow;
use sqlx::Row;
use tokio::sync::OnceCell;

use crate::db::pool;
use crate::error::{ApiError, ApiResult};

static SCHEMA: OnceCell<Schema> = OnceCell::const_new();

#[derive(Debug, Default)]
pub struct Schema {
    /// `function name` -> ordered `(parameter name, type)` pairs, input side.
    functions: HashMap<String, Vec<(String, String)>>,
    /// `table` -> `column` -> type.
    columns: HashMap<String, HashMap<String, String>>,
}

impl Schema {
    /// The Postgres type of a named parameter of a stored function.
    pub fn rpc_param_type(&self, function: &str, parameter: &str) -> Option<&str> {
        self.functions
            .get(function)
            .and_then(|params| params.iter().find(|(name, _)| name == parameter))
            .map(|(_, ty)| ty.as_str())
    }

    /// Every input parameter of a stored function, in declaration order.
    pub fn rpc_params(&self, function: &str) -> Option<&[(String, String)]> {
        self.functions.get(function).map(|v| v.as_slice())
    }

    /// The Postgres type of a column, used by the browser query gateway.
    pub fn column_type(&self, table: &str, column: &str) -> Option<&str> {
        self.columns.get(table)?.get(column).map(String::as_str)
    }

    pub fn has_table(&self, table: &str) -> bool {
        self.columns.contains_key(table)
    }
}

/// Loads the schema if it has not been loaded yet; safe to call per request.
pub async fn get() -> ApiResult<&'static Schema> {
    SCHEMA
        .get_or_try_init(fetch)
        .await
        .map(|schema| &*schema)
}

async fn fetch() -> Result<Schema, ApiError> {
    let pool = pool().await?;

    let column_rows: Vec<PgRow> = sqlx::query(
        r#"
        SELECT c.relname::text      AS table_name,
               a.attname::text      AS column_name,
               pg_catalog.format_type(a.atttypid, a.atttypmod)::text AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND c.relkind IN ('r', 'v', 'm', 'p')
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| ApiError::Other(format!("schema introspection failed: {e}")))?;

    let mut columns: HashMap<String, HashMap<String, String>> = HashMap::new();
    for row in column_rows {
        let table: String = row.get("table_name");
        let column: String = row.get("column_name");
        let data_type: String = row.get("data_type");
        columns
            .entry(table)
            .or_default()
            .insert(column, base_type(&data_type));
    }

    // Input parameters. Two shapes, because Postgres keeps them in different
    // places: an all-IN function has `proallargtypes IS NULL` with
    // `proargnames`/`proargtypes` aligned, while one with OUT/TABLE columns
    // moves every argument into `proallargtypes` with `proargmodes` beside it.
    let mut functions: HashMap<String, Vec<(String, String)>> = HashMap::new();

    let plain: Vec<PgRow> = sqlx::query(
        r#"
        SELECT p.proname::text AS name,
               arg.argname::text AS argname,
               pg_catalog.format_type(arg.argtypeid, NULL)::text AS argtype
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL unnest(
            COALESCE(p.proargnames, ARRAY[]::text[]),
            p.proargtypes::oid[]
        ) WITH ORDINALITY AS arg(argname, argtypeid, ord)
        WHERE n.nspname = 'public' AND p.proallargtypes IS NULL
        ORDER BY 1, arg.ord
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| ApiError::Other(format!("function introspection failed: {e}")))?;

    let mode_rows: Vec<PgRow> = sqlx::query(
        r#"
        SELECT p.proname::text AS name,
               arg.argname::text AS argname,
               pg_catalog.format_type(arg.argtypeid, NULL)::text AS argtype
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL unnest(
            p.proallargtypes::oid[],
            COALESCE(p.proargnames, ARRAY[]::text[]),
            p.proargmodes::text[]
        ) WITH ORDINALITY AS arg(argtypeid, argname, argmode, ord)
        WHERE n.nspname = 'public'
          AND p.proallargtypes IS NOT NULL
          AND arg.argmode IN ('i', 'b', 'v')
        ORDER BY 1, arg.ord
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| ApiError::Other(format!("function introspection failed: {e}")))?;

    for row in plain.into_iter().chain(mode_rows) {
        let name: String = row.get("name");
        let argname: String = row.get("argname");
        let argtype: String = row.get("argtype");
        if argname.is_empty() {
            // Unnamed argument: callers bind by name, so it is not usable.
            continue;
        }
        functions
            .entry(name)
            .or_default()
            .push((argname, base_type(&argtype)));
    }

    Ok(Schema { functions, columns })
}

/// `numeric(30,10)` -> `numeric`, `character varying(64)` -> `character varying`.
/// Modifiers are meaningless for choosing a bind encoding and a cast written
/// with them is needlessly fragile.
fn base_type(data_type: &str) -> String {
    data_type.split('(').next().unwrap_or(data_type).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_are_stripped() {
        assert_eq!(base_type("numeric(30,10)"), "numeric");
        assert_eq!(base_type("character varying(64)"), "character varying");
        assert_eq!(base_type("timestamp with time zone"), "timestamp with time zone");
    }
}
