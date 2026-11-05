//! Pure logic behind `/api/bets/*`: query-param parsing, row classification,
//! aggregation, ranking and JSON formatting. Mirrors
//! `app/api/bets/history/route.ts`, `stats/statsCore.ts`,
//! `leaderboard/leaderboardCore.ts`, `[id]/route.ts` and `save/route.ts`.
//!
//! Everything here is side-effect free (no DB, no network, no clock): the
//! handlers pass `now_ms()` explicitly, and tests can pin the clock through
//! `CLOCK_OVERRIDE` or by handing the pure functions their own instant.
//!
//! Wire-shape rules inherited from the TS routes:
//!   * JSON numbers print through `js_num`, so integral floats are `10`, not
//!     `10.0` (JSON.stringify semantics) and non-finite values become `null`;
//!   * `round` implements JS `Math.round` (half toward +infinity) at 6
//!     decimals — Rust's `f64::round` is half-away-from-zero and would drift;
//!   * demo/play-money rows drop out via `is_demo_bet_row`, the port of
//!     `isDemoBetHistoryRow`, before any aggregate is computed.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::address;

/// Query-string parameters, already percent-decoded by axum.
pub type Params = BTreeMap<String, String>;

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/// Tests pin the clock here (-1 = "use the real time"); handlers read `now_ms`.
pub static CLOCK_OVERRIDE: AtomicI64 = AtomicI64::new(-1);

pub fn now_ms() -> i64 {
    let pinned = CLOCK_OVERRIDE.load(AtomicOrdering::Relaxed);
    if pinned >= 0 {
        return pinned;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// JS-semantics primitives
// ---------------------------------------------------------------------------

/// `Number.parseInt(raw, 10)`: leading whitespace, optional sign, digits only.
pub fn parse_int_prefix(raw: &str) -> Option<i64> {
    let s = raw.trim_start();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1i64, r),
        None => (1i64, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|v| sign * v)
}

/// `Number.parseFloat(s)`: longest numeric prefix, or NaN (None).
pub fn parse_float_prefix_str(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let mut end = 0;
    if end < bytes.len() && (bytes[end] == b'-' || bytes[end] == b'+') {
        end += 1;
    }
    let mut digits = 0;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
        digits += 1;
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let save = end;
        end += 1;
        if end < bytes.len() && (bytes[end] == b'-' || bytes[end] == b'+') {
            end += 1;
        }
        let mut exp_digits = 0;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
            exp_digits += 1;
        }
        if exp_digits == 0 {
            end = save;
        }
    }
    s[..end].parse::<f64>().ok()
}

/// `parseFloat(value)` from the save route: coerces to string, then prefix-parses.
pub fn parse_float_prefix(value: &Value) -> f64 {
    parse_float_prefix_str(&value_to_string(value)).unwrap_or(f64::NAN)
}

/// `toNumber` from statsCore/leaderboardCore: NaN and Infinity collapse to 0.
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).unwrap_or(0.0),
        other => parse_float_prefix_str(&value_to_string(other))
            .filter(|f| f.is_finite())
            .unwrap_or(0.0),
    }
}

/// `Number(v)` full-string coercion, used by the proof route's `num()` and the
/// recent feed. None is the JS NaN.
pub fn number_coerce(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        other => {
            let s = other.as_str().unwrap_or_default();
            let t = s.trim();
            if s.is_empty() {
                return Some(0.0);
            }
            if t.eq_ignore_ascii_case("infinity")
                || t.starts_with('+') && t[1..].eq_ignore_ascii_case("infinity")
            {
                return Some(f64::INFINITY);
            }
            if t.eq_ignore_ascii_case("-infinity") {
                return Some(f64::NEG_INFINITY);
            }
            if t.len() > 2 && t.starts_with("0x") && t[2..].chars().all(|c| c.is_ascii_hexdigit()) {
                return i64::from_str_radix(&t[2..], 16).ok().map(|v| v as f64);
            }
            if t.parse::<f64>().is_ok() {
                t.parse::<f64>().ok()
            } else {
                None
            }
        }
    }
}

/// `String(value)` for the ledger id / hash / address fields.
pub fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// JS `Math.round(x)` is half-toward-+infinity; Rust's `f64::round` is
/// half-away. The 6dp rounding every money figure passes through must match JS.
pub fn round6(n: f64) -> f64 {
    if !n.is_finite() {
        return f64::NAN;
    }
    (n * 1e6 + 0.5).floor() / 1e6
}

/// statsCore `round` — no finiteness guard (JSON.stringify turns NaN to null).
pub fn round(n: f64) -> f64 {
    round6(n)
}

/// leaderboardCore `round`: NaN/Infinity collapse to 0 instead of poisoning JSON.
pub fn round_finite(n: f64) -> f64 {
    if n.is_finite() {
        round6(n)
    } else {
        0.0
    }
}

/// JSON number with `JSON.stringify` semantics: integral floats print without
/// a fractional part; non-finite values print as `null`.
pub fn js_num(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        let i = n as i64;
        // -0 stringifies as "0" through serde; JS prints "-0". Unreachable for
        // values that came through round6 on real stakes; keep 0.
        return Value::Number(if i == 0 { 0.into() } else { i.into() });
    }
    serde_json::Number::from_f64(n)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn js_i64(v: i64) -> Value {
    Value::Number(v.into())
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

pub const MS_PER_DAY: i64 = 86_400_000;

/// `Date.parse` for the shapes these routes accept: `YYYY-MM-DD` (UTC
/// midnight, per ECMA-262) and full ISO-8601 with `Z` or `±hh:mm`. A naive
/// zone-less datetime is treated as UTC — JS would read it in the server's
/// local zone; the routes only ever receive `Z`/date-only strings in practice.
pub fn parse_date_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    // Date-only: UTC midnight.
    if s.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' {
        if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            return d
                .and_hms_opt(0, 0, 0)
                .map(|dt| dt.and_utc().timestamp_millis());
        }
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.and_utc().timestamp_millis());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f") {
        return Some(dt.and_utc().timestamp_millis());
    }
    None
}

/// `new Date(ms).toISOString()` — millisecond precision, always `Z`.
pub fn iso_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let naive = chrono::DateTime::from_timestamp(secs, (millis * 1_000_000) as u32)
        .map(|dt| dt.naive_utc())
        .unwrap_or_default();
    format!("{}Z", naive.format("%Y-%m-%dT%H:%M:%S%.3f"))
}

/// `new Date(ms)` floored to the UTC calendar instant.
pub fn utc_midnight_ms(ms: i64) -> i64 {
    let mut day = ms.div_euclid(MS_PER_DAY);
    if ms < 0 {
        day -= 1;
    }
    day * MS_PER_DAY
}

fn utc_day_key(ms: i64) -> String {
    let mut day = ms.div_euclid(MS_PER_DAY);
    if ms < 0 {
        day -= 1;
    }
    chrono::DateTime::from_timestamp(day * (MS_PER_DAY / 1000), 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Wallet / demo-row predicates
// ---------------------------------------------------------------------------

/// `/^0x[a-fA-F0-9]{40}$/` — stricter than `address::is_address_shape`, which
/// also admits a capital `0X` prefix the TS routes reject.
pub fn is_evm_address(value: &str) -> bool {
    let Some(hex_part) = value.strip_prefix("0x") else {
        return false;
    };
    hex_part.len() == 40 && hex_part.chars().all(|c| c.is_ascii_hexdigit())
}

/// `isDemoWalletAddress`: `0xDEMO…` wallets under any spelling.
pub fn is_demo_wallet_address(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(s)) => s.to_lowercase().starts_with("0xdemo"),
        _ => false,
    }
}

/// `isDemoBetHistoryRow`: play-money bet ids (`demo-…`) and demo wallets.
pub fn is_demo_bet_row(row: &Value) -> bool {
    if is_demo_wallet_address(row.get("wallet_address")) {
        return true;
    }
    match row.get("id") {
        None | Some(Value::Null) => false,
        Some(v) => value_to_string(v).to_lowercase().starts_with("demo-"),
    }
}

/// `canonicalHouseUserAddress` — re-exported so the bet routes read one module.
pub fn canonical_address(value: &str) -> String {
    address::canonical(value)
}

// ---------------------------------------------------------------------------
// /api/bets/history — param parsing
// ---------------------------------------------------------------------------

pub const DEFAULT_HISTORY_LIMIT: i64 = 50;
pub const MAX_HISTORY_LIMIT: i64 = 200;
pub const MAX_HISTORY_OFFSET: i64 = 5000;

const OUTCOMES: [&str; 3] = ["won", "lost", "all"];
const DIRECTIONS: [&str; 3] = ["UP", "DOWN", "DRAW"];

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryQuery {
    pub address: String,
    pub limit: i64,
    pub offset: i64,
    /// True only when the caller actually asked for a page offset.
    pub paged: bool,
    pub asset: Option<String>,
    /// 'won' | 'lost' | None (None == 'all' on the wire).
    pub outcome: Option<String>,
    pub direction: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

fn clamp_int(raw: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    match raw {
        None => fallback,
        Some(s) if s.trim().is_empty() => fallback,
        Some(s) => match parse_int_prefix(s) {
            None => fallback,
            Some(n) => n.min(max).max(min),
        },
    }
}

/// `/^[A-Z][A-Z0-9_-]{0,15}$/` after uppercasing.
fn asset_code_ok(code: &str) -> bool {
    let bytes = code.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 16
        && bytes[0].is_ascii_alphabetic()
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn parse_bound(raw: Option<&String>) -> Result<Option<String>, String> {
    let Some(v) = raw.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match parse_date_ms(v) {
        None => Err("Invalid date filter".to_string()),
        Some(t) => Ok(Some(iso_ms(t))),
    }
}

/// `parseHistoryRequest`, against a decoded parameter map instead of
/// URLSearchParams (axum already percent-decodes). Err carries the exact 400
/// message the TS route sends.
pub fn parse_history_request(params: &Params) -> Result<HistoryQuery, String> {
    let Some(wallet) = params.get("wallet") else {
        return Err("Missing wallet parameter".to_string());
    };
    if !is_evm_address(wallet.trim()) {
        return Err("Invalid wallet parameter".to_string());
    }

    let limit = clamp_int(
        params.get("limit").map(String::as_str),
        DEFAULT_HISTORY_LIMIT,
        1,
        MAX_HISTORY_LIMIT,
    );
    let offset_param = params.get("offset").map(|s| s.as_str());
    let offset = clamp_int(offset_param, 0, 0, MAX_HISTORY_OFFSET);

    let mut asset: Option<String> = None;
    if let Some(raw) = params
        .get("asset")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let code = raw.to_uppercase();
        if code != "ALL" {
            if !asset_code_ok(&code) {
                return Err("Invalid asset filter".to_string());
            }
            asset = Some(code);
        }
    }

    let raw_outcome = params
        .get("outcome")
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|| "all".to_string());
    if !OUTCOMES.contains(&raw_outcome.as_str()) {
        return Err("Invalid outcome filter".to_string());
    }
    let outcome = if raw_outcome == "all" {
        None
    } else {
        Some(raw_outcome)
    };

    let mut direction: Option<String> = None;
    if let Some(raw) = params
        .get("direction")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let code = raw.to_uppercase();
        if !DIRECTIONS.contains(&code.as_str()) {
            return Err("Invalid direction filter".to_string());
        }
        direction = Some(code);
    }

    let from = parse_bound(params.get("from"))?;
    let to = parse_bound(params.get("to"))?;
    if let (Some(f), Some(t)) = (&from, &to) {
        if parse_date_ms(f).unwrap_or(0) > parse_date_ms(t).unwrap_or(0) {
            return Err("Date range is inverted".to_string());
        }
    }

    Ok(HistoryQuery {
        address: canonical_address(wallet),
        limit,
        offset,
        paged: offset_param.is_some_and(|s| !s.trim().is_empty()),
        asset,
        outcome,
        direction,
        from,
        to,
    })
}

