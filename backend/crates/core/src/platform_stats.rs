//! Platform stats behind `/api/admin/stats`.
//!
//! Kept as a pure aggregation over row arrays plus a thin fetch layer, so the
//! money invariants that the landing page quotes are testable offline:
//!   * a bet is *demo* if its wallet is a `0xdemo…` address **or** its id starts
//!     with `demo-` (an id prefix on a real wallet is still play money),
//!   * only the real subset may reach a public number,
//!   * per-session dwell is capped and the 7-day window is measured against the
//!     clock the caller passes, never `Date::now()` inside the pure functions.
//!
//! Number coercion follows `Number(...)` rather than Rust's `parse()`: the TS
//! sums propagate `NaN` into the aggregate and `JSON.stringify` renders that as
//! `null`, so `to_value` does the same instead of silently substituting a zero.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Number, Value};

use crate::db;
use crate::error::{ApiError, ApiResult};

/// Page size of the full-table scans, matching the TS `PAGE`.
pub const PAGE: i64 = 1_000;
/// An open session is assumed to have gone idle 90s after its last ping.
pub const SESSION_IDLE_TAIL_MS: i64 = 90_000;
/// Only the last week of sessions feeds the average.
pub const SESSION_LOOKBACK_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
/// A single session may not contribute more than this to the average.
pub const SESSION_MAX_SECONDS: i64 = 4 * 60 * 60;

// ---------------------------------------------------------------------------
// Play-money detection
// ---------------------------------------------------------------------------

/// `isDemoWallet` / `isDemoWalletAddress`: the demo agent wallets are all
/// minted under the `0xdemo…` prefix.
pub fn is_demo_wallet(address: Option<&Value>) -> bool {
    match address {
        Some(Value::String(s)) => s.to_lowercase().trim_start().starts_with("0xdemo"),
        Some(Value::Number(n)) => n.to_string().to_lowercase().starts_with("0xdemo"),
        _ => false,
    }
}

/// `isDemoBetId`: the client mints `demo-…` ids for play-money bets placed from
/// a real wallet, so the id is a second, independent marker.
pub fn is_demo_bet_id(id: Option<&Value>) -> bool {
    match id {
        Some(Value::String(s)) => s.to_lowercase().starts_with("demo-"),
        Some(Value::Number(n)) => n.to_string().to_lowercase().starts_with("demo-"),
        _ => false,
    }
}

/// `isDemo(bet)` — the row-level predicate the real/demo split uses.
pub fn is_demo_bet(row: &Value) -> bool {
    is_demo_wallet(row.get("wallet_address")) || is_demo_bet_id(row.get("id"))
}

// ---------------------------------------------------------------------------
// JS-shaped coercion
// ---------------------------------------------------------------------------

/// `Number(v)` for a JSON cell. Anything unparsable is `NaN`: the callers sum it and the `NaN` shows
/// up as `null` in the JSON, which is the honest outcome.
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => f64::NAN,
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                parse_js_number(trimmed)
            }
        }
        // Objects and arrays are `NaN` under `Number()`.
        Some(_) => f64::NAN,
    }
}

/// `Number(v ?? 0)` — the guard the TS used on every ledger column.
pub fn number_or_zero(value: Option<&Value>) -> f64 {
    if matches!(value, None | Some(Value::Null)) {
        return 0.0;
    }
    js_number(value)
}

fn parse_js_number(raw: &str) -> f64 {
    if raw.eq_ignore_ascii_case("infinity") || raw == "+Infinity" {
        return f64::INFINITY;
    }
    // Hex, octal and binary literals are valid JS numeric strings.
    let (sign, body) = match raw.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, raw.strip_prefix('+').unwrap_or(raw)),
    };
    let lower = body.to_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        return u64::from_str_radix(hex, 16)
            .map(|v| sign * v as f64)
            .unwrap_or(f64::NAN);
    }
    body.parse::<f64>().map(|v| sign * v).unwrap_or(f64::NAN)
}

/// `b.won` inside `.filter()` — JS truthiness, not `== true`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        Some(Value::Bool(true)) => true,
    }
}

