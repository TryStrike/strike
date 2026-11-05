//! `lib/bans/walletBan.ts` — the global ban check every money path runs.

use serde_json::Value;

use strike_core::address::canonical;
use strike_core::config::config;

use crate::sql;

/// True when the wallet is banned by env (`BANNED_WALLET_ADDRESSES`) or by the
/// `banned_wallets` table. A failed lookup falls back to env-only, because a
/// missing table must not brick deposits - the TS did the same.
pub async fn is_globally_banned(address: &str) -> bool {
    let key = canonical(address);
    if config()
        .banned_wallet_addresses
        .iter()
        .any(|banned| canonical(banned) == key)
    {
        return true;
    }

    let bind = Value::String(key);
    match sql::fetch_one(
        "SELECT wallet_address FROM banned_wallets WHERE wallet_address = CAST($1 AS text) LIMIT 1",
        &[("text", &bind)],
    )
    .await
    {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(err) => {
            tracing::warn!("banned_wallets lookup failed: {err}");
            false
        }
    }
}
