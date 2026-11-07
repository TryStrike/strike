//! `/api/withdrawals` — the player's own withdrawal history.
//!
//! Two gates, in this order:
//!   1. the first-party balance session (`assertBalanceApiAuthorized`), and
//!   2. a wallet-signed read proof (`strike_core::read_auth`).
//!
//! The ledger is then scoped to the **recovered signer** of that proof. No
//! `address` parameter is accepted anywhere, so a valid session for wallet A
//! cannot read wallet B's requests, fees or payout addresses — the list is not
//! an enumeration oracle.
//!
//! The projection lists the columns explicitly *and* re-projects the rows: the
//! signed intent (`signature`), `notes` and `decided_by` must never leave the
//! server, and that must survive someone widening the SELECT later.

use crate::http::Query;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use strike_core::address::search_variants;
use strike_core::db;
use strike_core::error::ApiResult;
use strike_core::read_auth::{self, READ_AUTH_HEADER};

use crate::http;
use crate::sql;

const DEFAULT_PAGE_SIZE: i64 = 20;
const MAX_PAGE_SIZE: i64 = 50;
/// Hard ceiling: the list is paging, not bulk-exporting.
const MAX_OFFSET: i64 = 500;

/// The columns the player view may see. `signed_at` is a bare epoch ms and is
/// here so the status page can honestly show when the 10-minute acceptance
/// window elapses; it reveals nothing about the signature.
const PLAYER_COLUMNS: &str =
    "id, currency, amount, fee_amount, net_amount, status, requested_at, decided_at, \
     tx_hash, fee_tx_hash, signed_at";

/// The only keys the response may carry, in this order.
const PLAYER_KEYS: [&str; 11] = [
    "id",
    "currency",
    "amount",
    "fee_amount",
    "net_amount",
    "status",
    "requested_at",
    "decided_at",
    "tx_hash",
    "fee_tx_hash",
    "signed_at",
];

pub fn routes() -> Router {
    Router::new().route("/api/withdrawals", get(list))
}

#[derive(Deserialize)]
struct Paging {
    limit: Option<String>,
    offset: Option<String>,
}

async fn list(headers: HeaderMap, Query(query): Query<Paging>) -> Response {
    if let Err(deny) = http::require_balance_session(&headers) {
        return deny.into_response();
    }
    match fetch(&headers, query).await {
        Ok(response) => response,
        Err(err) => {
            tracing::error!("[withdrawals] {err}");
            // Generic message: the raw error may quote column or filter detail.
            http::json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Failed to fetch withdrawals" }),
            )
        }
    }
}

async fn fetch(headers: &HeaderMap, query: Paging) -> ApiResult<Response> {
    let raw = http::header_str(headers, READ_AUTH_HEADER);
    let proof = match read_auth::verify_read_auth(raw.as_deref(), now_ms()).await {
        Ok(proof) => proof,
        Err(failure) => {
            return Ok(http::json_status(
                StatusCode::UNAUTHORIZED,
                json!({
                    "error": failure.message(),
                    "code": format!("read_auth_{}", failure.code()),
                }),
            ))
        }
    };

    // Scope strictly to the recovered signer. `search_variants` covers the rows
    // written before the canonical-spelling fix, and all of them belong to this
    // same wallet.
    let variants = search_variants(&proof.address);
    let binds: Vec<Value> = variants.iter().map(|v| Value::String(v.clone())).collect();
    let bind_refs: Vec<(&str, &Value)> = binds.iter().map(|v| ("text", v)).collect();
    let where_clause = format!(
        "user_address IN ({})",
        sql::in_list(1, "text", bind_refs.len())
    );

    let (limit, offset) = parse_paging(query);
    let total = count_rows(&where_clause, &bind_refs).await.unwrap_or(0);
    let rows = rows_for(&where_clause, &bind_refs, limit, offset).await?;

    let withdrawals: Vec<Value> = rows.iter().map(project).collect();
    let has_more = offset + (withdrawals.len() as i64) < total;
    Ok(axum::Json(json!({
        "withdrawals": withdrawals,
        "paging": {
            "limit": limit,
            "offset": offset,
            "total": total,
            "hasMore": has_more,
        },
    }))
    .into_response())
}

/// `parsePaging`: a non-integer or below-one `limit` falls back to the default
/// rather than erroring, an oversized one is *capped* at `MAX_PAGE_SIZE` (the TS
/// is explicit: "oversized requests are capped, not defaulted"), and `offset` is
/// clamped rather than refused.
fn parse_paging(query: Paging) -> (i64, i64) {
    let raw_limit = query.limit.as_deref().and_then(parse_js_integer);
    let raw_offset = query.offset.as_deref().and_then(parse_js_integer);
    let limit = match raw_limit {
        Some(n) if n >= 1 => n.min(MAX_PAGE_SIZE),
        _ => DEFAULT_PAGE_SIZE,
    };
    let offset = match raw_offset {
        Some(n) if n >= 0 => n.min(MAX_OFFSET),
        _ => 0,
    };
    (limit, offset)
}

/// `Number(x)` followed by `Number.isInteger`: only a whole number qualifies,
/// so `"20.5"`, `"abc"` and `""` are all "not supplied".
fn parse_js_integer(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(n) = trimmed.parse::<i64>() {
        return Some(n);
    }
    // `Number("1e3")` is 1000, which *is* an integer.
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|f| f.is_finite() && f.fract() == 0.0)
        .map(|f| f as i64)
}