/// `String(r.network ?? 'UNKNOWN').trim() || 'UNKNOWN'`
pub fn network_label(value: Option<&Value>) -> String {
    let raw = match value {
        None | Some(Value::Null) => "UNKNOWN".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => value_to_string(other),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "UNKNOWN".to_string()
    } else {
        trimmed.to_string()
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// `normalizeWalletForBanKey` — the key the user sets dedupe on.
fn user_key(address: Option<&Value>) -> Option<String> {
    let raw = match address {
        Some(Value::String(s)) => s.trim().to_lowercase(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return None,
    };
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// `new Date(iso).getTime()`, `NaN` for anything unparsable.
pub fn parse_epoch_ms(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s.trim())
            .map(|dt| dt.timestamp_millis() as f64)
            .or_else(|_| {
                chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%dT%H:%M:%S%.f")
                    .map(|dt| dt.and_utc().timestamp_millis() as f64)
            })
            .or_else(|_| {
                chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
                    .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64)
            })
            .unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// A finite, non-negative epoch ms — the guard the TS lacked in a few places.
fn usable_epoch_ms(value: f64) -> Option<f64> {
    if value.is_finite() {
        Some(value)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct NetworkPnL {
    pub volume: f64,
    pub payout: f64,
    pub platform_pnl: f64,
}

impl NetworkPnL {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("volume".into(), number_to_json(self.volume));
        map.insert("payout".into(), number_to_json(self.payout));
        map.insert("platformPnL".into(), number_to_json(self.platform_pnl));
        Value::Object(map)
    }
}

/// `aggregateByNetwork` — volume and payout per network, with the house's
/// margin derived afterwards so a `NaN` amount cannot leak into only one field.
pub fn aggregate_by_network(rows: &[Value]) -> BTreeMap<String, NetworkPnL> {
    let mut acc: BTreeMap<String, NetworkPnL> = BTreeMap::new();
    for row in rows {
        let entry = acc.entry(network_label(row.get("network"))).or_default();
        entry.volume += number_or_zero(row.get("amount"));
        entry.payout += number_or_zero(row.get("payout"));
    }
    for pnl in acc.values_mut() {
        pnl.platform_pnl = pnl.volume - pnl.payout;
    }
    acc
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModeStats {
    pub total_bets: usize,
    pub total_volume: f64,
    pub total_payout: f64,
    pub total_wins: usize,
    pub total_losses: usize,
    pub win_rate: f64,
    pub platform_pnl: f64,
    pub platform_pnl_by_network: BTreeMap<String, NetworkPnL>,
    pub total_users: usize,
    pub total_referrals: f64,
    pub average_session_seconds: f64,
    pub session_sample_count: usize,
}

impl ModeStats {
    pub fn to_value(&self) -> Value {
        let networks = self
            .platform_pnl_by_network
            .iter()
            .map(|(k, v)| (k.clone(), v.to_value()))
            .collect::<Map<_, _>>();
        let mut map = Map::new();
        map.insert("totalBets".into(), json_usize(self.total_bets));
        map.insert("totalVolume".into(), number_to_json(self.total_volume));
        map.insert("totalPayout".into(), number_to_json(self.total_payout));
        map.insert("totalWins".into(), json_usize(self.total_wins));
        map.insert("totalLosses".into(), json_usize(self.total_losses));
        map.insert("winRate".into(), number_to_json(self.win_rate));
        map.insert("platformPnL".into(), number_to_json(self.platform_pnl));
        map.insert("platformPnLByNetwork".into(), Value::Object(networks));
        map.insert("totalUsers".into(), json_usize(self.total_users));
        map.insert(
            "totalReferrals".into(),
            number_to_json(self.total_referrals),
        );
        map.insert(
            "averageSessionSeconds".into(),
            number_to_json(self.average_session_seconds),
        );
        map.insert(
            "sessionSampleCount".into(),
            json_usize(self.session_sample_count),
        );
        Value::Object(map)
    }
}

/// `winRate` is a one-decimal percentage, and an empty set is 0 rather than a
/// division by zero.
pub fn win_rate(total_wins: usize, total_bets: usize) -> f64 {
    if total_bets > 0 {
        (total_wins as f64 / total_bets as f64 * 1000.0).round() / 10.0
    } else {
        0.0
    }
}

/// `buildModeStats`.
pub fn build_mode_stats(
    bets: &[Value],
    user_keys: &BTreeSet<String>,
    total_referrals: f64,
    average_session_seconds: f64,
    session_sample_count: usize,
) -> ModeStats {
    let total_bets = bets.len();
    let total_wins = bets.iter().filter(|b| truthy(b.get("won"))).count();
    let total_volume = bets
        .iter()
        .fold(0.0_f64, |acc, b| acc + number_or_zero(b.get("amount")));
    let total_payout = bets
        .iter()
        .fold(0.0_f64, |acc, b| acc + number_or_zero(b.get("payout")));
    ModeStats {
        total_bets,
        total_volume,
        total_payout,
        total_wins,
        total_losses: total_bets - total_wins,
        win_rate: win_rate(total_wins, total_bets),
        platform_pnl: total_volume - total_payout,
        platform_pnl_by_network: aggregate_by_network(bets),
        total_users: user_keys.len(),
        total_referrals,
        average_session_seconds,
        session_sample_count,
    }
}

/// `sessionDurationSeconds` — an ended session counts to `ended_at`, an open one
/// to its last ping plus the idle tail, never past `now_ms`, and never negative.
pub fn session_duration_seconds(
    started_at_ms: f64,
    last_ping_at_ms: f64,
    ended_at_ms: Option<f64>,
    now_ms: f64,
) -> i64 {
    let end = match usable_epoch_ms(ended_at_ms.unwrap_or(f64::NAN)) {
        Some(ended) => ended,
        None => {
            let ping = match usable_epoch_ms(last_ping_at_ms) {
                Some(p) => p,
                None => return 0,
            };
            (ping + SESSION_IDLE_TAIL_MS as f64).min(now_ms)
        }
    };
    let started = match usable_epoch_ms(started_at_ms) {
        Some(s) => s,
        None => return 0,
    };
    ((end - started) / 1000.0).floor().max(0.0) as i64
}

/// The session loop: `(average_seconds, sample_count)` for one wallet class.
///
/// `sessions` rows need `wallet_address`, `started_at`, `last_ping_at`,
/// `ended_at`.
pub fn session_average(sessions: &[Value], demo: bool, now_ms: i64) -> (f64, usize) {
    let cutoff = now_ms as f64 - SESSION_LOOKBACK_MS as f64;
    let mut sum = 0.0_f64;
    let mut count = 0usize;
    for row in sessions {
        let started = parse_epoch_ms(row.get("started_at"));
        if !started.is_finite() || started < cutoff {
            continue;
        }
        let seconds = session_duration_seconds(
            started,
            parse_epoch_ms(row.get("last_ping_at")),
            match row.get("ended_at") {
                Some(Value::Null) | None => None,
                other => Some(parse_epoch_ms(other)),
            },
            now_ms as f64,
        );
        if seconds <= 0 {
            continue;
        }
        let capped = seconds.min(SESSION_MAX_SECONDS) as f64;
        if is_demo_wallet(row.get("wallet_address")) == demo {
            sum += capped;
            count += 1;
        }
    }
    if count > 0 {
        (sum / count as f64, count)
    } else {
        (0.0, 0)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CurrencyStat {
    pub total_balance: f64,
    pub user_count: usize,
}

/// `currencyStats`: every row of `user_balances` counts a holder, so a wallet
/// holding two currencies appears under both.
pub fn currency_stats(rows: &[Value]) -> BTreeMap<String, CurrencyStat> {
    let mut acc: BTreeMap<String, CurrencyStat> = BTreeMap::new();
    for row in rows {
        let currency = network_label(row.get("currency"));
        let entry = acc.entry(currency).or_default();
        entry.total_balance += js_number(row.get("balance"));
        entry.user_count += 1;
    }
    acc
}

fn currency_stats_to_value(stats: &BTreeMap<String, CurrencyStat>) -> Value {
    Value::Object(
        stats
            .iter()
            .map(|(k, v)| {
                let mut map = Map::new();
                map.insert("totalBalance".into(), number_to_json(v.total_balance));
                map.insert("userCount".into(), json_usize(v.user_count));
                (k.clone(), Value::Object(map))
            })
            .collect(),
    )
}

/// `Number -> Value`, with `NaN`/infinite rendering as `null` the way
/// `JSON.stringify` does.
pub fn number_to_json(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn json_usize(value: usize) -> Value {
    Value::Number(Number::from(value as u64))
}

// ---------------------------------------------------------------------------
// The whole platform aggregate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PlatformStats {
    pub real: ModeStats,
    pub demo: ModeStats,
    pub currency_stats: BTreeMap<String, CurrencyStat>,
    pub total_deposits: usize,
    pub total_withdrawals: usize,
}

impl PlatformStats {
    /// The admin shape (`real`, `demo`, `currencyStats`, deposits, withdrawals).
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("real".into(), self.real.to_value());
        map.insert("demo".into(), self.demo.to_value());
        map.insert(
            "currencyStats".into(),
            currency_stats_to_value(&self.currency_stats),
        );
        map.insert("totalDeposits".into(), json_usize(self.total_deposits));
        map.insert(
            "totalWithdrawals".into(),
            json_usize(self.total_withdrawals),
        );
        Value::Object(map)
    }
}

/// The rows the aggregate needs. Each scan pages like the TS `for(;;)` loops;
/// a scan that returns a short page is done.
///
/// `select_and_where` is the statement *without* the window clause - this adds
/// `LIMIT/OFFSET` with its own two binds, so the arity check can never disagree
/// with the number of placeholders a caller wrote.
async fn scan_pageed(select_and_where: &str) -> ApiResult<Vec<Value>> {
    let statement = format!("{select_and_where} LIMIT CAST($1 AS int8) OFFSET CAST($2 AS int8)");
    let mut rows = Vec::new();
    let mut from = 0_i64;
    loop {
        let from_value = Value::from(from);
        let to_value = Value::from(PAGE);
        let chunk = db::fetch(&statement, &[("int8", &to_value), ("int8", &from_value)]).await?;
        let short = (chunk.len() as i64) < PAGE;
        rows.extend(chunk);
        if short {
            break;
        }
        from += PAGE;
    }
    Ok(rows)
}

/// `computePlatformStats()`.
pub async fn compute(now_ms: i64) -> ApiResult<PlatformStats> {
    let bets = scan_pageed(
        "SELECT id, wallet_address, amount, payout, won, network FROM bet_history \
         ORDER BY id ASC",
    )
    .await
    .map_err(|e| ApiError::Other(format!("bet_history: {e}")))?;

    let sessions = scan_pageed(
        "SELECT wallet_address, started_at, last_ping_at, ended_at FROM user_sessions \
         ORDER BY started_at ASC",
    )
    .await
    .map_err(|e| ApiError::Other(format!("user_sessions: {e}")))?;

    let audit = scan_pageed(
        "SELECT operation_type FROM balance_audit_log \
         WHERE operation_type IN ('deposit', 'withdrawal')",
    )
    .await
    .map_err(|e| ApiError::Other(format!("balance_audit_log: {e}")))?;

    let balances = db::fetch(
        "SELECT currency, balance, user_address FROM user_balances",
        &[],
    )
    .await
    .map_err(|e| ApiError::Other(format!("user_balances: {e}")))?;

    let referrals = db::fetch(
        "SELECT user_address, referral_count FROM user_referrals",
        &[],
    )
    .await
    .map_err(|e| ApiError::Other(format!("user_referrals: {e}")))?;

    let banned = db::fetch("SELECT wallet_address FROM banned_wallets", &[])
        .await
        .map_err(|e| ApiError::Other(format!("banned_wallets: {e}")))?;

    Ok(aggregate(
        &bets, &sessions, &audit, &balances, &referrals, &banned, now_ms,
    ))
}

/// The pure half of `computePlatformStats`, split out so the invariants above
/// are testable without a database.
pub fn aggregate(
    bets: &[Value],
    sessions: &[Value],
    audit: &[Value],
    balances: &[Value],
    referrals: &[Value],
    banned: &[Value],
    now_ms: i64,
) -> PlatformStats {
    let real_bets: Vec<Value> = bets.iter().filter(|b| !is_demo_bet(b)).cloned().collect();
    let demo_bets: Vec<Value> = bets.iter().filter(|b| is_demo_bet(b)).cloned().collect();

    // A wallet counts once per class, whichever table it first appears in.
    let mut real_users: BTreeSet<String> = BTreeSet::new();
    let mut demo_users: BTreeSet<String> = BTreeSet::new();
    for row in bets {
        if let Some(key) = user_key(row.get("wallet_address")) {
            (if is_demo_bet(row) {
                &mut demo_users
            } else {
                &mut real_users
            })
            .insert(key);
        }
    }
    // Deposited-but-never-bet wallets and banned wallets are "users" too.
    for row in balances {
        if let Some(key) = user_key(row.get("user_address")) {
            (if is_demo_wallet(row.get("user_address")) {
                &mut demo_users
            } else {
                &mut real_users
            })
            .insert(key);
        }
    }
    for row in banned {
        if let Some(key) = user_key(row.get("wallet_address")) {
            (if is_demo_wallet(row.get("wallet_address")) {
                &mut demo_users
            } else {
                &mut real_users
            })
            .insert(key);
        }
    }

    let referral_total = |demo: bool| -> f64 {
        referrals
            .iter()
            .filter(|r| is_demo_wallet(r.get("user_address")) == demo)
            .fold(0.0_f64, |acc, r| {
                acc + number_or_zero(r.get("referral_count"))
            })
    };

    let (avg_real, count_real) = session_average(sessions, false, now_ms);
    let (avg_demo, count_demo) = session_average(sessions, true, now_ms);

    PlatformStats {
        real: build_mode_stats(
            &real_bets,
            &real_users,
            referral_total(false),
            avg_real,
            count_real,
        ),
        demo: build_mode_stats(
            &demo_bets,
            &demo_users,
            referral_total(true),
            avg_demo,
            count_demo,
        ),
        currency_stats: currency_stats(balances),
        total_deposits: audit
            .iter()
            .filter(|r| r.get("operation_type").and_then(Value::as_str) == Some("deposit"))
            .count(),
        total_withdrawals: audit
            .iter()
            .filter(|r| r.get("operation_type").and_then(Value::as_str) == Some("withdrawal"))
            .count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000_000;

    fn bet(id: &str, wallet: &str, amount: f64, payout: f64, won: bool, network: &str) -> Value {
        json!({ "id": id, "wallet_address": wallet, "amount": amount, "payout": payout,
                "won": won, "network": network })
    }

    #[test]
    fn a_demo_id_on_a_real_wallet_is_still_play_money() {
        let real = bet("b1", "0xAbC0", 10.0, 4.0, true, "Arc");
        let by_wallet = bet("b2", "0xDEMO1", 10.0, 4.0, true, "Arc");
        let by_id = bet("demo-b3", "0xAbC0", 10.0, 4.0, true, "Arc");
        assert!(!is_demo_bet(&real));
        assert!(is_demo_bet(&by_wallet));
        assert!(
            is_demo_bet(&by_id),
            "the id prefix alone must flip the row to demo"
        );
    }

    #[test]
    fn real_and_demo_bets_aggregate_apart() {
        let bets = vec![
            bet("b1", "0xAbC0", 100.0, 30.0, true, "USDC"),
            bet("demo-b2", "0xAbC0", 500.0, 400.0, true, "USDC"),
            bet("b3", "0xdEmO3", 900.0, 0.0, false, "USDC"),
        ];
        let stats = aggregate(&bets, &[], &[], &[], &[], &[], NOW);
        assert_eq!(stats.real.total_bets, 1);
        assert_eq!(stats.demo.total_bets, 2);
        assert_eq!(stats.real.total_volume, 100.0);
    }

    #[test]
    fn win_rate_is_a_one_decimal_percentage_and_zero_when_empty() {
        assert_eq!(win_rate(1, 3), 33.3);
        assert_eq!(win_rate(2, 3), 66.7);
        assert_eq!(win_rate(0, 0), 0.0);
    }

    #[test]
    fn per_network_pnl_is_volume_minus_payout() {
        let rows = vec![
            bet("a", "0x1", 10.0, 4.0, true, "usdc"),
            bet("b", "0x2", 5.0, 1.0, false, "USDC"),
            bet("c", "0x3", 2.0, 0.0, false, ""),
            bet("d", "0x4", 1.0, 0.0, false, "  "),
        ];
        let by_network = aggregate_by_network(&rows);
        // `String(x ?? 'UNKNOWN').trim() || 'UNKNOWN'` folds blanks together,
        // but is case-sensitive otherwise — the two spellings stay separate.
        assert_eq!(by_network.len(), 3);
        assert_eq!(by_network["usdc"].volume, 10.0);
        assert_eq!(by_network["USDC"].platform_pnl, 4.0);
        assert_eq!(by_network["UNKNOWN"].volume, 3.0);
    }

    #[test]
    fn an_open_session_counts_the_idle_tail_but_never_the_future() {
        let started = NOW as f64 - 60_000.0;
        // Ended sessions are exact.
        assert_eq!(
            session_duration_seconds(started, started, Some(started + 120_000.0), NOW as f64),
            120
        );
        // Open ones stop at last ping + 90s...
        assert_eq!(
            session_duration_seconds(started, NOW as f64 - 30_000.0, None, NOW as f64),
            60
        );
        // ...but never run past the clock they were measured against.
        assert_eq!(
            session_duration_seconds(started, NOW as f64 + 600_000.0, None, NOW as f64),
            60
        );
        // A garbage timestamp yields 0 rather than a negative dwell.
        assert_eq!(
            session_duration_seconds(f64::NAN, f64::NAN, None, NOW as f64),
            0
        );
    }

    #[test]
    fn session_average_drops_stale_rows_and_caps_a_single_dwell() {
        let row = |wallet: &str, started_ms: i64, pinged_ms: i64| -> Value {
            iso_session(wallet, started_ms, pinged_ms, None)
        };
        let fresh = NOW - 60_000;
        let sessions = vec![
            row("0xREAL1", fresh, NOW - 10_000),
            // Beyond the 7-day window.
            row("0xREAL2", NOW - SESSION_LOOKBACK_MS - 1, NOW),
            // A whole day of pinged dwell still counts as four hours.
            row("0xREAL3", NOW - 24 * 60 * 60_000, NOW),
            // Zero-length sessions are not a sample.
            row("0xREAL4", NOW, NOW),
            // Demo wallets feed the other bucket only.
            row("0xDEMO9", fresh, NOW - 10_000),
        ];
        let (avg, count) = session_average(&sessions, false, NOW);
        assert_eq!(count, 2, "stale and zero-length rows must not be sampled");
        // 60s for the row that opened a minute ago (its idle tail is clamped by
        // the clock) plus the capped four hours.
        assert_eq!(avg, (60.0 + SESSION_MAX_SECONDS as f64) / 2.0);
        assert_eq!(session_average(&sessions, true, NOW), (60.0, 1));
    }

    fn iso_session(wallet: &str, started_ms: i64, pinged_ms: i64, ended_ms: Option<i64>) -> Value {
        let iso = |ms: i64| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                .unwrap_or_default()
        };
        json!({
            "wallet_address": wallet,
            "started_at": iso(started_ms),
            "last_ping_at": iso(pinged_ms),
            "ended_at": ended_ms.map(|ms| Value::String(iso(ms))).unwrap_or(Value::Null),
        })
    }

    #[test]
    fn a_wallet_is_counted_once_even_across_three_tables() {
        let bets = vec![bet("b1", "0xAbC0", 10.0, 0.0, false, "USDC")];
        let balances = vec![
            json!({ "currency": "USDC", "balance": "12.5", "user_address": "0xabc0" }),
            json!({ "currency": "USDC", "balance": "2.5", "user_address": "0xdead" }),
        ];
        let banned = vec![json!({ "wallet_address": "0xAB C0".replace(' ', "") })];
        let stats = aggregate(&bets, &[], &[], &balances, &[], &banned, NOW);
        assert_eq!(
            stats.real.total_users, 2,
            "the same lowercase key must not count twice"
        );
        assert_eq!(stats.currency_stats["USDC"].total_balance, 15.0);
        assert_eq!(stats.currency_stats["USDC"].user_count, 2);
    }

    #[test]
    fn deposit_and_withdrawal_counts_ignore_other_operations() {
        let audit = vec![
            json!({ "operation_type": "deposit" }),
            json!({ "operation_type": "deposit" }),
            json!({ "operation_type": "withdrawal" }),
            json!({ "operation_type": "bet" }),
            json!({ "operation_type": "win" }),
        ];
        let stats = aggregate(&[], &[], &audit, &[], &[], &[], NOW);
        assert_eq!((stats.total_deposits, stats.total_withdrawals), (2, 1));
    }

    #[test]
    fn referral_totals_split_on_the_wallet_not_the_bet() {
        let referrals = vec![
            json!({ "user_address": "0xdemo1", "referral_count": 7 }),
            json!({ "user_address": "0xreal1", "referral_count": 3 }),
            json!({ "user_address": "0xreal2", "referral_count": null }),
        ];
        let stats = aggregate(&[], &[], &[], &[], &referrals, &[], NOW);
        assert_eq!(
            stats.real.total_referrals, 3.0,
            "a null count adds nothing, not NaN"
        );
        assert_eq!(stats.demo.total_referrals, 7.0);
    }

    #[test]
    fn numeric_strings_and_nulls_coerce_the_way_js_did() {
        assert_eq!(number_or_zero(Some(&json!("12.5"))), 12.5);
        assert_eq!(number_or_zero(Some(&json!(" 3 "))), 3.0);
        assert_eq!(number_or_zero(Some(&json!(null))), 0.0);
        assert_eq!(number_or_zero(None), 0.0);
        assert!(number_or_zero(Some(&json!("abc"))).is_nan());
        assert_eq!(js_number(Some(&json!(""))), 0.0);
        assert!(js_number(Some(&json!(null))).is_nan());
        // NaN cannot be represented in JSON; the aggregate surfaces it as null,
        // exactly like JSON.stringify did, rather than inventing a zero.
        assert_eq!(number_to_json(f64::NAN), Value::Null);
    }
}
