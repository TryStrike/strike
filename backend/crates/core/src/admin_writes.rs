//! Pure logic behind the admin write routes (withdrawal accept/reject, unban,
//! banned wallets, danger zone) and the error sanitiser. Everything here is
//! offline-testable: the server crate supplies the database and the chain.

use rust_decimal::Decimal;
use serde_json::{Map, Value};

use crate::address::{canonical, is_address_shape, to_checksum};
use crate::bets::{is_demo_bet_row, js_num, to_number, value_to_string};
use crate::crypto::{is_within_accept_window_at, MAX_ACCEPT_INTENT_AGE_MS};
use crate::eth::verify_personal_signature;
use crate::ledger::{floor_to_token, split_fee, Tier};

// ── Request-id guard (`/^\d{1,15}$/` + safe integer) ────────────────────────

/// The accept/reject id guard. Digits only: `Number('1.5')` and `Number('1e9')`
/// are finite but are not request ids, so they must 400 before any query runs.
/// Fifteen digits is always below 2^53-1, so `isSafeInteger` only rejects zero.
pub fn parse_request_id(raw: Option<&str>) -> Option<i64> {
    let digits = raw?.trim();
    if digits.is_empty() || digits.len() > 15 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id: i64 = digits.parse().ok()?;
    (id >= 1).then_some(id)
}

// ── JS number formatting, needed by the signed message ──────────────────────

/// `String(n)` for the template-interpolated `signedAt`: integers print without
/// a fractional part (`1730000000000`, never `1730000000000.0`).
pub fn js_number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        // `-0.0 as i64` is 0, and JS String(-0) is "0"; both collapse here.
        return format!("{}", value as i64);
    }
    format!("{value}")
}

/// `Number.prototype.toFixed(8)` from the signed-intent message. Rounds against
/// the *exact binary value* (u128 mantissa math), which is what JS does, so
/// `1.000000005` prints `1.00000000` (its binary value is below the tie) rather
/// than the shortest-decimal rounding a naive `{:.8}` would give.
pub fn to_fixed8(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    let negative = value < 0.0; // -0.0 is false here, exactly like JS
    let x = value.abs();
    match scale_round_half_up(x) {
        Some(n) => {
            let int = n / 100_000_000;
            let frac = n % 100_000_000;
            format!("{}{int}.{frac:08}", if negative { "-" } else { "" })
        }
        // Values so large the scaled integer overflows u128 cannot be USDC
        // stakes; degrade to the formatting fallback rather than panicking.
        None => format!("{}{:.8}", if negative { "-" } else { "" }, x),
    }
}

/// `floor(x * 1e8 + 0.5)` exactly, via the f64's mantissa/exponent split.
fn scale_round_half_up(x: f64) -> Option<u128> {
    let (mantissa, exponent) = decompose(x);
    if exponent >= 0 {
        let whole = mantissa.checked_shl(exponent as u32)?;
        whole.checked_mul(100_000_000)
    } else {
        let k = (-exponent) as u32;
        if k >= 127 {
            // x * 1e8 < 0.5 for every f64 this deep: JS prints 0.00000000.
            return Some(0);
        }
        let numerator = mantissa.checked_mul(200_000_000)?;
        let half = 1u128 << k;
        Some(numerator.checked_add(half)? >> (k + 1))
    }
}

fn decompose(x: f64) -> (u128, i32) {
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7FF) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    if biased == 0 {
        (frac as u128, -1074)
    } else {
        ((frac | (1u64 << 52)) as u128, biased - 1075)
    }
}

// ── Signed withdrawal intent (accept route re-verification) ─────────────────

/// The message the wallet signed at request time. The accept route rebuilds it
/// per spelling, so a one-byte drift rejects every real signature.
pub fn withdrawal_intent_message(
    spelling: &str,
    amount: f64,
    normalized_currency: &str,
    signed_at: f64,
) -> String {
    format!(
        "Strike withdrawal authorization\naddress:{spelling}\namount:{}\ncurrency:{normalized_currency}\nsignedAt:{}",
        to_fixed8(amount),
        js_number_string(signed_at)
    )
}

/// The spellings the accept route tries: the stored value, plus its EIP-55
/// checksum (the wallet may have signed the checksummed form wagmi handed it).
/// `ethers.getAddress` throws for non-EVM strings, so those keep one spelling.
pub fn signature_spellings(stored: &str) -> Vec<String> {
    let mut spellings = vec![stored.to_string()];
    if is_address_shape(stored) {
        let checksummed = to_checksum(stored);
        if spellings.last().map(String::as_str) != Some(checksummed.as_str()) {
            spellings.push(checksummed);
        }
    }
    spellings
}