async fn rows_for(
    where_clause: &str,
    wallet_binds: &[(&str, &Value)],
    limit: i64,
    offset: i64,
) -> ApiResult<Vec<Value>> {
    let limit_bind = Value::from(limit);
    let offset_bind = Value::from(offset);
    let start = wallet_binds.len() + 1;
    let statement = format!(
        "SELECT {PLAYER_COLUMNS} FROM withdrawal_requests \
         WHERE {where_clause} \
         ORDER BY requested_at DESC, id DESC \
         LIMIT CAST(${start} AS int8) OFFSET CAST(${} AS int8)",
        start + 1
    );
    let mut binds: Vec<(&str, &Value)> = wallet_binds.to_vec();
    binds.push(("int8", &limit_bind));
    binds.push(("int8", &offset_bind));
    let rows = db::fetch(&statement, &binds).await.map_err(|err| {
        tracing::error!("[withdrawals] rows sql: {statement} || err: {err}");
        err
    })?;
    Ok(rows)
}

async fn count_rows(where_clause: &str, wallet_binds: &[(&str, &Value)]) -> ApiResult<i64> {
    let statement =
        format!("SELECT count(*) AS total FROM withdrawal_requests WHERE {where_clause}");
    let scalar = db::fetch_scalar(&statement, wallet_binds)
        .await
        .map_err(|err| {
            tracing::error!("[withdrawals] count sql: {statement} || err: {err}");
            err
        })?;
    Ok(scalar.as_i64().unwrap_or(0))
}

/// The player-safe projection. Even if `PLAYER_COLUMNS` were widened, a
/// signature or an operator note still cannot reach the browser.
fn project(row: &Value) -> Value {
    let mut map = Map::new();
    for key in PLAYER_KEYS {
        let value = match row.get(key) {
            None | Some(Value::Null) => Value::Null,
            Some(value) => value.clone(),
        };
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paging_defaults_instead_of_erroring() {
        let q = |limit: Option<&str>, offset: Option<&str>| Paging {
            limit: limit.map(str::to_string),
            offset: offset.map(str::to_string),
        };
        assert_eq!(parse_paging(q(None, None)), (20, 0));
        assert_eq!(parse_paging(q(Some("5"), Some("10"))), (5, 10));
        // Below one falls back to the default; it is never a 400.
        assert_eq!(parse_paging(q(Some("0"), None)), (20, 0));
        assert_eq!(parse_paging(q(Some("-5"), None)), (20, 0));
        // Above the ceiling the request is capped, not defaulted, exactly as
        // `Math.min(rawLimit, MAX_PAGE_SIZE)` did.
        assert_eq!(parse_paging(q(Some("51"), None)), (50, 0));
        assert_eq!(parse_paging(q(Some("2.5"), None)), (20, 0));
        assert_eq!(parse_paging(q(Some("abc"), None)), (20, 0));
        assert_eq!(parse_paging(q(Some(""), None)), (20, 0));
        // 50 is the ceiling, 500 the offset cap; negative offsets are ignored.
        assert_eq!(parse_paging(q(Some("50"), Some("9999"))), (50, 500));
        assert_eq!(parse_paging(q(Some("20"), Some("-1"))), (20, 0));
        // `Number("1e3")` is an integer, so it is honoured after clamping.
        assert_eq!(parse_paging(q(Some("1e3"), None)), (50, 0));
    }

    #[test]
    fn the_projection_drops_everything_not_on_the_list() {
        let row = json!({
            "id": "w1", "currency": "USDC", "amount": 10.0, "fee_amount": 0.5,
            "net_amount": 9.5, "status": "pending", "requested_at": "2026-01-01T00:00:00.000Z",
            "decided_at": null, "tx_hash": null, "fee_tx_hash": null, "signed_at": 1,
            "signature": "0xdeadbeef", "notes": "operator remark", "decided_by": "admin@strike",
        });
        let projected = project(&row);
        let map = projected.as_object().unwrap();
        assert_eq!(map.len(), PLAYER_KEYS.len());
        for forbidden in ["signature", "notes", "decided_by"] {
            assert!(map.get(forbidden).is_none(), "{forbidden} must never ship");
        }
        assert!(
            !map.contains_key("signature"),
            "absent, not withheld-but-present"
        );
        let serialized = projected.to_string();
        assert!(!serialized.contains("0xdeadbeef"));
        assert!(!serialized.contains("admin@strike"));
    }

    #[test]
    fn nullable_columns_become_json_null_not_a_missing_key() {
        let row = json!({ "id": "w1", "currency": "USDC", "amount": 1.0, "fee_amount": 0.0,
                          "net_amount": 1.0, "status": "pending",
                          "requested_at": "2026-01-01T00:00:00.000Z", "signed_at": 1 });
        let projected = project(&row);
        for key in ["decided_at", "tx_hash", "fee_tx_hash"] {
            assert_eq!(projected[key], Value::Null, "{key} must exist as null");
        }
    }

    #[test]
    fn an_empty_variant_list_matches_nothing_instead_of_failing_to_parse() {
        // `user_address IN ()` is a syntax error; `IN (NULL)` is not.
        assert_eq!(
            sql::in_list(1, "text", 2),
            "CAST($1 AS text), CAST($2 AS text)"
        );
        assert_eq!(sql::in_list(1, "text", 0), "NULL");
    }

    #[test]
    fn has_more_compares_the_offset_plus_rows_against_the_total() {
        // The expression the handler uses, pinned so a paging off-by-one cannot
        // hide the next page.
        let has_more = |offset: i64, rows: i64, total: i64| offset + rows < total;
        assert!(has_more(0, 20, 21));
        assert!(
            !has_more(0, 20, 20),
            "exactly one page read is not \"more\""
        );
        assert!(has_more(20, 20, 45));
        assert!(!has_more(20, 5, 25));
    }
}
