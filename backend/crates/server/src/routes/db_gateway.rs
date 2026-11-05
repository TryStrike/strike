//! `/api/db` — the browser query gateway.
//!
//! Everything (normalisation, the allow list, SQL compilation with typed binds,
//! and the response shape) lives in `strike_core::gateway`, where it is unit
//! tested without a database. This is the transport wrapper.

use axum::body::Bytes;
use axum::routing::post;
use axum::Router;

use strike_core::gateway::GatewayResponse;

pub fn routes() -> Router {
    Router::new().route("/api/db", post(handle))
}

async fn handle(raw: Bytes) -> GatewayResponse {
    strike_core::gateway::handle(&raw).await
}
