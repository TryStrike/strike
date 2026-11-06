//! `/api/markets`: stock prices next to each wrapper token's buy quote.

use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};

use strike_core::markets;

pub fn routes() -> Router {
    Router::new().route("/api/markets", get(list))
}

async fn list() -> impl IntoResponse {
    let snapshot = markets::snapshot().await;
    (
        [(header::CACHE_CONTROL, "public, max-age=15")],
        Json(snapshot.as_ref().clone()),
    )
}
