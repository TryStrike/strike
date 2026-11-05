//! `/api/arc/deposit-precheck` — the deposit modal's read-only pre-flight.
//!
//! Port of `app/api/arc/deposit-precheck/route.ts`. Deliberately narrow:
//!   * it never writes a balance — crediting stays on `POST /api/balance/deposit`;
//!   * it never touches the treasury signer, so the key is not even reachable
//!     from this path;
//!   * an expected "not now" answers 200 with `ready: false` plus a machine
//!     readable `code`, so the UI can name the reason instead of showing a fetch
//!     error.
//!
//! It is advisory only. The on-chain verifier behind the deposit route remains
//! the authority, so an unreachable precheck must never block a deposit.

use axum::extract::Query;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Map, Number, Value};

use strike_core::address::{canonical, is_address};
use strike_core::config::{self, arc_asset, config};
use strike_core::db;
use strike_core::error::ApiResult;

use crate::bans;

/// Reasons the player is shown, in the order they are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreFlight {
    Ok,
    AddressMissing,
    InvalidAddress,
    AssetUnsupported,
    TreasuryNotConfigured,
    WalletBanned,
    LedgerUnavailable,
}

impl PreFlight {
    pub fn code(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::AddressMissing => "address_missing",
            Self::InvalidAddress => "invalid_address",
            Self::AssetUnsupported => "asset_unsupported",
            Self::TreasuryNotConfigured => "treasury_not_configured",
            Self::WalletBanned => "wallet_banned",
            Self::LedgerUnavailable => "ledger_unavailable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Ok => "Deposits are open for this wallet.",
            Self::AddressMissing => "No wallet address supplied.",
            Self::InvalidAddress => "Not a valid Arc wallet address.",
            Self::AssetUnsupported => "That asset cannot be deposited on Strike.",
            Self::TreasuryNotConfigured => {
                "This deployment has no treasury address configured, so a deposit could not be credited."
            }
            Self::WalletBanned => "This wallet is banned from the platform.",
            Self::LedgerUnavailable => "The ledger could not be consulted right now.",
        }
    }

    /// Only the ledger-unreachable state is a 5xx; every other reason is a
    /// legitimate 200 so the client can read `code` rather than an error.
    pub fn status(self) -> axum::http::StatusCode {
        match self {
            Self::LedgerUnavailable => axum::http::StatusCode::SERVICE_UNAVAILABLE,
            _ => axum::http::StatusCode::OK,
        }
    }
}

/// What the modal echoes back so the player reads the exact token, network and
/// destination they are about to sign for. `treasury` is the server's copy of a
/// `NEXT_PUBLIC_` value on purpose — the UI must not trust its own build.
#[derive(Debug, Clone)]
pub struct Panel {
    pub chain_id: u64,
    pub network: &'static str,
    pub token: Option<&'static str>,
    pub treasury: String,
    pub treasury_configured: bool,
    pub banned: bool,
    pub balance: Option<f64>,
}

impl Panel {
    fn base() -> Self {
        let cfg = config();
        Self {
            chain_id: cfg.arc_chain_id,
            network: config::ARC_NETWORK_NAME,
            token: None,
            treasury: cfg.treasury_address.clone(),
            treasury_configured: is_address(&cfg.treasury_address),
            banned: false,
            balance: None,
        }
    }

    /// `{ready, code, message, ...base}` — the exact key set the route sends.
    pub fn json(&self, outcome: PreFlight) -> Value {
        let decimals = match self.token {
            Some(_) => Value::from(config::USDC_DECIMALS),
            None => Value::Null,
        };
        let mut map = Map::new();
        map.insert("ready".to_string(), json!(outcome == PreFlight::Ok));
        map.insert("code".to_string(), json!(outcome.code()));
        map.insert("message".to_string(), json!(outcome.message()));
        map.insert("chainId".to_string(), json!(self.chain_id));
        map.insert("network".to_string(), json!(self.network));
        map.insert(
            "token".to_string(),
            match self.token {
                Some(asset) => json!(asset),
                None => Value::Null,
            },
        );
        map.insert("decimals".to_string(), decimals);
        map.insert("treasury".to_string(), json!(self.treasury));
        map.insert(
            "treasuryConfigured".to_string(),
            json!(self.treasury_configured),
        );
        map.insert("banned".to_string(), json!(self.banned));
        map.insert(
            "balance".to_string(),
            match self.balance {
                Some(value) => Number::from_f64(value)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                _ => Value::Null,
            },
        );
        Value::Object(map)
    }
}

