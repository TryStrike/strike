pub mod agent;
pub mod arc;
pub mod arkiv;
pub mod balance;
pub mod balance_mutations;
pub mod bets;
pub mod blitz;
pub mod copilot;
pub mod markets;
pub mod payout;
pub mod precheck;
pub mod prices;
pub mod proofs;
pub mod session;
pub mod stepup;
pub mod stream;
pub mod withdrawals;
pub mod world;

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Map, Value};

use strike_core::db;
use strike_core::error::ApiResult;

pub fn router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(agent::routes())
        .merge(arc::routes())
        .merge(arkiv::routes())
        .merge(balance::routes())
        .merge(balance_mutations::routes())
        .merge(bets::routes())
        .merge(blitz::routes())
        .merge(copilot::routes())
        .merge(markets::routes())
        .merge(precheck::routes())
        .merge(prices::routes())
        .merge(proofs::routes())
        .merge(session::routes())
        .merge(stream::routes())
        .merge(stepup::routes())
        .merge(withdrawals::routes())
        .merge(world::routes())
}

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
