//! Pure logic behind `/api/bets/*`: query-param parsing, row classification,
//! aggregation and JSON formatting.
//!
//! Everything here is side-effect free (no DB, no network, no clock): the
//! handlers pass `now_ms()` explicitly, and tests can pin the clock through
//! `CLOCK_OVERRIDE` or by handing the pure functions their own instant.
//!
//! Wire-shape rules:
//!   * JSON numbers print through `js_num`, so integral floats are `10`, not
//!     `10.0` (JSON.stringify semantics) and non-finite values become `null`;
//!   * `round` implements JS `Math.round` (half toward +infinity) at 6
//!     decimals — Rust's `f64::round` is half-away-from-zero and would drift;
//!   * demo/play-money rows drop out via `is_demo_bet_row` before any
//!     aggregate is computed.

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

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

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

/// JS truthiness on a JSON value.
pub fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
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

    fn params(pairs: &[(&str, &str)]) -> Params {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
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
}