#[derive(serde::Deserialize, Default)]
struct Params {
    address: Option<String>,
    currency: Option<String>,
}

pub fn routes() -> Router {
    Router::new().route("/api/arc/deposit-precheck", get(precheck))
}

async fn precheck(Query(params): Query<Params>) -> Response {
    let outcome = run(params).await;
    respond(outcome)
}

fn respond(outcome: (PreFlight, Panel)) -> Response {
    let (state, panel) = outcome;
    let mut response = (state.status(), axum::Json(panel.json(state))).into_response();
    // Never cacheable: a cached "banned" or a cached "ready" is equally wrong.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

async fn run(params: Params) -> (PreFlight, Panel) {
    let address = params.address.unwrap_or_default().trim().to_string();
    // `searchParams.get('currency') || 'USDC'` — an empty param is the default.
    let currency = params
        .currency
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .or(Some("USDC"));
    let token = arc_asset(currency);

    let mut panel = Panel::base();
    panel.token = token;

    if address.is_empty() {
        return (PreFlight::AddressMissing, panel);
    }
    if !is_address(&address) {
        return (PreFlight::InvalidAddress, panel);
    }
    let Some(asset) = token else {
        return (PreFlight::AssetUnsupported, panel);
    };
    if !panel.treasury_configured {
        return (PreFlight::TreasuryNotConfigured, panel);
    }

    let banned = bans::is_globally_banned(&address).await;
    let balance = match read_balance(&address, asset).await {
        Ok(value) => value,
        // Ban list or ledger unreachable: report only the checks that did run
        // and leave the decision to the authoritative verifier on the deposit
        // route.
        Err(err) => {
            tracing::warn!("[deposit-precheck] ledger read failed: {err}");
            return (PreFlight::LedgerUnavailable, panel);
        }
    };

    panel.banned = banned;
    panel.balance = balance;
    if banned {
        return (PreFlight::WalletBanned, panel);
    }
    (PreFlight::Ok, panel)
}

/// `parseFloat(String(data.balance))` for the one row, `null` when the wallet
/// has never held this currency.
async fn read_balance(address: &str, asset: &str) -> ApiResult<Option<f64>> {
    let wallet = Value::String(canonical(address));
    let currency = Value::String(asset.to_string());
    let row = db::fetch_one(
        "SELECT balance FROM user_balances \
          WHERE user_address = CAST($1 AS text) AND currency = CAST($2 AS text) \
          LIMIT 1",
        &[("text", &wallet), ("text", &currency)],
    )
    .await?;
    Ok(row
        .as_ref()
        .and_then(|value| value.get("balance"))
        .and_then(js_number_field))
}

/// `parseFloat(String(x))`: a number passes through, a decimal string parses,
/// and anything else becomes `null` rather than a poisoned aggregate.
fn js_number_field(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    parsed.filter(|f| f.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_unreachable_ledger_is_a_5xx() {
        assert_eq!(PreFlight::Ok.status(), axum::http::StatusCode::OK);
        // A banned wallet is a legitimate, cacheable-free answer, not a fault.
        assert_eq!(PreFlight::WalletBanned.status(), axum::http::StatusCode::OK);
        assert_eq!(
            PreFlight::LedgerUnavailable.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            PreFlight::TreasuryNotConfigured.status(),
            axum::http::StatusCode::OK
        );
    }

    #[test]
    fn codes_and_messages_are_stable_machine_readable_pairs() {
        for (outcome, code) in [
            (PreFlight::Ok, "ok"),
            (PreFlight::AddressMissing, "address_missing"),
            (PreFlight::InvalidAddress, "invalid_address"),
            (PreFlight::AssetUnsupported, "asset_unsupported"),
            (PreFlight::TreasuryNotConfigured, "treasury_not_configured"),
            (PreFlight::WalletBanned, "wallet_banned"),
            (PreFlight::LedgerUnavailable, "ledger_unavailable"),
        ] {
            assert_eq!(outcome.code(), code);
            assert!(!outcome.message().is_empty());
        }
    }

    #[test]
    fn ready_is_true_for_ok_and_nothing_else() {
        let panel = Panel::base();
        assert_eq!(panel.json(PreFlight::Ok)["ready"], json!(true));
        for outcome in [
            PreFlight::AddressMissing,
            PreFlight::InvalidAddress,
            PreFlight::AssetUnsupported,
            PreFlight::TreasuryNotConfigured,
            PreFlight::WalletBanned,
            PreFlight::LedgerUnavailable,
        ] {
            assert_eq!(
                panel.json(outcome)["ready"],
                json!(false),
                "{}",
                outcome.code()
            );
        }
    }

    #[test]
    fn decimals_only_accompany_a_supported_asset() {
        let mut panel = Panel::base();
        panel.token = None;
        let body = panel.json(PreFlight::AssetUnsupported);
        assert_eq!(body["token"], Value::Null);
        assert_eq!(body["decimals"], Value::Null);

        panel.token = Some("USDC");
        let body = panel.json(PreFlight::Ok);
        assert_eq!(body["token"], json!("USDC"));
        assert_eq!(body["decimals"], json!(6), "USDC is 6 decimals on Arc");
    }

    #[test]
    fn the_panel_always_names_the_destination_being_signed() {
        let body = Panel::base().json(PreFlight::AddressMissing);
        for key in [
            "ready",
            "code",
            "message",
            "chainId",
            "network",
            "token",
            "decimals",
            "treasury",
            "treasuryConfigured",
            "banned",
            "balance",
        ] {
            assert!(
                body.get(key).is_some(),
                "{key} missing — the modal reads it unconditionally"
            );
        }
        assert_eq!(body["banned"], json!(false));
        assert_eq!(body["balance"], Value::Null);
        assert_eq!(body["network"], json!("Arc"));
    }

    #[test]
    fn an_unknown_asset_is_not_an_asset() {
        assert_eq!(arc_asset(Some("usdc")), Some("USDC"));
        assert_eq!(arc_asset(Some(" USdC ")), Some("USDC"));
        assert_eq!(arc_asset(None), None);
        assert_eq!(arc_asset(Some("")), None);
        assert_eq!(arc_asset(Some("ETH")), None);
    }

    #[test]
    fn balances_coerce_to_a_finite_number_or_null() {
        assert_eq!(js_number_field(&json!("12.5")), Some(12.5));
        assert_eq!(js_number_field(&json!(3)), Some(3.0));
        assert_eq!(js_number_field(&json!(null)), None);
        assert_eq!(js_number_field(&json!("not a number")), None);
        // A ledger row holding NaN must not become a balance the modal shows.
        assert_eq!(js_number_field(&json!("NaN")), None);
    }

    #[tokio::test]
    async fn missing_and_invalid_addresses_short_circuit_before_the_ledger() {
        // No DATABASE_URL in tests: reaching the ledger would panic/err out, so
        // these two passing proves the order is right.
        let (outcome, _) = run(Params::default()).await;
        assert_eq!(outcome, PreFlight::AddressMissing);
        let (outcome, _) = run(Params {
            address: Some("  ".into()),
            currency: None,
        })
        .await;
        assert_eq!(outcome, PreFlight::AddressMissing);
        let (outcome, _) = run(Params {
            address: Some("0xnot-an-address".into()),
            currency: None,
        })
        .await;
        assert_eq!(outcome, PreFlight::InvalidAddress);
        let (outcome, _) = run(Params {
            address: Some("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".into()),
            currency: Some("DOGE".into()),
        })
        .await;
        assert_eq!(outcome, PreFlight::AssetUnsupported);
    }
}
