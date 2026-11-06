//! `/api/markets`: stock prices next to each wrapper token's buy quote.

use axum::extract::Query;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use strike_core::markets;

pub fn routes() -> Router {
    Router::new()
        .route("/api/markets", get(list))
        .route("/api/markets/quote", get(quote))
}

#[derive(Deserialize)]
struct QuoteQuery {
    symbol: String,
    currency: Option<String>,
}

/// `GET /api/markets/quote?symbol=GOOGL`: the live price as a signed TestStockMarket quote.
async fn quote(Query(q): Query<QuoteQuery>) -> Response {
    match markets::signed_quote(&q.symbol, q.currency.as_deref().unwrap_or("USDC")).await {
        Ok(body) => ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn list() -> impl IntoResponse {
    let snapshot = markets::snapshot().await;
    (
        [(header::CACHE_CONTROL, "public, max-age=15")],
        Json(snapshot.as_ref().clone()),
    )
}
