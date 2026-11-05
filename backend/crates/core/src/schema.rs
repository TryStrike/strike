//! Column catalog.
//!
//! STRICT tables store NUMERIC, TIMESTAMPTZ and BOOLEAN all as INTEGER, so the
//! file alone cannot say how a value is read or written. This list keeps the
//! logical types, because handlers write them into `CAST($n AS <type>)`
//! placeholders.
//!
//! Two consumers:
//!   * binds: `db::typed_param` converts a JSON value by its declared type;
//!   * results: `db` decodes a column by its name, see [`decode_kind`]. Every
//!     SELECT in the codebase returns plain columns, so the name is enough; the
//!     `one_decode_per_column_name` test refuses a schema where it would not be.
//!
//! `schema_matches_the_sql_file` in `db.rs` checks this list against
//! `backend/schema.sql`.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::error::ApiResult;

const MONEY: &str = "numeric(30,10)";
const PRICE: &str = "numeric(20,8)";
const MULTIPLIER: &str = "numeric(10,4)";
const TS: &str = "timestamp with time zone";

/// `(table, column, logical type)` in table column order.
pub const COLUMNS: &[(&str, &str, &str)] = &[
    ("user_balances", "user_address", "text"),
    ("user_balances", "currency", "text"),
    ("user_balances", "balance", MONEY),
    ("user_balances", "user_tier", "text"),
    ("user_balances", "status", "text"),
    ("user_balances", "updated_at", TS),
    ("user_balances", "created_at", TS),
    ("balance_audit_log", "id", "bigint"),
    ("balance_audit_log", "user_address", "text"),
    ("balance_audit_log", "currency", "text"),
    ("balance_audit_log", "operation_type", "text"),
    ("balance_audit_log", "amount", MONEY),
    ("balance_audit_log", "balance_before", MONEY),
    ("balance_audit_log", "balance_after", MONEY),
    ("balance_audit_log", "transaction_hash", "text"),
    ("balance_audit_log", "bet_id", "text"),
    ("balance_audit_log", "created_at", TS),
    ("balance_audit_log", "idempotency_key", "text"),
    ("balance_audit_log", "settlement_token", "text"),
    ("balance_audit_log", "max_payout", MONEY),
    ("balance_audit_log", "end_time", TS),
    ("balance_audit_log", "consumed_at", TS),
    ("withdrawal_requests", "id", "bigint"),
    ("withdrawal_requests", "user_address", "text"),
    ("withdrawal_requests", "currency", "text"),
    ("withdrawal_requests", "amount", MONEY),
    ("withdrawal_requests", "fee_amount", MONEY),
    ("withdrawal_requests", "net_amount", MONEY),
    ("withdrawal_requests", "signature", "text"),
    ("withdrawal_requests", "signed_at", "bigint"),
    ("withdrawal_requests", "status", "text"),
    ("withdrawal_requests", "tx_hash", "text"),
    ("withdrawal_requests", "fee_tx_hash", "text"),
    ("withdrawal_requests", "decided_by", "text"),
    ("withdrawal_requests", "decided_at", TS),
    ("withdrawal_requests", "requested_at", TS),
    ("withdrawal_requests", "created_at", TS),
    ("withdrawal_requests", "notes", "text"),
    ("withdrawal_requests", "account_type", "text"),
    ("bet_history", "id", "text"),
    ("bet_history", "wallet_address", "text"),
    ("bet_history", "asset", "text"),
    ("bet_history", "direction", "text"),
    ("bet_history", "amount", MONEY),
    ("bet_history", "multiplier", MULTIPLIER),
    ("bet_history", "strike_price", PRICE),
    ("bet_history", "end_price", PRICE),
    ("bet_history", "payout", MONEY),
    ("bet_history", "won", "boolean"),
    ("bet_history", "mode", "text"),
    ("bet_history", "network", "text"),
    ("bet_history", "resolved_at", TS),
    ("bet_history", "created_at", TS),
    ("bet_rounds", "bet_id", "text"),
    ("bet_rounds", "user_address", "text"),
    ("bet_rounds", "currency", "text"),
    ("bet_rounds", "asset", "text"),
    ("bet_rounds", "mode", "text"),
    ("bet_rounds", "direction", "text"),
    ("bet_rounds", "stake", MONEY),
    ("bet_rounds", "multiplier", MULTIPLIER),
    ("bet_rounds", "strike_price", PRICE),
    ("bet_rounds", "strike_at", TS),
    ("bet_rounds", "strike_source", "text"),
    ("bet_rounds", "price_top", PRICE),
    ("bet_rounds", "price_bottom", PRICE),
    ("bet_rounds", "end_time", TS),
    ("bet_rounds", "created_at", TS),
    ("bet_rounds", "end_price", PRICE),
    ("bet_rounds", "end_price_at", TS),
    ("bet_rounds", "end_source", "text"),
    ("bet_rounds", "outcome", "text"),
    ("bet_rounds", "payout", MONEY),
    ("bet_rounds", "settled_by", "text"),
    ("bet_rounds", "settled_at", TS),
    ("user_referrals", "user_address", "text"),
    ("user_referrals", "referral_code", "text"),
    ("user_referrals", "referred_by", "text"),
    ("user_referrals", "referral_count", "integer"),
    ("user_referrals", "created_at", TS),
    ("banned_wallets", "wallet_address", "text"),
    ("banned_wallets", "reason", "text"),
    ("banned_wallets", "created_at", TS),
    ("user_sessions", "id", "uuid"),
    ("user_sessions", "wallet_address", "text"),
    ("user_sessions", "network", "text"),
    ("user_sessions", "started_at", TS),
    ("user_sessions", "last_ping_at", TS),
    ("user_sessions", "ended_at", TS),
    ("deposit_locks", "transaction_hash", "text"),
    ("deposit_locks", "user_address", "text"),
    ("deposit_locks", "currency", "text"),
    ("deposit_locks", "amount", MONEY),
    ("deposit_locks", "created_at", TS),
];

