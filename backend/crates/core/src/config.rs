//! Environment-backed configuration for the Strike backend. The root
//! `.env.local` drives both this service and the Next app.

use std::env;
use std::sync::OnceLock;

/// Arc Testnet, matching `frontend/lib/arc/config.ts`.
pub const ARC_DEFAULT_CHAIN_ID: u64 = 5042002;
pub const ARC_DEFAULT_RPC: &str = "https://rpc.testnet.arc.io";
pub const ARC_DEFAULT_EXPLORER: &str = "https://explorer.testnet.arc.io";
pub const ARC_DEFAULT_USDC: &str = "0x3600000000000000000000000000000000000000";
/// USDC on Arc is 6 decimals; the native gas balance is the same unit at 18.
pub const USDC_DECIMALS: u32 = 6;

/// The network label the deposit modal echoes back.
pub const ARC_NETWORK_NAME: &str = "Arc";

/// `ARC_ASSETS` — what this deployment can credit. Adding an asset means adding
/// its decimals and its token address too, so the list is deliberately short.
pub const ARC_ASSETS: [&str; 1] = ["USDC"];

/// `assetFrom(value)`: upper-cased and matched against the supported list, so
/// `usdc`, `USDC` and `" usdc "` all mean the same asset and anything else is
/// not an asset at all.
pub fn arc_asset(value: Option<&str>) -> Option<&'static str> {
    let raw = value.unwrap_or("").trim().to_uppercase();
    ARC_ASSETS.into_iter().find(|asset| *asset == raw)
}

