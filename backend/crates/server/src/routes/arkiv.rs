//! `/api/arkiv/*`: reads served from Arkiv, not from SQLite.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use strike_core::arkiv::{self, DEFAULT_RPC, EXPLORER};
use strike_core::bets::is_evm_address;
use strike_core::error::{ApiError, ApiResult};

use crate::http::require_balance_session;
use crate::routes::bets::bet_id::bet_id_ok;

const SEAL_WAIT: Duration = Duration::from_secs(25);
const MAX_IDS: usize = 100;

pub fn routes() -> Router {
    Router::new()
        .route("/api/arkiv/bets", get(history))
        .route("/api/arkiv/bets/{id}/seal", get(seal))
}

/// `{ key, creator, createdAt, attributes: [{ name, value }] }` as one flat object.
fn flatten(entity: &Value) -> Value {
    let mut row = Map::new();
    for field in ["key", "creator", "createdAt"] {
        if let Some(v) = entity.get(field) {
            row.insert(field.into(), v.clone());
        }
    }
    for a in entity["attributes"].as_array().into_iter().flatten() {
        if let Some(name) = a["name"].as_str().filter(|n| *n != "arkiv.schema") {
            row.insert(name.into(), a["value"].clone());
        }
    }
    Value::Object(row)
}

async fn history(headers: HeaderMap, Query(params): Query<HashMap<String, String>>) -> Response {
    run(async {
        require_balance_session(&headers)?;
        let wallet = params.get("wallet").map(|w| w.trim()).unwrap_or_default();
        if !is_evm_address(wallet) {
            return Err(ApiError::bad_request("Invalid wallet parameter"));
        }
        let ids: Vec<&str> = params
            .get("ids")
            .map(|ids| ids.split(',').map(str::trim).collect())
            .unwrap_or_default();
        if ids.is_empty() || ids.len() > MAX_IDS || !ids.iter().all(|id| bet_id_ok(id)) {
            return Err(ApiError::bad_request(format!(
                "ids must be 1 to {MAX_IDS} bet ids"
            )));
        }
        let arkiv = arkiv::shared()?;
        let query = arkiv.history_query(wallet, &ids);
        let result = arkiv.query(&query, ids.len() as u32).await?;
        let rows: Vec<Value> = result["data"]
            .as_array()
            .into_iter()
            .flatten()
            .map(flatten)
            .collect();
        Ok(json!({
            "rpc": DEFAULT_RPC,
            "explorer": EXPLORER,
            "query": query,
            "rows": rows,
        }))
    })
    .await
}

async fn seal(headers: HeaderMap, Path(bet_id): Path<String>) -> Response {
    run(async {
        require_balance_session(&headers)?;
        let arkiv = arkiv::shared()?;
        let seal = arkiv::wait_for_seal(bet_id.trim(), SEAL_WAIT)
            .await?
            .ok_or_else(|| ApiError::json(axum::http::StatusCode::NOT_FOUND, "Unknown bet"))?;
        let Some(key) = seal.key.clone() else {
            return Ok(json!({ "sealed": false, "settled": seal.settled_at_us.is_some() }));
        };
        let entity = arkiv.entity(&key).await?;
        Ok(json!({
            "sealed": true,
            "block": seal.block,
            "entityUrl": format!("{EXPLORER}/entity/{key}"),
            "entity": if entity.is_null() { Value::Null } else { flatten(&entity) },
        }))
    })
    .await
}

async fn run(body: impl std::future::Future<Output = ApiResult<Value>>) -> Response {
    match body.await {
        Ok(value) => Json(value).into_response(),
        Err(err) => err.into_response(),
    }
}