const CHAIN_TX_KEYS: [&str; 3] = ["tx_hash", "txHash", "settlement_tx_hash"];

fn is_chain_tx_hash(value: &str) -> bool {
    // /^0x[0-9a-fA-F]{64}$/
    let Some(hex_part) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    else {
        return false;
    };
    hex_part.len() == 64 && hex_part.chars().all(|c| c.is_ascii_hexdigit())
}

/// `pickRowTxHash`: the first row spelling that holds a real 32-byte hash.
/// Internal markers (`lock:…`, `INTERNAL`) never survive this.
pub fn pick_row_tx_hash(row: &Value) -> Option<String> {
    for key in CHAIN_TX_KEYS {
        if let Some(Value::String(v)) = row.get(key) {
            let trimmed = v.trim();
            if is_chain_tx_hash(trimmed) {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// `isDemoBetHistoryRow` + `pickRowTxHash` + `ledgerRef` enrichment on one row.
pub fn decorate_history_row(row: &Value) -> Value {
    let mut map = match row {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    };
    let id = map.get("id").cloned().unwrap_or(Value::Null);
    let is_demo = is_demo_bet_row(&Value::Object(map.clone()));
    let tx = pick_row_tx_hash(&Value::Object(map.clone()));
    map.insert("isDemoBet".into(), Value::Bool(is_demo));
    map.insert(
        "txHash".into(),
        tx.map(Value::String).unwrap_or(Value::Null),
    );
    map.insert("ledgerRef".into(), Value::String(value_to_string(&id)));
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// /api/bets/stats — pure aggregation (statsCore.ts)
// ---------------------------------------------------------------------------

pub const STATS_DEFAULT_WINDOW: &str = "30d";
pub const STATS_MAX_ROWS: usize = 5000;

/// Parses the `window` query param; Err means "reject the request with 400".
#[allow(clippy::result_unit_err)]
pub fn parse_stats_window(raw: Option<&str>) -> Result<String, ()> {
    let Some(v) = raw.filter(|s| !s.is_empty()) else {
        return Ok(STATS_DEFAULT_WINDOW.to_string());
    };
    let v = v.trim().to_lowercase();
    match v.as_str() {
        "7d" | "30d" | "all" => Ok(v),
        _ => Err(()),
    }
}

fn stats_window_days(window: &str) -> Option<i64> {
    match window {
        "7d" => Some(7),
        "30d" => Some(30),
        _ => None,
    }
}

/// ISO lower bound applied to `created_at`; None for the "all" window.
pub fn stats_window_start_iso(window: &str, now: i64) -> Option<String> {
    stats_window_days(window).map(|d| iso_ms(now - d * MS_PER_DAY))
}

/// Number of daily buckets the sparkline series covers for a window.
pub fn stats_series_days(window: &str) -> i64 {
    stats_window_days(window).unwrap_or(30)
}

fn bool_field(row: &Value, key: &str) -> bool {
    row.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn number_field(row: &Value, key: &str) -> f64 {
    row.get(key).map(to_number).unwrap_or(0.0)
}

/// Net result of one settled bet: (payout if won, else 0) - stake.
pub fn bet_net(row: &Value) -> f64 {
    let payout = if bool_field(row, "won") {
        number_field(row, "payout")
    } else {
        0.0
    };
    payout - number_field(row, "amount")
}

/// `effectiveMs`: settlement time (resolved_at, else created_at); 0 means
/// "not recorded" — unparsable or missing timestamps.
pub fn effective_ms(row: &Value) -> i64 {
    let raw = match row.get("resolved_at") {
        Some(v) if !v.is_null() => Some(v),
        _ => row.get("created_at").filter(|v| !v.is_null()),
    };
    match raw {
        Some(v) => {
            let s = value_to_string(v);
            if s.is_empty() {
                0
            } else {
                parse_date_ms(&s).unwrap_or(0)
            }
        }
        None => 0,
    }
}

pub fn compute_streaks(won_flags: &[bool]) -> (i64, i64) {
    let (mut longest_win, mut longest_loss, mut win_run, mut loss_run) = (0i64, 0i64, 0i64, 0i64);
    for won in won_flags {
        if *won {
            win_run += 1;
            loss_run = 0;
        } else {
            loss_run += 1;
            win_run = 0;
        }
        if win_run > longest_win {
            longest_win = win_run;
        }
        if loss_run > longest_loss {
            longest_loss = loss_run;
        }
    }
    (longest_win, longest_loss)
}

/// Daily buckets for the trailing `days` UTC days ending at `now` (inclusive),
/// zero-filled so the sparkline never sees missing dates. Rows outside the
/// trailing window are ignored.
pub fn build_daily_series(rows: &[Value], days: i64, now: i64) -> Vec<Value> {
    let bounded_days = days.clamp(1, 365) as usize;
    let today = utc_midnight_ms(now);
    let keys: Vec<String> = (0..bounded_days)
        .rev()
        .map(|i| utc_day_key(today - i as i64 * MS_PER_DAY))
        .collect();

    let mut buckets: Vec<(String, i64, f64, f64)> =
        keys.iter().map(|k| (k.clone(), 0i64, 0f64, 0f64)).collect();
    for row in rows {
        let key = utc_day_key(effective_ms(row));
        if let Some(b) = buckets.iter_mut().find(|(k, ..)| *k == key) {
            b.1 += 1;
            b.2 += number_field(row, "amount");
            b.3 += bet_net(row);
        }
    }

    let mut cum = 0f64;
    buckets
        .into_iter()
        .map(|(date, bets, volume, net)| {
            cum += net;
            let mut point = Map::new();
            point.insert("date".into(), Value::String(date));
            point.insert("bets".into(), js_i64(bets));
            point.insert("volume".into(), js_num(round(volume)));
            point.insert("net".into(), js_num(round(net)));
            point.insert("cumNet".into(), js_num(round(cum)));
            Value::Object(point)
        })
        .collect()
}

/// JS `??` on a JSON value: null/absent only, empty string passes through.
fn coalesce<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get(key).filter(|v| !v.is_null())
}

fn trade_of(row: &Value) -> Value {
    let at = coalesce(row, "resolved_at").or_else(|| coalesce(row, "created_at"));
    let asset = match row.get("asset") {
        Some(v) if !v.is_null() => value_to_string(v),
        _ => "—".to_string(),
    };
    let mut map = Map::new();
    map.insert("asset".into(), Value::String(asset));
    map.insert("net".into(), js_num(round(bet_net(row))));
    map.insert(
        "at".into(),
        at.filter(|v| is_truthy(Some(v)))
            .map(|v| Value::String(value_to_string(v)))
            .unwrap_or(Value::Null),
    );
    map.insert("amount".into(), js_num(round(number_field(row, "amount"))));
    map.insert("won".into(), Value::Bool(bool_field(row, "won")));
    Value::Object(map)
}

/// `aggregateWalletStats`: demo rows dropped here (single source of truth),
/// rows sorted oldest→newest by settlement time, then summarised into the
/// exact JSON shape the TS route ships.
pub fn aggregate_wallet_stats(
    input_rows: &[Value],
    window: &str,
    now: i64,
    max_rows: Option<usize>,
) -> Value {
    let rows: Vec<Value> = input_rows
        .iter()
        .filter(|r| !is_demo_bet_row(r))
        .cloned()
        .collect();
    let max = max_rows.unwrap_or(usize::MAX);
    let truncated = rows.len() > max;

    let mut chronological = rows.clone();
    chronological.sort_by_key(effective_ms);
    if truncated {
        let start = rows.len() - max;
        chronological = chronological[start..].to_vec();
    }

    let mut volume = 0f64;
    let mut net_pnl = 0f64;
    let mut wins = 0i64;
    let mut best: Option<&Value> = None;
    let mut worst: Option<&Value> = None;
    let mut best_net = f64::NEG_INFINITY;
    let mut worst_net = f64::INFINITY;
    // Insertion-ordered per-asset tally (JS Map order feeds the stable sort).
    let mut assets: Vec<(String, i64, i64, f64, f64)> = Vec::new();

    for row in &chronological {
        let amount = number_field(row, "amount");
        let net = bet_net(row);
        volume += amount;
        net_pnl += net;
        let won = bool_field(row, "won");
        if won {
            wins += 1;
        }
        if net > best_net {
            best_net = net;
            best = Some(row);
        }
        if net < worst_net {
            worst_net = net;
            worst = Some(row);
        }
        let key = match row.get("asset") {
            Some(v) if !v.is_null() => value_to_string(v),
            _ => "—".to_string(),
        };
        match assets.iter_mut().find(|(a, ..)| *a == key) {
            Some(entry) => {
                entry.1 += 1;
                entry.3 += amount;
                entry.4 += net;
                if won {
                    entry.2 += 1;
                }
            }
            None => assets.push((key, 1, if won { 1 } else { 0 }, amount, net)),
        }
    }

    let total_bets = chronological.len() as i64;
    let won_flags: Vec<bool> = chronological.iter().map(|r| bool_field(r, "won")).collect();
    let (longest_win_streak, longest_loss_streak) = compute_streaks(&won_flags);

    // volume desc; JS Array.sort is stable, so first-seen order breaks ties.
    let mut per_asset_values: Vec<Value> = assets
        .iter()
        .map(|(asset, bets, w, vol, net)| {
            let mut m = Map::new();
            m.insert("asset".into(), Value::String(asset.clone()));
            m.insert("bets".into(), js_i64(*bets));
            m.insert("wins".into(), js_i64(*w));
            m.insert(
                "winRate".into(),
                js_num(if *bets > 0 {
                    round((*w as f64 / *bets as f64) * 100.0 * 10.0) / 10.0
                } else {
                    0.0
                }),
            );
            m.insert("volume".into(), js_num(round(*vol)));
            m.insert("netPnl".into(), js_num(round(*net)));
            Value::Object(m)
        })
        .collect();
    let volumes: Vec<f64> = per_asset_values
        .iter()
        .map(|v| v.get("volume").and_then(Value::as_f64).unwrap_or(0.0))
        .collect();
    let mut idx: Vec<usize> = (0..volumes.len()).collect();
    idx.sort_by(|a, b| {
        volumes[*b]
            .partial_cmp(&volumes[*a])
            .unwrap_or(Ordering::Equal)
    });
    per_asset_values = idx
        .into_iter()
        .map(|i| std::mem::take(&mut per_asset_values[i]))
        .collect();

    let mut map = Map::new();
    map.insert("window".into(), Value::String(window.to_string()));
    map.insert("totalBets".into(), js_i64(total_bets));
    map.insert("wins".into(), js_i64(wins));
    map.insert("losses".into(), js_i64(total_bets - wins));
    map.insert(
        "winRate".into(),
        js_num(if total_bets > 0 {
            round((wins as f64 / total_bets as f64) * 100.0 * 10.0) / 10.0
        } else {
            0.0
        }),
    );
    map.insert("volume".into(), js_num(round(volume)));
    map.insert("netPnl".into(), js_num(round(net_pnl)));
    map.insert("longestWinStreak".into(), js_i64(longest_win_streak));
    map.insert("longestLossStreak".into(), js_i64(longest_loss_streak));
    map.insert(
        "bestTrade".into(),
        best.map(trade_of).unwrap_or(Value::Null),
    );
    map.insert(
        "worstTrade".into(),
        if total_bets > 0 {
            worst.map(trade_of).unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );
    map.insert("perAsset".into(), Value::Array(per_asset_values));
    map.insert(
        "series".into(),
        Value::Array(build_daily_series(
            &chronological,
            stats_series_days(window),
            now,
        )),
    );
    map.insert("truncated".into(), Value::Bool(truncated));
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// /api/bets/leaderboard — pure core (leaderboardCore.ts)
// ---------------------------------------------------------------------------

pub const LB_DEFAULT_LIMIT: i64 = 10;
pub const LB_MAX_LIMIT: i64 = 100;
pub const LB_PAGE_ROWS: i64 = 1000;
pub const LB_MAX_SCAN_ROWS: i64 = 5000;
pub const LB_CACHE_TTL_MS: i64 = 60_000;
pub const LB_MAX_CACHED_BOARDS: usize = 8;

/// None means "not a window we recognise" (absent/empty collapses to None).
pub fn parse_leaderboard_window(raw: Option<&str>) -> Option<&'static str> {
    let v = raw.map(|s| s.trim().to_lowercase())?;
    match v.as_str() {
        "today" => Some("today"),
        "7d" => Some("7d"),
        "30d" => Some("30d"),
        "all" => Some("all"),
        _ => None,
    }
}

/// Case-insensitive metric lookup; returns the canonical spelling.
pub fn parse_metric(raw: Option<&str>) -> Option<&'static str> {
    let v = raw
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())?;
    match v.as_str() {
        "netpnl" => Some("netPnl"),
        "volume" => Some("volume"),
        "winrate" => Some("winRate"),
        "bets" => Some("bets"),
        _ => None,
    }
}

/// Lower bound (inclusive) for `created_at`, or None for an unbounded board.
/// `today` is anchored to UTC midnight so the boundary is honest server-side.
pub fn leaderboard_window_start_ms(window: &str, now: i64) -> Option<i64> {
    match window {
        "today" => Some(utc_midnight_ms(now)),
        "7d" => Some(now - 7 * MS_PER_DAY),
        "30d" => Some(now - 30 * MS_PER_DAY),
        _ => None,
    }
}

/// Resolve the effective `created_at` lower bound: `window` wins when present,
/// otherwise the legacy rolling `timeframeHours` is honoured, clamped to five
/// years so an absurd value cannot scan forever.
pub fn resolve_since_ms(
    window: Option<&str>,
    timeframe_hours: Option<f64>,
    now: i64,
) -> Option<i64> {
    if let Some(w) = window {
        return leaderboard_window_start_ms(w, now);
    }
    let hours = timeframe_hours.filter(|h| h.is_finite() && *h > 0.0)?;
    let clamped = hours.min(24.0 * 365.0 * 5.0);
    Some(now - (clamped * 3_600_000.0) as i64)
}

/// Net PnL of one settled bet: the payout actually booked on a win, minus the
/// stake. A losing row contributes `-stake` even if a stray payout is present.
pub fn row_net_pnl(row: &Value) -> f64 {
    let payout = if bool_field(row, "won") {
        number_field(row, "payout")
    } else {
        0.0
    };
    payout - number_field(row, "amount")
}

/// Board-level PnL from a wallet's totals: payout settled minus stake, 6dp.
pub fn net_pnl_of(total_payout: f64, total_wagered: f64) -> f64 {
    let p = if total_payout.is_finite() {
        total_payout
    } else {
        0.0
    };
    let w = if total_wagered.is_finite() {
        total_wagered
    } else {
        0.0
    };
    round_finite(p - w)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub wallet_address: String,
    pub total_bets: i64,
    pub wins: i64,
    pub losses: i64,
    pub total_wagered: f64,
    pub total_payout: f64,
    pub net_pnl: f64,
    pub total_volume: f64,
    pub win_rate: f64,
    pub primary_network: String,
    pub primary_asset: String,
    pub last_bet_at: Option<String>,
}

impl Entry {
    /// `publicRow`: the wire shape, wallet truncated, back-compat keys first.
    pub fn public_row(&self, rank: i64, username: Option<String>) -> Value {
        let mut m = Map::new();
        m.insert(
            "wallet_address".into(),
            Value::String(truncate_address(&self.wallet_address)),
        );
        m.insert(
            "username".into(),
            username.map(Value::String).unwrap_or(Value::Null),
        );
        m.insert("total_bets".into(), js_i64(self.total_bets));
        m.insert("wins".into(), js_i64(self.wins));
        m.insert("losses".into(), js_i64(self.losses));
        m.insert("total_wagered".into(), js_num(self.total_wagered));
        m.insert("total_payout".into(), js_num(self.total_payout));
        m.insert("net_profit".into(), js_num(self.net_pnl));
        m.insert("win_rate".into(), js_num(self.win_rate));
        m.insert(
            "primary_network".into(),
            Value::String(self.primary_network.clone()),
        );
        m.insert(
            "primary_asset".into(),
            Value::String(self.primary_asset.clone()),
        );
        m.insert("rank".into(), js_i64(rank));
        m.insert("net_pnl".into(), js_num(self.net_pnl));
        m.insert("total_volume".into(), js_num(self.total_volume));
        m.insert(
            "last_bet_at".into(),
            self.last_bet_at
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        Value::Object(m)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AggregateResult {
    pub entries: EntryList,
    /// Assets present in real rows, busiest first — feeds the board selector.
    pub assets: Vec<(String, i64)>,
    pub real_rows: i64,
    pub demo_rows_dropped: i64,
}

pub type EntryList = Vec<Entry>;

/// count desc, then name asc — deterministic so ties do not shuffle boards.
/// Ties on names compare by bytes; wallet/asset names are ASCII in practice.
fn top_of(tally: &[(String, i64)], fallback: &str) -> String {
    if tally.is_empty() {
        return fallback.to_string();
    }
    let mut sorted = tally.to_vec();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    sorted[0].0.clone()
}

fn string_or_fallback(row: &Value, key: &str, fallback: &str) -> String {
    match row.get(key) {
        Some(v) if is_truthy(Some(v)) => value_to_string(v),
        _ => fallback.to_string(),
    }
}

fn bump(tally: &mut Vec<(String, i64)>, key: &str) {
    match tally.iter_mut().find(|(k, _)| k == key) {
        Some(e) => e.1 += 1,
        None => tally.push((key.to_string(), 1)),
    }
}

/// One entry per wallet over real (non-demo) rows; entry order is first-seen
/// wallet order, like the JS Map the TS core used.
pub fn aggregate_rows(rows: &[Value]) -> AggregateResult {
    #[rustfmt::skip]
    #[allow(clippy::type_complexity)]
    let mut wallets: Vec<(String, i64, i64, i64, f64, f64, Vec<(String, i64)>, Vec<(String, i64)>, Option<String>)> = Vec::new();
    let mut asset_tally: Vec<(String, i64)> = Vec::new();
    let mut demo_rows_dropped = 0i64;

    for row in rows {
        if is_demo_bet_row(row) {
            demo_rows_dropped += 1;
            continue;
        }
        let addr = canonical_address(
            &row.get("wallet_address")
                .map(value_to_string)
                .unwrap_or_default(),
        );
        if addr.is_empty() {
            continue;
        }
        let stake = number_field(row, "amount");
        let won = bool_field(row, "won");

        let idx = match wallets.iter().position(|(a, ..)| *a == addr) {
            Some(i) => i,
            None => {
                wallets.push((
                    addr.clone(),
                    0,
                    0,
                    0,
                    0.0,
                    0.0,
                    Vec::new(),
                    Vec::new(),
                    None,
                ));
                wallets.len() - 1
            }
        };
        let entry = &mut wallets[idx];
        entry.1 += 1; // total_bets
        entry.4 += stake; // total_wagered
        if won {
            entry.2 += 1; // wins
            entry.5 += number_field(row, "payout"); // total_payout
        } else {
            entry.3 += 1; // losses
        }

        let network = string_or_fallback(row, "network", "USDC");
        bump(&mut entry.6, &network);
        let asset = string_or_fallback(row, "asset", "USDC");
        bump(&mut entry.7, &asset);
        bump(&mut asset_tally, &asset);

        let at = coalesce(row, "created_at")
            .map(value_to_string)
            .filter(|s| !s.is_empty());
        if let Some(at) = at {
            let fresher = match &entry.8 {
                None => true,
                Some(cur) => match (parse_date_ms(&at), parse_date_ms(cur)) {
                    (Some(a), Some(b)) => a > b,
                    _ => false,
                },
            };
            if fresher {
                entry.8 = Some(at);
            }
        }
    }

    let entries = wallets
        .into_iter()
        .map(
            |(
                wallet_address,
                total_bets,
                wins,
                losses,
                total_wagered,
                total_payout,
                networks,
                assets,
                last_bet_at,
            )| {
                let net = net_pnl_of(total_payout, total_wagered);
                Entry {
                    wallet_address,
                    total_bets,
                    wins,
                    losses,
                    total_wagered: round_finite(total_wagered),
                    total_payout: round_finite(total_payout),
                    net_pnl: net,
                    total_volume: round_finite(total_wagered),
                    win_rate: if total_bets > 0 {
                        (wins as f64 / total_bets as f64) * 100.0
                    } else {
                        0.0
                    },
                    primary_network: top_of(&networks, "USDC"),
                    primary_asset: top_of(&assets, "USDC"),
                    last_bet_at,
                }
            },
        )
        .collect();

    let mut assets = asset_tally;
    assets.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    AggregateResult {
        entries,
        assets,
        real_rows: rows.len() as i64 - demo_rows_dropped,
        demo_rows_dropped,
    }
}

pub fn metric_value(entry: &Entry, metric: &str) -> f64 {
    match metric {
        "netPnl" => entry.net_pnl,
        "volume" => entry.total_wagered,
        "winRate" => entry.win_rate,
        _ => entry.total_bets as f64,
    }
}

/// Rank comparator for the chosen metric: higher is better; ties break on
/// PnL, then volume, then the address, so every rank is stable across requests.
pub fn compare_entries(a: &Entry, b: &Entry, metric: &str) -> Ordering {
    let diff = metric_value(b, metric) - metric_value(a, metric);
    if diff > 0.0 {
        return Ordering::Greater;
    }
    if diff < 0.0 {
        return Ordering::Less;
    }
    if metric != "netPnl" {
        let pnl = b.net_pnl - a.net_pnl;
        if pnl > 0.0 {
            return Ordering::Greater;
        }
        if pnl < 0.0 {
            return Ordering::Less;
        }
    }
    if metric != "volume" {
        let vol = b.total_wagered - a.total_wagered;
        if vol > 0.0 {
            return Ordering::Greater;
        }
        if vol < 0.0 {
            return Ordering::Less;
        }
    }
    a.wallet_address.cmp(&b.wallet_address)
}

pub fn sort_entries(entries: &[Entry], metric: &str) -> Vec<Entry> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| compare_entries(a, b, metric));
    sorted
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankLookup {
    pub rank: i64,
    pub people_ahead: i64,
    /// Wallets ranked on this board slice — NOT the whole population.
    pub total_ranked: i64,
    pub next_rank: Option<i64>,
    pub next_rank_value: Option<f64>,
    pub gap_to_next_rank: Option<f64>,
    /// Rank could not be determined exactly (own is outside the slice).
    pub estimated: bool,
}

/// Where `own` sits among `entries` (already sorted by the same metric).
pub fn lookup_rank(entries: &[Entry], own: &Entry, metric: &str) -> RankLookup {
    let exact_index = entries
        .iter()
        .position(|e| e.wallet_address == own.wallet_address);

    let people_ahead = match exact_index {
        Some(i) => i as i64,
        None => entries
            .iter()
            .filter(|e| compare_entries(e, own, metric) == Ordering::Less)
            .count() as i64,
    };

    let mut next_rank_value: Option<f64> = None;
    match exact_index {
        Some(i) if i > 0 => next_rank_value = Some(metric_value(&entries[i - 1], metric)),
        None if people_ahead > 0 => {
            next_rank_value = Some(metric_value(&entries[(people_ahead - 1) as usize], metric))
        }
        _ => {}
    }

    let own_value = metric_value(own, metric);
    let gap = next_rank_value.map(|v| {
        round_finite((v - own_value).max(0.0) + if metric == "bets" { 1.0 } else { 0.01 })
    });

    RankLookup {
        rank: people_ahead + 1,
        people_ahead,
        total_ranked: entries.len() as i64,
        next_rank: if people_ahead > 0 {
            Some(people_ahead)
        } else {
            None
        },
        next_rank_value: next_rank_value.map(round_finite),
        gap_to_next_rank: gap,
        estimated: exact_index.is_none(),
    }
}

/// `truncateAddress` — board addresses never leave in full form.
pub fn truncate_address(addr: &str) -> String {
    let chars: Vec<char> = addr.chars().collect();
    if chars.len() < 12 {
        return addr.to_string();
    }
    let prefix: String = chars[..6].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}…{suffix}")
}

/// `clampLimit`: junk / non-positive → default 10, ceiling 100.
pub fn clamp_limit(raw: Option<&str>) -> i64 {
    match raw.and_then(parse_int_prefix) {
        Some(n) if n > 0 => n.min(LB_MAX_LIMIT),
        _ => LB_DEFAULT_LIMIT,
    }
}

/// Asset names are bind parameters, but keep them boring anyway.
pub fn sanitize_asset(raw: Option<&str>) -> String {
    let v = raw.unwrap_or("ALL").trim().to_uppercase();
    let cleaned: String = v
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(16)
        .collect();
    if cleaned.is_empty() {
        "ALL".to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// /api/bets/leaderboard — snapshot cache (route.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Snapshot {
    /// Epoch ms of the scan — the timestamp the page reports as "updated".
    pub updated_at: i64,
    pub entries: Vec<Entry>,
    pub assets: Vec<(String, i64)>,
    pub scanned_rows: i64,
    pub real_rows: i64,
    pub demo_rows_dropped: i64,
    /// True when the row cap truncated the scan: totals are partial.
    pub truncated: bool,
    pub since_ms: Option<i64>,
}

pub fn cache_key(window: Option<&str>, timeframe_hours: Option<f64>, asset: &str) -> String {
    let tf = match timeframe_hours {
        Some(h) if h.is_finite() => {
            if h.fract() == 0.0 {
                format!("{}", h as i64)
            } else {
                h.to_string()
            }
        }
        _ => "-".to_string(),
    };
    format!("{}|{}|{}", window.unwrap_or("-"), tf, asset)
}

/// Insertion-ordered board cache: 60 s TTL, at most 8 boards, oldest key first
/// (the JS `Map` semantics the TS route relied on, including that re-setting a
/// key keeps its original position).
#[derive(Default)]
pub struct BoardCache {
    entries: Vec<(String, Snapshot)>,
}

impl BoardCache {
    pub fn get(&self, key: &str) -> Option<&Snapshot> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Hit only if within the TTL — this is what `getSnapshot` consults.
    pub fn get_fresh(&self, key: &str, now: i64) -> Option<&Snapshot> {
        self.get(key)
            .filter(|s| now - s.updated_at < LB_CACHE_TTL_MS)
    }

    /// `Map.set` then evict-oldest while over capacity.
    pub fn insert(&mut self, key: String, snapshot: Snapshot) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = snapshot,
            None => self.entries.push((key, snapshot)),
        }
        while self.entries.len() > LB_MAX_CACHED_BOARDS {
            self.entries.remove(0);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// `metaBlock`: scan bounds and freshness for every board response. Extras are
/// merged first, matching the TS object spread.
pub fn meta_block(
    snapshot: &Snapshot,
    now: i64,
    cached: bool,
    extras: Vec<(String, Value)>,
) -> Value {
    let mut map = Map::new();
    for (k, v) in extras {
        map.insert(k, v);
    }
    map.insert(
        "since".into(),
        snapshot
            .since_ms
            .map(|ms| Value::String(iso_ms(ms)))
            .unwrap_or(Value::Null),
    );
    map.insert("scannedRows".into(), js_i64(snapshot.scanned_rows));
    map.insert("realRows".into(), js_i64(snapshot.real_rows));
    map.insert("demoRowsDropped".into(), js_i64(snapshot.demo_rows_dropped));
    map.insert("truncated".into(), Value::Bool(snapshot.truncated));
    map.insert(
        "updatedAt".into(),
        Value::String(iso_ms(snapshot.updated_at)),
    );
    map.insert("cached".into(), Value::Bool(cached));
    map.insert(
        "stale".into(),
        Value::Bool(now - snapshot.updated_at >= LB_CACHE_TTL_MS),
    );
    Value::Object(map)
}

pub fn snapshot_assets_value(assets: &[(String, i64)]) -> Value {
    Value::Array(
        assets
            .iter()
            .map(|(asset, bets)| {
                let mut m = Map::new();
                m.insert("asset".into(), Value::String(asset.clone()));
                m.insert("bets".into(), js_i64(*bets));
                Value::Object(m)
            })
            .collect::<Vec<_>>(),
    )
}

// ---------------------------------------------------------------------------
// /api/bets/save — upsert field coercion
// ---------------------------------------------------------------------------

/// JS truthiness on a JSON value (`!x` in the TS routes).
pub fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `asset || 'BNB'` — any falsy value takes the default.
pub fn save_string_or_default(body: &Value, key: &str, default: &str) -> String {
    match body.get(key) {
        Some(v) if is_truthy(Some(v)) => value_to_string(v),
        _ => default.to_string(),
    }
}

/// `parseFloat(x) || fallback` — NaN and 0 both take the fallback.
pub fn save_float_or(body: &Value, key: &str, fallback: f64) -> f64 {
    let parsed = parse_float_prefix(body.get(key).unwrap_or(&Value::Null));
    if parsed.is_finite() && parsed != 0.0 {
        parsed
    } else {
        fallback
    }
}

/// `parseFloat(x) || 0` — NaN lands on 0.
pub fn save_float(body: &Value, key: &str) -> f64 {
    let parsed = parse_float_prefix(body.get(key).unwrap_or(&Value::Null));
    if parsed.is_finite() {
        parsed
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// /api/bets/[id] — proof helpers
// ---------------------------------------------------------------------------

/// `num()` from the proof route: null / '' / non-finite become JSON null.
pub fn proof_num(value: Option<&Value>) -> Option<f64> {
    let v = value?;
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        other => match number_coerce(other) {
            Some(f) if f.is_finite() => Some(f),
            _ => None,
        },
    }
}

/// `iso()` from the proof route: falsy in, unparsable in → null.
pub fn proof_iso(value: Option<&Value>) -> Option<String> {
    let v = value?;
    if !is_truthy(Some(v)) {
        return None;
    }
    parse_date_ms(&value_to_string(v)).map(iso_ms)
}

pub fn is_chain_hash_strict(value: &str) -> bool {
    is_chain_tx_hash(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WALLET: &str = "0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1";
    const WALLET_LOWER: &str = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "0xcccccccccccccccccccccccccccccccccccccccc";

    fn params(pairs: &[(&str, &str)]) -> Params {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn parse_int_and_float_prefix_match_js() {
        assert_eq!(parse_int_prefix("123abc"), Some(123));
        assert_eq!(parse_int_prefix(" -5 "), Some(-5));
        assert_eq!(parse_int_prefix("+7"), Some(7));
        assert_eq!(parse_int_prefix("abc"), None);
        assert_eq!(parse_int_prefix(""), None);
        assert_eq!(parse_float_prefix_str("10.5xyz"), Some(10.5));
        assert_eq!(parse_float_prefix_str("1e3"), Some(1000.0));
        assert_eq!(parse_float_prefix_str("1e"), Some(1.0));
        assert_eq!(parse_float_prefix_str(".5"), Some(0.5));
        assert_eq!(parse_float_prefix_str("abc"), None);
    }

    #[test]
    fn js_number_printing_and_rounding() {
        assert_eq!(js_num(10.0), json!(10));
        assert_eq!(js_num(9.5), json!(9.5));
        assert_eq!(js_num(f64::NAN), Value::Null);
        assert_eq!(round(1.234567891), 1.234568);
        assert_eq!(round(-1.234567891), -1.234568);
        assert_eq!(round_finite(f64::INFINITY), 0.0);
        assert_eq!(to_number(&json!("12.5")), 12.5);
        assert_eq!(to_number(&Value::Null), 0.0);
        assert_eq!(to_number(&json!("abc")), 0.0);
        assert_eq!(to_number(&json!(7)), 7.0);
        // Number() vs parseFloat(): the proof route refuses trailing garbage.
        assert_eq!(proof_num(Some(&json!("12abc"))), None);
        assert_eq!(number_coerce(&json!(" 12 ")), Some(12.0));
        assert_eq!(number_coerce(&json!("")), Some(0.0));
    }

    #[test]
    fn date_parsing_edges() {
        assert_eq!(parse_date_ms("2026-02-01"), Some(1_769_904_000_000)); // UTC midnight
        assert_eq!(
            parse_date_ms("2026-02-01T00:00:00.000Z"),
            Some(1_769_904_000_000)
        );
        assert_eq!(parse_date_ms("not-a-date"), None);
        assert_eq!(iso_ms(1_769_904_000_000), "2026-02-01T00:00:00.000Z");
        assert_eq!(utc_midnight_ms(1_769_904_000_000 + 1), 1_769_904_000_000);
        assert_eq!(utc_day_key(0), "1970-01-01"); // epoch zero = "not recorded"
    }

    #[test]
    fn demo_rows_are_detected_like_the_ts_helper() {
        assert!(is_demo_bet_row(
            &json!({"id": "demo-1700000000000", "wallet_address": WALLET_LOWER})
        ));
        assert!(is_demo_bet_row(
            &json!({"id": "DEMO-1", "wallet_address": WALLET_LOWER})
        ));
        assert!(is_demo_bet_row(
            &json!({"id": "real", "wallet_address": "0xDEMO11111111111111111111111111111111111"})
        ));
        assert!(is_demo_bet_row(
            &json!({"id": "real", "wallet_address": "0xdemooooo00000000000000000000000000000000"})
        ));
        assert!(!is_demo_bet_row(
            &json!({"id": "bet_1", "wallet_address": WALLET_LOWER})
        ));
        assert!(!is_demo_bet_row(&json!({"id": null})));
        assert!(!is_demo_bet_row(&json!({})));
    }

    #[test]
    fn evm_address_shape_rejects_what_the_ts_regex_rejects() {
        assert!(is_evm_address(WALLET));
        assert!(is_evm_address(WALLET_LOWER));
        // The TS regex is lowercase-`0x`-only, unlike address::is_address_shape.
        assert!(!is_evm_address(&WALLET.replace("0x", "0X")));
        assert!(!is_evm_address("hunter2"));
        assert!(!is_evm_address("0xdeadbeef"));
        assert_eq!(canonical_address(WALLET), WALLET_LOWER);
    }

    #[test]
    fn history_params_defaults_and_clamps() {
        let q = parse_history_request(&params(&[("wallet", WALLET)])).unwrap();
        assert_eq!(q.address, WALLET_LOWER);
        assert_eq!((q.limit, q.offset, q.paged), (50, 0, false));
        assert!(q.asset.is_none() && q.outcome.is_none() && q.direction.is_none());
        assert!(q.from.is_none() && q.to.is_none());

        let clamped =
            parse_history_request(&params(&[("wallet", WALLET), ("limit", "100000")])).unwrap();
        assert_eq!(clamped.limit, MAX_HISTORY_LIMIT);
        let junk = parse_history_request(&params(&[("wallet", WALLET), ("limit", "abc")])).unwrap();
        assert_eq!(junk.limit, DEFAULT_HISTORY_LIMIT);
        let negative =
            parse_history_request(&params(&[("wallet", WALLET), ("limit", "-5")])).unwrap();
        assert_eq!(negative.limit, 1);
        let deep = parse_history_request(&params(&[
            ("wallet", WALLET),
            ("offset", "999999999"),
            ("limit", "25"),
        ]))
        .unwrap();
        assert_eq!((deep.offset, deep.paged), (MAX_HISTORY_OFFSET, true));
        let empty_offset =
            parse_history_request(&params(&[("wallet", WALLET), ("offset", " ")])).unwrap();
        assert!(!empty_offset.paged);
        assert_eq!(empty_offset.offset, 0);
    }

    #[test]
    fn history_params_reject_with_the_exact_ts_messages() {
        assert_eq!(
            parse_history_request(&params(&[])).unwrap_err(),
            "Missing wallet parameter"
        );
        assert_eq!(
            parse_history_request(&params(&[("wallet", "not-a-wallet")])).unwrap_err(),
            "Invalid wallet parameter"
        );
        assert_eq!(
            parse_history_request(&params(&[("wallet", WALLET), ("asset", ";--drop")]))
                .unwrap_err(),
            "Invalid asset filter"
        );
        assert_eq!(
            parse_history_request(&params(&[
                ("wallet", WALLET),
                ("asset", "TOO_LONG_ASSET_CODE_NAME")
            ]))
            .unwrap_err(),
            "Invalid asset filter"
        );
        assert_eq!(
            parse_history_request(&params(&[("wallet", WALLET), ("outcome", "maybe")]))
                .unwrap_err(),
            "Invalid outcome filter"
        );
        assert_eq!(
            parse_history_request(&params(&[("wallet", WALLET), ("direction", "SIDEWAYS")]))
                .unwrap_err(),
            "Invalid direction filter"
        );
        assert_eq!(
            parse_history_request(&params(&[("wallet", WALLET), ("from", "not-a-date")]))
                .unwrap_err(),
            "Invalid date filter"
        );
        assert_eq!(
            parse_history_request(&params(&[
                ("wallet", WALLET),
                ("from", "2026-05-01T00:00:00.000Z"),
                ("to", "2026-01-01T00:00:00.000Z")
            ]))
            .unwrap_err(),
            "Date range is inverted"
        );
    }

    #[test]
    fn history_params_normalise_asset_and_dates() {
        let q = parse_history_request(&params(&[
            ("wallet", WALLET),
            ("asset", "ALL"),
            ("from", "2026-02-01"),
            ("to", "2026-02-02"),
        ]))
        .unwrap();
        assert!(q.asset.is_none(), "ALL means no asset filter");
        assert_eq!(q.from.as_deref(), Some("2026-02-01T00:00:00.000Z"));
        assert_eq!(q.to.as_deref(), Some("2026-02-02T00:00:00.000Z"));

        let q = parse_history_request(&params(&[
            ("wallet", WALLET),
            ("asset", "btc"),
            ("outcome", "LOST"),
            ("direction", "down"),
        ]))
        .unwrap();
        assert_eq!(q.asset.as_deref(), Some("BTC"));
        assert_eq!(q.outcome.as_deref(), Some("lost"));
        assert_eq!(q.direction.as_deref(), Some("DOWN"));
    }

    #[test]
    fn tx_hash_pick_prefers_the_first_real_spelling() {
        let hash = format!("0x{}", "a".repeat(64));
        assert_eq!(
            pick_row_tx_hash(&json!({"tx_hash": hash.clone()})).as_deref(),
            Some(hash.as_str())
        );
        assert_eq!(
            pick_row_tx_hash(&json!({"settlement_tx_hash": format!(" {hash} ")})).as_deref(),
            Some(hash.as_str())
        );
        let other = format!("0x{}", "c".repeat(64));
        assert_eq!(
            pick_row_tx_hash(&json!({"tx_hash": hash.clone(), "settlement_tx_hash": other}))
                .as_deref(),
            Some(hash.as_str())
        );
        assert_eq!(
            pick_row_tx_hash(&json!({"tx_hash": format!("lock:{hash}")})),
            None
        );
        assert_eq!(pick_row_tx_hash(&json!({"tx_hash": "INTERNAL"})), None);
        assert_eq!(pick_row_tx_hash(&json!({"tx_hash": "0xdeadbeef"})), None);
        assert_eq!(
            pick_row_tx_hash(&json!({"tx_hash": format!("0x{}", "b".repeat(63))})),
            None
        );
        assert_eq!(pick_row_tx_hash(&json!({"tx_hash": 12345})), None);
        assert_eq!(pick_row_tx_hash(&json!({"settlement_tx_hash": null})), None);
        assert_eq!(pick_row_tx_hash(&json!({})), None);
    }

    #[test]
    fn history_rows_carry_demo_flag_and_ledger_ref() {
        let row = decorate_history_row(&json!({"id": "demo-1700000000000", "asset": "BTC"}));
        assert_eq!(row["isDemoBet"], json!(true));
        assert_eq!(row["txHash"], Value::Null);
        assert_eq!(row["ledgerRef"], json!("demo-1700000000000"));
        assert_eq!(row["asset"], json!("BTC"));

        let real = decorate_history_row(&json!({"id": "bet_1", "wallet_address": WALLET_LOWER}));
        assert_eq!(real["isDemoBet"], json!(false));

        let hash = format!("0x{}", "a".repeat(64));
        let with_hash = decorate_history_row(&json!({"id": "bet_2", "tx_hash": hash.clone()}));
        assert_eq!(with_hash["txHash"], json!(hash));
    }

    #[test]
    fn stats_window_parsing() {
        assert_eq!(parse_stats_window(None).unwrap(), "30d");
        assert_eq!(parse_stats_window(Some("")).unwrap(), "30d");
        assert_eq!(parse_stats_window(Some("7D")).unwrap(), "7d");
        assert_eq!(parse_stats_window(Some("all")).unwrap(), "all");
        assert!(parse_stats_window(Some("90d")).is_err());
        let now = 1_770_000_000_000i64;
        assert_eq!(
            stats_window_start_iso("7d", now).as_deref(),
            Some(iso_ms(now - 7 * MS_PER_DAY).as_str())
        );
        assert_eq!(stats_window_start_iso("all", now), None);
        assert_eq!(stats_series_days("7d"), 7);
        assert_eq!(stats_series_days("30d"), 30);
        assert_eq!(stats_series_days("all"), 30);
    }

    #[test]
    fn streaks_over_chronological_flags() {
        // W W L W W W L L W
        let (win, loss) =
            compute_streaks(&[true, true, false, true, true, true, false, false, true]);
        assert_eq!((win, loss), (3, 2));
        assert_eq!(compute_streaks(&[]), (0, 0));
    }

    #[test]
    fn bet_net_is_defensive_on_losing_rows() {
        assert_eq!(
            bet_net(&json!({"amount": "10", "payout": "19", "won": true})),
            9.0
        );
        assert_eq!(
            bet_net(&json!({"amount": "10", "payout": "0", "won": false})),
            -10.0
        );
        assert_eq!(
            bet_net(&json!({"amount": "10", "payout": "999", "won": false})),
            -10.0
        );
        assert_eq!(
            bet_net(&json!({"amount": null, "payout": null, "won": false})),
            0.0
        );
    }

    #[test]
    fn daily_series_is_zero_filled_and_cumulative() {
        // Fixed "now": 2026-02-10T12:00:00Z
        let now = parse_date_ms("2026-02-10T12:00:00.000Z").unwrap();
        let series = build_daily_series(&[], 7, now);
        assert_eq!(series.len(), 7);
        assert_eq!(series[0]["date"], json!("2026-02-04"));
        assert_eq!(series[6]["date"], json!("2026-02-10"));
        assert!(series
            .iter()
            .all(|p| p["bets"] == json!(0) && p["cumNet"] == json!(0)));

        let row = |a: f64, p: f64, won: bool, at: &str| json!({"amount": a, "payout": p, "won": won, "resolved_at": at, "created_at": at});
        let rows = vec![
            row(10.0, 19.0, true, "2026-02-08T05:00:00.000Z"),
            row(5.0, 0.0, false, "2026-02-09T05:00:00.000Z"),
            row(10.0, 19.0, true, "2026-01-28T05:00:00.000Z"), // outside the window
        ];
        let series = build_daily_series(&rows, 7, now);
        let win_day = series
            .iter()
            .find(|p| p["date"] == json!("2026-02-08"))
            .unwrap();
        let loss_day = series
            .iter()
            .find(|p| p["date"] == json!("2026-02-09"))
            .unwrap();
        assert_eq!(win_day["bets"], json!(1));
        assert_eq!(win_day["net"], json!(9));
        assert_eq!(win_day["cumNet"], json!(9));
        assert_eq!(loss_day["volume"], json!(5));
        assert_eq!(loss_day["net"], json!(-5));
        assert_eq!(loss_day["cumNet"], json!(4));
        // Zero-fill keeps the series at `days` points even with stragglers.
        assert_eq!(build_daily_series(&rows, 0, now).len(), 1);
        assert_eq!(build_daily_series(&rows, 999, now).len(), 365);
    }

    #[test]
    fn stats_aggregate_over_a_real_wallet() {
        let now = parse_date_ms("2026-02-10T12:00:00.000Z").unwrap();
        let stats = aggregate_wallet_stats(&[], "30d", now, Some(STATS_MAX_ROWS));
        assert_eq!(stats["totalBets"], json!(0));
        // Win rate of a wallet with zero settled bets is 0, not NaN.
        assert_eq!(stats["winRate"], json!(0));
        assert_eq!(stats["bestTrade"], Value::Null);
        assert_eq!(stats["worstTrade"], Value::Null);
        assert_eq!(stats["perAsset"], json!([]));
        assert_eq!(stats["series"].as_array().unwrap().len(), 30);
        assert_eq!(stats["truncated"], json!(false));

        let rows = vec![
            json!({"id": "a", "wallet_address": WALLET_LOWER, "asset": "BTC", "amount": 10.0, "payout": 19.0, "won": true, "resolved_at": "2026-02-07T12:00:00.000Z"}),
            json!({"id": "b", "wallet_address": WALLET_LOWER, "asset": "BTC", "amount": 10.0, "payout": 19.0, "won": true, "resolved_at": "2026-02-08T12:00:00.000Z"}),
            json!({"id": "c", "wallet_address": WALLET_LOWER, "asset": "ETH", "amount": 20.0, "payout": 0.0, "won": false, "resolved_at": "2026-02-09T12:00:00.000Z"}),
            json!({"id": "d", "wallet_address": WALLET_LOWER, "asset": "ETH", "amount": 4.0, "payout": 100.0, "won": true, "resolved_at": "2026-02-09T00:00:00.000Z"}),
            json!({"id": "demo-x", "wallet_address": WALLET_LOWER, "asset": "BTC", "amount": 999.0, "payout": 0.0, "won": false, "resolved_at": "2026-02-10T12:00:00.000Z"}),
        ];
        let stats = aggregate_wallet_stats(&rows, "all", now, None);
        assert_eq!(stats["totalBets"], json!(4));
        assert_eq!(stats["volume"], json!(44));
        assert_eq!(stats["netPnl"], json!(94));
        assert_eq!(stats["winRate"], json!(75));
        assert_eq!(stats["longestWinStreak"], json!(3));
        assert_eq!(stats["longestLossStreak"], json!(1));
        assert_eq!(stats["bestTrade"]["asset"], json!("ETH"));
        assert_eq!(stats["bestTrade"]["net"], json!(96));
        assert_eq!(stats["worstTrade"]["net"], json!(-20));
        assert_eq!(stats["worstTrade"]["won"], json!(false));
        let per_asset = stats["perAsset"].as_array().unwrap();
        assert_eq!(per_asset[0]["asset"], json!("ETH"));
        assert_eq!(per_asset[0]["volume"], json!(24));
        assert_eq!(per_asset[0]["winRate"], json!(50));
        assert_eq!(per_asset[0]["netPnl"], json!(76));
        assert_eq!(per_asset[1]["asset"], json!("BTC"));
        assert_eq!(per_asset[1]["volume"], json!(20));
        assert_eq!(per_asset[1]["winRate"], json!(100));

        // Truncation flags the window partial and keeps the most-recent rows.
        let many: Vec<Value> = (0..10)
            .map(|i| json!({"id": format!("r{i}"), "wallet_address": WALLET_LOWER, "amount": 1.0, "payout": 0.0, "won": false, "resolved_at": iso_ms(now - i * 1000)}))
            .collect();
        let stats = aggregate_wallet_stats(&many, "all", now, Some(4));
        assert_eq!(stats["truncated"], json!(true));
        assert_eq!(stats["totalBets"], json!(4));
        assert_eq!(stats["volume"], json!(4));
    }

    #[test]
    fn stats_sorts_unordered_rows_before_streaks() {
        let rows = vec![
            json!({"id": "newest-win", "wallet_address": WALLET_LOWER, "amount": 1.0, "won": true, "resolved_at": "2026-02-10T09:36:00.000Z"}),
            json!({"id": "mid-loss", "wallet_address": WALLET_LOWER, "amount": 1.0, "won": false, "resolved_at": "2026-02-09T12:00:00.000Z"}),
            json!({"id": "oldest-win", "wallet_address": WALLET_LOWER, "amount": 1.0, "won": true, "resolved_at": "2026-02-08T12:00:00.000Z"}),
        ];
        let now = parse_date_ms("2026-02-10T12:00:00.000Z").unwrap();
        let stats = aggregate_wallet_stats(&rows, "30d", now, None);
        // Interleaved input, chronological streaks: 1/1, not 2.
        assert_eq!(stats["longestWinStreak"], json!(1));
        assert_eq!(stats["longestLossStreak"], json!(1));
    }

    #[test]
    fn stats_falls_back_to_created_at_when_unresolved() {
        let now = parse_date_ms("2026-02-10T12:00:00.000Z").unwrap();
        let created_at = iso_ms(now - 17_280_000);
        let rows = vec![
            json!({"id": "c1", "wallet_address": WALLET_LOWER, "amount": 10.0, "payout": 19.0, "won": true, "resolved_at": null, "created_at": created_at}),
        ];
        let stats = aggregate_wallet_stats(&rows, "7d", now, None);
        assert_eq!(stats["bestTrade"]["net"], json!(9));
        assert_eq!(stats["bestTrade"]["at"], json!(created_at));
        // Both timestamps missing -> epoch zero = "not recorded"; the row still
        // aggregates but buckets outside the trailing window.
        let ghost = json!({"id": "g", "wallet_address": WALLET_LOWER, "amount": 1.0, "payout": 0.0, "won": false, "resolved_at": null, "created_at": null});
        assert_eq!(effective_ms(&ghost), 0);
    }

    #[test]
    fn leaderboard_window_and_metric_parsing() {
        assert_eq!(parse_leaderboard_window(Some("today")), Some("today"));
        assert_eq!(parse_leaderboard_window(Some(" 7D ")), Some("7d"));
        assert_eq!(parse_leaderboard_window(Some("ALL")), Some("all"));
        assert_eq!(parse_leaderboard_window(Some("30d")), Some("30d"));
        assert_eq!(parse_leaderboard_window(Some("1y")), None);
        assert_eq!(parse_leaderboard_window(Some("")), None);
        assert_eq!(parse_leaderboard_window(None), None);

        assert_eq!(parse_metric(Some("netPnl")), Some("netPnl"));
        assert_eq!(parse_metric(Some("netpnl")), Some("netPnl"));
        assert_eq!(parse_metric(Some("VOLUME")), Some("volume"));
        assert_eq!(parse_metric(Some("winRate")), Some("winRate"));
        assert_eq!(parse_metric(Some("bets")), Some("bets"));
        assert_eq!(parse_metric(Some("feelings")), None);
        assert_eq!(parse_metric(None), None);
    }

    #[test]
    fn leaderboard_since_boundaries() {
        let now = parse_date_ms("2026-01-15T12:34:56.000Z").unwrap();
        assert_eq!(
            leaderboard_window_start_ms("today", now),
            parse_date_ms("2026-01-15T00:00:00.000Z")
        );
        // "today" stays honest at the boundary: 23:59:59.999Z still maps to midnight.
        let edge = parse_date_ms("2026-01-15T23:59:59.999Z").unwrap();
        assert_eq!(
            leaderboard_window_start_ms("today", edge),
            parse_date_ms("2026-01-15T00:00:00.000Z")
        );
        assert_eq!(
            leaderboard_window_start_ms("7d", now),
            Some(now - 7 * MS_PER_DAY)
        );
        assert_eq!(leaderboard_window_start_ms("all", now), None);
        assert_eq!(resolve_since_ms(Some("all"), None, now), None);
        assert_eq!(
            resolve_since_ms(None, Some(168.0), now),
            Some(now - 168 * 3_600_000)
        );
        assert_eq!(
            resolve_since_ms(None, Some(24.0), now),
            Some(now - 24 * 3_600_000)
        );
        assert_eq!(resolve_since_ms(None, None, now), None);
        assert_eq!(resolve_since_ms(None, Some(f64::NAN), now), None);
        assert_eq!(resolve_since_ms(None, Some(0.0), now), None);
        assert_eq!(resolve_since_ms(None, Some(-5.0), now), None);
        // Absurd legacy windows clamp to five years instead of scanning forever.
        assert_eq!(
            resolve_since_ms(None, Some(1e12), now),
            Some(now - (24.0 * 365.0 * 5.0 * 3_600_000.0) as i64)
        );
        // window wins over timeframeHours — and 'all' still short-circuits.
        assert_eq!(
            resolve_since_ms(Some("7d"), Some(720.0), now),
            Some(now - 7 * MS_PER_DAY)
        );
        assert_eq!(resolve_since_ms(Some("all"), Some(24.0), now), None);
    }

    fn lb_row(wallet: &str, id: &str, amount: f64, payout: f64, won: bool) -> Value {
        json!({
            "id": id, "wallet_address": wallet, "asset": "BTC", "network": "BOT",
            "amount": amount, "payout": payout, "won": won, "created_at": "2026-01-10T00:00:00.000Z"
        })
    }

    #[test]
    fn leaderboard_aggregation_drops_demo_rows_first() {
        let rows = vec![
            lb_row(A, "real-1", 10.0, 100.0, true),
            lb_row(A, "demo-1700000000000", 50.0, 5000.0, true),
            lb_row(B, "DEMO-1", 5.0, 50.0, true),
        ];
        let agg = aggregate_rows(&rows);
        assert_eq!(agg.demo_rows_dropped, 2);
        assert_eq!(agg.real_rows, 1);
        assert_eq!(
            agg.entries
                .iter()
                .map(|e| e.wallet_address.as_str())
                .collect::<Vec<_>>(),
            vec![A]
        );
        assert_eq!(agg.entries[0].net_pnl, 90.0);
        assert_eq!(agg.entries[0].total_bets, 1);
        // The demo stake must not leak into the asset selector either.
        assert_eq!(agg.assets, vec![("BTC".to_string(), 1)]);

        // A whole demo wallet is dropped too, even with a real-looking id.
        let rows = vec![
            lb_row(A, "r1", 10.0, 30.0, true),
            lb_row(
                "0xDEMO11111111111111111111111111111111111",
                "r2",
                10.0,
                1e9,
                true,
            ),
        ];
        let agg = aggregate_rows(&rows);
        assert_eq!(agg.demo_rows_dropped, 1);
        assert_eq!(agg.entries.len(), 1);
        assert_eq!(agg.entries[0].net_pnl, 20.0);
    }

    #[test]
    fn leaderboard_merges_case_variants_and_tallies() {
        let rows = vec![
            json!({"id": "u1", "wallet_address": "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "amount": 10.0, "payout": 0.0, "won": false, "asset": "ETH", "network": "BOT", "created_at": "2026-01-02T00:00:00.000Z"}),
            json!({"id": "u2", "wallet_address": A, "amount": 20.0, "payout": 0.0, "won": false, "asset": "BTC", "network": "ARC", "created_at": "2026-01-09T00:00:00.000Z"}),
        ];
        let agg = aggregate_rows(&rows);
        assert_eq!(agg.entries.len(), 1);
        let e = &agg.entries[0];
        assert_eq!(e.wallet_address, A);
        assert_eq!(e.total_wagered, 30.0);
        assert_eq!(e.net_pnl, -30.0);
        assert_eq!(e.losses, 2);
        assert_eq!(e.last_bet_at.as_deref(), Some("2026-01-09T00:00:00.000Z"));
        // 2-2 ties in both tallies break alphabetically.
        assert_eq!(e.primary_network, "ARC");
        assert_eq!(e.primary_asset, "BTC");

        let full = aggregate_rows(&[
            lb_row(A, "f1", 10.0, 19.0, true),
            lb_row(A, "f2", 10.0, 21.0, true),
            lb_row(A, "f3", 5.0, 0.0, false),
            lb_row(A, "f4", 5.0, 0.0, false),
        ]);
        let e = &full.entries[0];
        assert_eq!((e.total_bets, e.wins, e.losses), (4, 2, 2));
        assert_eq!(
            (e.total_wagered, e.total_payout, e.net_pnl),
            (30.0, 40.0, 10.0)
        );
        assert_eq!(
            e.net_pnl,
            e.total_payout - e.total_wagered,
            "net is payout - wagered"
        );
        assert_eq!(e.total_volume, 30.0);
        assert_eq!(e.win_rate, 50.0);
        assert_eq!(e.primary_network, "BOT");
        assert_eq!(e.primary_asset, "BTC");

        // A row with no wallet is ignored; an empty board is fine.
        assert_eq!(
            aggregate_rows(&[json!({"id": "x", "wallet_address": "  ", "amount": 100.0})])
                .entries
                .len(),
            0
        );
        let empty = aggregate_rows(&[]);
        assert!(empty.entries.is_empty());
        assert_eq!((empty.real_rows, empty.demo_rows_dropped), (0, 0));

        // The asset selector list is busiest first, ties alphabetical.
        let rows = vec![
            lb_row(A, "s1", 1.0, 0.0, false),
            json!({"id": "s2", "wallet_address": B, "amount": 1.0, "won": false, "asset": "ETH", "network": "BOT", "created_at": "2026-01-10T00:00:00.000Z"}),
            json!({"id": "s3", "wallet_address": B, "amount": 1.0, "won": false, "asset": "ETH", "network": "BOT", "created_at": "2026-01-10T00:00:00.000Z"}),
            json!({"id": "s4", "wallet_address": C, "amount": 1.0, "won": false, "asset": "GOLD", "network": "BOT", "created_at": "2026-01-10T00:00:00.000Z"}),
        ];
        assert_eq!(
            aggregate_rows(&rows).assets,
            vec![
                ("ETH".to_string(), 2),
                ("BTC".to_string(), 1),
                ("GOLD".to_string(), 1)
            ]
        );
    }

    #[test]
    fn leaderboard_pnl_math() {
        assert_eq!(
            row_net_pnl(&json!({"won": true, "amount": 10.0, "payout": 19.0})),
            9.0
        );
        assert_eq!(
            row_net_pnl(&json!({"won": false, "amount": 10.0, "payout": 999.0})),
            -10.0
        );
        assert_eq!(
            row_net_pnl(&json!({"won": true, "amount": "2.50", "payout": "4.75"})),
            2.25
        );
        assert_eq!(
            row_net_pnl(&json!({"won": true, "amount": "oops", "payout": "4.75"})),
            4.75
        );
        assert_eq!(
            row_net_pnl(&json!({"won": false, "amount": null, "payout": null})),
            0.0
        );
        assert_eq!(net_pnl_of(100.0, 60.0), 40.0);
        assert_eq!(net_pnl_of(0.0, 25.0), -25.0);
        assert_eq!(net_pnl_of(0.1 + 0.2, 0.3), 0.0);
    }

    fn sample_entries() -> Vec<Entry> {
        let rows = vec![
            lb_row(A, "a1", 10.0, 0.0, false),
            lb_row(B, "b1", 50.0, 90.0, true),
            lb_row(B, "b2", 10.0, 20.0, true),
            lb_row(C, "c1", 80.0, 85.0, true),
            lb_row(C, "c2", 10.0, 0.0, false),
        ];
        aggregate_rows(&rows).entries
    }

    #[test]
    fn leaderboard_ordering_and_tie_breaks() {
        let entries = sample_entries();
        let by = |w: &str| {
            entries
                .iter()
                .find(|e| e.wallet_address == w)
                .unwrap()
                .clone()
        };
        assert_eq!(metric_value(&by(A), "netPnl"), -10.0);
        assert_eq!(metric_value(&by(B), "netPnl"), 50.0);
        assert_eq!(metric_value(&by(C), "volume"), 90.0);
        assert_eq!(metric_value(&by(C), "winRate"), 50.0);
        assert_eq!(metric_value(&by(B), "bets"), 2.0);

        let order = |m: &str| {
            sort_entries(&entries, m)
                .iter()
                .map(|e| e.wallet_address.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(order("netPnl"), vec![B, C, A]);
        assert_eq!(order("volume"), vec![C, B, A]);
        assert_eq!(order("winRate"), vec![B, C, A]);
        // bets metric: B and C tie at 2 bets; netPnl tiebreak puts B (+50) first.
        assert_eq!(order("bets"), vec![B, C, A]);

        // Pure address tie-break when everything else matches.
        let tied_rows = vec![
            json!({"id": "c1", "wallet_address": C, "amount": 10.0, "payout": 0.0, "won": false, "asset": "BTC", "network": "BOT", "created_at": "2026-01-10T00:00:00.000Z"}),
            json!({"id": "b1", "wallet_address": B, "amount": 10.0, "payout": 0.0, "won": false, "asset": "BTC", "network": "BOT", "created_at": "2026-01-10T00:00:00.000Z"}),
        ];
        let tied = sort_entries(&aggregate_rows(&tied_rows).entries, "bets");
        assert_eq!(
            tied.iter()
                .map(|e| e.wallet_address.as_str())
                .collect::<Vec<_>>(),
            vec![B, C]
        );
        assert_eq!(
            sort_entries(&aggregate_rows(&tied_rows).entries, "bets"),
            tied
        );
        assert_eq!(compare_entries(&tied[0], &tied[1], "bets"), Ordering::Less);
    }

    #[test]
    fn leaderboard_rank_lookup() {
        let entries = sample_entries();
        let sorted = sort_entries(&entries, "netPnl");
        let find = |w: &str| {
            sorted
                .iter()
                .find(|e| e.wallet_address == w)
                .unwrap()
                .clone()
        };

        let rank = lookup_rank(&sorted, &find(C), "netPnl");
        assert_eq!(
            (
                rank.rank,
                rank.people_ahead,
                rank.total_ranked,
                rank.next_rank
            ),
            (2, 1, 3, Some(1))
        );
        assert_eq!(rank.next_rank_value, Some(50.0));
        // 50 - (-5) = 55, plus the 0.01 needed to strictly overtake.
        assert!((rank.gap_to_next_rank.unwrap() - 55.01).abs() < 1e-9);
        assert!(!rank.estimated);

        let leader = lookup_rank(&sorted, &find(B), "netPnl");
        assert_eq!(leader.rank, 1);
        assert_eq!(leader.people_ahead, 0);
        assert_eq!(leader.next_rank, None);
        assert_eq!(leader.next_rank_value, None);
        assert_eq!(leader.gap_to_next_rank, None);

        // Outside the returned slice: only the leader was returned.
        let slice = sorted[..1].to_vec();
        let rank = lookup_rank(&slice, &find(A), "netPnl");
        assert!(rank.estimated);
        assert_eq!(
            (
                rank.rank,
                rank.people_ahead,
                rank.total_ranked,
                rank.next_rank_value
            ),
            (2, 1, 1, Some(50.0))
        );

        // An absent wallet others beat is ranked by counting, not guessing.
        let mut outsider = find(A);
        outsider.wallet_address = "0xdddddddddddddddddddddddddddddddddddddddd".to_string();
        outsider.net_pnl = 0.0;
        let rank = lookup_rank(&sorted, &outsider, "netPnl");
        assert_eq!(rank.rank, 2); // only B (+50) beats 0
        assert_eq!(rank.people_ahead, 1);
        assert!(rank.estimated);
        assert_eq!(rank.next_rank_value, Some(50.0));

        // Bet counts use whole-number gaps.
        let sorted_bets = sort_entries(&entries, "bets");
        let rank = lookup_rank(&sorted_bets, &find(A), "bets");
        assert_eq!(rank.rank, 3);
        assert_eq!(rank.gap_to_next_rank, Some(2.0));
    }

    #[test]
    fn wire_formatting_helpers() {
        assert_eq!(truncate_address(A), "0xaaaa…aaaa");
        assert_eq!(truncate_address("short"), "short");
        assert_eq!(truncate_address(""), "");
        assert_eq!(clamp_limit(None), 10);
        assert_eq!(clamp_limit(Some("abc")), 10);
        assert_eq!(clamp_limit(Some("-1")), 10);
        assert_eq!(clamp_limit(Some("0")), 10);
        assert_eq!(clamp_limit(Some("999999")), 100);
        assert_eq!(sanitize_asset(None), "ALL");
        assert_eq!(sanitize_asset(Some("btc")), "BTC");
        assert_eq!(sanitize_asset(Some("usdc ; drop")), "USDCDROP");
        assert_eq!(sanitize_asset(Some("%%%")), "ALL");
        assert_eq!(sanitize_asset(Some(&"A".repeat(30))), "A".repeat(16));
        assert_eq!(
            Entry {
                wallet_address: A.into(),
                total_bets: 1,
                wins: 1,
                losses: 0,
                total_wagered: 10.0,
                total_payout: 30.0,
                net_pnl: 20.0,
                total_volume: 10.0,
                win_rate: 100.0,
                primary_network: "BOT".into(),
                primary_asset: "BTC".into(),
                last_bet_at: None,
            }
            .public_row(1, Some("Alice".into()))["wallet_address"],
            json!("0xaaaa…aaaa")
        );
    }

    #[test]
    fn board_cache_ttl_and_insertion_order_eviction() {
        let snap = |at: i64| Snapshot {
            updated_at: at,
            entries: vec![],
            assets: vec![],
            scanned_rows: 0,
            real_rows: 0,
            demo_rows_dropped: 0,
            truncated: false,
            since_ms: None,
        };
        let mut cache = BoardCache::default();
        cache.insert("a".into(), snap(0));
        assert!(cache.get_fresh("a", LB_CACHE_TTL_MS - 1).is_some());
        assert!(cache.get_fresh("a", LB_CACHE_TTL_MS).is_none());
        assert!(cache.get_fresh("missing", 0).is_none());

        for i in 0..10 {
            cache.insert(cache_key(None, Some(i as f64 + 1.0), "X"), snap(i));
        }
        assert_eq!(cache.len(), LB_MAX_CACHED_BOARDS);
        // Insertion-order eviction: the oldest keys are gone.
        assert!(cache.get(&cache_key(None, Some(1.0), "X")).is_none());
        assert!(cache.get(&cache_key(None, Some(2.0), "X")).is_none());
        assert!(cache.get(&cache_key(None, Some(9.0), "X")).is_some());

        assert_eq!(cache_key(Some("7d"), None, "BTC"), "7d|-|BTC");
        assert_eq!(cache_key(None, None, "ALL"), "-|-|ALL");
        assert_eq!(cache_key(None, Some(720.0), "ALL"), "-|720|ALL");
        assert_eq!(cache_key(None, Some(1.5), "ALL"), "-|1.5|ALL");
    }

    #[test]
    fn meta_block_reports_freshness() {
        let snap = Snapshot {
            updated_at: 1_000,
            entries: vec![],
            assets: vec![],
            scanned_rows: 5000,
            real_rows: 4999,
            demo_rows_dropped: 1,
            truncated: true,
            since_ms: None,
        };
        let meta = meta_block(
            &snap,
            1_000 + LB_CACHE_TTL_MS,
            false,
            vec![("limit".into(), js_i64(10))],
        );
        assert_eq!(meta["since"], Value::Null);
        assert_eq!(meta["scannedRows"], json!(5000));
        assert_eq!(meta["realRows"], json!(4999));
        assert_eq!(meta["demoRowsDropped"], json!(1));
        assert_eq!(meta["truncated"], json!(true));
        assert_eq!(meta["cached"], json!(false));
        assert_eq!(meta["stale"], json!(true));
        assert_eq!(meta["limit"], json!(10));
        assert_eq!(meta["updatedAt"], json!(iso_ms(1_000)));

        let bounded = Snapshot {
            since_ms: Some(1_769_904_000_000),
            ..snap.clone()
        };
        let meta = meta_block(&bounded, 2_000, true, vec![]);
        assert_eq!(meta["since"], json!("2026-02-01T00:00:00.000Z"));
        assert_eq!(meta["cached"], json!(true));
        // Only 1s after the scan, so the board is cached but still fresh.
        assert_eq!(meta["stale"], json!(false));
    }

    #[test]
    fn save_coercions_match_the_ts_defaults() {
        let body = json!({"asset": "", "direction": null, "multiplier": 0, "amount": "10.5xyz", "won": "yes"});
        assert_eq!(save_string_or_default(&body, "asset", "BNB"), "BNB");
        assert_eq!(save_string_or_default(&body, "direction", "UP"), "UP");
        assert_eq!(save_string_or_default(&body, "network", "USDC"), "USDC");
        assert_eq!(save_float_or(&body, "multiplier", 1.9), 1.9); // parseFloat -> 0 is falsy
        assert_eq!(save_float(&body, "amount"), 10.5);
        assert_eq!(save_float(&body, "strikePrice"), 0.0);
        assert_eq!(save_float(&json!({"x": 2}), "x"), 2.0);
        assert!(is_truthy(Some(&json!("yes"))));
        assert!(!is_truthy(Some(&json!(""))));
        assert!(!is_truthy(Some(&json!(0))));
        assert!(!is_truthy(Some(&json!(false))));
        assert!(!is_truthy(None));
    }

    #[test]
    fn proof_num_and_iso() {
        assert_eq!(proof_num(None), None);
        assert_eq!(proof_num(Some(&Value::Null)), None);
        assert_eq!(proof_num(Some(&json!(""))), None);
        assert_eq!(proof_num(Some(&json!("5"))), Some(5.0));
        assert_eq!(proof_num(Some(&json!(9.5))), Some(9.5));
        assert_eq!(proof_num(Some(&json!("12abc"))), None); // Number(), not parseFloat()
        assert_eq!(
            proof_iso(Some(&json!("2023-11-14T22:13:40.000Z"))).as_deref(),
            Some("2023-11-14T22:13:40.000Z")
        );
        assert_eq!(proof_iso(Some(&json!("garbage"))), None);
        assert_eq!(proof_iso(Some(&json!(0))), None); // falsy
        assert_eq!(proof_iso(None), None);
        assert!(is_chain_hash_strict(&format!("0x{}", "a".repeat(64))));
        assert!(!is_chain_hash_strict("INTERNAL"));
        assert!(!is_chain_hash_strict(&format!("lock:0x{}", "a".repeat(64))));
    }
}
