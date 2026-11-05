//! Strike backend service: the Rust replacement for the Next.js `app/api`
//! routes. It answers the same `/api/...` paths with the same JSON so the
//! frontend can be pointed at either implementation during the cutover.

mod agent;
mod bans;
mod http;
mod routes;
mod sql;

use std::net::SocketAddr;
use std::path::Path;

use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use strike_core::config::config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    load_env_file(&std::env::current_dir()?);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let stale = strike_core::agent::stop_all_running(strike_core::db::db().await?).await?;
    if stale > 0 {
        tracing::warn!("{stale} agent sessions were running before the restart, marked stopped");
    }

    tokio::spawn(strike_core::ticks::run_flusher());
    tokio::spawn(strike_core::withdrawals::watch_stuck());
    tokio::spawn(strike_core::prices::run_sampler());
    tokio::spawn(strike_core::settlement::run_sweeper());

    let bind = config().bind_addr.clone();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("strike-backend listening on http://{bind}");

    let app = http::with_api_headers(routes::router(), config().app_url.as_deref())
        .layer(TraceLayer::new_for_http());

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    // Every response is out, but a client that hung up left its payout running,
    // and returning from main would cancel it mid-transfer.
    tracing::info!("waiting for payouts in flight");
    strike_core::eth::payouts_drained().await;
    Ok(())
}

/// The root .env.local. A missing file is normal in containers,
/// where the variables come from the environment directly. Only `dir` itself is
/// looked at: `dotenvy::from_filename` walks up parent directories, which would
/// let a worktree pick up the checkout's live env.
fn load_env_file(dir: &Path) {
    let _ = dotenvy::from_path(dir.join(".env.local"))
        .or_else(|_| dotenvy::from_path(dir.join(".env")));
}

/// systemd sends SIGTERM, a terminal sends ctrl_c. Closing the price streams is
/// what lets the graceful stop finish: they would otherwise never end.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;

    tracing::info!("shutdown requested");
    strike_core::stream::close_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_env_file_in_a_parent_directory_is_ignored() {
        let dir = std::env::temp_dir().join(format!("env-{}", uuid::Uuid::new_v4()));
        let child = dir.join("worktree");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(dir.join(".env.local"), "STRIKE_TEST_PARENT=live\n").unwrap();
        std::fs::write(dir.join(".env"), "STRIKE_TEST_PARENT=live\n").unwrap();

        load_env_file(&child);
        assert!(std::env::var("STRIKE_TEST_PARENT").is_err());

        // `.env.local` wins over `.env` in the directory itself.
        std::fs::write(child.join(".env.local"), "STRIKE_TEST_OWN=local\n").unwrap();
        std::fs::write(child.join(".env"), "STRIKE_TEST_OWN=plain\n").unwrap();
        load_env_file(&child);
        assert_eq!(std::env::var("STRIKE_TEST_OWN").unwrap(), "local");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
