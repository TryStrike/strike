//! Route families. Each module owns one area of the Next.js `app/api` tree and
//! exposes `routes()`; `router()` merges them under the same `/api/...` paths so
//! the frontend proxy is a 1:1 rewrite with no path translation.

pub mod admin;
pub mod admin_reads_a;
pub mod admin_reads_b;
pub mod admin_writes;
pub mod agent;
pub mod arc;
pub mod arkiv;
pub mod balance;
pub mod balance_mutations;
pub mod bets;
pub mod copilot;
pub mod precheck;
pub mod prices;
pub mod referral;
pub mod session;
pub mod stream;
pub mod withdrawals;

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Map, Value};

use strike_core::db;
use strike_core::error::ApiResult;

pub fn router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(admin::routes())
        .merge(admin_reads_a::routes())
        .merge(admin_reads_b::routes())
        .merge(admin_writes::routes())
        .merge(agent::routes())
        .merge(arc::routes())
        .merge(arkiv::routes())
        .merge(balance::routes())
        .merge(balance_mutations::routes())
        .merge(bets::routes())
        .merge(copilot::routes())
        .merge(precheck::routes())
        .merge(prices::routes())
        .merge(referral::routes())
        .merge(session::routes())
        .merge(stream::routes())
        .merge(withdrawals::routes())
}

/// Liveness for the container orchestrator and the migration cutover check.
/// `{"ok":true}` matches the shape the rest of the API answers with.
async fn health() -> ApiResult<Json<Value>> {
    let database = match db::ping().await {
        Ok(()) => "up",
        Err(_) => "down",
    };
    let mut map = Map::new();
    map.insert("ok".into(), Value::Bool(database == "up"));
    map.insert("service".into(), Value::String("strike-backend".into()));
    map.insert("database".into(), Value::String(database.into()));
    Ok(Json(Value::Object(map)))
}
