//! Environment-backed configuration for the Strike backend.
//!
//! Mirrors the TypeScript service's `process.env` reads exactly, so the same
//! `.env` file drives both during the migration.

use std::env;
use std::sync::OnceLock;

/// Arc network defaults from `lib/arc/config.ts`.
pub const ARC_DEFAULT_CHAIN_ID: u64 = 5042;
pub const ARC_DEFAULT_RPC: &str = "https://rpc.mainnet.arc.io";
pub const ARC_DEFAULT_EXPLORER: &str = "https://explorer.arc.io";
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
    env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn parse_num<T: std::str::FromStr>(key: &str) -> Option<T> {
    str_var(key).and_then(|v| v.parse::<T>().ok())
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: Option<String>,
    pub pool_max: u32,
    pub statement_timeout_ms: u64,
    pub balance_internal_secret: Option<String>,
    pub balance_settlement_secret: Option<String>,
    pub dashboard_password: Option<String>,
    pub admin_session_hours: f64,
    pub arc_chain_id: u64,
    pub arc_rpc: String,
    pub arc_explorer: String,
    pub arc_usdc: String,
    pub treasury_address: String,
    pub treasury_secret_key: Option<String>,
    pub platform_fee_wallet: Option<String>,
    pub banned_wallet_addresses: Vec<String>,
    pub withdrawal_frequency_exempt: Vec<String>,
    pub app_url: Option<String>,
    /// `NODE_ENV === 'production'` equivalent: strict guard behaviour.
    pub production: bool,
    pub bind_addr: String,
}

impl Config {
    /// Reads the environment with the same defaults the TS service used.
    ///
    /// Nothing here panics: a missing secret disables the feature it guards
    /// (exactly like the `process.env` reads did) and a missing `DATABASE_URL`
    /// fails at the first query instead, so pure functions stay testable
    /// without a fully populated environment.
    pub fn from_env() -> Self {
        let database_url = str_var("DATABASE_URL");

        let node_env = str_var("NODE_ENV").unwrap_or_default();
        let production = node_env == "production" || str_var("VERCEL_ENV").is_some();

        let banned = str_var("BANNED_WALLET_ADDRESSES")
            .map(|v| split_list(&v))
            .unwrap_or_default();
        let exempt = str_var("WITHDRAWAL_FREQUENCY_REVIEW_EXEMPT_WALLETS")
            .map(|v| split_list(&v))
            .unwrap_or_default();

        Self {
            database_url,
            pool_max: parse_num("PGPOOL_MAX").unwrap_or(5),
            statement_timeout_ms: parse_num("PGSTATEMENT_TIMEOUT_MS").unwrap_or(8_000),
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
                .or_else(|| str_var("ARC_RPC_URL"))
                .unwrap_or_else(|| ARC_DEFAULT_RPC.to_string()),
            arc_explorer: str_var("NEXT_PUBLIC_ARC_EXPLORER")
                .unwrap_or_else(|| ARC_DEFAULT_EXPLORER.to_string()),
            arc_usdc: str_var("NEXT_PUBLIC_ARC_USDC_ADDRESS")
                .or_else(|| str_var("ARC_USDC_ADDRESS"))
                .unwrap_or_else(|| ARC_DEFAULT_USDC.to_string()),
            treasury_address: str_var("NEXT_PUBLIC_TREASURY_ADDRESS").unwrap_or_default(),
            treasury_secret_key: str_var("ARC_TREASURY_SECRET_KEY"),
            platform_fee_wallet: str_var("NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC"),
            banned_wallet_addresses: banned,
            withdrawal_frequency_exempt: exempt,
            app_url: str_var("NEXT_PUBLIC_APP_URL"),
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