/// How an INTEGER cell in a result set becomes JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decode {
    Numeric(u32),
    Bool,
    Timestamp,
}

/// Scale of `numeric(p,s)`; a bare `numeric` is a money value.
pub fn numeric_scale(type_name: &str) -> Option<u32> {
    let rest = type_name.strip_prefix("numeric")?;
    if rest.is_empty() {
        return Some(crate::money::MONEY_SCALE);
    }
    rest.strip_prefix('(')?
        .strip_suffix(')')?
        .split(',')
        .nth(1)?
        .trim()
        .parse()
        .ok()
}

fn decode_of(type_name: &str) -> Option<Decode> {
    match type_name {
        TS => Some(Decode::Timestamp),
        "boolean" => Some(Decode::Bool),
        other => numeric_scale(other).map(Decode::Numeric),
    }
}

/// The non-plain decoding for a result column, by name.
pub fn decode_kind(column: &str) -> Option<Decode> {
    static BY_NAME: OnceLock<HashMap<&'static str, Decode>> = OnceLock::new();
    BY_NAME
        .get_or_init(|| {
            COLUMNS
                .iter()
                .filter_map(|(_, column, ty)| decode_of(ty).map(|d| (*column, d)))
                .collect()
        })
        .get(column)
        .copied()
}

#[derive(Debug, Default)]
pub struct Schema;

impl Schema {
    /// The logical type of a column, used by the browser query gateway.
    pub fn column_type(&self, table: &str, column: &str) -> Option<&str> {
        COLUMNS
            .iter()
            .find(|(t, c, _)| *t == table && *c == column)
            .map(|(_, _, ty)| *ty)
    }

    pub fn has_table(&self, table: &str) -> bool {
        COLUMNS.iter().any(|(t, _, _)| *t == table)
    }
}

/// Kept async and fallible so call sites read like the catalog load they were.
pub async fn get() -> ApiResult<&'static Schema> {
    Ok(&Schema)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_are_read_from_the_type() {
        assert_eq!(numeric_scale("numeric(30,10)"), Some(10));
        assert_eq!(numeric_scale("numeric(10,4)"), Some(4));
        assert_eq!(numeric_scale("numeric"), Some(10));
        assert_eq!(numeric_scale("text"), None);
        assert_eq!(numeric_scale("numeric(bad)"), None);
    }

    #[test]
    fn one_decode_per_column_name() {
        for (table, column, ty) in COLUMNS {
            assert_eq!(
                decode_kind(column),
                decode_of(ty),
                "{table}.{column} decodes differently from another column of the same name"
            );
        }
    }

    #[test]
    fn lookups_follow_the_list() {
        let schema = Schema;
        assert_eq!(
            schema.column_type("bet_history", "multiplier"),
            Some("numeric(10,4)")
        );
        assert_eq!(schema.column_type("bet_history", "nope"), None);
        assert!(schema.has_table("deposit_locks"));
        assert!(!schema.has_table("pg_class"));
    }
}
