//! `/api/bets/*` — the betting-history family.
//!
//! Ports `app/api/bets/{history,stats,leaderboard,recent,save,[id]}/route.ts`.
//! All param parsing, aggregation and formatting is pure logic in
//! `strike_core::bets`; these modules are transport plus hand-written SQL with
//! typed binds (see `crate::sql` and the `Binds` helper below).

pub mod bet_id;
pub mod history;
pub mod leaderboard;
pub mod recent;
pub mod save;
pub mod stats;

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::Value;

use strike_core::db::is_safe_type_expression;
use strike_core::error::{ApiError, ApiResult};

/// `NextResponse.json(body, { status, headers: { 'Cache-Control': cache } })`.
pub(crate) fn json_cached(status: StatusCode, body: Value, cache: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_str(cache).unwrap_or_else(|_| HeaderValue::from_static("no-store")),
    );
    (status, headers, axum::Json(body)).into_response()
}

pub fn routes() -> Router {
    Router::new()
        .merge(history::routes())
        .merge(stats::routes())
        .merge(leaderboard::routes())
        .merge(recent::routes())
        .merge(save::routes())
        .merge(bet_id::routes())
}

/// Owned bind list for one statement. `push` returns the `CAST($n AS ty)`
/// fragment to splice into SQL; the bind itself is always a text-shaped value
/// cast server-side, matching the convention in `crates/server/src/sql.rs`.
/// Type names only ever come from `column_type` (the catalog), never client input.
pub(crate) struct Binds {
    entries: Vec<(String, Value)>,
}

impl Binds {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    /// Adds `value` under the catalog type `ty`, returning `CAST($n AS ty)`.
    pub fn push(&mut self, ty: String, value: Value) -> String {
        self.entries.push((ty, value));
        format!("CAST(${} AS {})", self.entries.len(), self.entries.last().unwrap().0)
    }

    /// A hard-coded primitive type bind (paging offsets, booleans): the type
    /// comes from this source file's allowlist, not the catalog.
    pub fn push_static(&mut self, ty: &'static str, value: Value) -> String {
        debug_assert!(is_safe_type_expression(ty));
        self.push(ty.to_string(), value)
    }

    pub fn refs(&self) -> Vec<(&str, &Value)> {
        self.entries.iter().map(|(t, v)| (t.as_str(), v)).collect()
    }

    /// Number of binds pushed so far.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Bind refs restricted to the first `n` entries, for a statement that
    /// shares the prefix of the parameter list (count vs. rows query).
    pub fn refs_upto(&self, n: usize) -> Vec<(&str, &Value)> {
        self.entries[..n].iter().map(|(t, v)| (t.as_str(), v)).collect()
    }
}

/// The Postgres type of a column, read from the loaded catalog and re-validated
/// so it is safe to write inside a CAST. Never from a client.
pub(crate) async fn column_type(table: &str, column: &str) -> ApiResult<String> {
    let schema = strike_core::schema::get().await?;
    let ty = schema
        .column_type(table, column)
        .ok_or_else(|| ApiError::internal(format!("unknown column {table}.{column}")))?;
    if !is_safe_type_expression(ty) {
        return Err(ApiError::internal(format!("Unusable type for {table}.{column}")));
    }
    Ok(ty.to_string())
}

/// `NextResponse.json(..., { headers: { 'Cache-Control': ... } })` for the
/// wallet-scoped (private) vs. board-scoped (public) cache postures.
pub(crate) const PUBLIC_BOARD_CACHE: &str = "public, s-maxage=30, stale-while-revalidate=120";
pub(crate) const RECENT_CACHE: &str = "public, s-maxage=5, stale-while-revalidate=30";
pub(crate) const PRIVATE_NO_STORE: &str = "private, no-store, max-age=0, must-revalidate";
