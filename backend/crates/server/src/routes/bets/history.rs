//! `GET /api/bets/history` — `app/api/bets/history/route.ts`.
//!
//! Param parsing, clamping, row decoration and demo detection are pure
//! (`strike_core::bets`); this module owns the transport and the two bounded
//! statements: the exact count for the filtered set and the page of rows.

use std::collections::HashMap;

use axum::extract::Query;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};

use strike_core::bets::{
    decorate_history_row, parse_history_request, HistoryQuery, DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT,
};
use strike_core::error::ApiError;

use crate::http::{json_status, require_balance_session};
use crate::sql;

use super::{column_type, Binds};

/// `BET_COLUMNS` from the TS route, verbatim.
const BET_COLUMNS: &str = "id, wallet_address, asset, direction, amount, multiplier, \
     strike_price, end_price, payout, won, mode, network, resolved_at, created_at";

pub fn routes() -> Router {
    Router::new().route("/api/bets/history", get(handle))
}

async fn handle(headers: HeaderMap, Query(raw): Query<HashMap<String, String>>) -> Response {
    // `assertBalanceApiAuthorized` runs before anything else and answers directly.
    if let Err(err) = require_balance_session(&headers) {
        return err.into_response();
    }

    let params = raw.into_iter().collect();
    let query = match parse_history_request(&params) {
        Ok(query) => query,
        Err(message) => {
            tracing::warn!("[bets/history] rejected request: {message}");
            return error_json(400, &message);
        }
    };

    match run(query.clone()).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

/// The data fetch + response assembly. Errors here map to the two TS failure
/// messages: a query failure is `Failed to fetch bets`, anything else (schema
/// lookup) is the generic `Internal server error` from the route's outer catch.
async fn run(q: HistoryQuery) -> Result<Value, ApiError> {
    let mut binds = Binds::new();
    let mut clauses: Vec<String> = Vec::new();

    // Every predicate value is bound; the CAST type always comes from the
    // catalog via `column_type`, never from the client.
    clauses.push(format!(
        "wallet_address = {}",
        binds.push(column_type("bet_history", "wallet_address").await?, Value::String(q.address.clone()))
    ));
    if let Some(asset) = &q.asset {
        clauses.push(format!(
            "asset = {}",
            binds.push(column_type("bet_history", "asset").await?, Value::String(asset.clone()))
        ));
    }
    if let Some(outcome) = &q.outcome {
        clauses.push(format!(
            "won = {}",
            binds.push(
                column_type("bet_history", "won").await?,
                Value::Bool(outcome == "won"),
            )
        ));
    }
    if let Some(direction) = &q.direction {
        clauses.push(format!(
            "direction = {}",
            binds.push(column_type("bet_history", "direction").await?, Value::String(direction.clone()))
        ));
    }
    if let Some(from) = &q.from {
        clauses.push(format!(
            "resolved_at >= {}",
            binds.push(column_type("bet_history", "resolved_at").await?, Value::String(from.clone()))
        ));
    }
    if let Some(to) = &q.to {
        clauses.push(format!(
            "resolved_at <= {}",
            binds.push(column_type("bet_history", "resolved_at").await?, Value::String(to.clone()))
        ));
    }

    // The filter binds are shared by both statements; the row query appends the
    // page binds, so the count reads only this prefix.
    let filter_binds = binds.len();
    let where_sql = format!("WHERE {}", clauses.join(" AND "));

    let count_sql = format!("SELECT COUNT(*)::bigint AS count FROM bet_history {where_sql}");
    let mut rows_sql = format!(
        "SELECT {BET_COLUMNS} FROM bet_history {where_sql} \
         ORDER BY resolved_at DESC, created_at DESC"
    );
    if q.paged {
        let limit_ph = binds.push_static("bigint", Value::String(q.limit.to_string()));
        let offset_ph = binds.push_static("bigint", Value::String(q.offset.to_string()));
        rows_sql = format!("{rows_sql} LIMIT {limit_ph} OFFSET {offset_ph}");
    } else {
        let limit_ph = binds.push_static("bigint", Value::String(q.limit.to_string()));
        rows_sql = format!("{rows_sql} LIMIT {limit_ph}");
    }

    let count_row = sql::fetch_one(&count_sql, &binds.refs_upto(filter_binds))
        .await
        .map_err(query_failure)?;
    let count_value = count_row.and_then(|row| row.get("count").cloned()).unwrap_or(Value::Null);
    let rows = sql::fetch(&rows_sql, &binds.refs()).await.map_err(query_failure)?;

    let bets: Vec<Value> = rows.iter().map(decorate_history_row).collect();
    // `typeof count === 'number' ? count : bets.length`
    let total = count_value.as_i64().unwrap_or_else(|| bets.len() as i64);
    let has_more = if q.paged {
        q.offset + (bets.len() as i64) < total
    } else {
        (bets.len() as i64) >= q.limit
    };

    let mut body = Map::new();
    body.insert("bets".into(), Value::Array(bets));
    body.insert("count".into(), Value::from(total));
    body.insert("total".into(), Value::from(total));
    body.insert("limit".into(), Value::from(q.limit));
    body.insert("offset".into(), Value::from(if q.paged { q.offset } else { 0 }));
    body.insert("hasMore".into(), Value::Bool(has_more));

    let mut filters = Map::new();
    filters.insert("asset".into(), optional(&q.asset));
    filters.insert("outcome".into(), optional(&q.outcome));
    filters.insert("direction".into(), optional(&q.direction));
    filters.insert("from".into(), optional(&q.from));
    filters.insert("to".into(), optional(&q.to));
    body.insert("filters".into(), Value::Object(filters));

    Ok(Value::Object(body))
}

fn optional(value: &Option<String>) -> Value {
    value.clone().map(Value::String).unwrap_or(Value::Null)
}

fn query_failure(err: ApiError) -> ApiError {
    tracing::error!("[bets/history] query failed {err}");
    ApiError::internal("Failed to fetch bets")
}

/// `NextResponse.json({ error }, { status })` for the parse-rejection path.
fn error_json(status: u16, message: &str) -> Response {
    let body = Map::from_iter([("error".to_string(), Value::String(message.to_string()))]);
    json_status(
        axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
        Value::Object(body),
    )
}

/// Exported for parity checks against the TS constants.
#[allow(dead_code)]
const LIMIT_BOUNDS: (i64, i64) = (DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
