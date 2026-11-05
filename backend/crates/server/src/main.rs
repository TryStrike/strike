//! Strike backend service: the Rust replacement for the Next.js `app/api`
//! routes. It answers the same `/api/...` paths with the same JSON so the
//! frontend can be pointed at either implementation during the cutover.

mod bans;
mod http;
mod routes;
mod sql;

use std::time::Duration;

use axum::Router;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use strike_core::config::config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Same .env the TypeScript service reads; a missing file is normal in
    // containers, where the variables come from the environment directly.
    let _ = dotenvy::from_filename(".env.local").or_else(|_| dotenvy::from_filename(".env"));

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let bind = config().bind_addr.clone();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("strike-backend listening on http://{bind}");

    let app = Router::new().merge(routes::router()).layer(TraceLayer::new_for_http());

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown requested");
    // Give in-flight ledger calls a moment to finish rather than cutting them
    // off mid-transaction.
    tokio::time::sleep(Duration::from_millis(250)).await;
}
