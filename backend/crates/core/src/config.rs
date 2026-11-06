use std::env;
use std::sync::OnceLock;

pub const ARC_DEFAULT_CHAIN_ID: u64 = 5042002;
pub const ARC_DEFAULT_RPC: &str = "https://rpc.testnet.arc.io";
pub const ARC_DEFAULT_EXPLORER: &str = "https://explorer.testnet.arc.io";
pub const ARC_DEFAULT_USDC: &str = "0x3600000000000000000000000000000000000000";
pub const ARC_DEFAULT_EURC: &str = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
pub const USDC_DECIMALS: u32 = 6;

pub const ARC_NETWORK_NAME: &str = "Arc";

pub const ARC_ASSETS: [&str; 2] = ["USDC", "EURC"];

pub fn arc_asset(value: Option<&str>) -> Option<&'static str> {
    let raw = value.unwrap_or("").trim().to_uppercase();
    ARC_ASSETS.into_iter().find(|asset| *asset == raw)
}

pub fn token_address(currency: &str) -> Option<String> {
    let cfg = config();
    match arc_asset(Some(currency))? {
        "USDC" => Some(cfg.arc_usdc.clone()),
        "EURC" => Some(cfg.arc_eurc.clone()),
        _ => None,
    }
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
    pub sqlite_path: Option<String>,
    pub read_pool: usize,
    pub statement_timeout_ms: u64,
    pub sqlite_fullfsync: bool,
    pub ticks_sqlite_path: Option<String>,
    pub tick_flush_secs: u64,
    pub tick_retention_days: u64,
    pub tick_ring_secs: usize,
    pub withdrawal_stuck_secs: i64,
    pub binance_endpoint: String,
    pub binance_ws_endpoint: String,
    pub binance_perp_endpoint: String,
    pub binance_perp_ws_endpoint: String,
    pub kraken_endpoint: String,
    pub yahoo_spark_endpoint: String,
    pub price_sample_ms: u64,
    pub bet_tick_max_age_ms: i64,
    pub bet_price_tolerance_bps: f64,
    pub settle_tick_tolerance_ms: i64,
    pub balance_internal_secret: Option<String>,
    pub balance_settlement_secret: Option<String>,
    pub arc_chain_id: u64,
    pub arc_rpc: String,
    pub arc_explorer: String,
    pub arc_usdc: String,
    pub arc_eurc: String,
    pub treasury_address: String,
    pub arkiv_secret_key: Option<String>,
    pub swarm_bee_url: Option<String>,
    /// TestStockMarket on Arc testnet; quotes are signed for this address.
    pub stock_market_address: Option<String>,
    pub swarm_batch_id: Option<String>,
    pub arkiv_rpc: String,
    pub treasury_secret_key: Option<String>,
    pub banned_wallet_addresses: Vec<String>,
    pub withdrawal_frequency_exempt: Vec<String>,
    pub app_url: Option<String>,
    pub agent_max_per_trade: rust_decimal::Decimal,
    pub agent_max_budget: rust_decimal::Decimal,
    pub agent_max_minutes: i64,
    pub anthropic_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub jev_endpoint: String,
    pub anthropic_base_url: String,
    pub agent_max_open_stake: rust_decimal::Decimal,
    pub max_stake: rust_decimal::Decimal,
    pub max_wallet_open_stake: rust_decimal::Decimal,
    pub world_idkit: Option<IdkitApp>,
    pub world_action: String,
    pub dev_no_world: bool,
    pub world_limits: WorldLimits,
    pub proofs_start_epoch: Option<u64>,
    pub production: bool,
    pub bind_addr: String,
}

