mod agent;
mod bans;
mod http;
mod routes;
mod sql;
mod watcher;

use std::net::SocketAddr;
use std::path::Path;

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use tower_http::catch_panic::CatchPanicLayer;
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

    std::panic::set_hook(Box::new(|info| tracing::error!("panic: {info}")));

    let stale = strike_core::agent::stop_all_running(strike_core::db::db().await?).await?;
    if stale > 0 {
        tracing::warn!("{stale} agent sessions were running before the restart, marked stopped");
    }
    let orphans = strike_core::agentpass::fail_orphans(strike_core::db::db().await?).await?;
    if orphans > 0 {
        tracing::warn!(
            "{orphans} Agent Pass approvals lost their poller in the restart, marked failed"
        );
    }

    let released = strike_core::db::execute(
        "DELETE FROM deposit_locks WHERE transaction_hash NOT IN \
         (SELECT transaction_hash FROM balance_audit_log WHERE transaction_hash IS NOT NULL)",
        &[],
    )
    .await?;
    if released > 0 {
        tracing::warn!("released {released} deposit locks left without a credit");
    }
    supervise("tick flusher", strike_core::ticks::run_flusher());
    supervise(
        "stuck-withdrawal watcher",
        strike_core::withdrawals::watch_stuck(),
    );
    supervise("price sampler", strike_core::prices::run_sampler());
    if strike_core::prices::uses_live_binance() {
        supervise("binance stream", strike_core::binance_ws::run());
    }
    supervise("settlement sweeper", strike_core::settlement::run_sweeper());
    supervise("agent result recorder", agent::run_result_recorder());
    supervise("shadow log", strike_core::shadow::run());
    if strike_core::world::dev_bypass() {
        tracing::warn!(
            "STRIKE_DEV_NO_WORLD=1: every wallet is its own Orb human and step-ups approve themselves. Dev only."
        );
    } else {
        if strike_core::world::gate_ready().is_err() {
            tracing::warn!(
                "NEXT_PUBLIC_WORLD_APP_ID, WORLD_RP_ID or WORLD_RP_SIGNING_KEY is unset: bets, agents and withdrawals answer 503 world_unconfigured"
            );
        }
        if strike_core::agentpass::ap_config().is_none() {
            tracing::warn!(
                "WORLD_AP_CLIENT_ID or WORLD_AP_CLIENT_SECRET is unset: YOLO starts, big withdrawals and big proposals answer 503 world_unconfigured"
            );
        }
    }
    if !strike_core::jev::enabled() {
        tracing::warn!("OPENROUTER_API_KEY is unset: the jev gate is off, the rule decides alone");
    }
    match strike_core::arkiv::init()? {
        Some(arkiv) => {
            supervise("arkiv sealer", strike_core::arkiv::run_sealer(arkiv));
            supervise(
                "arkiv epoch archive",
                strike_core::arkiv::run_archiver(arkiv),
            );
        }
        None => {
            tracing::warn!("ARKIV_PRIVATE_KEY is unset: settled rounds are not sealed on Arkiv")
        }
    }
    if config().treasury_secret_key.is_some() {
        supervise("round committer", strike_core::proofs::run_committer());
    }

    let bind = config().bind_addr.clone();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("strike-backend listening on http://{bind}");

    let app = http::with_api_headers(routes::router(), config().app_url.as_deref())
        .layer(middleware::from_fn(log_server_errors))
        .layer(CatchPanicLayer::new())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|req: &Request| {
                    tracing::debug_span!("request", method = %req.method(), path = %req.uri().path())
                })
                .on_failure(()),
        );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    tracing::info!("waiting for payouts in flight");
    strike_core::eth::payouts_drained().await;
    Ok(())
}

fn supervise<F>(name: &'static str, task: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let handle = tokio::spawn(task);
    tokio::spawn(async move {
        match handle.await {
            Ok(()) => tracing::info!("{name} stopped"),
            Err(err) => {
                tracing::error!("{name} died: {err}. Exiting so the service restarts.");
                std::process::exit(1);
            }
        }
    });
}

async fn log_server_errors(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let res = next.run(req).await;
    if res.status().is_server_error() {
        tracing::error!(status = res.status().as_u16(), "{method} {path} failed");
    }
    res
}

fn load_env_file(dir: &Path) {
    let _ = dotenvy::from_path(dir.join(".env.local"))
        .or_else(|_| dotenvy::from_path(dir.join(".env")));
}

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

        std::fs::write(child.join(".env.local"), "STRIKE_TEST_OWN=local\n").unwrap();
        std::fs::write(child.join(".env"), "STRIKE_TEST_OWN=plain\n").unwrap();
        load_env_file(&child);
        assert_eq!(std::env::var("STRIKE_TEST_OWN").unwrap(), "local");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