/// True when any spelling's rebuilt message recovers a signer whose canonical
/// form is the row's wallet — the exact `some(...)` in the TS accept route.
pub async fn verify_withdrawal_intent(
    stored_address: &str,
    amount: f64,
    normalized_currency: &str,
    signed_at: f64,
    signature: &str,
) -> crate::error::ApiResult<bool> {
    for spelling in signature_spellings(stored_address) {
        let message = withdrawal_intent_message(&spelling, amount, normalized_currency, signed_at);
        if verify_personal_signature(stored_address, &message, signature).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The 400 body when the stored intent has aged out of the acceptance window.
/// `Math.round(MAX_ACCEPT_INTENT_AGE_MS / 60000)` is exactly 10.
pub fn stale_intent_message() -> String {
    format!(
        "Signed withdrawal authorization is older than {} minutes. Ask the user to request the withdrawal again.",
        MAX_ACCEPT_INTENT_AGE_MS / 60_000
    )
}

/// `isAuthorizationWithinAcceptWindow` re-exported so this module owns every
/// gate the accept route applies.
pub fn within_accept_window(now_ms: i64, signed_at_ms: i64) -> bool {
    is_within_accept_window_at(now_ms, signed_at_ms)
}

// ── Platform fee ────────────────────────────────

/// `executeTreasuryWithdrawal`'s pre-chain arithmetic, in the TS order:
/// currency gate, fee source, then the net-must-be-positive gate. The error
/// strings are what land in the NEEDS_RECONCILIATION note, not the response.
/// Returns `(fee, net)` summing to `amount`, with the net payable on-chain: the
/// stored fee picks the net, floored to the token, and the fee is the remainder,
/// so a row queued with an unpayable float fee still pays. No stored fee is the
/// free tier.
pub fn plan_payout(
    currency: &str,
    amount: Decimal,
    fee_override: Option<Decimal>,
) -> Result<(Decimal, Decimal), String> {
    let normalized = currency.to_uppercase();
    if normalized != "USDC" {
        return Err(format!("Unsupported currency for withdrawal: {currency}"));
    }
    let net = match fee_override {
        Some(fee) => floor_to_token(amount - fee),
        None => {
            split_fee(amount, Tier::Free)
                .ok_or("Withdrawal amount is out of range")?
                .1
        }
    };
    if net <= Decimal::ZERO {
        return Err("Withdrawal net amount after fees must be > 0".to_string());
    }
    Ok((amount - net, net))
}

// ── Reconciliation parking ───────────────────────────────────────────────────

/// `NEEDS_RECONCILIATION:${reason}` sliced to 500 UTF-16 code units like JS
/// `.slice(0, 500)`.
pub fn reconciliation_note(reason: &str) -> String {
    take_utf16(&format!("NEEDS_RECONCILIATION:{reason}"), 500)
}

// ── Error sanitising ───────────────────────────────────────────────────────

const MAX_CLIENT_MESSAGE_LENGTH: usize = 220;

/// True when the message may not be echoed to the admin UI: over-long,
/// multi-line, or carrying one of the DB/secrets fingerprints the TS regex list
/// declares. There is no regex crate here, so each pattern is transcribed to a
/// boundary/phrase scan; the example set in the tests pins both directions.
pub fn looks_like_internal_error(message: &str) -> bool {
    if message.is_empty() {
        return true;
    }
    if message.chars().count() > MAX_CLIENT_MESSAGE_LENGTH {
        return true;
    }
    if message.trim().contains(['\r', '\n', '\t']) {
        return true;
    }
    let lower = message.as_bytes().to_vec();
    let lower = ascii_lower(&lower);

    // /\bselect\b[\s\S]*\bfrom\b/i
    if let Some(pos) = find_word(&lower, b"select") {
        if find_word_from(&lower, b"from", pos + 6).is_some() {
            return true;
        }
    }
    // /\binsert\s+into\b/i and /\bdelete\s+from\b/i
    if word_ws_word(&lower, b"insert", b"into") || word_ws_word(&lower, b"delete", b"from") {
        return true;
    }
    // /\bupdate\s+\S+\s+set\b/i
    if word_token_word(&lower, b"update", b"set") {
        return true;
    }
    // Unbounded phrases.
    for phrase in [
        "where clause",
        "syntax error at or near",
        "violates",
        "constraint",
        "foreign key",
        "connection string",
        "connection pool",
        "connection refused",
        "connection timeout",
        "connection lost",
        "connection terminated",
        "econnrefused",
        "econnreset",
        "etimedout",
        "enotfound",
        "apikey",
        "api_key",
        "api key",
        "secret",
        "password",
        "token",
        "node_modules",
        "sqlite",
        "no such table",
        "no such column",
    ] {
        if find_sub(&lower, phrase.as_bytes()).is_some() {
            return true;
        }
    }
    // Word-bounded: postgres, plpgsql, SQL.
    for w in ["postgres", "plpgsql", "sql"] {
        if find_word(&lower, w.as_bytes()).is_some() {
            return true;
        }
    }
    // /\bpg_\b/ — the trailing boundary demands a non-word follower (or end).
    if let Some(pos) = find_sub(&lower, b"pg_") {
        let before_ok = pos == 0 || !is_word_byte(lower[pos - 1]);
        let after_ok = pos + 3 >= lower.len() || !is_word_byte(lower[pos + 3]);
        if before_ok && after_ok {
            return true;
        }
    }
    // /relation\s*["']/i
    if let Some(pos) = find_sub(&lower, b"relation") {
        let mut idx = pos + 8;
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        if idx < lower.len() && (lower[idx] == b'\'' || lower[idx] == b'"') {
            return true;
        }
    }
    // /\bat\s+\S+\s+\(.*:\d+:\d+\)/ — a V8 stack frame.
    if has_stack_frame(&lower) {
        return true;
    }
    // /\{\s*"?(severity|code|detail|hint)"?\s*:/i — raw pg error JSON.
    has_pg_error_json(&lower)
}

/// `sanitizeErrorMessage`: the length/shape gates run against the raw message,
/// so a long SQL fragment cannot sneak through as a "short" message.
pub fn sanitize_error_text(err_text: &str, fallback: &str) -> String {
    let message = err_text.trim();
    if message.is_empty() || looks_like_internal_error(message) {
        return fallback.to_string();
    }
    message.to_string()
}

fn ascii_lower(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| b.to_ascii_lowercase()).collect()
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn find_sub_after(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// First word-bounded (case-insensitive, already-lowered) occurrence at or
/// after `from`.
fn find_word_from(lower: &[u8], word: &[u8], from: usize) -> Option<usize> {
    let mut start = from;
    while let Some(pos) = find_sub_after(lower, word, start) {
        let before_ok = pos == 0 || !is_word_byte(lower[pos - 1]);
        let end = pos + word.len();
        let after_ok = end >= lower.len() || !is_word_byte(lower[end]);
        if before_ok && after_ok {
            return Some(pos);
        }
        start = pos + 1;
    }
    None
}

fn find_word(lower: &[u8], word: &[u8]) -> Option<usize> {
    find_word_from(lower, word, 0)
}

/// `wordA \s+ wordB` with word boundaries on both ends.
fn word_ws_word(lower: &[u8], first: &[u8], second: &[u8]) -> bool {
    let mut start = 0;
    while let Some(pos) = find_word_from(lower, first, start) {
        start = pos + 1;
        let end = pos + first.len();
        let mut idx = end;
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        if idx == end {
            continue;
        }
        if find_word_from(lower, second, idx) == Some(idx) {
            return true;
        }
    }
    false
}

/// `wordA \s+ \S+ \s+ wordB`.
fn word_token_word(lower: &[u8], first: &[u8], second: &[u8]) -> bool {
    let mut start = 0;
    while let Some(pos) = find_word_from(lower, first, start) {
        start = pos + 1;
        let mut idx = pos + first.len();
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        let token_begin = idx;
        while idx < lower.len() && !is_ws(lower[idx]) {
            idx += 1;
        }
        if idx == token_begin {
            continue;
        }
        let ws_begin = idx;
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        if idx == ws_begin {
            continue;
        }
        if find_word_from(lower, second, idx) == Some(idx) {
            return true;
        }
    }
    false
}

fn has_stack_frame(lower: &[u8]) -> bool {
    let mut start = 0;
    while let Some(pos) = find_word_from(lower, b"at", start) {
        start = pos + 2;
        let mut idx = pos + 2;
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        let token_begin = idx;
        while idx < lower.len() && !is_ws(lower[idx]) {
            idx += 1;
        }
        if idx == token_begin {
            continue;
        }
        let ws_begin = idx;
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        if idx == ws_begin {
            continue;
        }
        if idx < lower.len()
            && lower[idx] == b'('
            && colon_digits_colon_digits_close(lower, idx + 1)
        {
            return true;
        }
    }
    false
}

/// `.*:\d+:\d+\)` after an open paren.
fn colon_digits_colon_digits_close(lower: &[u8], from: usize) -> bool {
    let mut i = from;
    while i < lower.len() {
        if lower[i] == b':' {
            let mut a = i + 1;
            while a < lower.len() && lower[a].is_ascii_digit() {
                a += 1;
            }
            if a > i + 1 && a < lower.len() && lower[a] == b':' {
                let mut b = a + 1;
                while b < lower.len() && lower[b].is_ascii_digit() {
                    b += 1;
                }
                if b > a + 1 && b < lower.len() && lower[b] == b')' {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn has_pg_error_json(lower: &[u8]) -> bool {
    let mut start = 0;
    while let Some(rel) = find_sub_after(lower, b"{", start) {
        start = rel + 1;
        let mut idx = rel + 1;
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        let quoted = idx < lower.len() && lower[idx] == b'"';
        if quoted {
            idx += 1;
        }
        let key_len = ["severity", "code", "detail", "hint"]
            .iter()
            .find(|k| lower[idx.min(lower.len())..].starts_with(k.as_bytes()))
            .map(|k| k.len());
        let Some(kl) = key_len else { continue };
        idx += kl;
        if quoted && idx < lower.len() && lower[idx] == b'"' {
            idx += 1;
        }
        while idx < lower.len() && is_ws(lower[idx]) {
            idx += 1;
        }
        if idx < lower.len() && lower[idx] == b':' {
            return true;
        }
    }
    false
}

// ── Danger-zone aggregation ───────────

pub const FREQUENCY_REVIEW_THRESHOLD: i64 = 10;
/// Every scan is bounded and pages of 1000.
pub const SCAN_PAGE: i64 = 1000;
pub const BET_SCAN_CAP: i64 = 20_000;
pub const AUDIT_SCAN_CAP: i64 = 20_000;
pub const PENDING_SCAN_CAP: i64 = 5_000;

/// Win-streak scan: group non-demo bet rows by their *stored* wallet spelling,
/// in first-seen order, and keep the wallets whose longest run of `won`
/// reaches the threshold. `latest` is the first ten results in scan order.
pub fn win_streak_hits(bet_rows: &[Value]) -> Vec<(String, i64, Vec<bool>)> {
    let mut order: Vec<String> = Vec::new();
    let mut results: Vec<Vec<bool>> = Vec::new();
    for row in bet_rows {
        if is_demo_bet_row(row) {
            continue;
        }
        let address = row
            .get("wallet_address")
            .map(value_to_string)
            .unwrap_or_default();
        let won = row.get("won").and_then(Value::as_bool).unwrap_or(false);
        match order.iter().position(|a| *a == address) {
            Some(idx) => results[idx].push(won),
            None => {
                order.push(address);
                results.push(vec![won]);
            }
        }
    }

    let mut hits = Vec::new();
    for (address, flags) in order.into_iter().zip(results) {
        // The TS loop: the current run resets on a loss, the max folds in at
        // each loss and once at the end.
        let (mut current, mut max) = (0i64, 0i64);
        for won in &flags {
            if *won {
                current += 1;
            } else {
                max = max.max(current);
                current = 0;
            }
        }
        max = max.max(current);
        if max >= FREQUENCY_REVIEW_THRESHOLD {
            let latest = flags.iter().take(10).copied().collect();
            hits.push((address, max, latest));
        }
    }
    hits
}

/// `{ ...user_balances row, maxStreak, latestBets }` — the spread order keeps
/// the DB columns first, exactly like the TS object spread.
pub fn suspicious_user_json(balance_row: &Value, max_streak: i64, latest_bets: Vec<bool>) -> Value {
    let mut map = match balance_row.as_object() {
        Some(m) => m.clone(),
        None => Map::new(),
    };
    map.insert("maxStreak".to_string(), Value::Number(max_streak.into()));
    map.insert(
        "latestBets".to_string(),
        Value::Array(latest_bets.into_iter().map(Value::Bool).collect()),
    );
    Value::Object(map)
}

/// Per-wallet withdrawal tallies, keyed by the canonical address, in first-seen
/// order (audit rows first, then pending-only wallets).
#[derive(Debug, Clone)]
pub struct WdStats {
    pub user_address: String,
    pub completed_count: i64,
    pub pending_count: i64,
    pub total_withdrawn: f64,
    pub pending_amount: f64,
    pub pending_requests: Vec<Value>,
    pub currencies: Vec<String>,
}

impl WdStats {
    pub fn empty(user_address: String) -> Self {
        Self {
            user_address,
            completed_count: 0,
            pending_count: 0,
            total_withdrawn: 0.0,
            pending_amount: 0.0,
            pending_requests: Vec::new(),
            currencies: Vec::new(),
        }
    }

    pub fn total_count(&self) -> i64 {
        self.completed_count + self.pending_count
    }

    fn add_currency(&mut self, currency: &str) {
        if !self.currencies.iter().any(|c| c == currency) {
            self.currencies.push(currency.to_string());
        }
    }
}

pub fn aggregate_withdrawal_stats(audit_rows: &[Value], pending_rows: &[Value]) -> Vec<WdStats> {
    fn locate<'a>(stats: &'a mut Vec<WdStats>, key: &str) -> &'a mut WdStats {
        if !stats.iter().any(|s| s.user_address == key) {
            stats.push(WdStats::empty(key.to_string()));
        }
        stats.iter_mut().find(|s| s.user_address == key).unwrap()
    }

    let mut stats: Vec<WdStats> = Vec::new();
    for row in audit_rows {
        let address = row
            .get("user_address")
            .map(value_to_string)
            .unwrap_or_default();
        let key = canonical(&address);
        let entry = locate(&mut stats, &key);
        entry.completed_count += 1;
        entry.total_withdrawn += row.get("amount").map(to_number).unwrap_or(0.0);
        entry.add_currency(&row.get("currency").map(value_to_string).unwrap_or_default());
    }
    for row in pending_rows {
        let address = row
            .get("user_address")
            .map(value_to_string)
            .unwrap_or_default();
        let key = canonical(&address);
        let entry = locate(&mut stats, &key);
        entry.pending_count += 1;
        entry.pending_amount += row.get("amount").map(to_number).unwrap_or(0.0);
        entry.add_currency(&row.get("currency").map(value_to_string).unwrap_or_default());
        entry.pending_requests.push(row.clone());
    }
    stats
}

/// Threshold + exemption filter. `exempt` is the raw env list; the TS helper
/// canonicalises both sides before the membership test, and an empty address is
/// never exempt.
pub fn frequency_review_candidates(stats: Vec<WdStats>, exempt: &[String]) -> Vec<WdStats> {
    let exempt_keys: Vec<String> = exempt.iter().map(|e| canonical(e)).collect();
    stats
        .into_iter()
        .filter(|s| s.total_count() >= FREQUENCY_REVIEW_THRESHOLD)
        // TS: an empty address is never exempt; otherwise it is a canonical
        // membership test against the (already canonical) env list.
        .filter(|s| {
            let key = canonical(&s.user_address);
            !(exempt_keys.contains(&key) && !key.is_empty())
        })
        .collect()
}

/// One frequency-user row, enriched with the deposit/balance queries and
/// `net_pnl = (withdrawn + available) - deposited`, in the TS key order.
pub fn frequency_user_json(
    stats: &WdStats,
    total_deposited: f64,
    total_available_balance: f64,
) -> Value {
    let net_pnl = (stats.total_withdrawn + total_available_balance) - total_deposited;
    let has_flag = stats.pending_requests.iter().any(|r| {
        r.get("decided_by")
            .and_then(Value::as_str)
            .is_some_and(|d| d.starts_with("FREQUENCY_REVIEW"))
    });
    let mut map = Map::new();
    map.insert(
        "user_address".into(),
        Value::String(stats.user_address.clone()),
    );
    map.insert(
        "completed_withdrawals".into(),
        Value::Number(stats.completed_count.into()),
    );
    map.insert(
        "pending_withdrawals".into(),
        Value::Number(stats.pending_count.into()),
    );
    map.insert(
        "total_withdrawals".into(),
        Value::Number(stats.total_count().into()),
    );
    map.insert("total_withdrawn".into(), js_num(stats.total_withdrawn));
    map.insert("pending_amount".into(), js_num(stats.pending_amount));
    map.insert(
        "pending_requests".into(),
        Value::Array(stats.pending_requests.clone()),
    );
    map.insert(
        "currencies".into(),
        Value::Array(
            stats
                .currencies
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    map.insert("total_deposited".into(), js_num(total_deposited));
    map.insert(
        "total_available_balance".into(),
        js_num(total_available_balance),
    );
    map.insert("net_pnl".into(), js_num(net_pnl));
    map.insert("has_frequency_flag".into(), Value::Bool(has_flag));
    // Local sort key; stripped by `sort_frequency_users` before the response.
    map.insert(
        "__sort_total".into(),
        Value::Number(stats.total_count().into()),
    );
    Value::Object(map)
}

/// `frequencyUsers.sort((a, b) => b.total_withdrawals - a.total_withdrawals)` —
/// stable, ties keep the aggregation order.
pub fn sort_frequency_users(users: Vec<Value>) -> Vec<Value> {
    let mut indexed: Vec<(usize, Value)> = users.into_iter().enumerate().collect();
    indexed.sort_by(|(ia, a), (ib, b)| {
        let ta = a.get("__sort_total").and_then(Value::as_i64).unwrap_or(0);
        let tb = b.get("__sort_total").and_then(Value::as_i64).unwrap_or(0);
        tb.cmp(&ta).then(ia.cmp(ib))
    });
    indexed
        .into_iter()
        .map(|(_, mut v)| {
            if let Some(map) = v.as_object_mut() {
                map.remove("__sort_total");
            }
            v
        })
        .collect()
}

/// The danger-zone response body, key order as in the TS route.
pub fn danger_zone_json(suspicious: Vec<Value>, frequency: Vec<Value>, scans: Value) -> Value {
    let mut map = Map::new();
    map.insert("suspiciousUsers".into(), Value::Array(suspicious));
    map.insert("frequencyUsers".into(), Value::Array(frequency));
    map.insert("scans".into(), scans);
    Value::Object(map)
}

pub fn scans_json(bets_truncated: bool, audit_truncated: bool, pending_truncated: bool) -> Value {
    json_like(&[
        ("betsTruncated", Value::Bool(bets_truncated)),
        ("auditTruncated", Value::Bool(audit_truncated)),
        ("pendingTruncated", Value::Bool(pending_truncated)),
        ("betScanCap", Value::Number(BET_SCAN_CAP.into())),
        ("auditScanCap", Value::Number(AUDIT_SCAN_CAP.into())),
        ("pendingScanCap", Value::Number(PENDING_SCAN_CAP.into())),
    ])
}

pub(crate) fn json_like(pairs: &[(&str, Value)]) -> Value {
    Value::Object(Map::from_iter(
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())),
    ))
}

// ── Unban audit rows ─────────────────────────────────────────────────────────

/// One `admin_balance_wipe` audit row per currency whose balance was actually
/// non-zero before the wipe. `amount` is negative: the house took it back.
pub fn wipe_audit_rows(balance_rows: &[Value], ban_key: &str) -> Vec<Value> {
    balance_rows
        .iter()
        .filter(|row| row.get("balance").map(to_number).unwrap_or(0.0) > 0.0)
        .map(|row| {
            let balance = row.get("balance").map(to_number).unwrap_or(0.0);
            json_like(&[
                (
                    "user_address",
                    row.get("user_address").cloned().unwrap_or(Value::Null),
                ),
                (
                    "currency",
                    row.get("currency").cloned().unwrap_or(Value::Null),
                ),
                (
                    "operation_type",
                    Value::String("admin_balance_wipe".to_string()),
                ),
                ("amount", js_num(-balance)),
                (
                    "transaction_hash",
                    Value::String(format!("admin:unban:{ban_key}")),
                ),
            ])
        })
        .collect()
}

/// UTF-16 code-unit length, matching JS `.length` for the 128/500-char gates.
pub fn utf16_len(value: &str) -> usize {
    value
        .chars()
        .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
        .sum()
}

/// `body.walletAddress.length > 128` on the *trimmed* string.
pub fn wallet_address_too_long(trimmed: &str) -> bool {
    utf16_len(trimmed) > 128
}

/// Ban reason default + slice, exactly as the TS POST does: a blank or
/// non-string reason becomes the default text, then 500 code units.
pub fn ban_reason(reason: Option<&Value>) -> String {
    let trimmed = match reason {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => "Banned by administrator".to_string(),
    };
    take_utf16(&trimmed, 500)
}

pub fn take_utf16(value: &str, units: usize) -> String {
    let mut used = 0usize;
    let mut out = String::new();
    for ch in value.chars() {
        let cost = if (ch as u32) > 0xFFFF { 2 } else { 1 };
        if used + cost > units {
            break;
        }
        used += cost;
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::is_demo_wallet_address;
    use serde_json::json;

    #[test]
    fn request_ids_are_digits_only_and_at_least_one() {
        assert_eq!(parse_request_id(Some("7")), Some(7));
        assert_eq!(
            parse_request_id(Some(" 7 ")),
            Some(7),
            "trim before the digit gate"
        );
        assert_eq!(
            parse_request_id(Some("000000000000001")),
            Some(1),
            "leading zeros are still digits"
        );
        for bad in [
            "",
            "0",
            "-1",
            "1.5",
            "1e9",
            "abc",
            "12 34",
            "١٢",
            &"1".repeat(16),
        ] {
            assert_eq!(parse_request_id(Some(bad)), None, "{bad:?} must 400");
        }
        assert_eq!(parse_request_id(None), None);
        // 15 digits is inside 2^53, so the safe-integer gate is the >=1 check.
        assert_eq!(
            parse_request_id(Some(&"9".repeat(15))),
            Some(999_999_999_999_999)
        );
    }

    #[test]
    fn the_withdrawal_intent_message_is_the_exact_signed_bytes() {
        // Pinned from the TS route's template literal; the parity harness must
        // keep this byte-identical or every admin accept fails with 401.
        assert_eq!(
            withdrawal_intent_message("0xAbC123", 1.5, "USDT", 1_788_000_000_000.0),
            "Strike withdrawal authorization\naddress:0xAbC123\namount:1.50000000\ncurrency:USDT\nsignedAt:1788000000000"
        );
        // No stray '.0' on the timestamp, no drift in the fixed amount.
        let msg = withdrawal_intent_message("0xabc", 10.0, "USDC", 1_730_000_000_000.0);
        assert!(!msg.contains("1730000000000.0"));
        assert!(msg.contains("amount:10.00000000"));
    }

    #[test]
    fn spellings_cover_both_casings_of_an_evm_row_and_only_one_otherwise() {
        let lower = "0xd1220a0cf47c7b9be7a2e6ba89f429762b72db5b";
        let spellings = signature_spellings(lower);
        assert_eq!(spellings.len(), 2);
        assert_eq!(spellings[0], lower, "the stored spelling is tried first");
        assert_eq!(spellings[1], "0xd1220A0Cf47c7B9be7A2E6Ba89F429762B72dB5B");
        // Non-EVM values: getAddress would throw, so one spelling stands.
        assert_eq!(
            signature_spellings("privy-ext-42"),
            vec!["privy-ext-42".to_string()]
        );
    }

    #[test]
    fn payout_plan_rejects_in_the_ts_order() {
        let dec = |text: &str| crate::money::parse_decimal(text).unwrap();
        let (ten, one, nine) = (dec("10"), dec("1"), dec("9"));
        assert_eq!(plan_payout("usdc", ten, Some(one)), Ok((one, nine)));
        assert_eq!(
            plan_payout("USDC", ten, None),
            Ok((one, nine)),
            "fee defaults to the free tier"
        );
        // A row queued by the float maths still pays: net floors, fee takes the rest.
        let (fee, net) = plan_payout("USDC", dec("0.57"), Some(dec("0.05699999"))).unwrap();
        assert_eq!((fee, net), (dec("0.057"), dec("0.513")));
        assert!(plan_payout("BTC", ten, None)
            .unwrap_err()
            .starts_with("Unsupported currency for withdrawal: BTC"));
        assert_eq!(
            plan_payout("USDC", dec("0.5"), Some(dec("0.5"))).unwrap_err(),
            "Withdrawal net amount after fees must be > 0"
        );
    }

    #[test]
    fn reconciliation_notes_are_prefixed_and_clamped() {
        assert_eq!(reconciliation_note("boom"), "NEEDS_RECONCILIATION:boom");
        let long = reconciliation_note(&"x".repeat(600));
        assert_eq!(long.chars().count(), 500);
        assert!(long.starts_with("NEEDS_RECONCILIATION:"));
    }

    #[test]
    fn ui_safe_messages_pass_through_and_internals_fall_back() {
        for (raw, fallback, expected) in [
            ("Insufficient balance", "Failed", "Insufficient balance"),
            ("  Account is frozen.  ", "Failed", "Account is frozen."),
        ] {
            assert_eq!(sanitize_error_text(raw, fallback), expected);
        }
        for raw in [
            r#"relation "banned_wallets" does not exist"#,
            "SELECT balance FROM user_balances WHERE id = 3 failed",
            "insert into bet_history violates not-null constraint",
            "UPDATE user_balances set balance = 0",
            "delete from banned_wallets where true",
            "syntax error at or near \"FORM\"",
            "connection timeout reached",
            "ECONNREFUSED 10.0.0.1:5432",
            "    at Object.<anonymous> (/app/node_modules/x/y.js:1:2)",
            r#"{"severity": "ERROR", "code": "42P01"}"#,
            "an unknown pg_ extension blew up",
            "token expired for the session",
            &"x".repeat(221),
            "multi\nline",
        ] {
            assert!(looks_like_internal_error(raw), "leak guard missed: {raw}");
            assert_eq!(
                sanitize_error_text(raw, "Failed to unban wallet"),
                "Failed to unban wallet"
            );
        }
        // Safe-by-construction messages survive.
        for safe in [
            "Insufficient house balance for acceptance",
            "Account is banned.",
            "Failed to load danger zone",
            "Request not found",
        ] {
            assert!(
                !looks_like_internal_error(safe),
                "over-eager leak guard: {safe}"
            );
        }
        assert!(looks_like_internal_error(""), "empty messages fall back");
    }

    #[test]
    fn win_streak_hits_need_ten_in_a_row() {
        let wallet = "0xaaa111111111111111111111111111111111111";
        let mk = |id: &str, won: bool| json!({ "id": id, "wallet_address": wallet, "won": won, "created_at": "2026-01-01T00:00:00.000Z" });
        let nine: Vec<Value> = (0..9).map(|i| mk(&format!("b{i}"), true)).collect();
        assert!(
            win_streak_hits(&nine).is_empty(),
            "nine in a row stays below the threshold"
        );

        let mut ten = nine.clone();
        ten.push(mk("b9", true));
        let hits = win_streak_hits(&ten);
        assert_eq!(hits.len(), 1);
        let (address, max, latest) = &hits[0];
        assert_eq!(address, wallet);
        assert_eq!(*max, 10);
        assert_eq!(latest.len(), 10, "latestBets caps at ten");

        // The run breaks at the loss: 9 + 9 is not an 18-streak.
        let mut broken = vec![mk("b9", false)];
        broken.extend((0..9).map(|i| mk(&format!("w{i}"), true)));
        broken.push(mk("x", false));
        broken.extend((0..9).map(|i| mk(&format!("v{i}"), true)));
        assert!(win_streak_hits(&broken).is_empty());

        // Demo play rows never qualify.
        let demo: Vec<Value> = (0..12).map(|i| mk(&format!("demo-{i}"), true)).collect();
        assert!(win_streak_hits(&demo).is_empty());
    }

    #[test]
    fn withdrawal_stats_aggregate_across_casings_and_currencies() {
        let upper = "0xAbC111111111111111111111111111111111111";
        let lower = "0xabc111111111111111111111111111111111111";
        let audit = vec![
            json!({ "user_address": upper, "currency": "USDC", "amount": 4.0, "created_at": "x" }),
            json!({ "user_address": lower, "currency": "BOT", "amount": 6.0, "created_at": "y" }),
        ];
        let pending = vec![json!({
            "user_address": upper, "currency": "USDC", "amount": 2.0,
            "decided_by": "FREQUENCY_REVIEW:auto", "requested_at": "z", "id": 9, "signed_at": 1
        })];
        let stats = aggregate_withdrawal_stats(&audit, &pending);
        assert_eq!(stats.len(), 1, "canonical key collapses the two spellings");
        let s = &stats[0];
        assert_eq!(s.user_address, lower);
        assert_eq!(
            (s.completed_count, s.pending_count, s.total_count()),
            (2, 1, 3)
        );
        assert_eq!(s.total_withdrawn, 10.0);
        assert_eq!(s.pending_amount, 2.0);
        assert_eq!(
            s.currencies,
            vec!["USDC".to_string(), "BOT".to_string()],
            "insertion order kept"
        );
        assert_eq!(
            s.pending_requests.len(),
            1,
            "the pending row rides along verbatim"
        );
    }

    #[test]
    fn frequency_filter_applies_the_threshold_then_the_exemption() {
        let hot = WdStats {
            completed_count: 7,
            pending_count: 3,
            ..WdStats::empty("0xhot1111111111111111111111111111111111".to_string())
        };
        let cold = WdStats {
            completed_count: 9,
            ..WdStats::empty("0xcold111111111111111111111111111111111".to_string())
        };
        let exempted = WdStats {
            completed_count: 20,
            ..WdStats::empty("0xexempt11111111111111111111111111111111".to_string())
        };
        let kept: Vec<String> = frequency_review_candidates(
            vec![hot, cold, exempted],
            &["0xExempt11111111111111111111111111111111".to_string()],
        )
        .into_iter()
        .map(|s| s.user_address)
        .collect();
        assert_eq!(
            kept,
            vec!["0xhot1111111111111111111111111111111111".to_string()]
        );
    }

    #[test]
    fn frequency_user_rows_carry_pnl_and_the_review_flag() {
        let stats = WdStats {
            completed_count: 8,
            pending_count: 2,
            total_withdrawn: 40.0,
            pending_amount: 5.0,
            pending_requests: vec![json!({ "decided_by": "FREQUENCY_REVIEW:queue" })],
            currencies: vec!["USDC".to_string()],
            user_address: "0xabc111111111111111111111111111111111111".to_string(),
        };
        let row = frequency_user_json(&stats, 100.0, 20.0);
        assert_eq!(
            row["net_pnl"],
            json!(-40),
            "(40 + 20) - 100; JS prints an integer"
        );
        assert_eq!(row["total_withdrawals"], 10);
        assert_eq!(row["has_frequency_flag"], json!(true));
        assert_eq!(row["currencies"], json!(["USDC"]));
        let plain = frequency_user_json(
            &WdStats {
                pending_requests: vec![json!({ "decided_by": "admin" })],
                ..stats
            },
            0.0,
            0.0,
        );
        assert_eq!(plain["has_frequency_flag"], json!(false));
    }

    #[test]
    fn wipe_audit_rows_only_fire_for_positive_balances_and_are_negative() {
        let rows = vec![
            json!({ "user_address": "0xa", "currency": "USDC", "balance": 12.5 }),
            json!({ "user_address": "0xa", "currency": "BOT", "balance": 0.0 }),
            json!({ "user_address": "0xa", "currency": "WETH", "balance": Value::Null }),
            json!({ "user_address": "0xa", "currency": "USDC2", "balance": 1 }),
        ];
        let out = wipe_audit_rows(&rows, "0xa");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["operation_type"], "admin_balance_wipe");
        assert_eq!(out[0]["amount"], -12.5);
        assert_eq!(out[0]["transaction_hash"], "admin:unban:0xa");
        assert_eq!(out[1]["amount"], -1, "integer balances stay integers");
        assert!(wipe_audit_rows(&[], "0xa").is_empty());
    }

    #[test]
    fn ban_gates_use_utf16_lengths_and_the_default_reason() {
        assert!(!wallet_address_too_long(&format!("0x{}", "a".repeat(126))));
        assert!(wallet_address_too_long(&"b".repeat(129)));
        // A surrogate pair is two code units, exactly as JS counts it.
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(ban_reason(None), "Banned by administrator");
        assert_eq!(ban_reason(Some(&json!("   "))), "Banned by administrator");
        assert_eq!(ban_reason(Some(&json!("  fraud  "))), "fraud");
        assert_eq!(
            ban_reason(Some(&json!(42))),
            "Banned by administrator",
            "non-strings default"
        );
        assert_eq!(
            ban_reason(Some(&json!(&"r".repeat(600)))).chars().count(),
            500
        );
    }

    #[test]
    fn accept_window_boundaries_match_the_ts() {
        let now = 1_700_000_000_000;
        assert!(
            within_accept_window(now, now - 10 * 60 * 1000),
            "the boundary is inclusive (<=)"
        );
        assert!(!within_accept_window(now, now - 10 * 60 * 1000 - 1));
        assert!(
            within_accept_window(now, now + 60_000),
            "skewed-ahead signatures get a minute"
        );
        assert!(!within_accept_window(now, now + 60_001));
    }

    #[test]
    fn demo_predicates_are_shared_with_the_bets_module() {
        assert!(is_demo_wallet_address(Some(&json!(
            "0xDEMO11111111111111111111111111111111111"
        ))));
        assert!(!is_demo_wallet_address(Some(&json!("0xabc"))));
    }
}