impl Config {
    pub fn from_env() -> Self {
        let node_env = str_var("NODE_ENV").unwrap_or_default();
        let production = node_env == "production";
        let dev_no_world = str_var("STRIKE_DEV_NO_WORLD").as_deref() == Some("1");
        assert!(
            !(production && dev_no_world),
            "STRIKE_DEV_NO_WORLD=1 is refused when NODE_ENV=production"
        );

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
            withdrawal_stuck_secs: parse_num("WITHDRAWAL_STUCK_SECS").unwrap_or(600),
            binance_endpoint: str_var("BINANCE_ENDPOINT")
                .unwrap_or_else(|| crate::prices::BINANCE_ENDPOINT.to_string()),
            binance_ws_endpoint: str_var("BINANCE_WS_ENDPOINT")
                .unwrap_or_else(|| crate::prices::BINANCE_WS_ENDPOINT.to_string()),
            binance_perp_endpoint: str_var("BINANCE_PERP_ENDPOINT")
                .unwrap_or_else(|| crate::prices::BINANCE_PERP_ENDPOINT.to_string()),
            binance_perp_ws_endpoint: str_var("BINANCE_PERP_WS_ENDPOINT")
                .unwrap_or_else(|| crate::prices::BINANCE_PERP_WS_ENDPOINT.to_string()),
            kraken_endpoint: str_var("KRAKEN_ENDPOINT")
                .unwrap_or_else(|| crate::prices::KRAKEN_ENDPOINT.to_string()),
            yahoo_spark_endpoint: str_var("YAHOO_SPARK_ENDPOINT")
                .unwrap_or_else(|| crate::prices::SPARK_ENDPOINT.to_string()),
            price_sample_ms: parse_num("PRICE_SAMPLE_MS").unwrap_or(1_000),
            bet_tick_max_age_ms: parse_num("BET_TICK_MAX_AGE_MS").unwrap_or(3_000),
            bet_price_tolerance_bps: parse_num("BET_PRICE_TOLERANCE_BPS").unwrap_or(50.0),
            settle_tick_tolerance_ms: parse_num("SETTLE_TICK_TOLERANCE_MS").unwrap_or(5_000),
            balance_internal_secret: str_var("BALANCE_INTERNAL_SECRET"),
            balance_settlement_secret: str_var("BALANCE_SETTLEMENT_SECRET"),
            arc_chain_id: parse_num("NEXT_PUBLIC_ARC_CHAIN_ID").unwrap_or(ARC_DEFAULT_CHAIN_ID),
            arc_rpc: str_var("NEXT_PUBLIC_ARC_RPC_ENDPOINT")
                .unwrap_or_else(|| ARC_DEFAULT_RPC.to_string()),
            arc_explorer: str_var("NEXT_PUBLIC_ARC_EXPLORER")
                .unwrap_or_else(|| ARC_DEFAULT_EXPLORER.to_string()),
            arc_usdc: str_var("NEXT_PUBLIC_ARC_USDC_ADDRESS")
                .unwrap_or_else(|| ARC_DEFAULT_USDC.to_string()),
            arc_eurc: str_var("NEXT_PUBLIC_ARC_EURC_ADDRESS")
                .unwrap_or_else(|| ARC_DEFAULT_EURC.to_string()),
            treasury_address: str_var("NEXT_PUBLIC_TREASURY_ADDRESS").unwrap_or_default(),
            arkiv_secret_key: str_var("ARKIV_PRIVATE_KEY"),
            swarm_bee_url: str_var("SWARM_BEE_URL"),
            stock_market_address: str_var("NEXT_PUBLIC_STOCK_MARKET_ADDRESS"),
            swarm_batch_id: str_var("SWARM_BATCH_ID"),
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
            max_stake: parse_num("MAX_STAKE").unwrap_or(rust_decimal::Decimal::from(100)),
            max_wallet_open_stake: parse_num("MAX_WALLET_OPEN_STAKE")
                .unwrap_or(rust_decimal::Decimal::from(300)),
            world_idkit: IdkitApp::from_env(),
            world_action: str_var("WORLD_ACTION").unwrap_or_else(|| "strike-human".to_string()),
            dev_no_world,
            world_limits: WorldLimits::from_env(),
            proofs_start_epoch: parse_num("PROOFS_START_EPOCH"),
            production,
            bind_addr: str_var("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".to_string()),
        }
    }

    pub fn is_settlement_signing_configured(&self) -> bool {
        self.balance_settlement_secret.is_some()
    }
}

#[derive(Debug, Clone)]
pub struct TierCaps {
    pub open_cap: rust_decimal::Decimal,
    pub daily_loss: rust_decimal::Decimal,
}

#[derive(Debug, Clone)]
pub struct WorldLimits {
    pub selfie: TierCaps,
    pub orb: TierCaps,
    pub cooloff_min: i64,
    pub stepup_withdraw_over: rust_decimal::Decimal,
    pub stepup_proposal_over: rust_decimal::Decimal,
}

impl WorldLimits {
    fn from_env() -> Self {
        let usdc = |key: &str, default: i64| {
            parse_num(key).unwrap_or(rust_decimal::Decimal::from(default))
        };
        Self {
            selfie: TierCaps {
                open_cap: usdc("WORLD_SELFIE_OPEN_CAP", 5),
                daily_loss: usdc("WORLD_SELFIE_DAILY_LOSS", 25),
            },
            orb: TierCaps {
                open_cap: usdc("WORLD_ORB_OPEN_CAP", 50),
                daily_loss: usdc("WORLD_ORB_DAILY_LOSS", 200),
            },
            cooloff_min: parse_num("WORLD_COOLOFF_MIN").unwrap_or(30),
            stepup_withdraw_over: usdc("STEPUP_WITHDRAW_OVER", 25),
            stepup_proposal_over: usdc("STEPUP_PROPOSAL_OVER", 5),
        }
    }

    pub fn caps(&self, tier: &str) -> &TierCaps {
        if tier == "orb" {
            &self.orb
        } else {
            &self.selfie
        }
    }
}

#[derive(Clone)]
pub struct IdkitApp {
    pub app_id: String,
    pub rp_id: String,
    pub signing_key: k256::ecdsa::SigningKey,
    pub environment: String,
    pub verify_url: String,
}

impl std::fmt::Debug for IdkitApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdkitApp")
            .field("app_id", &self.app_id)
            .field("rp_id", &self.rp_id)
            .field("environment", &self.environment)
            .field("verify_url", &self.verify_url)
            .finish_non_exhaustive()
    }
}

impl IdkitApp {
    fn from_env() -> Option<Self> {
        let (app_id, rp_id, key) = (
            str_var("NEXT_PUBLIC_WORLD_APP_ID")?,
            str_var("WORLD_RP_ID")?,
            str_var("WORLD_RP_SIGNING_KEY")?,
        );
        let signing_key = hex::decode(key.strip_prefix("0x").unwrap_or(&key))
            .ok()
            .and_then(|bytes| k256::ecdsa::SigningKey::from_slice(&bytes).ok())
            .expect("WORLD_RP_SIGNING_KEY must be a 32 byte hex secp256k1 key");
        let environment = match str_var("WORLD_ENVIRONMENT").as_deref() {
            None | Some("production") => "production",
            Some("staging") => "staging",
            Some(other) => panic!("WORLD_ENVIRONMENT is {other}, it must be production or staging"),
        };
        Some(Self {
            app_id,
            rp_id,
            signing_key,
            environment: environment.to_string(),
            verify_url: str_var("WORLD_VERIFY_URL")
                .unwrap_or_else(|| "https://developer.world.org".to_string())
                .trim_end_matches('/')
                .to_string(),
        })
    }
}

fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

static CONFIG: OnceLock<Config> = OnceLock::new();

pub fn config() -> &'static Config {
    CONFIG.get_or_init(Config::from_env)
}