fn str_var(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_num<T: std::str::FromStr>(key: &str) -> Option<T> {
    str_var(key).and_then(|v| v.parse::<T>().ok())
}

#[derive(Debug, Clone)]
pub struct Config {
    /// Path of the SQLite ledger file.
    pub sqlite_path: Option<String>,
    pub read_pool: usize,
    pub statement_timeout_ms: u64,
    /// `SQLITE_FULLFSYNC`, on unless set to `OFF`. Forces the drive cache on
    /// macOS and does nothing on Linux.
    pub sqlite_fullfsync: bool,
    /// Tick history. Never the ledger file; unset keeps ticks in memory only.
    pub ticks_sqlite_path: Option<String>,
    pub tick_flush_secs: u64,
    pub tick_retention_days: u64,
    /// Ticks kept in memory per asset.
    pub tick_ring_secs: usize,
    /// An accepted withdrawal with no hash after this long needs an operator.
    pub withdrawal_stuck_secs: i64,
    /// Upstream quote URLs. Overridable so a test decides what the market did.
    pub binance_endpoint: String,
    pub binance_ws_endpoint: String,
    pub yahoo_spark_endpoint: String,
    /// How long between samples of every tradable asset.
    pub price_sample_ms: u64,
    /// The newest crypto tick a bet may take its strike from.
    pub bet_tick_max_age_ms: i64,
    /// How far a client's strike may sit from the server's, in basis points.
    pub bet_price_tolerance_bps: f64,
    /// How far before `end_time` a crypto tick may be and still settle a round.
    pub settle_tick_tolerance_ms: i64,
    pub balance_internal_secret: Option<String>,
    pub balance_settlement_secret: Option<String>,
    pub dashboard_password: Option<String>,
    pub admin_session_hours: f64,
    pub arc_chain_id: u64,
    pub arc_rpc: String,
    pub arc_explorer: String,
    pub arc_usdc: String,
    pub treasury_address: String,
    /// `ARKIV_PRIVATE_KEY`. Unset leaves settled bets unsealed.
    pub arkiv_secret_key: Option<String>,
    /// `ARKIV_RPC_URL`, with `ARKIV_ACCESS_KEY` appended as the path when set.
    pub arkiv_rpc: String,
    pub treasury_secret_key: Option<String>,
    pub banned_wallet_addresses: Vec<String>,
    pub withdrawal_frequency_exempt: Vec<String>,
    pub app_url: Option<String>,
    /// House ceilings on what one agent session may be started with.
    pub agent_max_per_trade: rust_decimal::Decimal,
    pub agent_max_budget: rust_decimal::Decimal,
    pub agent_max_minutes: i64,
    /// Backend only. The copilot answers 503 without it.
    pub anthropic_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub jev_endpoint: String,
    /// Overridable so a test decides what the model says.
    pub anthropic_base_url: String,
    /// Open stake summed across every running agent.
    pub agent_max_open_stake: rust_decimal::Decimal,
    /// `NODE_ENV === 'production'` equivalent: strict guard behaviour.
    pub production: bool,
    pub bind_addr: String,
}

impl Config {
    /// Reads the environment with the same defaults the TS service used.
    ///
    /// Nothing here panics: a missing secret disables the feature it guards
    /// (exactly like the `process.env` reads did) and a missing `SQLITE_PATH`
    /// fails at the first query instead, so pure functions stay testable
    /// without a fully populated environment.
    pub fn from_env() -> Self {
        let node_env = str_var("NODE_ENV").unwrap_or_default();
        let production = node_env == "production";

        let banned = str_var("BANNED_WALLET_ADDRESSES")
            .map(|v| split_list(&v))
            .unwrap_or_default();
        let exempt = str_var("WITHDRAWAL_FREQUENCY_REVIEW_EXEMPT_WALLETS")
            .map(|v| split_list(&v))
            .unwrap_or_default();

        Self {
            sqlite_path: str_var("SQLITE_PATH"),
            read_pool: parse_num("SQLITE_READ_POOL").unwrap_or(8),
            statement_timeout_ms: parse_num("SQLITE_STATEMENT_TIMEOUT_MS").unwrap_or(8_000),
            sqlite_fullfsync: !str_var("SQLITE_FULLFSYNC")
                .is_some_and(|v| v.eq_ignore_ascii_case("off")),
            ticks_sqlite_path: str_var("TICKS_SQLITE_PATH"),
            tick_flush_secs: parse_num("TICK_FLUSH_SECS").unwrap_or(120),
            tick_retention_days: parse_num("TICK_RETENTION_DAYS").unwrap_or(3),
            tick_ring_secs: parse_num("TICK_RING_SECS").unwrap_or(900),
            // Two transfers can each wait 180 s for confirmations.
            withdrawal_stuck_secs: parse_num("WITHDRAWAL_STUCK_SECS").unwrap_or(600),
            binance_endpoint: str_var("BINANCE_ENDPOINT")
                .unwrap_or_else(|| crate::prices::BINANCE_ENDPOINT.to_string()),
            binance_ws_endpoint: str_var("BINANCE_WS_ENDPOINT")
                .unwrap_or_else(|| crate::prices::BINANCE_WS_ENDPOINT.to_string()),
            yahoo_spark_endpoint: str_var("YAHOO_SPARK_ENDPOINT")
                .unwrap_or_else(|| crate::prices::SPARK_ENDPOINT.to_string()),
            price_sample_ms: parse_num("PRICE_SAMPLE_MS").unwrap_or(1_000),
            bet_tick_max_age_ms: parse_num("BET_TICK_MAX_AGE_MS").unwrap_or(3_000),
            bet_price_tolerance_bps: parse_num("BET_PRICE_TOLERANCE_BPS").unwrap_or(50.0),
            settle_tick_tolerance_ms: parse_num("SETTLE_TICK_TOLERANCE_MS").unwrap_or(5_000),
            balance_internal_secret: str_var("BALANCE_INTERNAL_SECRET"),
            balance_settlement_secret: str_var("BALANCE_SETTLEMENT_SECRET"),
            dashboard_password: str_var("DASHBOARD_PASSWORD"),
            // TS: ADMIN_SESSION_HOURS ?? 8, falling back to 8 when unparseable
            // or non-positive.
            admin_session_hours: parse_num("ADMIN_SESSION_HOURS")
                .map(|h: f64| if h > 0.0 { h } else { 8.0 })
                .unwrap_or(8.0),
            arc_chain_id: parse_num("NEXT_PUBLIC_ARC_CHAIN_ID").unwrap_or(ARC_DEFAULT_CHAIN_ID),
            arc_rpc: str_var("NEXT_PUBLIC_ARC_RPC_ENDPOINT")
                .unwrap_or_else(|| ARC_DEFAULT_RPC.to_string()),
            arc_explorer: str_var("NEXT_PUBLIC_ARC_EXPLORER")
                .unwrap_or_else(|| ARC_DEFAULT_EXPLORER.to_string()),
            arc_usdc: str_var("NEXT_PUBLIC_ARC_USDC_ADDRESS")
                .unwrap_or_else(|| ARC_DEFAULT_USDC.to_string()),
            treasury_address: str_var("NEXT_PUBLIC_TREASURY_ADDRESS").unwrap_or_default(),
            arkiv_secret_key: str_var("ARKIV_PRIVATE_KEY"),
            arkiv_rpc: {
                let base = str_var("ARKIV_RPC_URL")
                    .unwrap_or_else(|| crate::arkiv::DEFAULT_RPC.to_string());
                match str_var("ARKIV_ACCESS_KEY") {
                    Some(key) => format!("{}/{key}", base.trim_end_matches('/')),
                    None => base,
                }
            },
            treasury_secret_key: str_var("ARC_TREASURY_SECRET_KEY"),
            banned_wallet_addresses: banned,
            withdrawal_frequency_exempt: exempt,
            app_url: str_var("NEXT_PUBLIC_APP_URL"),
            agent_max_per_trade: parse_num("AGENT_MAX_PER_TRADE")
                .unwrap_or(rust_decimal::Decimal::from(10)),
            agent_max_budget: parse_num("AGENT_MAX_BUDGET")
                .unwrap_or(rust_decimal::Decimal::from(100)),
            agent_max_minutes: parse_num("AGENT_MAX_MINUTES").unwrap_or(30),
            anthropic_api_key: str_var("ANTHROPIC_API_KEY"),
            openrouter_api_key: str_var("OPENROUTER_API_KEY"),
            jev_endpoint: str_var("JEV_ENDPOINT")
                .unwrap_or_else(|| crate::jev::ENDPOINT.to_string()),
            anthropic_base_url: str_var("ANTHROPIC_BASE_URL")
                .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            agent_max_open_stake: parse_num("AGENT_MAX_OPEN_STAKE")
                .unwrap_or(rust_decimal::Decimal::from(200)),
            production,
            bind_addr: str_var("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".to_string()),
        }
    }

    pub fn is_settlement_signing_configured(&self) -> bool {
        self.balance_settlement_secret.is_some()
    }
}

fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// Process-wide config, initialised once from the environment.
pub fn config() -> &'static Config {
    CONFIG.get_or_init(Config::from_env)
}
