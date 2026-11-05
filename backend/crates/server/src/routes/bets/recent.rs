//! `GET /api/bets/recent`.
//!
//! Public live-wins feed: no guard, addresses shortened server-side, demo rows
//! dropped. Reads a 60-row slice but ships at most 8 real wins so a play-money
//! streak cannot starve the feed.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};

use strike_core::bets::{is_demo_bet_row, to_number, value_to_string};

use crate::sql;

use super::json_cached;

const RECENT_SQL: &str = "SELECT id, wallet_address, asset, payout, created_at \
     FROM bet_history WHERE won IS TRUE ORDER BY created_at DESC LIMIT 60";

pub fn routes() -> Router {
    Router::new().route("/api/bets/recent", get(handle))
}

async fn handle() -> Response {
    // `won = true` and the 60/8 caps are hard-coded constants, not client input,
    // so they live in the statement directly (`IS TRUE`/`LIMIT 60`) with no bind.
    let rows = match sql::fetch(RECENT_SQL, &[]).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!("[bets/recent] query failed {err}");
            // The TS route answers a database failure as `{ wins: [] }` at 500.
            let body = Value::Object(Map::from_iter([("wins".to_string(), Value::Array(vec![]))]));
            return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(body)).into_response();
        }
    };

    let wins: Vec<Value> = rows
        .iter()
        .filter(|row| !is_demo_bet_row(row))
        .take(8)
        .map(wire_row)
        .collect();

    let body = Value::Object(Map::from_iter([("wins".to_string(), Value::Array(wins))]));
    json_cached(StatusCode::OK, body, super::RECENT_CACHE)
}

/// `{ id, trader, asset, payout, at }`; `trader` is the raw `slice(0,6)…slice(-4)`
/// over `String(wallet_address)` (no length guard, exactly like the TS).
fn wire_row(row: &Value) -> Value {
    let trader = {
        let raw = value_to_string(row.get("wallet_address").unwrap_or(&Value::Null));
        let chars: Vec<char> = raw.chars().collect();
        let head: String = chars.iter().take(6).collect();
        let tail: String = if chars.len() > 4 {
            chars[chars.len() - 4..].iter().collect()
        } else {
            chars.iter().collect()
        };
        format!("{head}…{tail}")
    };

    // `Number(row.payout) || 0`
    let payout = {
        let n = to_number(row.get("payout").unwrap_or(&Value::Null));
        if n == 0.0 || n.is_nan() {
            0.0
        } else {
            n
        }
    };

    let mut map = Map::new();
    map.insert("id".into(), row.get("id").cloned().unwrap_or(Value::Null));
    map.insert("trader".into(), Value::String(trader));
    map.insert(
        "asset".into(),
        row.get("asset").cloned().unwrap_or(Value::Null),
    );
    map.insert("payout".into(), Value::from(payout));
    map.insert(
        "at".into(),
        row.get("created_at").cloned().unwrap_or(Value::Null),
    );
    Value::Object(map)
}
