//! The admin read family: `/api/admin/{stats,users,transactions,game-history,
//! mode-analytics}` plus `POST /api/admin/users/status`.
//!
//! Port of the six `app/api/admin/**/route.ts` handlers and what they import
//! (`lib/admin/adminError.ts`, `lib/admin/listParams.ts`,
//! `lib/admin/walletAddressVariants.ts`, `lib/wallet/canonicalAddress.ts`,
//! `lib/balance/houseLedgerCurrency.ts`, `lib/admin/computeStats.ts`).
//!
//! Split like `crate::platform_stats`: every decision that does not need a
//! socket is a pure function here (param parsing, clamping, aggregation,
//! projection, the SQL text + typed binds), and the async half is a thin scan
//! that only moves rows. The handlers in
//! `crates/server/src/routes/admin_reads_a.rs` add the guard and the wire shape.
//!
//! Wire discipline inherited from the TS, restated because it is load-bearing:
//!   * **Bind typing.** Each placeholder carries the column's logical type as
//!     `CAST($n AS <type>)` (see [`Binds`] and `crate::db`), which decides how the
//!     value is stored. The types below are the primitive ones of
//!     `crate::schema` for exactly these tables
//!     (`text`, `timestamp with time zone`, `boolean`, `int8` for the paging
//!     window), never a client-supplied string — same convention as
//!     `routes/withdrawals.rs`.
//!   * **Projection.** Admin rows carry wallet addresses, tx hashes, referral
//!     graphs and operator-visible statuses. Rows are re-projected through a
//!     named key list *after* the SELECT, so widening a column list cannot ship
//!     a private column — the `routes/withdrawals.rs` discipline.
//!   * **Numbers.** `NUMERIC(30,10)` reaches us as a JSON number via
//!     `crate::db`, which is what the TS sent too (`pg.types` parser =
//!     `parseFloat`), so `balance` / `amount` / `payout` stay numbers on both
//!     sides. Where the TS *compared* one as a string (`currency`, `network`,
//!     `asset`, `id` are TEXT and were lowercased/uppercased), that happens here
//!     on the JSON string column. No column is read as an exact decimal.
//!   * **Errors.** `adminErrorResponse` logs the cause and echoes
//!     `sanitizeErrorMessage(err, fallback)`, so a UI-safe message survives and
//!     anything SQL/connection/stack-shaped becomes the route's own fallback.
//!     [`sanitize_error_message`] is that function, without a regex engine.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Map, Number, Value};

use crate::address;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::platform_stats::{
    is_demo_bet, js_number, number_or_zero, number_to_json, parse_epoch_ms, truthy, CurrencyStat,
    PlatformStats,
};

// ---------------------------------------------------------------------------
// Constants lifted from the TS
// ---------------------------------------------------------------------------

/// `LIST_DEFAULT_LIMIT` / `LIST_MAX_LIMIT` / `LIST_MAX_OFFSET`.
pub const LIST_DEFAULT_LIMIT: i64 = 50;
pub const LIST_MAX_LIMIT: i64 = 200;
pub const LIST_MAX_OFFSET: i64 = 100_000;
/// `LIST_MAX_QUERY_LENGTH`; the rejection fires at twice this raw length.
pub const LIST_MAX_QUERY_LENGTH: usize = 100;
/// `PAGE` / `SCAN_PAGE`: the PostgREST-era row cap every scan walks past.
pub const SCAN_PAGE: i64 = 1_000;
/// `SCAN_CAP` from the game-history account filter: the in-memory ceiling.
pub const SCAN_CAP: usize = 20_000;
/// `MAX_CLIENT_MESSAGE_LENGTH` from adminError.ts.
pub const MAX_CLIENT_MESSAGE_LENGTH: usize = 220;

/// `user_balances` columns the users route reads (and ships).
const BALANCE_SELECT: &str =
    "user_address, currency, balance, status, user_tier, updated_at, created_at";
/// The keys one user row may carry: the seven balance columns, then the four
/// merged fields the dashboard reads. Nothing else reaches the client.
pub const USER_ROW_KEYS: [&str; 11] = [
    "user_address",
    "currency",
    "balance",
    "status",
    "user_tier",
    "updated_at",
    "created_at",
    "tier",
    "username",
    "activity",
    "referral",
];
/// `SELECT_COLUMNS` from the transactions route, verbatim.
const TRANSACTION_SELECT: &str = "id, user_address, currency, operation_type, amount, \
     balance_before, balance_after, transaction_hash, bet_id, created_at";
pub const TRANSACTION_ROW_KEYS: [&str; 10] = [
    "id",
    "user_address",
    "currency",
    "operation_type",
    "amount",
    "balance_before",
    "balance_after",
    "transaction_hash",
    "bet_id",
    "created_at",
];
/// `SELECT_COLUMNS` from the game-history route, verbatim.
const GAME_SELECT: &str = "id, wallet_address, asset, direction, amount, payout, won, mode, \
     network, created_at";
pub const GAME_ROW_KEYS: [&str; 10] = [
    "id",
    "wallet_address",
    "asset",
    "direction",
    "amount",
    "payout",
    "won",
    "mode",
    "network",
    "created_at",
];
/// The mode-analytics read needs the multiplier as well as the payout.
const MODE_ANALYTICS_SELECT: &str = "id, wallet_address, amount, payout, won, mode, network, \
     asset, multiplier";

/// `ALLOWED_STATUSES` from users/status.
pub const ALLOWED_USER_STATUSES: [&str; 3] = ["active", "frozen", "banned"];
/// The `status` enum each route declares to `parseListParams`.
pub const USER_STATUS_VALUES: [&str; 3] = ["active", "frozen", "banned"];
pub const TRANSACTION_STATUS_VALUES: [&str; 2] = ["deposit", "withdrawal"];
pub const GAME_STATUS_VALUES: [&str; 2] = ["won", "lost"];
pub const ACCOUNT_VALUES: [&str; 3] = ["all", "real", "demo"];

// ---------------------------------------------------------------------------
// URLSearchParams (`new URL(request.url).searchParams`)
// ---------------------------------------------------------------------------

/// Decodes a raw query string the way `URLSearchParams` does: `&`-separated
/// pairs split on the *first* `=`, `+` meaning a space, an absent `=` meaning an
/// empty value, empty chunks skipped, invalid percent-escapes left literal.
pub fn url_query_pairs(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for chunk in raw.split('&') {
        if chunk.is_empty() {
            continue;
        }
        let (key, value) = match chunk.split_once('=') {
            Some((k, v)) => (k, v),
            None => (chunk, ""),
        };
        out.push((decode_form(key), decode_form(value)));
    }
    out
}

fn decode_form(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]);
                match hex.ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    // Not a valid escape: `URLSearchParams` keeps it verbatim.
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    // Percent-decoded bytes are UTF-8 in the browser; a broken sequence becomes
    // U+FFFD there and through `from_utf8_lossy` here.
    String::from_utf8_lossy(&out).into_owned()
}

/// `searchParams.get(name)`: the **first** occurrence wins, later duplicates are
/// ignored. A stored `None` means the name was absent (`?? ''` in the parser).
pub fn param<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

// ---------------------------------------------------------------------------
// lib/admin/listParams.ts
// ---------------------------------------------------------------------------

/// `ListParamsOptions`. No route in this family overrides `defaultLimit`, so it
/// is not modelled.
#[derive(Debug, Clone, Copy, Default)]
pub struct ListOptions<'a> {
    pub status_values: Option<&'a [&'a str]>,
    pub extra_enums: &'a [(&'a str, &'a [&'a str])],
}

/// `ParsedListParams`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListParams {
    pub limit: i64,
    pub offset: i64,
    pub q: Option<String>,
    pub status: Option<String>,
    pub currency: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub extras: Vec<(String, String)>,
}

impl ListParams {
    /// `p.extras.account ?? 'all'` and friends.
    pub fn extra(&self, name: &str) -> Option<&str> {
        self.extras
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

impl Default for ListParams {
    fn default() -> Self {
        Self {
            limit: LIST_DEFAULT_LIMIT,
            offset: 0,
            q: None,
            status: None,
            currency: None,
            from: None,
            to: None,
            extras: Vec::new(),
        }
    }
}

/// `parseWholeNumber` — `/^\d+$/` then `Number` then `Number.isSafeInteger`.
/// So `'1.5'`, `'-3'`, `'+5'`, `'0x10'`, `'1e5x'`, `'NaN'` and a 400-digit
/// number are all "invalid", while `'0012'` is a legal 12.
fn parse_whole_number(raw: &str) -> Option<i64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = raw.parse::<f64>().ok()?;
    if !n.is_finite() || n > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as i64)
}

/// `normalizeIso`. Date-only is UTC midnight; full ISO keeps its offset.
///
/// Divergence, deliberate: `Date.parse` also swallows `10/02/2026` and other
/// locale-dependent forms. Those are answered with the same 400 text the TS
/// gives a genuinely unparseable value, because a silently mis-read bound on an
/// admin audit filter is worse than a refusal.
fn normalize_iso(raw: &str, name: &str) -> Result<String, String> {
    let date_only = raw.len() == 10
        && raw.as_bytes()[4] == b'-'
        && raw.as_bytes()[7] == b'-'
        && raw.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    let candidate = if date_only {
        format!("{raw}T00:00:00Z")
    } else {
        raw.to_string()
    };
    match parse_iso_ms(&candidate) {
        Some(ms) => Ok(crate::bets::iso_ms(ms)),
        None => Err(format!("Invalid {name} (expected an ISO date)")),
    }
}

/// The ISO shapes [`normalize_iso`] accepts.
fn parse_iso_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt.and_utc().timestamp_millis());
        }
    }
    None
}

/// `sanitizeQueryTerm` — commas would split the compiled `OR` clause, so they
/// go, with the control characters; ILIKE wildcards stay because the term is
/// bound as a parameter, never concatenated. Trailing trim, then 100 code units.
pub fn sanitize_query_term(q: &str) -> String {
    let mut out = String::new();
    for ch in q.chars() {
        let code = ch as u32;
        if ch == ',' || code < 32 || code == 127 {
            continue;
        }
        out.push(ch);
    }
    let trimmed = out.trim();
    take_utf16(trimmed, LIST_MAX_QUERY_LENGTH).into_owned()
}

/// `String.prototype.slice(0, n)` counts UTF-16 code units, not bytes.
fn take_utf16(value: &str, max: usize) -> std::borrow::Cow<'_, str> {
    if value.encode_utf16().count() <= max {
        return std::borrow::Cow::Borrowed(value);
    }
    let mut out = String::new();
    let mut units = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    std::borrow::Cow::Owned(out)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `likePattern` — a contains-pattern for the compiled `ILIKE`.
pub fn like_pattern(sanitized_q: &str) -> String {
    format!("%{sanitized_q}%")
}

/// `listRange` — `[offset, offset + limit - 1]`, i.e. the LIMIT/OFFSET window.
pub fn list_range(p: &ListParams) -> (i64, i64) {
    (p.offset, p.offset + p.limit - 1)
}

/// `parseListParams`. `Err(message)` is the 400 body text — client-safe by
/// construction, which is why the routes echo it verbatim.
pub fn parse_list_params(
    pairs: &[(String, String)],
    opts: &ListOptions,
) -> Result<ListParams, String> {
    let mut params = ListParams::default();

    let limit_raw = param(pairs, "limit").unwrap_or("").trim().to_string();
    if !limit_raw.is_empty() {
        let Some(n) = parse_whole_number(&limit_raw) else {
            return Err("Invalid limit (must be a whole number).".to_string());
        };
        if n < 1 {
            return Err("limit must be >= 1.".to_string());
        }
        params.limit = n.min(LIST_MAX_LIMIT);
    }

    let offset_raw = param(pairs, "offset").unwrap_or("").trim().to_string();
    if !offset_raw.is_empty() {
        let Some(n) = parse_whole_number(&offset_raw) else {
            return Err("Invalid offset (must be a whole number).".to_string());
        };
        params.offset = n.min(LIST_MAX_OFFSET);
    }

    let q_raw = param(pairs, "q").unwrap_or("").trim().to_string();
    if !q_raw.is_empty() {
        let q = sanitize_query_term(&q_raw);
        if utf16_len(&q_raw) > LIST_MAX_QUERY_LENGTH * 2 {
            return Err(format!(
                "q is too long (max {LIST_MAX_QUERY_LENGTH} characters)."
            ));
        }
        params.q = if q.is_empty() { None } else { Some(q) };
    }

    let status_raw = param(pairs, "status").unwrap_or("").trim().to_lowercase();
    if !status_raw.is_empty() {
        let allowed = opts.status_values;
        let known = allowed
            .is_some_and(|values| !values.is_empty() && values.contains(&status_raw.as_str()));
        if !known {
            let allowed_text = match allowed {
                Some(values) if !values.is_empty() => {
                    format!(" Allowed: {}.", values.join(", "))
                }
                _ => String::new(),
            };
            return Err(format!("Invalid status: {status_raw}.{allowed_text}"));
        }
        params.status = Some(status_raw);
    }

    let currency_raw = param(pairs, "currency").unwrap_or("").trim().to_string();
    if !currency_raw.is_empty() {
        let ok = currency_raw.len() <= 16
            && currency_raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !ok {
            return Err("Invalid currency (expected a short ticker symbol).".to_string());
        }
        params.currency = Some(currency_raw.to_uppercase());
    }

    let from_raw = param(pairs, "from").unwrap_or("").trim().to_string();
    if !from_raw.is_empty() {
        params.from = Some(normalize_iso(&from_raw, "from")?);
    }

    let to_raw = param(pairs, "to").unwrap_or("").trim().to_string();
    if !to_raw.is_empty() {
        params.to = Some(normalize_iso(&to_raw, "to")?);
    }

    if !from_raw.is_empty()
        && !to_raw.is_empty()
        && params.from.is_some()
        && params.to.is_some()
        && params.to.as_deref() < params.from.as_deref()
    {
        return Err("to must not be earlier than from.".to_string());
    }

    for (name, allowed) in opts.extra_enums {
        let raw = param(pairs, name).unwrap_or("").trim().to_lowercase();
        if raw.is_empty() {
            continue;
        }
        if !allowed.contains(&raw.as_str()) {
            return Err(format!(
                "Invalid {name}: {raw}. Allowed: {}.",
                allowed.join(", ")
            ));
        }
        params.extras.push((name.to_string(), raw));
    }

    Ok(params)
}

// ---------------------------------------------------------------------------
// lib/admin/adminError.ts — the leak filter, without a regex engine
// ---------------------------------------------------------------------------

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Every start index of `needle` as a whole word (`\bneedle\b`, case-insensitive
/// on ASCII, matching JS's `\w`).
fn word_positions(haystack: &str, needle: &str) -> Vec<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    let mut out = Vec::new();
    if n.is_empty() || h.len() < n.len() {
        return out;
    }
    for i in 0..=(h.len() - n.len()) {
        if !h[i..i + n.len()].eq_ignore_ascii_case(n) {
            continue;
        }
        let left_ok = i == 0 || !is_word_byte(h[i - 1]);
        let right_ok = i + n.len() == h.len() || !is_word_byte(h[i + n.len()]);
        if left_ok && right_ok {
            out.push(i);
        }
    }
    out
}

fn has_word(haystack: &str, needle: &str) -> bool {
    !word_positions(haystack, needle).is_empty()
}

/// `\bfirst\b[\s\S]*\bsecond\b` — `second` anywhere at or after `first`.
fn has_word_then(haystack: &str, first: &str, second: &str) -> bool {
    let before = word_positions(haystack, first);
    let after = word_positions(haystack, second);
    before.iter().any(|i| after.iter().any(|j| j >= i))
}

fn skip_ws(haystack: &str, mut idx: usize) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let mut moved = false;
    while idx < bytes.len() && (bytes[idx] as char).is_ascii_whitespace() {
        idx += 1;
        moved = true;
    }
    moved.then_some(idx)
}

fn skip_ws_optional(haystack: &str, mut idx: usize) -> usize {
    let bytes = haystack.as_bytes();
    while idx < bytes.len() && (bytes[idx] as char).is_ascii_whitespace() {
        idx += 1;
    }
    idx
}

/// `word_at(haystack, i)` — `needle` starts exactly at `i` and ends on a word
/// boundary (`\bneedle` at a fixed offset, as the regexes need after `\s+`).
fn word_at(haystack: &str, start: usize, needle: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if start + n.len() > h.len() {
        return false;
    }
    if !h[start..start + n.len()].eq_ignore_ascii_case(n) {
        return false;
    }
    match h.get(start + n.len()) {
        None => true,
        Some(&b) => !is_word_byte(b),
    }
}

/// `\bfirst\s+second\b` (one or more spaces between two word tokens).
fn has_word_space_word(haystack: &str, first: &str, second: &str) -> bool {
    word_positions(haystack, first).into_iter().any(|i| {
        skip_ws(haystack, i + first.len())
            .map(|j| word_at(haystack, j, second))
            .unwrap_or(false)
    })
}

/// `\bupdate\s+\S+\s+set\b`.
fn has_update_set(haystack: &str) -> bool {
    let bytes = haystack.as_bytes();
    word_positions(haystack, "update").into_iter().any(|i| {
        let Some(after_first) = skip_ws(haystack, i + "update".len()) else {
            return false;
        };
        let mut idx = after_first;
        let token_start = idx;
        while idx < bytes.len() && !(bytes[idx] as char).is_ascii_whitespace() {
            idx += 1;
        }
        if idx == token_start {
            return false; // `\S+` needs at least one character
        }
        let Some(after_token) = skip_ws(haystack, idx) else {
            return false;
        };
        word_at(haystack, after_token, "set")
    })
}

/// `connection (?:string|pool|refused|timeout|lost|terminated)`. The regex has
/// no word boundary and exactly one literal space, so a case-insensitive
/// substring test per tail is an exact match.
fn has_connection_shape(haystack: &str) -> bool {
    const TAILS: [&str; 6] = ["string", "pool", "refused", "timeout", "lost", "terminated"];
    let lower = haystack.to_lowercase();
    TAILS
        .iter()
        .any(|tail| lower.contains(&format!("connection {tail}")))
}

/// `/\bat\s+\S+\s+\(.*:\d+:\d+\)/` — a V8 stack frame (case-sensitive, like JS).
fn has_stack_frame(haystack: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0usize;
    while let Some(found) = haystack[from..].find("at ") {
        let start = from + found;
        from = start + 1;
        if start > 0 && is_word_byte(bytes[start - 1]) {
            continue;
        }
        let Some(after_at) = skip_ws(haystack, start + 2) else {
            continue;
        };
        let mut idx = after_at;
        while idx < bytes.len() && !(bytes[idx] as char).is_ascii_whitespace() {
            idx += 1;
        }
        if idx == after_at {
            continue;
        }
        let Some(after_token) = skip_ws(haystack, idx) else {
            continue;
        };
        if bytes.get(after_token) != Some(&b'(') {
            continue;
        }
        if line_ends_with_coords(&haystack[after_token..]) {
            return true;
        }
    }
    false
}

/// The `\(.*:\d+:\d+\)` tail: two colon-separated digit runs before a `)`, on
/// one line (`.` does not cross a newline in JS).
fn line_ends_with_coords(rest: &str) -> bool {
    let Some(line_end) = rest.find('\n') else {
        return ends_with_coords_line(rest);
    };
    ends_with_coords_line(&rest[..line_end])
}

fn ends_with_coords_line(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut end = 0usize;
    while end < bytes.len() {
        if let Some(close) = bytes[end..].iter().position(|b| *b == b')') {
            let window = &line[end..end + close];
            if window.ends_with_digit_pair() {
                return true;
            }
            end += close + 1;
            continue;
        }
        break;
    }
    false
}

trait DigitPair {
    fn ends_with_digit_pair(&self) -> bool;
}

impl DigitPair for str {
    /// `.*:\d+:\d+` — the last two colon-separated runs are both all digits.
    fn ends_with_digit_pair(&self) -> bool {
        let parts: Vec<&str> = self.rsplitn(3, ':').collect();
        parts.len() == 3
            && !parts[0].is_empty()
            && parts[0].bytes().all(|b| b.is_ascii_digit())
            && parts[1]
                .bytes()
                .all(|b| !b.is_ascii_whitespace() && !(b as char).is_ascii_whitespace())
            && !parts[1].is_empty()
    }
}

/// `/\{\s*"?(severity|code|detail|hint)"?\s*:/i` — a raw pg error object.
fn has_pg_error_json(haystack: &str) -> bool {
    const KEYS: [&str; 4] = ["severity", "code", "detail", "hint"];
    let lower = haystack.to_lowercase();
    let bytes = lower.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'{' {
            continue;
        }
        let mut idx = skip_ws_optional(&lower, i + 1);
        let quoted = matches!(bytes.get(idx), Some(b'"'));
        if quoted {
            idx += 1;
        }
        let name_start = idx;
        if !KEYS.iter().any(|key| {
            let end = name_start + key.len();
            end <= bytes.len() && lower[name_start..end].eq_ignore_ascii_case(key)
        }) {
            continue;
        }
        idx += KEYS
            .iter()
            .find(|key| {
                let end = name_start + key.len();
                end <= bytes.len() && lower[name_start..end].eq_ignore_ascii_case(key)
            })
            .map(|k| k.len())
            .unwrap_or(0);
        idx = skip_ws_optional(&lower, idx);
        if matches!(bytes.get(idx), Some(b'"')) && quoted {
            idx += 1;
            idx = skip_ws_optional(&lower, idx);
        }
        if matches!(bytes.get(idx), Some(b':')) {
            return true;
        }
    }
    false
}

/// `looksLikeInternalError(message)`.
pub fn looks_like_internal_error(message: &str) -> bool {
    if message.is_empty() {
        return true;
    }
    if utf16_len(message) > MAX_CLIENT_MESSAGE_LENGTH {
        return true;
    }
    if message
        .trim()
        .chars()
        .any(|c| matches!(c, '\r' | '\n' | '\t'))
    {
        return true;
    }
    has_word_then(message, "select", "from")
        || has_word_space_word(message, "insert", "into")
        || has_update_set(message)
        || has_word_space_word(message, "delete", "from")
        || has_word_space_word(message, "where", "clause")
        || contains_ci(message, "syntax error at or near")
        || has_relation_quote(message)
        || contains_ci(message, "permission denied for")
        || contains_ci(message, "violates")
        || contains_ci(message, "constraint")
        || contains_ci(message, "foreign key")
        || has_word(message, "postgres")
        || has_word(message, "pg_")
        || has_word(message, "plpgsql")
        || has_word(message, "SQL")
        || has_connection_shape(message)
        || contains_ci(message, "ECONNREFUSED")
        || contains_ci(message, "ECONNRESET")
        || contains_ci(message, "ETIMEDOUT")
        || contains_ci(message, "ENOTFOUND")
        || contains_ci(message, "DATABASE_URL")
        || contains_ci(message, "SUPABASE_SERVICE")
        || contains_ci(message, "API_KEY")
        || contains_ci(message, "APIKEY")
        || contains_ci(message, "API KEY")
        || contains_ci(message, "SECRET")
        || contains_ci(message, "PASSWORD")
        || contains_ci(message, "TOKEN")
        || has_stack_frame(message)
        || message.contains("node_modules")
        || message.contains("sqlite")
        || message.contains("no such table")
        || message.contains("no such column")
        || has_pg_error_json(message)
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// `/relation\s*["']/i` — no word boundary, so `relations"x` matches too.
fn has_relation_quote(message: &str) -> bool {
    let lower = message.to_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0usize;
    while let Some(found) = lower[from..].find("relation") {
        let start = from + found;
        from = start + 1;
        let mut idx = skip_ws_optional(&lower, start + "relation".len());
        // `\s*` is ASCII-whitespace-only here; a quote immediately after is fine.
        if idx < bytes.len() && idx == start + "relation".len() {
            idx = skip_ws_optional(&lower, idx);
        }
        if matches!(bytes.get(idx), Some(b'"') | Some(b'\'')) {
            return true;
        }
    }
    false
}

/// `sanitizeErrorMessage(err, fallback)` — the length/shape guards run against
/// the RAW message, so a long SQL fragment cannot sneak in as "short".
pub fn sanitize_error_message(raw: &str, fallback: &str) -> String {
    let message = raw.trim();
    if message.is_empty() || looks_like_internal_error(message) {
        return fallback.to_string();
    }
    message.to_string()
}

/// `{ error: message }`, the one body shape every admin route uses.
pub fn error_body(message: &str) -> Value {
    Value::Object(Map::from_iter([(
        "error".to_string(),
        Value::String(message.to_string()),
    )]))
}

// ---------------------------------------------------------------------------
// Typed binds and prepared statements
// ---------------------------------------------------------------------------

/// Owned bind list for one statement. `push` hands back the `CAST($n AS ty)`
/// fragment to splice into SQL, so the placeholder and the declared type can
/// never disagree, and `db::fetch`'s arity check can never be surprised.
#[derive(Debug, Clone, Default)]
pub struct Binds {
    entries: Vec<(String, Value)>,
}

impl Binds {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, type_name: &str, value: Value) -> String {
        self.entries.push((type_name.to_string(), value));
        let idx = self.entries.len();
        let ty = &self.entries[idx - 1].0;
        format!("CAST(${idx} AS {ty})")
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn refs(&self) -> Vec<(&str, &Value)> {
        self.entries.iter().map(|(t, v)| (t.as_str(), v)).collect()
    }

    /// The first `n` binds, for the COUNT query that shares the WHERE prefix.
    pub fn refs_upto(&self, n: usize) -> Vec<(&str, &Value)> {
        self.entries[..n.min(self.len())]
            .iter()
            .map(|(t, v)| (t.as_str(), v))
            .collect()
    }
}

/// A compiled read: the row statement, an optional exact-count statement over
/// the same filter prefix, and the binds for both.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub sql: String,
    pub count_sql: Option<String>,
    pub binds: Binds,
    /// How many leading binds the WHERE clause alone used.
    pub filter_binds: usize,
}

impl Prepared {
    pub fn row_refs(&self) -> Vec<(&str, &Value)> {
        self.binds.refs()
    }

    pub fn count_refs(&self) -> Vec<(&str, &Value)> {
        self.binds.refs_upto(self.filter_binds)
    }
}

/// `text` — the type of every address, ticker, id and status column below.
const TEXT: &str = "text";
/// `timestamp with time zone` — `created_at` on both audited tables.
const TIMESTAMPTZ: &str = "timestamp with time zone";
const BOOLEAN: &str = "boolean";
/// Paging window type (`int8`/`bigint`), as in `routes/withdrawals.rs`.
const INT8: &str = "int8";

// ---------------------------------------------------------------------------
// /api/admin/stats
// ---------------------------------------------------------------------------

/// The `/api/admin/stats` body: the backward-compatible top-level fields are
/// the demo + real sums, and `revenue` is the same figure as `platformPnL`
/// (both are the house margin), exactly as the TS spells them.
pub fn admin_stats_body(stats: &PlatformStats) -> Value {
    let combined_pnl = stats.demo.platform_pnl + stats.real.platform_pnl;
    let mut map = Map::new();
    map.insert(
        "totalVolume".into(),
        json_number(stats.demo.total_volume + stats.real.total_volume),
    );
    map.insert(
        "totalBets".into(),
        json_count(stats.demo.total_bets as i64 + stats.real.total_bets as i64),
    );
    map.insert(
        "totalUsers".into(),
        json_count(stats.demo.total_users as i64 + stats.real.total_users as i64),
    );
    map.insert("platformPnL".into(), json_number(combined_pnl));
    map.insert("revenue".into(), json_number(combined_pnl));
    map.insert(
        "currencyStats".into(),
        currency_stats_body(&stats.currency_stats),
    );
    map.insert("demo".into(), stats.demo.to_value());
    map.insert("real".into(), stats.real.to_value());
    Value::Object(map)
}

/// `currencyStats`. Duplicated from `platform_stats`' private helper because
/// that module is shared with the public endpoint and is not mine to widen.
pub fn currency_stats_body(stats: &BTreeMap<String, CurrencyStat>) -> Value {
    Value::Object(
        stats
            .iter()
            .map(|(currency, stat)| {
                let mut map = Map::new();
                map.insert("totalBalance".into(), json_number(stat.total_balance));
                map.insert("userCount".into(), json_count(stat.user_count as i64));
                (currency.clone(), Value::Object(map))
            })
            .collect(),
    )
}

/// `Math.round` (half toward +infinity) — Rust's `round` is half away from zero,
/// which would disagree on a negative margin.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    (value + 0.5).floor()
}

fn json_count(value: i64) -> Value {
    Value::Number(Number::from(value))
}

/// A JS number as `JSON.stringify` would write it: an integral double prints
/// without a decimal point (`0`, not `0.0`) and `NaN`/`Infinity` print `null`.
/// serde_json keeps an `f64` as `0.0`, which parses back to the same double in
/// the browser, but the integer form is both byte-faithful and what the
/// dashboard's own sums produce.
pub fn json_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        // `-0.0` folds onto `0`, again like JSON.stringify.
        return Value::Number(Number::from(value as i64));
    }
    number_to_json(value)
}

// ---------------------------------------------------------------------------
// /api/admin/users
// ---------------------------------------------------------------------------

/// `balanceRowKey` — the canonical wallet, the raw ticker, joined.
pub fn balance_row_key(user_address: &Value, currency: &Value) -> String {
    format!(
        "{}::{}",
        canonical_of(user_address),
        currency.as_str().unwrap_or("")
    )
}

/// `canonicalHouseUserAddress(String(x))` for a column that is TEXT in the
/// schema. A `null` becomes the empty string rather than the TypeError the TS
/// would have thrown; no column fed here is nullable.
pub fn canonical_of(value: &Value) -> String {
    match value {
        Value::String(s) => address::canonical(s),
        Value::Null => String::new(),
        other => address::canonical(&crate::bets::value_to_string(other)),
    }
}

/// `userActivity` entries.
#[derive(Debug, Clone, Default)]
pub struct UserActivity {
    pub total_bets: i64,
    pub total_volume: f64,
    pub wins: i64,
}

impl UserActivity {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("totalBets".into(), json_count(self.total_bets));
        map.insert("totalVolume".into(), json_number(self.total_volume));
        map.insert("wins".into(), json_count(self.wins));
        Value::Object(map)
    }
}

/// The bet aggregate keyed by canonical wallet — every currency row of one
/// wallet therefore shows the same activity block, as the TS did.
///
/// Demo bets (`demo-…` ids or `0xdemo…` wallets) are excluded: this is the
/// real-money column of the users table.
pub fn aggregate_user_activity(bets: &[Value]) -> HashMap<String, UserActivity> {
    let mut acc: HashMap<String, UserActivity> = HashMap::new();
    for row in bets.iter().filter(|b| !is_demo_bet(b)) {
        let key = canonical_of(row.get("wallet_address").unwrap_or(&Value::Null));
        let entry = acc.entry(key).or_default();
        entry.total_bets += 1;
        entry.total_volume += number_or_zero(row.get("amount"));
        if truthy(row.get("won")) {
            entry.wins += 1;
        }
    }
    acc
}

/// `resolveHouseLedgerCurrency`: Arc settles in native USDC, so the ledger row
/// is chosen by the selected asset alone and anything unrecognised falls back
/// to USDC rather than to a currency the treasury cannot pay.
///
/// `Err(())` models the TS `(x || '').toUpperCase()` TypeError a non-string,
/// non-null asset would have thrown (caught by the route as a 500).
/// `bet_history.asset` is `TEXT NOT NULL`, so it is unreachable in practice.
#[allow(clippy::result_unit_err)]
pub fn resolve_house_ledger_currency(selected_currency: Option<&Value>) -> Result<String, ()> {
    const PLAYABLE: [&str; 1] = ["USDC"];
    let selected = match selected_currency {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.to_uppercase(),
        Some(_) => return Err(()),
    };
    Ok(if PLAYABLE.contains(&selected.as_str()) {
        selected
    } else {
        "USDC".to_string()
    })
}

/// `syntheticFromBets`: wallets that bet on an `(address, currency)` pair with
/// no `user_balances` row yet appear as zero balances, so the list is not
/// limited to people who have already deposited.
pub fn synthetic_balance_rows(
    balances: &[Value],
    bets: &[Value],
    now_iso: &str,
) -> ApiResult<Vec<Value>> {
    let mut seen: HashSet<String> = balances
        .iter()
        .map(|b| {
            balance_row_key(
                b.get("user_address").unwrap_or(&Value::Null),
                b.get("currency").unwrap_or(&Value::Null),
            )
        })
        .collect();
    let mut out = Vec::new();
    for row in bets.iter().filter(|b| !is_demo_bet(b)) {
        let wallet = canonical_of(row.get("wallet_address").unwrap_or(&Value::Null));
        let currency = resolve_house_ledger_currency(row.get("asset")).map_err(|_| {
            ApiError::Other("selectedCurrency.toUpperCase is not a function".into())
        })?;
        let key = format!("{wallet}::{currency}");
        if !seen.insert(key) {
            continue;
        }
        let mut synth = Map::new();
        synth.insert("user_address".into(), Value::String(wallet));
        synth.insert("currency".into(), Value::String(currency));
        synth.insert("balance".into(), json_count(0));
        synth.insert("status".into(), Value::String("active".into()));
        synth.insert("user_tier".into(), Value::String("free".into()));
        synth.insert("updated_at".into(), Value::String(now_iso.to_string()));
        synth.insert("created_at".into(), Value::String(now_iso.to_string()));
        out.push(Value::Object(synth));
    }
    Ok(out)
}

/// The merge half of the route: balance rows (real plus synthetic) plus the
/// activity, referral and profile lookups, in the deterministic order the TS
/// sorted into.
///
/// The shipped `user_address` is the row's stored spelling, *not* the canonical
/// one, because the TS spread `...b`.
pub fn build_user_rows(
    balances: &[Value],
    bets: &[Value],
    referrals: &[Value],
    profiles: &[Value],
    now_iso: &str,
) -> ApiResult<Vec<Value>> {
    let activity = aggregate_user_activity(bets);
    let mut merged: Vec<Value> = Vec::with_capacity(balances.len());
    merged.extend(balances.iter().cloned());
    merged.extend(synthetic_balance_rows(balances, bets, now_iso)?);

    // `referralMap[canonical(addr)] = row` — a duplicate wallet keeps the last
    // row read, which is whatever order Postgres returned them in.
    let mut referral_map: HashMap<String, Value> = HashMap::new();
    for row in referrals {
        referral_map.insert(
            canonical_of(row.get("user_address").unwrap_or(&Value::Null)),
            row.clone(),
        );
    }
    let mut profile_map: HashMap<String, String> = HashMap::new();
    for row in profiles {
        let username = match row.get("username") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        profile_map.insert(
            canonical_of(row.get("user_address").unwrap_or(&Value::Null)),
            username,
        );
    }

    let users: Vec<Value> = merged
        .iter()
        .map(|b| {
            let addr = canonical_of(b.get("user_address").unwrap_or(&Value::Null));
            let mut row = b.as_object().cloned().unwrap_or_default();
            row.insert(
                "tier".into(),
                b.get("user_tier").cloned().unwrap_or(Value::Null),
            );
            // `profileMap[addr] || null` — an empty username is null on the wire.
            let username = profile_map.get(&addr).cloned().unwrap_or_default();
            row.insert(
                "username".into(),
                if username.is_empty() {
                    Value::Null
                } else {
                    Value::String(username)
                },
            );
            row.insert(
                "activity".into(),
                activity
                    .get(&addr)
                    .cloned()
                    .map(|a| a.to_value())
                    .unwrap_or_else(|| UserActivity::default().to_value()),
            );
            let referral = referral_map.get(&addr).cloned().unwrap_or_else(|| {
                let mut fallback = Map::new();
                fallback.insert("referral_code".into(), Value::String("NONE".into()));
                fallback.insert("referral_count".into(), json_count(0));
                Value::Object(fallback)
            });
            row.insert("referral".into(), referral);
            Value::Object(row)
        })
        .collect();

    let mut users = users;
    sort_user_rows(&mut users);
    Ok(users)
}

/// `users.sort(...)`: newest `updated_at` first, then the address ascending.
///
/// `Date.parse(x) || 0` folds an unparsable timestamp onto the epoch, so those
/// rows land at the very bottom. Rows with byte-identical keys (the same wallet,
/// the same instant, two currencies) are left in read order: the TS comparator
/// returns `1` for equal strings, which is not a strict weak ordering, so V8's
/// answer there is not observable enough to copy.
pub fn sort_user_rows(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        let ta = sort_time(a);
        let tb = sort_time(b);
        tb.partial_cmp(&ta)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| js_lt_str(&address_of(a), &address_of(b)))
    });
}

/// JS's `a < b ? -1 : 1` over UTF-16 code units (wallet addresses are ASCII, so
/// this only matters for exotic stored spellings).
fn js_lt_str(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ua = a.encode_utf16();
    let mut ub = b.encode_utf16();
    loop {
        match (ua.next(), ub.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (Some(_), None) => {
                // `a > ''`, so the JS comparator still answers `-1`/`1` and never
                // the `0` a real ordering would give.
                return std::cmp::Ordering::Greater;
            }
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(x), Some(y)) => {
                if x != y {
                    return if x < y {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    };
                }
            }
        }
    }
}

fn sort_time(row: &Value) -> f64 {
    let ms = parse_epoch_ms(row.get("updated_at"));
    if ms.is_finite() {
        ms
    } else {
        0.0
    }
}

fn address_of(row: &Value) -> String {
    row.get("user_address")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `matchesListFilters` — the uniform in-memory filters over aggregated rows.
pub fn matches_list_filters(row: &Value, p: &ListParams) -> bool {
    matches_list_filters_on(row, p, "updated_at")
}

/// The same filters with the time window over `time_field`.
pub fn matches_list_filters_on(row: &Value, p: &ListParams, time_field: &str) -> bool {
    if let Some(q) = &p.q {
        let needle = q.to_lowercase();
        let address = row
            .get("user_address")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let username = match row.get("username") {
            Some(Value::String(s)) => s.to_lowercase(),
            _ => String::new(),
        };
        if !address.contains(&needle) && !username.contains(&needle) {
            return false;
        }
    }
    if let Some(status) = &p.status {
        let row_status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if &row_status != status {
            return false;
        }
    }
    if let Some(currency) = &p.currency {
        let row_currency = row
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_uppercase();
        if &row_currency != currency {
            return false;
        }
    }
    if p.from.is_some() || p.to.is_some() {
        let ts = parse_epoch_ms(row.get(time_field));
        if ts.is_finite() {
            if let Some(from) = &p.from {
                let bound_value = Value::String(from.clone());
                let bound = parse_epoch_ms(Some(&bound_value));
                if ts < bound {
                    return false;
                }
            }
            if let Some(to) = &p.to {
                let bound_value = Value::String(to.clone());
                let bound = parse_epoch_ms(Some(&bound_value));
                if ts > bound {
                    return false;
                }
            }
        } else {
            // A row whose timestamp cannot be read cannot be placed in the
            // window, so a bounded query drops it — as the TS did.
            return false;
        }
    }
    true
}

/// `?referrers=1` narrows to wallets actually holding a referral code, so the
/// Referrals tab pages server-side instead of post-slicing a page.
pub fn filter_referrers(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .filter(|u| {
            let code = u
                .get("referral")
                .and_then(|r| r.get("referral_code"))
                .and_then(Value::as_str)
                .unwrap_or("");
            !code.is_empty() && code != "NONE"
        })
        .collect()
}

/// `filtered.slice(p.offset, p.offset + p.limit)`.
pub fn page_slice<T>(items: Vec<T>, offset: i64, limit: i64) -> Vec<T> {
    let skip = offset.max(0) as usize;
    let take = limit.max(0) as usize;
    items.into_iter().skip(skip).take(take).collect()
}

/// The users page, already projected through [`USER_ROW_KEYS`].
pub struct UsersPage {
    pub users: Vec<Value>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

impl UsersPage {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("users".into(), Value::Array(self.users.clone()));
        map.insert("total".into(), json_count(self.total));
        map.insert("limit".into(), json_count(self.limit));
        map.insert("offset".into(), json_count(self.offset));
        Value::Object(map)
    }
}

/// The pure half of the route over source rows. `now_iso` is the caller's clock
/// in `new Date().toISOString()` form, so synthetic rows are testable offline.
pub fn users_page(
    balances: &[Value],
    bets: &[Value],
    referrals: &[Value],
    profiles: &[Value],
    p: &ListParams,
    now_iso: &str,
) -> ApiResult<UsersPage> {
    let rows = build_user_rows(balances, bets, referrals, profiles, now_iso)?;
    let filtered: Vec<Value> = rows
        .into_iter()
        .filter(|row| matches_list_filters(row, p))
        .collect();
    let filtered = if p.extra("referrers") == Some("1") {
        filter_referrers(filtered)
    } else {
        filtered
    };
    let total = filtered.len() as i64;
    let users = page_slice(filtered, p.offset, p.limit)
        .into_iter()
        .map(|row| project_row(&row, &USER_ROW_KEYS))
        .collect();
    Ok(UsersPage {
        users,
        total,
        limit: p.limit,
        offset: p.offset,
    })
}

/// The whitelisted projection: only these keys ship, absent columns become
/// JSON null rather than a missing key (the SELECT decided the shape; this is
/// the belt-and-braces half, so a widened column list cannot leak a wallet note
/// or a payout detail).
pub fn project_row(row: &Value, keys: &[&str]) -> Value {
    let mut map = Map::new();
    for key in keys {
        let value = match row.get(*key) {
            None | Some(Value::Null) => Value::Null,
            Some(value) => value.clone(),
        };
        map.insert((*key).to_string(), value);
    }
    Value::Object(map)
}

pub fn project_rows(rows: &[Value], keys: &[&str]) -> Vec<Value> {
    rows.iter().map(|row| project_row(row, keys)).collect()
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/status
// ---------------------------------------------------------------------------

/// The three rejections this route can answer before touching the database, in
/// the TS's check order. The strings are the exact 400 bodies.
pub const MISSING_ADDRESS_OR_STATUS: &str = "Missing userAddress or status";
pub const ADDRESS_TOO_LONG: &str = "userAddress is too long";
pub const INVALID_STATUS: &str = "Invalid status";
pub const INVALID_ADDRESS: &str = "Invalid wallet address";
pub const INVALID_JSON_BODY: &str = "Invalid JSON body.";

/// Validates the JSON body and yields `(variants, status)` to apply.
///
/// `userAddress` must be a *string* (a number is a 400, not a coercion) and is
/// measured after trimming; the enum check runs before any DB round-trip so an
/// unknown status is a 400 and never a 500.
pub fn validate_status_request(body: &Value) -> Result<(Vec<String>, String), &'static str> {
    let address = match body.get("userAddress") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
        _ => return Err(MISSING_ADDRESS_OR_STATUS),
    };
    if utf16_len(address.trim()) > 128 {
        return Err(ADDRESS_TOO_LONG);
    }
    let status = match body.get("status") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(MISSING_ADDRESS_OR_STATUS),
    };
    if !ALLOWED_USER_STATUSES.contains(&status.as_str()) {
        return Err(INVALID_STATUS);
    }
    let variants = address::search_variants(&address);
    if variants.is_empty() {
        return Err(INVALID_ADDRESS);
    }
    Ok((variants, status))
}

/// `UPDATE user_balances SET status = … WHERE user_address IN (…)` — the shape
/// the TS's `.update({status}).in('user_address', variants)` compiled to.
///
/// Deliberately *not* re-projected: it returns no rows at all (`.update()`
/// without `.select()` yields `data: null`), so only the affected count comes
/// back and the route answers `{success:true, status}` whatever it is — a
/// wallet with no balance row is a silent no-op in the TS too.
pub fn status_update(variants: &[String], status: &str) -> Prepared {
    let mut binds = Binds::new();
    let status_ph = binds.push(TEXT, Value::String(status.to_string()));
    let list: Vec<String> = variants
        .iter()
        .map(|v| binds.push(TEXT, Value::String(v.clone())))
        .collect();
    // An empty list would be `IN ()`, which Postgres rejects as a syntax error;
    // `IN (NULL)` is valid and matches nothing. The route cannot reach this (an
    // empty variant list is a 400 before the update), so it is a guard rail.
    let guard = if list.is_empty() {
        "NULL".to_string()
    } else {
        list.join(", ")
    };
    let sql =
        format!("UPDATE user_balances SET status = {status_ph} WHERE user_address IN ({guard})");
    Prepared {
        sql,
        count_sql: None,
        binds,
        filter_binds: 0,
    }
}

// ---------------------------------------------------------------------------
// GET /api/admin/transactions
// ---------------------------------------------------------------------------

/// The deposit/withdrawal audit list, filtered and paged in SQL like the TS's
/// query builder. The `.in('operation_type', [...])` guard is always present, so
/// an admin query can never read a `bet_placed` row's hash.
pub fn transactions_statement(p: &ListParams) -> Prepared {
    let mut binds = Binds::new();
    let mut clauses: Vec<String> = Vec::new();

    let pair: Vec<String> = ["deposit", "withdrawal"]
        .iter()
        .map(|op| binds.push(TEXT, Value::String(op.to_string())))
        .collect();
    clauses.push(format!("operation_type IN ({})", pair.join(", ")));

    if let Some(status) = &p.status {
        let ph = binds.push(TEXT, Value::String(status.clone()));
        clauses.push(format!("operation_type = {ph}"));
    }
    if let Some(currency) = &p.currency {
        let ph = binds.push(TEXT, Value::String(currency.clone()));
        clauses.push(format!("currency = {ph}"));
    }
    if let Some(q) = &p.q {
        let pattern = Value::String(like_pattern(q));
        let address_ph = binds.push(TEXT, pattern.clone());
        let hash_ph = binds.push(TEXT, pattern);
        clauses.push(format!(
            "(pg_ilike(user_address, {address_ph}) OR pg_ilike(transaction_hash, {hash_ph}))"
        ));
    }
    if let Some(from) = &p.from {
        let ph = binds.push(TIMESTAMPTZ, Value::String(from.clone()));
        clauses.push(format!("created_at >= {ph}"));
    }
    if let Some(to) = &p.to {
        let ph = binds.push(TIMESTAMPTZ, Value::String(to.clone()));
        clauses.push(format!("created_at <= {ph}"));
    }

    let where_sql = format!("WHERE {}", clauses.join(" AND "));
    let filter_binds = binds.len();
    let limit_ph = binds.push(INT8, json_count(p.limit));
    let offset_ph = binds.push(INT8, json_count(p.offset));

    Prepared {
        sql: format!(
            "SELECT {TRANSACTION_SELECT} FROM balance_audit_log {where_sql} \
             ORDER BY created_at DESC, id DESC LIMIT {limit_ph} OFFSET {offset_ph}"
        ),
        count_sql: Some(format!(
            "SELECT COUNT(*) AS count FROM balance_audit_log {where_sql}"
        )),
        binds,
        filter_binds,
    }
}

/// `{transactions, total, limit, offset}` — the dashboard's existing keys plus
/// the paging trio the TS added.
pub fn transactions_body(rows: &[Value], total: i64, p: &ListParams) -> Value {
    let mut map = Map::new();
    map.insert(
        "transactions".into(),
        Value::Array(project_rows(rows, &TRANSACTION_ROW_KEYS)),
    );
    map.insert("total".into(), json_count(total));
    map.insert("limit".into(), json_count(p.limit));
    map.insert("offset".into(), json_count(p.offset));
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// GET /api/admin/game-history
// ---------------------------------------------------------------------------

/// The DB-expressible half of the game-history filters.
fn game_history_clauses(p: &ListParams, binds: &mut Binds) -> Vec<String> {
    let mut clauses: Vec<String> = Vec::new();
    match p.status.as_deref() {
        Some("won") => {
            let ph = binds.push(BOOLEAN, Value::Bool(true));
            clauses.push(format!("won = {ph}"));
        }
        Some("lost") => {
            let ph = binds.push(BOOLEAN, Value::Bool(false));
            clauses.push(format!("won = {ph}"));
        }
        _ => {}
    }
    if let Some(currency) = &p.currency {
        let ph = binds.push(TEXT, Value::String(currency.clone()));
        clauses.push(format!("asset = {ph}"));
    }
    if let Some(q) = &p.q {
        let pattern = Value::String(like_pattern(q));
        let wallet_ph = binds.push(TEXT, pattern.clone());
        let asset_ph = binds.push(TEXT, pattern.clone());
        let id_ph = binds.push(TEXT, pattern);
        clauses.push(format!(
            "(pg_ilike(wallet_address, {wallet_ph}) OR pg_ilike(asset, {asset_ph}) OR pg_ilike(id, {id_ph}))"
        ));
    }
    if let Some(from) = &p.from {
        let ph = binds.push(TIMESTAMPTZ, Value::String(from.clone()));
        clauses.push(format!("created_at >= {ph}"));
    }
    if let Some(to) = &p.to {
        let ph = binds.push(TIMESTAMPTZ, Value::String(to.clone()));
        clauses.push(format!("created_at <= {ph}"));
    }
    clauses
}

/// The `account=all` statement: fully DB-expressible, so it pages with an exact
/// count.
pub fn game_history_page_statement(p: &ListParams) -> Prepared {
    let mut binds = Binds::new();
    let clauses = game_history_clauses(p, &mut binds);
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let filter_binds = binds.len();
    let limit_ph = binds.push(INT8, json_count(p.limit));
    let offset_ph = binds.push(INT8, json_count(p.offset));

    Prepared {
        sql: format!(
            "SELECT {GAME_SELECT} FROM bet_history {where_sql} \
             ORDER BY created_at DESC, id DESC LIMIT {limit_ph} OFFSET {offset_ph}"
        ),
        count_sql: Some(format!(
            "SELECT COUNT(*) AS count FROM bet_history {where_sql}"
        )),
        binds,
        filter_binds,
    }
}

/// One page of the real/demo scan: the same filters, a fixed window, no count.
pub fn game_history_scan_statement(p: &ListParams, from: i64) -> Prepared {
    let mut binds = Binds::new();
    let clauses = game_history_clauses(p, &mut binds);
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let filter_binds = binds.len();
    let page_ph = binds.push(INT8, json_count(SCAN_PAGE));
    let offset_ph = binds.push(INT8, json_count(from));

    Prepared {
        sql: format!(
            "SELECT {GAME_SELECT} FROM bet_history {where_sql} \
             ORDER BY created_at DESC, id DESC LIMIT {page_ph} OFFSET {offset_ph}"
        ),
        count_sql: None,
        binds,
        filter_binds,
    }
}

/// The scan loop's stop rule, factored out of the async walk so the cap is
/// testable: continue while the page was full and the ceiling is not reached.
///
/// `Some(truncated)` stops the loop. `truncated` is true only when the ceiling
/// was hit *by* a full page — that is, rows the filter would have kept may still
/// be waiting past `SCAN_CAP`, which the response reports honestly.
pub fn scan_stop_decision(collected: usize, chunk_len: usize) -> Option<bool> {
    let short_page = (chunk_len as i64) < SCAN_PAGE;
    if short_page || collected >= SCAN_CAP {
        return Some(collected >= SCAN_CAP && chunk_len == SCAN_PAGE as usize);
    }
    None
}

/// The real/demo split over the scanned rows, then the in-memory page.
///
/// The split lives in JS because a bet is play-money when its id starts with
/// `demo-` **or** its wallet is `0xdemo…`; SQL has no cheap equivalent of the
/// second test and the TS route said so in its header comment.
pub fn game_history_account_page(
    collected: &[Value],
    account: &str,
    offset: i64,
    limit: i64,
) -> (i64, Vec<Value>) {
    let wanted = account == "demo";
    let filtered: Vec<Value> = collected
        .iter()
        .filter(|row| is_demo_bet(row) == wanted)
        .cloned()
        .collect();
    let total = filtered.len() as i64;
    (total, page_slice(filtered, offset, limit))
}

/// `{bets, total, limit, offset, account}`, plus `scanTruncated` for the
/// account-filtered branch only — the DB-paged branch cannot truncate.
pub fn game_history_body(
    bets: &[Value],
    total: i64,
    p: &ListParams,
    account: &str,
    truncated: Option<bool>,
) -> Value {
    let mut map = Map::new();
    map.insert(
        "bets".into(),
        Value::Array(project_rows(bets, &GAME_ROW_KEYS)),
    );
    map.insert("total".into(), json_count(total));
    map.insert("limit".into(), json_count(p.limit));
    map.insert("offset".into(), json_count(p.offset));
    map.insert("account".into(), Value::String(account.to_string()));
    if let Some(truncated) = truncated {
        map.insert("scanTruncated".into(), Value::Bool(truncated));
    }
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// GET /api/admin/mode-analytics
// ---------------------------------------------------------------------------

/// `String(b.network || 'UNKNOWN').toUpperCase()` — note `''` is falsy, so a
/// blank chain folds onto UNKNOWN, and this is *case-folded*, unlike the
/// case-sensitive `network_label` the platform stats use.
pub fn chain_label(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "UNKNOWN".to_string(),
        Some(Value::String(s)) if s.is_empty() => "UNKNOWN".to_string(),
        Some(Value::Bool(false)) => "UNKNOWN".to_string(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => "UNKNOWN".to_string(),
        Some(other) => crate::bets::value_to_string(other).to_uppercase(),
    }
}

/// `String(b.asset || 'USDC').toUpperCase()`.
pub fn asset_label(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "USDC".to_string(),
        Some(Value::String(s)) if s.is_empty() => "USDC".to_string(),
        Some(Value::Bool(false)) => "USDC".to_string(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => "USDC".to_string(),
        Some(other) => crate::bets::value_to_string(other).to_uppercase(),
    }
}

/// `(b.mode || 'binomo').toLowerCase()`.
pub fn mode_label(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "binomo".to_string(),
        Some(Value::String(s)) if s.is_empty() => "binomo".to_string(),
        Some(Value::Bool(false)) => "binomo".to_string(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => "binomo".to_string(),
        Some(other) => crate::bets::value_to_string(other).to_lowercase(),
    }
}

/// `MODE_LABELS`.
pub fn mode_display_label(mode: &str) -> &str {
    match mode {
        "binomo" => "Classic (Binomo)",
        "box" => "Box Mode",
        "draw" => "Draw Mode",
        other => other,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChainStat {
    pub total_bets: i64,
    pub wins: i64,
    pub total_wagered: f64,
    pub total_paid_out: f64,
    pub house_pnl: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModeStat {
    pub mode: String,
    pub label: String,
    pub total_bets: i64,
    pub wins: i64,
    pub losses: i64,
    pub win_rate: f64,
    pub total_wagered: f64,
    pub total_paid_out: f64,
    pub house_pnl: f64,
    pub avg_multiplier: f64,
    pub by_chain: Vec<(String, ChainStat)>,
    pub top_assets: Vec<(String, i64)>,
}

impl ModeStat {
    pub fn to_value(&self) -> Value {
        // `byChain` was a JS object: its JSON key order is not part of the
        // contract, so a sorted map is a faithful rendering.
        let chains: Map<String, Value> = self
            .by_chain
            .iter()
            .map(|(chain, stat)| {
                let mut map = Map::new();
                map.insert("totalBets".into(), json_count(stat.total_bets));
                map.insert("wins".into(), json_count(stat.wins));
                map.insert("totalWagered".into(), json_number(stat.total_wagered));
                map.insert("totalPaidOut".into(), json_number(stat.total_paid_out));
                map.insert("housePnL".into(), json_number(stat.house_pnl));
                (chain.clone(), Value::Object(map))
            })
            .collect();
        let assets: Vec<Value> = self
            .top_assets
            .iter()
            .map(|(asset, count)| {
                let mut map = Map::new();
                map.insert("asset".into(), Value::String(asset.clone()));
                map.insert("count".into(), json_count(*count));
                Value::Object(map)
            })
            .collect();

        let mut map = Map::new();
        map.insert("mode".into(), Value::String(self.mode.clone()));
        map.insert("label".into(), Value::String(self.label.clone()));
        map.insert("totalBets".into(), json_count(self.total_bets));
        map.insert("wins".into(), json_count(self.wins));
        map.insert("losses".into(), json_count(self.losses));
        map.insert("winRate".into(), json_number(self.win_rate));
        map.insert("totalWagered".into(), json_number(self.total_wagered));
        map.insert("totalPaidOut".into(), json_number(self.total_paid_out));
        map.insert("housePnL".into(), json_number(self.house_pnl));
        map.insert("avgMultiplier".into(), json_number(self.avg_multiplier));
        map.insert("byChain".into(), Value::Object(chains));
        map.insert("topAssets".into(), Value::Array(assets));
        Value::Object(map)
    }
}

#[derive(Debug, Default, Clone)]
struct ModeAccumulator {
    bets: i64,
    wins: i64,
    wagered: f64,
    paid: f64,
    multiplier_sum: f64,
    /// Insertion-ordered, because `.sort()` on `Object.entries` is stable and
    /// `topAssets` is an array — the wire order of ties is observable.
    chains: Vec<(String, [f64; 4])>,
    assets: Vec<(String, i64)>,
}

/// `computeModes`.
pub fn compute_modes(bets: &[Value]) -> Vec<ModeStat> {
    let mut modes: Vec<(String, ModeAccumulator)> = Vec::new();

    for row in bets {
        let mode = mode_label(row.get("mode"));
        let amount = number_or_zero(row.get("amount"));
        let payout = number_or_zero(row.get("payout"));
        // `Number(b.multiplier ?? 1.9)` — a missing multiplier counts as the
        // classic payout odds, not as zero, so the average stays honest.
        let multiplier = match row.get("multiplier") {
            None | Some(Value::Null) => 1.9,
            Some(value) => js_number(Some(value)),
        };
        let won = truthy(row.get("won"));

        let entry = match modes.iter_mut().find(|(name, _)| name == &mode) {
            Some((_, acc)) => acc,
            None => {
                modes.push((mode, ModeAccumulator::default()));
                &mut modes.last_mut().expect("just pushed").1
            }
        };

        entry.bets += 1;
        if won {
            entry.wins += 1;
        }
        entry.wagered += amount;
        entry.paid += payout;
        entry.multiplier_sum += multiplier;

        let chain = chain_label(row.get("network"));
        let chain_idx = match entry.chains.iter().position(|(name, _)| *name == chain) {
            Some(idx) => idx,
            None => {
                entry.chains.push((chain, [0.0; 4]));
                entry.chains.len() - 1
            }
        };
        let counters = &mut entry.chains[chain_idx].1;
        counters[0] += 1.0;
        if won {
            counters[1] += 1.0;
        }
        counters[2] += amount;
        counters[3] += payout;

        let asset = asset_label(row.get("asset"));
        let asset_idx = match entry.assets.iter().position(|(name, _)| *name == asset) {
            Some(idx) => idx,
            None => {
                entry.assets.push((asset, 0));
                entry.assets.len() - 1
            }
        };
        entry.assets[asset_idx].1 += 1;
    }

    let mut stats: Vec<ModeStat> = modes
        .into_iter()
        .map(|(mode, acc)| {
            let chains = acc
                .chains
                .into_iter()
                .map(|(chain, c)| {
                    (
                        chain,
                        ChainStat {
                            total_bets: c[0] as i64,
                            wins: c[1] as i64,
                            total_wagered: c[2],
                            total_paid_out: c[3],
                            house_pnl: c[2] - c[3],
                        },
                    )
                })
                .collect();
            let mut assets = acc.assets;
            assets.sort_by_key(|asset| std::cmp::Reverse(asset.1));
            let top_assets = assets.into_iter().take(5).collect();
            ModeStat {
                label: mode_display_label(&mode).to_string(),
                total_bets: acc.bets,
                wins: acc.wins,
                losses: acc.bets - acc.wins,
                // `Math.round((wins / bets) * 1000) / 10` — one decimal percent.
                win_rate: if acc.bets > 0 {
                    js_round(acc.wins as f64 / acc.bets as f64 * 1000.0) / 10.0
                } else {
                    0.0
                },
                total_wagered: acc.wagered,
                total_paid_out: acc.paid,
                house_pnl: acc.wagered - acc.paid,
                // `Math.round((sum / bets) * 100) / 100` — two decimals.
                avg_multiplier: if acc.bets > 0 {
                    js_round(acc.multiplier_sum / acc.bets as f64 * 100.0) / 100.0
                } else {
                    0.0
                },
                by_chain: chains,
                top_assets,
                mode,
            }
        })
        .collect();
    // Busiest mode first; V8's stable sort keeps the first-seen order on ties.
    stats.sort_by_key(|stat| std::cmp::Reverse(stat.total_bets));
    stats
}

/// The whole mode-analytics body: three splits over the same scan.
pub fn mode_analytics_body(all: &[Value]) -> Value {
    let real: Vec<Value> = all.iter().filter(|b| !is_demo_bet(b)).cloned().collect();
    let demo: Vec<Value> = all.iter().filter(|b| is_demo_bet(b)).cloned().collect();
    let mut map = Map::new();
    map.insert(
        "real".into(),
        Value::Array(
            compute_modes(&real)
                .iter()
                .map(ModeStat::to_value)
                .collect(),
        ),
    );
    map.insert(
        "demo".into(),
        Value::Array(
            compute_modes(&demo)
                .iter()
                .map(ModeStat::to_value)
                .collect(),
        ),
    );
    map.insert(
        "combined".into(),
        Value::Array(compute_modes(all).iter().map(ModeStat::to_value).collect()),
    );
    map.insert("totalBets".into(), json_count(all.len() as i64));
    map.insert("totalRealBets".into(), json_count(real.len() as i64));
    map.insert("totalDemoBets".into(), json_count(demo.len() as i64));
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// The thin fetch half
// ---------------------------------------------------------------------------

/// Walks a statement a `SCAN_PAGE` window at a time. The TS did the same to get
/// past PostgREST's 1 000-row default; the window is `LIMIT/OFFSET` with typed
/// binds, so no row is missed and none is counted twice.
///
/// `statement` is everything *up to* the window clause (it must carry its own
/// `ORDER BY` if the scan is to be deterministic), and takes no binds — every
/// admin scan here is unfiltered apart from hard-coded literals.
async fn scan_all(statement: &str) -> ApiResult<Vec<Value>> {
    let sql = format!("{statement} LIMIT CAST($1 AS int8) OFFSET CAST($2 AS int8)");
    let mut rows = Vec::new();
    let mut from = 0_i64;
    loop {
        let page = json_count(SCAN_PAGE);
        let offset = json_count(from);
        let chunk = db::fetch(&sql, &[("int8", &page), ("int8", &offset)]).await?;
        let short = (chunk.len() as i64) < SCAN_PAGE;
        rows.extend(chunk);
        if short {
            break;
        }
        from += SCAN_PAGE;
    }
    Ok(rows)
}

async fn run_prepared(prepared: &Prepared) -> ApiResult<(Vec<Value>, i64)> {
    let rows = db::fetch(&prepared.sql, &prepared.row_refs()).await?;
    let total = match &prepared.count_sql {
        Some(count_sql) => db::fetch_one(count_sql, &prepared.count_refs())
            .await?
            .and_then(|row| row.get("count").cloned())
            // `count ?? (data || []).length`
            .and_then(|v| v.as_i64())
            .unwrap_or(rows.len() as i64),
        None => rows.len() as i64,
    };
    Ok((rows, total))
}

/// `computePlatformStats()` + the admin-only sums. The aggregate itself is
/// `platform_stats::aggregate` — one source of truth shared with `/api/stats/public`.
pub async fn load_admin_stats(now_ms: i64) -> ApiResult<Value> {
    let stats = crate::platform_stats::compute(now_ms).await?;
    Ok(admin_stats_body(&stats))
}

/// The five reads the users route issues.
///
/// `user_profiles` errors are swallowed on purpose: the TS destructured only
/// `data` from that query, so a profile failure degrades to "no usernames"
/// instead of a 500. Every other failure is fatal, as it was there.
pub async fn load_users(p: &ListParams, now_ms: i64) -> ApiResult<UsersPage> {
    let balances = scan_all(&format!(
        "SELECT {BALANCE_SELECT} FROM user_balances ORDER BY updated_at DESC"
    ))
    .await?;

    // One unpaginated read: the TS's bet count query has no `.range()`, so the
    // "1000-row default" its comment worries about never applied here.
    let bets = db::fetch(
        "SELECT id, wallet_address, amount, payout, won, network, asset FROM bet_history",
        &[],
    )
    .await?;

    let referrals = db::fetch(
        "SELECT user_address, referral_code, referral_count, referred_by FROM user_referrals",
        &[],
    )
    .await?;

    let profiles = match db::fetch("SELECT user_address, username FROM user_profiles", &[]).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("[admin/users] user_profiles read failed, usernames dropped: {err}");
            Vec::new()
        }
    };

    let now_iso = crate::bets::iso_ms(now_ms);
    users_page(&balances, &bets, &referrals, &profiles, p, &now_iso)
}

pub async fn load_transactions(p: &ListParams) -> ApiResult<Value> {
    let prepared = transactions_statement(p);
    let (rows, total) = run_prepared(&prepared).await?;
    Ok(transactions_body(&rows, total, p))
}

/// The `account=all` read: DB-paged with an exact count.
pub async fn load_game_history_page(p: &ListParams) -> ApiResult<Value> {
    let prepared = game_history_page_statement(p);
    let (rows, total) = run_prepared(&prepared).await?;
    Ok(game_history_body(&rows, total, p, "all", None))
}

/// The `account=real|demo` read: scan the (capped) filtered remainder, split in
/// memory, then slice.
pub async fn load_game_history_account(p: &ListParams, account: &str) -> ApiResult<Value> {
    let mut collected: Vec<Value> = Vec::new();
    let mut from = 0_i64;
    let truncated = loop {
        let prepared = game_history_scan_statement(p, from);
        let chunk = db::fetch(&prepared.sql, &prepared.row_refs()).await?;
        let chunk_len = chunk.len();
        collected.extend(chunk);
        if let Some(decision) = scan_stop_decision(collected.len(), chunk_len) {
            break decision;
        }
        from += SCAN_PAGE;
    };

    let (total, page) = game_history_account_page(&collected, account, p.offset, p.limit);
    Ok(game_history_body(&page, total, p, account, Some(truncated)))
}

/// The mode-analytics scan: every bet, ordered by id so pages cannot overlap.
pub async fn load_mode_analytics() -> ApiResult<Value> {
    let rows = scan_all(&format!(
        "SELECT {MODE_ANALYTICS_SELECT} FROM bet_history ORDER BY id ASC"
    ))
    .await?;
    Ok(mode_analytics_body(&rows))
}

/// `UPDATE … SET status` for the users/status route. Rows affected is returned
/// but, like the TS, never inspected: the route answers success regardless.
pub async fn apply_user_status(variants: &[String], status: &str) -> ApiResult<u64> {
    let prepared = status_update(variants, status);
    db::execute(&prepared.sql, &prepared.row_refs()).await
}

// ---------------------------------------------------------------------------
// Tests — pure only: no database, no network, no clock
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform_stats::ModeStats;
    use serde_json::json;

    fn pairs(query: &[(&str, &str)]) -> Vec<(String, String)> {
        url_query_pairs(
            &query
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("&"),
        )
    }

    fn opts<'a>(
        status: Option<&'a [&'a str]>,
        extras: &'a [(&'a str, &'a [&'a str])],
    ) -> ListOptions<'a> {
        ListOptions {
            status_values: status,
            extra_enums: extras,
        }
    }

    fn parsed(query: &[(&str, &str)], o: &ListOptions) -> ListParams {
        match parse_list_params(&pairs(query), o) {
            Ok(p) => p,
            Err(e) => panic!("expected ok, got {e}"),
        }
    }

    fn rejected(query: &[(&str, &str)], o: &ListOptions) -> String {
        match parse_list_params(&pairs(query), o) {
            Err(e) => e,
            Ok(_) => panic!("expected a validation failure"),
        }
    }

    // -- URLSearchParams ----------------------------------------------------

    #[test]
    fn the_time_window_reads_the_field_it_is_given() {
        let window = ListParams {
            from: Some("2026-01-01T00:00:00.000Z".to_string()),
            ..ListParams::default()
        };
        let row = json!({
            "updated_at": "2020-01-01T00:00:00.000Z",
            "first_deposit_at": "2026-06-01T00:00:00.000Z",
        });
        assert!(!matches_list_filters(&row, &window));
        assert!(matches_list_filters_on(&row, &window, "first_deposit_at"));
        // Never deposited: a bounded range cannot place the row.
        assert!(!matches_list_filters_on(
            &json!({ "first_deposit_at": null }),
            &window,
            "first_deposit_at"
        ));
    }

    #[test]
    fn query_decoding_follows_urlsearchparams() {
        let decoded = url_query_pairs("limit=5&limit=9&q=0xAb%20c&plus=a+b&bare&broken%zz=1&&x=%2");
        let map = decoded
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect::<Vec<_>>();
        // First occurrence wins for a repeated name.
        assert_eq!(param(&decoded, "limit"), Some("5"));
        assert!(map.contains(&("q", "0xAb c")));
        assert!(map.contains(&("plus", "a b")));
        assert!(map.contains(&("bare", "")));
        // An invalid escape survives literally, as the browser keeps it.
        assert!(map.contains(&("broken%zz", "1")));
        assert!(map.contains(&("x", "%2")));
        assert_eq!(param(&decoded, "missing"), None);
    }

    // -- paging -------------------------------------------------------------

    #[test]
    fn defaults_and_caps_match_the_ts() {
        let o = opts(None, &[]);
        let p = parsed(&[], &o);
        assert_eq!((p.limit, p.offset), (50, 0));
        assert_eq!(p.q, None);
        assert_eq!(parsed(&[("limit", "100000")], &o).limit, LIST_MAX_LIMIT);
        assert_eq!(parsed(&[("limit", "200")], &o).limit, 200);
        assert_eq!(parsed(&[("limit", "1")], &o).limit, 1);
        // Clamped, not refused, while still a safe integer.
        assert!(parsed(&[("offset", "999999999999")], &o).offset <= LIST_MAX_OFFSET);
        assert_eq!(
            list_range(&parsed(&[("limit", "25"), ("offset", "50")], &o)),
            (50, 74)
        );
        // Leading zeros are still whole numbers.
        assert_eq!(parsed(&[("limit", "0012")], &o).limit, 12);
    }

    #[test]
    fn non_integer_or_unsafe_paging_input_is_rejected() {
        let o = opts(None, &[]);
        for bad in [
            "NaN",
            "Infinity",
            "-Infinity",
            "1e5x",
            "abc",
            "5.5",
            "-10",
            "%2B5",
            "0x10",
        ] {
            assert!(
                rejected(&[("limit", bad)], &o).contains("limit"),
                "{bad} should be a limit rejection"
            );
        }
        // `?limit=+5` is not a signed number: URLSearchParams decodes the `+` as
        // a space, the TS trims it away and 5 is a whole number. Faithful, not a
        // hole — the digit test runs on the decoded value.
        assert_eq!(parsed(&[("limit", "+5")], &o).limit, 5);
        assert!(rejected(&[("offset", "1.5")], &o).contains("offset"));
        assert!(rejected(&[("offset", "-3")], &o).contains("offset"));
        assert!(rejected(&[("offset", "999999999999999999999999")], &o).contains("offset"));
        // 0 is a whole number but below the minimum.
        assert_eq!(rejected(&[("limit", "0")], &o), "limit must be >= 1.");
        // A blank value counts as absent, exactly like `?? ''` + trim.
        assert_eq!(parsed(&[("limit", "")], &o).limit, LIST_DEFAULT_LIMIT);
        assert_eq!(parsed(&[("limit", "   ")], &o).limit, LIST_DEFAULT_LIMIT);
    }

    #[test]
    fn q_is_sanitized_before_it_can_reach_the_or_clause() {
        let o = opts(None, &[]);
        assert_eq!(
            parsed(&[("q", "  0xAbC123  ")], &o).q.as_deref(),
            Some("0xAbC123")
        );
        assert_eq!(parsed(&[("q", "a,b")], &o).q.as_deref(), Some("ab"));
        assert_eq!(parsed(&[("q", "   ")], &o).q, None);
        assert_eq!(sanitize_query_term("a,b\r(c)d\u{0}e"), "ab(c)de");
        // Over 2x the cap is a refusal; inside it, a truncation.
        assert!(rejected(&[("q", &"x".repeat(250))], &o).contains("q is too long"));
        let long = "y".repeat(150);
        assert_eq!(
            parsed(&[("q", &long)], &o).q.unwrap().len(),
            LIST_MAX_QUERY_LENGTH
        );
        assert_eq!(like_pattern("0xabc"), "%0xabc%");
    }

    #[test]
    fn enums_are_validated_before_sql_and_named_in_the_error() {
        let o = opts(Some(&TRANSACTION_STATUS_VALUES), &[]);
        assert_eq!(
            parsed(&[("status", "DEPOSIT")], &o).status.as_deref(),
            Some("deposit")
        );
        assert_eq!(
            rejected(&[("status", "refunded")], &o),
            "Invalid status: refunded. Allowed: deposit, withdrawal."
        );
        // A route that declares no enum refuses any status rather than 500ing.
        let none = opts(None, &[]);
        assert_eq!(
            rejected(&[("status", "anything")], &none),
            "Invalid status: anything."
        );

        let extras: [&str; 3] = ["all", "real", "demo"];
        let enum_list = [("account", &extras[..])];
        let eo = opts(Some(&GAME_STATUS_VALUES), &enum_list);
        assert_eq!(
            parsed(&[("account", "Real")], &eo).extra("account"),
            Some("real")
        );
        assert_eq!(
            rejected(&[("account", "testnet")], &eo),
            "Invalid account: testnet. Allowed: all, real, demo."
        );
        assert!(parsed(&[("account", "")], &eo).extras.is_empty());
    }

    #[test]
    fn currency_must_be_a_short_ticker() {
        let o = opts(None, &[]);
        assert_eq!(
            parsed(&[("currency", "usdc")], &o).currency.as_deref(),
            Some("USDC")
        );
        for bad in ["USDC; DROP TABLE", "%a%", &"A".repeat(17), "a-b"] {
            assert!(
                rejected(&[("currency", bad)], &o).contains("currency"),
                "{bad} should be rejected"
            );
        }
        assert_eq!(
            parsed(&[("currency", "A_1")], &o).currency.as_deref(),
            Some("A_1")
        );
    }

    #[test]
    fn date_bounds_are_normalized_to_utc_iso_and_ordered() {
        let o = opts(None, &[]);
        assert_eq!(
            parsed(&[("from", "2026-10-01")], &o).from.as_deref(),
            Some("2026-10-01T00:00:00.000Z")
        );
        assert_eq!(
            parsed(&[("to", "2026-10-02T12:30:00Z")], &o).to.as_deref(),
            Some("2026-10-02T12:30:00.000Z")
        );
        assert!(
            rejected(&[("from", "yesterday")], &o).contains("Invalid from (expected an ISO date)")
        );
        assert!(rejected(&[("to", "2026-13-45")], &o).contains("Invalid to"));
        assert_eq!(
            rejected(&[("from", "2026-10-05"), ("to", "2026-10-01")], &o),
            "to must not be earlier than from."
        );
        // An equal bound is allowed (the window is inclusive on both ends).
        assert!(
            parse_list_params(&pairs(&[("from", "2026-10-01"), ("to", "2026-10-01")]), &o).is_ok()
        );
    }

    // -- error sanitizer ---------------------------------------------------

    #[test]
    fn db_and_stack_shaped_messages_never_reach_the_client() {
        let leaks = [
            r#"select "id" from "withdrawal_requests" where status = $1"#,
            r#"relation "user_balances" does not exist"#,
            "syntax error at or near \"FROM\"",
            "permission denied for table withdrawals",
            "duplicate key value violates unique constraint \"x_pkey\"",
            "connect ECONNREFUSED 10.0.0.3:5432",
            "connection pool timeout",
            "Invalid or missing DATABASE_URL",
            "password authentication failed for user \"neondb_owner\"",
            "{\"severity\":\"ERROR\",\"code\":\"42P01\",\"detail\":\"x\"}",
            "Error: boom\n    at handler (/app/route.ts:10:5)",
            "ERROR: relation pg_class not found — SQL state 42P01",
            &"x".repeat(500),
            "line one\nline two",
            "",
            "an INSERT INTO users thing happened",
            // `\bupdate\s+\S+\s+set\b` needs exactly one non-space token between,
            // which is what a real statement looks like.
            "please UPDATE user_balances SET status",
            "cannot DELETE FROM that table",
            "check the WHERE clause again",
            "plpgsql raised something",
            "node_modules/pg/lib/index.js blew up",
            "missing api_key for neon",
        ];
        for leak in leaks {
            assert!(
                looks_like_internal_error(leak) || leak.is_empty(),
                "leaked: {leak}"
            );
            assert_eq!(
                sanitize_error_message(leak, "generic fallback"),
                "generic fallback"
            );
        }
    }

    #[test]
    fn ui_safe_messages_pass_through() {
        assert_eq!(
            sanitize_error_message("Insufficient house balance for acceptance", "fb"),
            "Insufficient house balance for acceptance"
        );
        assert_eq!(
            sanitize_error_message("  Request not found  ", "fb"),
            "Request not found"
        );
        // The guard runs on the trimmed message; a long raw message still fails.
        assert!(looks_like_internal_error(
            &"y".repeat(MAX_CLIENT_MESSAGE_LENGTH + 1)
        ));
    }

    // -- /api/admin/stats body ---------------------------------------------

    fn mode_stats(volume: f64, payout: f64, bets: usize, users: usize) -> ModeStats {
        ModeStats {
            total_bets: bets,
            total_volume: volume,
            total_payout: payout,
            platform_pnl: volume - payout,
            total_users: users,
            ..ModeStats::default()
        }
    }

    fn platform(
        real: ModeStats,
        demo: ModeStats,
        currencies: &[(&str, CurrencyStat)],
    ) -> PlatformStats {
        let mut currency_stats = BTreeMap::new();
        for (name, stat) in currencies {
            currency_stats.insert(name.to_string(), *stat);
        }
        PlatformStats {
            real,
            demo,
            currency_stats,
            total_deposits: 0,
            total_withdrawals: 0,
        }
    }

    #[test]
    fn admin_stats_sums_demo_and_real_and_duplicates_the_margin_as_revenue() {
        let body = admin_stats_body(&platform(
            mode_stats(1000.0, 400.0, 10, 4),
            mode_stats(250.0, 100.0, 5, 2),
            &[(
                "USDC",
                CurrencyStat {
                    total_balance: 12.5,
                    user_count: 3,
                },
            )],
        ));
        // Integral sums print the way `JSON.stringify` prints them: no `.0`.
        assert_eq!(body["totalVolume"], json!(1250));
        assert_eq!(body["totalBets"], json!(15));
        assert_eq!(
            body["totalUsers"],
            json!(6),
            "the TS adds the two sets, so a wallet in both counts twice"
        );
        assert_eq!(body["platformPnL"], json!(750));
        assert_eq!(body["revenue"], body["platformPnL"]);
        assert_eq!(body["currencyStats"]["USDC"]["totalBalance"], json!(12.5));
        assert_eq!(body["currencyStats"]["USDC"]["userCount"], json!(3));
        assert!(body.get("real").is_some() && body.get("demo").is_some());
        // The admin body does not carry the deposit/withdrawal counters.
        assert!(body.get("totalDeposits").is_none());
    }

    #[test]
    fn a_nan_aggregate_surfaces_as_null_like_json_stringify_did() {
        let body = admin_stats_body(&platform(
            mode_stats(f64::NAN, 0.0, 1, 0),
            mode_stats(0.0, 0.0, 0, 0),
            &[],
        ));
        assert_eq!(body["totalVolume"], Value::Null);
    }

    // -- /api/admin/users --------------------------------------------------

    fn balance(addr: &str, currency: &str, balance: f64, status: &str, updated: &str) -> Value {
        json!({
            "user_address": addr, "currency": currency, "balance": balance, "status": status,
            "user_tier": "free", "updated_at": updated, "created_at": updated,
        })
    }

    fn bet(id: &str, wallet: &str, amount: f64, won: bool, asset: &str) -> Value {
        json!({ "id": id, "wallet_address": wallet, "amount": amount, "payout": 0.0, "won": won,
                "network": "ARC", "asset": asset })
    }

    #[test]
    fn activity_aggregates_per_canonical_wallet_and_skips_play_money() {
        let bets = vec![
            bet("b1", "0xABC", 10.0, true, "USDC"),
            bet("b2", "0xabc", 5.5, false, "USDC"),
            bet("demo-b3", "0xabc", 900.0, true, "USDC"),
            bet("b4", "0xdemo9", 900.0, true, "USDC"),
        ];
        let acc = aggregate_user_activity(&bets);
        assert_eq!(acc.len(), 1, "both spellings of the wallet are one user");
        let entry = &acc["0xabc"];
        assert_eq!((entry.total_bets, entry.wins), (2, 1));
        assert_eq!(entry.total_volume, 15.5);
    }

    #[test]
    fn synthetic_rows_fill_bet_wallets_that_have_no_balance_row() {
        let balances = vec![balance(
            "0xABC",
            "USDC",
            1.0,
            "active",
            "2026-01-02T00:00:00.000Z",
        )];
        let bets = vec![
            bet("b1", "0xabc", 1.0, false, "USDC"),
            bet("b2", "0xdef", 1.0, false, "BOTCOIN"),
            bet("b3", "0xd3f", 1.0, false, ""),
            bet("demo-b4", "0xghost", 1.0, false, "USDC"),
        ];
        let rows = synthetic_balance_rows(&balances, &bets, "2026-05-05T00:00:00.000Z").unwrap();
        assert_eq!(
            rows.len(),
            2,
            "the seen key and the demo bet are both skipped"
        );
        assert_eq!(rows[0]["user_address"], json!("0xdef"));
        // resolveHouseLedgerCurrency: an unrecognised asset is USDC, never a
        // currency the treasury cannot pay out.
        assert_eq!(rows[0]["currency"], json!("USDC"));
        assert_eq!(rows[1]["user_address"], json!("0xd3f"));
        assert_eq!(rows[0]["balance"], json!(0));
        assert_eq!(rows[0]["status"], json!("active"));
        assert_eq!(rows[0]["user_tier"], json!("free"));
        assert_eq!(rows[0]["updated_at"], json!("2026-05-05T00:00:00.000Z"));
        assert!(resolve_house_ledger_currency(Some(&json!("usdc"))).unwrap() == "USDC");
        // A non-string asset is the TypeError the TS would have thrown.
        assert!(resolve_house_ledger_currency(Some(&json!(5))).is_err());
        assert_eq!(
            resolve_house_ledger_currency(Some(&Value::Null)).unwrap(),
            "USDC"
        );
    }

    #[test]
    fn a_non_string_asset_aborts_the_users_read_as_the_ts_typeerror_did() {
        let balances = vec![balance(
            "0xabc",
            "USDC",
            1.0,
            "active",
            "2026-01-02T00:00:00.000Z",
        )];
        let bets = vec![bet("b1", "0xdef", 1.0, false, "")];
        // A real asset string is fine; poison the table with a number instead.
        let mut poisoned = bets;
        poisoned[0]["asset"] = json!(7);
        let err = users_page(
            &balances,
            &poisoned,
            &[],
            &[],
            &ListParams::default(),
            "2026-05-05T00:00:00.000Z",
        )
        .err()
        .expect("the TypeError surfaces as an error");
        assert!(err.to_string().contains("toUpperCase"));
    }

    #[test]
    fn merged_rows_carry_the_dashboard_keys_and_null_absences() {
        let balances = vec![balance(
            "0xAbC",
            "USDC",
            3.0,
            "active",
            "2026-01-02T00:00:00.000Z",
        )];
        let bets = vec![bet("b1", "0xabc", 7.0, true, "USDC")];
        let referrals = vec![json!({
            "user_address": "0xABC", "referral_code": "ARC2026", "referral_count": 4,
            "referred_by": "0xother",
        })];
        let profiles = vec![json!({ "user_address": "0xabc", "username": "satoshi" })];
        let rows = build_user_rows(
            &balances,
            &bets,
            &referrals,
            &profiles,
            "2026-05-05T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "the seen balance key suppresses the synthetic row"
        );
        let row = &rows[0];
        assert_eq!(
            row["user_address"],
            json!("0xAbC"),
            "the stored spelling ships, not the canonical one"
        );
        assert_eq!(row["tier"], json!("free"));
        assert_eq!(row["username"], json!("satoshi"));
        assert_eq!(row["activity"]["totalBets"], json!(1));
        assert_eq!(row["referral"]["referral_code"], json!("ARC2026"));
        assert_eq!(row["referral"]["referred_by"], json!("0xother"));

        let bare = build_user_rows(&balances, &[], &[], &[], "2026-05-05T00:00:00.000Z").unwrap();
        assert_eq!(bare[0]["username"], Value::Null);
        assert_eq!(bare[0]["referral"]["referral_code"], json!("NONE"));
        assert_eq!(bare[0]["referral"]["referral_count"], json!(0));
        assert_eq!(bare[0]["activity"]["totalVolume"], json!(0));
    }

    #[test]
    fn rows_sort_newest_first_with_the_address_as_the_tiebreak() {
        let mut rows = vec![
            balance("0xzzz", "USDC", 1.0, "active", "2026-01-01T00:00:00.000Z"),
            balance("0xaaa", "USDC", 1.0, "active", "2026-01-01T00:00:00.000Z"),
            balance("0xmid", "USDC", 1.0, "active", "2026-02-01T00:00:00.000Z"),
            // `Date.parse(...) || 0` puts an unparsable timestamp at the epoch.
            balance("0xjunk", "USDC", 1.0, "active", "not a date"),
        ];
        sort_user_rows(&mut rows);
        let order: Vec<&str> = rows
            .iter()
            .map(|r| r["user_address"].as_str().unwrap())
            .collect();
        assert_eq!(order, vec!["0xmid", "0xaaa", "0xzzz", "0xjunk"]);
    }

    #[test]
    fn list_filters_narrow_the_aggregated_rows() {
        let rows: Vec<Value> = vec![
            json!({ "user_address": "0xAbC", "currency": "USDC", "status": "Active",
                    "username": "Alice", "updated_at": "2026-01-05T00:00:00.000Z" }),
            json!({ "user_address": "0xdef", "currency": "BOT", "status": "banned",
                    "username": null, "updated_at": "2026-01-02T00:00:00.000Z" }),
            json!({ "user_address": "0xff0", "currency": "USDC", "status": "frozen",
                    "username": "", "updated_at": "nonsense" }),
        ];
        let referral_enum = [("referrers", &["1"][..])];
        let o = opts(Some(&USER_STATUS_VALUES), &referral_enum);

        let by_q = parsed(&[("q", "ALICE")], &o);
        // The row address is matched case-insensitively, the username too.
        let hits: Vec<&Value> = rows
            .iter()
            .filter(|r| matches_list_filters(r, &by_q))
            .collect();
        assert_eq!(hits.len(), 1);

        let by_status = parsed(&[("status", "banned")], &o);
        assert_eq!(
            rows.iter()
                .filter(|r| matches_list_filters(r, &by_status))
                .count(),
            1
        );

        let by_currency = parsed(&[("currency", "bot")], &o);
        assert_eq!(
            rows.iter()
                .filter(|r| matches_list_filters(r, &by_currency))
                .count(),
            1
        );

        let window = parsed(&[("from", "2026-01-03"), ("to", "2026-01-31")], &o);
        let in_window: Vec<&Value> = rows
            .iter()
            .filter(|r| matches_list_filters(r, &window))
            .collect();
        assert_eq!(
            in_window.len(),
            1,
            "the unparsable row is dropped by a bounded query"
        );
        assert_eq!(in_window[0]["user_address"], json!("0xAbC"));

        // With no bounds the unparsable row survives.
        assert_eq!(
            rows.iter()
                .filter(|r| matches_list_filters(r, &ListParams::default()))
                .count(),
            3
        );
    }

    #[test]
    fn referrers_filter_and_paging_slice_agree_with_the_ts() {
        let rows: Vec<Value> = (0..5)
            .map(|i| {
                json!({ "user_address": format!("0x{i}"),
                        "referral": if i % 2 == 0 {
                            json!({ "referral_code": "NONE", "referral_count": 0 })
                        } else {
                            json!({ "referral_code": format!("C{i}"), "referral_count": 1 })
                        } })
            })
            .collect();
        let referrers = filter_referrers(rows.clone());
        assert_eq!(referrers.len(), 2, "only wallets holding a real code");
        let page = page_slice(referrers, 1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["user_address"], json!("0x3"));
        // An offset past the end is an empty page, never an error.
        assert!(page_slice(rows.clone(), 900, 50).is_empty());
        assert_eq!(page_slice(rows, 0, 0).len(), 0);
    }

    #[test]
    fn users_page_reports_the_filtered_total_and_projects_the_whitelist() {
        let balances = vec![balance(
            "0xabc",
            "USDC",
            1.0,
            "active",
            "2026-01-02T00:00:00.000Z",
        )];
        let referral_enum = [("referrers", &["1"][..])];
        let o = opts(Some(&USER_STATUS_VALUES), &referral_enum);
        let page = users_page(
            &balances,
            &[],
            &[],
            &[json!({ "user_address": "0xabc", "username": "", "secret_note": "risk flag" })],
            &parsed(&[], &o),
            "2026-05-05T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!((page.total, page.limit, page.offset), (1, 50, 0));
        let body = page.to_value();
        assert_eq!(body["users"].as_array().unwrap().len(), 1);
        let row = &body["users"][0];
        assert_eq!(row["username"], Value::Null, "an empty username is null");
        // Nothing outside the key list can ride along, even if a SELECT widened.
        let rendered = row.to_string();
        assert!(!rendered.contains("risk-"), "{rendered}");
        for key in USER_ROW_KEYS {
            assert!(row.get(key).is_some(), "{key} must always be present");
        }
        assert_eq!(row.as_object().unwrap().len(), USER_ROW_KEYS.len());
    }

    // -- POST /api/admin/users/status --------------------------------------

    #[test]
    fn status_rejections_are_ordered_and_exact() {
        let o = json!({});
        assert_eq!(
            validate_status_request(&o).unwrap_err(),
            MISSING_ADDRESS_OR_STATUS
        );
        assert_eq!(
            validate_status_request(&json!({ "userAddress": 42, "status": "active" })).unwrap_err(),
            MISSING_ADDRESS_OR_STATUS,
            "a number is not a string, so it is a 400 rather than a coercion"
        );
        assert_eq!(
            validate_status_request(&json!({ "userAddress": "   ", "status": "active" }))
                .unwrap_err(),
            MISSING_ADDRESS_OR_STATUS
        );
        // A degenerate address is still a non-empty variant list, so the update
        // targets it rather than 400ing: `walletAddressSearchVariants` only
        // returns [] for a blank string, and the blank case is caught above.
        let (variants, _) =
            validate_status_request(&json!({ "userAddress": "0x", "status": "active" }))
                .expect("a short address is not a rejection");
        assert_eq!(variants, vec!["0x".to_string()]);
        assert_eq!(
            validate_status_request(&json!({ "userAddress": "0xabc" })).unwrap_err(),
            MISSING_ADDRESS_OR_STATUS
        );
        assert_eq!(
            validate_status_request(&json!({ "userAddress": "0xabc", "status": "refunded" }))
                .unwrap_err(),
            INVALID_STATUS,
            "the enum is checked before any DB round-trip"
        );
        assert_eq!(
            validate_status_request(
                &json!({ "userAddress": &"0".repeat(129), "status": "active" })
            )
            .unwrap_err(),
            ADDRESS_TOO_LONG
        );
        // A whitespace-only address is caught by the first check, so the empty
        // variant list is unreachable through a valid body; force it directly.
        assert_eq!(address::search_variants("  "), Vec::<String>::new());
        assert_eq!(
            validate_status_request(&json!({"userAddress": null, "status": "active"})).unwrap_err(),
            MISSING_ADDRESS_OR_STATUS
        );

        let (variants, status) = validate_status_request(
            &json!({ "userAddress": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "status": "banned" }),
        )
        .unwrap();
        assert_eq!(status, "banned");
        assert_eq!(variants.len(), 2, "checksummed plus lowercase");
        assert_eq!(variants[0], "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    }

    #[test]
    fn the_status_update_casts_every_bind_and_binds_no_wildcards() {
        let prepared = status_update(&["0xabc".into(), "0xABC".into()], "frozen");
        assert_eq!(
            prepared.sql,
            "UPDATE user_balances SET status = CAST($1 AS text) \
             WHERE user_address IN (CAST($2 AS text), CAST($3 AS text))"
        );
        assert_eq!(prepared.binds.len(), 3);
        assert_eq!(
            prepared.row_refs(),
            vec![
                ("text", &Value::String("frozen".into())),
                ("text", &Value::String("0xabc".into())),
                ("text", &Value::String("0xABC".into())),
            ]
        );
        // The statement with zero variants can never degenerate to `IN ()`, which
        // Postgres rejects: it matches nothing instead. The route 400s a blank
        // address before this is reachable, so it is a guard rail, not a path.
        let prepared = status_update(&[], "active");
        assert_eq!(
            prepared.sql,
            "UPDATE user_balances SET status = CAST($1 AS text) WHERE user_address IN (NULL)"
        );
    }

    // -- /api/admin/transactions -------------------------------------------

    #[test]
    fn the_transactions_statement_never_lets_an_untyped_literal_reach_sql() {
        let o = opts(Some(&TRANSACTION_STATUS_VALUES), &[]);
        let p = parsed(
            &[
                ("status", "deposit"),
                ("currency", "usdc"),
                ("q", "0xabc"),
                ("from", "2026-10-01"),
                ("to", "2026-10-02T12:00:00Z"),
                ("limit", "25"),
                ("offset", "50"),
            ],
            &o,
        );
        let prepared = transactions_statement(&p);
        assert_eq!(
            prepared.sql,
            "SELECT id, user_address, currency, operation_type, amount, balance_before, \
             balance_after, transaction_hash, bet_id, created_at FROM balance_audit_log \
             WHERE operation_type IN (CAST($1 AS text), CAST($2 AS text)) \
             AND operation_type = CAST($3 AS text) AND currency = CAST($4 AS text) \
             AND (pg_ilike(user_address, CAST($5 AS text)) OR pg_ilike(transaction_hash, CAST($6 AS text))) \
             AND created_at >= CAST($7 AS timestamp with time zone) \
             AND created_at <= CAST($8 AS timestamp with time zone) \
             ORDER BY created_at DESC, id DESC LIMIT CAST($9 AS int8) OFFSET CAST($10 AS int8)"
        );
        assert_eq!(
            prepared.count_sql.as_deref(),
            Some(
                "SELECT COUNT(*) AS count FROM balance_audit_log \
                 WHERE operation_type IN (CAST($1 AS text), CAST($2 AS text)) \
                 AND operation_type = CAST($3 AS text) AND currency = CAST($4 AS text) \
                 AND (pg_ilike(user_address, CAST($5 AS text)) OR pg_ilike(transaction_hash, CAST($6 AS text))) \
                 AND created_at >= CAST($7 AS timestamp with time zone) \
                 AND created_at <= CAST($8 AS timestamp with time zone)"
            )
        );
        // The COUNT statement reads the shared filter prefix only.
        assert_eq!(prepared.filter_binds, 8);
        assert_eq!(prepared.count_refs().len(), 8);
        assert_eq!(prepared.row_refs().len(), 10);
        let bound = prepared.row_refs();
        assert_eq!(
            bound[4].1,
            &json!("%0xabc%"),
            "the search term is a bound pattern"
        );
        assert_eq!(
            bound[9].1,
            &json!(50),
            "OFFSET is the 9th placeholder's value, order matters"
        );
        assert_eq!(db::highest_placeholder(&prepared.sql), prepared.binds.len());
    }

    #[test]
    fn transactions_body_keeps_the_dashboard_keys_and_the_paging_trio() {
        let o = opts(Some(&TRANSACTION_STATUS_VALUES), &[]);
        let p = parsed(&[("limit", "10"), ("offset", "20")], &o);
        let rows = vec![json!({
            "id": 7, "user_address": "0xabc", "currency": "USDC", "operation_type": "deposit",
            "amount": 5.0, "balance_before": 0.0, "balance_after": 5.0,
            "transaction_hash": null, "bet_id": null, "created_at": "2026-01-01T00:00:00.000Z",
        })];
        let body = transactions_body(&rows, 123, &p);
        assert_eq!(body["total"], json!(123));
        assert_eq!(body["limit"], json!(10));
        assert_eq!(body["offset"], json!(20));
        let tx = &body["transactions"][0];
        assert_eq!(tx.as_object().unwrap().len(), TRANSACTION_ROW_KEYS.len());
        assert_eq!(
            tx["transaction_hash"],
            Value::Null,
            "a null column is a present key"
        );
        assert_eq!(
            tx["amount"],
            json!(5.0),
            "NUMERIC stays a JSON number, as parseFloat made it"
        );
    }

    // -- /api/admin/game-history -------------------------------------------

    #[test]
    fn game_history_binds_its_outcome_as_a_real_boolean() {
        let o = opts(Some(&GAME_STATUS_VALUES), &[("account", &ACCOUNT_VALUES)]);
        let won = parsed(&[("status", "WON")], &o);
        let prepared = game_history_page_statement(&won);
        assert!(
            prepared.sql.contains("WHERE won = CAST($1 AS boolean)"),
            "{}",
            prepared.sql
        );
        assert_eq!(prepared.binds.refs()[0], ("boolean", &Value::Bool(true)));

        let lost = parsed(&[("status", "lost"), ("q", "demo")], &o);
        let prepared = game_history_page_statement(&lost);
        assert!(prepared.sql.contains("won = CAST($1 AS boolean)"));
        assert!(prepared
            .sql
            .contains("(pg_ilike(wallet_address, CAST($2 AS text)) OR pg_ilike(asset, CAST($3 AS text)) OR pg_ilike(id, CAST($4 AS text)))"));
        assert_eq!(prepared.count_refs().len(), 4);
        assert_eq!(db::highest_placeholder(&prepared.sql), prepared.binds.len());
    }

    #[test]
    fn an_unfiltered_game_history_read_has_no_where_clause_at_all() {
        let o = opts(Some(&GAME_STATUS_VALUES), &[("account", &ACCOUNT_VALUES)]);
        let p = parsed(&[], &o);
        let prepared = game_history_page_statement(&p);
        assert!(!prepared.sql.contains("WHERE"));
        assert!(prepared
            .sql
            .ends_with("LIMIT CAST($1 AS int8) OFFSET CAST($2 AS int8)"));
        assert_eq!(db::highest_placeholder(&prepared.sql), prepared.binds.len());
    }

    #[test]
    fn the_scan_window_is_bounded_and_carries_the_filter_binds_first() {
        let o = opts(Some(&GAME_STATUS_VALUES), &[("account", &ACCOUNT_VALUES)]);
        let p = parsed(&[("currency", "usdc")], &o);
        let prepared = game_history_scan_statement(&p, 3_000);
        assert!(prepared.sql.contains("asset = CAST($1 AS text)"));
        assert!(prepared
            .sql
            .ends_with("LIMIT CAST($2 AS int8) OFFSET CAST($3 AS int8)"));
        assert_eq!(prepared.count_sql, None);
        assert_eq!(prepared.binds.refs()[1].1, &json!(1_000));
        assert_eq!(prepared.binds.refs()[2].1, &json!(3_000));
    }

    #[test]
    fn the_scan_stops_on_a_short_page_or_at_the_cap_and_says_so() {
        // A full page below the cap keeps walking.
        assert_eq!(
            scan_stop_decision(SCAN_PAGE as usize, SCAN_PAGE as usize),
            None
        );
        assert_eq!(
            scan_stop_decision(2_500, 500),
            Some(false),
            "short page: done, nothing lost"
        );
        assert_eq!(scan_stop_decision(0, 0), Some(false));
        // Exactly at the cap with a full page: more rows may exist unread.
        assert_eq!(scan_stop_decision(SCAN_CAP, SCAN_PAGE as usize), Some(true));
        // Hitting the cap on a short page means the read was complete anyway.
        assert_eq!(scan_stop_decision(SCAN_CAP, 40), Some(false));
        // 20 pages of 1 000 is the ceiling the TS set.
        let mut collected = 0usize;
        let mut stops = 0;
        for _ in 0..40 {
            collected += SCAN_PAGE as usize;
            stops += 1;
            if scan_stop_decision(collected, SCAN_PAGE as usize).is_some() {
                break;
            }
        }
        assert_eq!((collected, stops), (SCAN_CAP, 20));
    }

    #[test]
    fn the_account_split_is_the_js_demo_test_not_a_sql_one() {
        let rows = vec![
            bet("b1", "0xreal", 1.0, true, "USDC"),
            bet("demo-b2", "0xreal", 1.0, false, "USDC"),
            bet("b3", "0xDemo9", 1.0, true, "USDC"),
        ];
        let (total, real_page) = game_history_account_page(&rows, "real", 0, 50);
        assert_eq!((total, real_page.len()), (1, 1));
        assert_eq!(real_page[0]["id"], json!("b1"));
        let (demo_total, demo_page) = game_history_account_page(&rows, "demo", 1, 50);
        assert_eq!(demo_total, 2);
        assert_eq!(
            demo_page.len(),
            1,
            "offset and limit slice the filtered set"
        );
        assert_eq!(demo_page[0]["id"], json!("b3"));

        let o = opts(Some(&GAME_STATUS_VALUES), &[("account", &ACCOUNT_VALUES)]);
        let p = parsed(&[], &o);
        let body = game_history_body(&demo_page, demo_total, &p, "demo", Some(true));
        assert_eq!(body["scanTruncated"], json!(true));
        assert_eq!(body["total"], json!(2));
        assert_eq!(body["account"], json!("demo"));
        assert_eq!(
            body["bets"].as_array().unwrap()[0]
                .as_object()
                .unwrap()
                .len(),
            GAME_ROW_KEYS.len()
        );

        let all = game_history_body(&rows, 3, &p, "all", None);
        assert!(
            all.get("scanTruncated").is_none(),
            "the DB-paged branch cannot truncate"
        );
        assert_eq!(all["account"], json!("all"));
    }

    // -- /api/admin/mode-analytics -----------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn analytics_bet(
        id: &str,
        wallet: &str,
        mode: &str,
        amount: f64,
        payout: f64,
        won: bool,
        network: &str,
        asset: &str,
        multiplier: f64,
    ) -> Value {
        json!({ "id": id, "wallet_address": wallet, "amount": amount, "payout": payout,
                "won": won, "mode": mode, "network": network, "asset": asset,
                "multiplier": multiplier })
    }

    #[test]
    fn mode_analytics_labels_chains_and_assets_the_way_js_did() {
        assert_eq!(chain_label(Some(&json!("arc"))), "ARC");
        assert_eq!(chain_label(Some(&json!(""))), "UNKNOWN");
        assert_eq!(chain_label(None), "UNKNOWN");
        assert_eq!(chain_label(Some(&Value::Null)), "UNKNOWN");
        assert_eq!(asset_label(Some(&json!("usdt"))), "USDT");
        assert_eq!(asset_label(Some(&json!(""))), "USDC");
        assert_eq!(mode_label(Some(&json!(" BOX "))), " box ");
        assert_eq!(mode_label(Some(&json!(""))), "binomo");
        assert_eq!(mode_display_label("box"), "Box Mode");
        assert_eq!(
            mode_display_label("roulette"),
            "roulette",
            "an unknown mode labels itself"
        );
    }

    #[test]
    fn mode_analytics_aggregates_margin_rate_and_average_multiplier() {
        let rows = vec![
            analytics_bet(
                "b1", "0xreal", "BINOMO", 100.0, 190.0, true, "arc", "USDC", 1.9,
            ),
            analytics_bet(
                "b2", "0xreal", "binomo", 50.0, 0.0, false, "arc", "usdc", 1.9,
            ),
            analytics_bet("b3", "0xreal", "box", 10.0, 100.0, true, "ARC", "EURC", 2.0),
        ];
        let modes = compute_modes(&rows);
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0].mode, "binomo", "busiest mode first");
        assert_eq!(modes[0].total_bets, 2);
        assert_eq!(modes[0].wins, 1);
        assert_eq!(modes[0].losses, 1);
        assert_eq!(modes[0].win_rate, 50.0);
        assert_eq!(modes[0].total_wagered, 150.0);
        assert_eq!(modes[0].total_paid_out, 190.0);
        assert_eq!(
            modes[0].house_pnl, -40.0,
            "the house margin is wagered minus paid"
        );
        assert_eq!(modes[0].avg_multiplier, 1.9);
        assert_eq!(
            modes[0].by_chain.len(),
            1,
            "'arc' and 'ARC' are one chain once uppercased"
        );
        assert_eq!(modes[0].by_chain[0].0, "ARC");
        assert_eq!(modes[0].by_chain[0].1.total_bets, 2);
        assert_eq!(modes[0].by_chain[0].1.house_pnl, -40.0);
        assert_eq!(modes[0].top_assets, vec![("USDC".to_string(), 2)]);

        // One bet: a 1/3 win rate rounds to one decimal, an empty set is 0.
        let single = compute_modes(&[analytics_bet(
            "x", "0xr", "draw", 3.0, 0.0, false, "arc", "usdc", 2.0,
        )]);
        assert_eq!(single[0].label, "Draw Mode");
        assert_eq!(single[0].win_rate, 0.0);
        assert_eq!(single[0].avg_multiplier, 2.0);
        assert_eq!(compute_modes(&[]).len(), 0);
    }

    #[test]
    fn win_rate_and_average_multiplier_round_like_math_round() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(-0.5), -0.0, "JS rounds half toward +infinity");
        assert!(js_round(f64::NAN).is_nan());
        let rows = vec![
            analytics_bet("a", "0xr", "binomo", 1.0, 1.0, true, "arc", "usdc", 1.9),
            analytics_bet("b", "0xr", "binomo", 1.0, 1.0, false, "arc", "usdc", 1.9),
            analytics_bet("c", "0xr", "binomo", 1.0, 1.0, false, "arc", "usdc", 2.0),
        ];
        let modes = compute_modes(&rows);
        assert_eq!(modes[0].win_rate, 33.3);
        assert_eq!(
            modes[0].avg_multiplier, 1.93,
            "(1.9+1.9+2.0)/3 = 1.9333 -> 1.93"
        );
    }

    #[test]
    fn a_missing_multiplier_counts_as_the_classic_odds_not_zero() {
        let mut row = analytics_bet("a", "0xr", "binomo", 1.0, 1.0, true, "arc", "usdc", 1.9);
        row.as_object_mut().unwrap().remove("multiplier");
        let modes = compute_modes(&[row]);
        assert_eq!(modes[0].avg_multiplier, 1.9);
    }

    #[test]
    fn top_assets_are_count_desc_then_first_seen_and_capped_at_five() {
        let mut rows = Vec::new();
        for (asset, count) in [
            ("USDT", 3usize),
            ("USDC", 5),
            ("EURC", 1),
            ("DAI", 2),
            ("WBTC", 2),
            ("METH", 2),
        ] {
            for _ in 0..count {
                rows.push(analytics_bet(
                    "b", "0xr", "binomo", 1.0, 0.0, false, "arc", asset, 1.9,
                ));
            }
        }
        let modes = compute_modes(&rows);
        let top = modes[0]
            .top_assets
            .iter()
            .map(|(asset, count)| (asset.as_str(), *count))
            .collect::<Vec<_>>();
        assert_eq!(top.len(), 5, "the TS sliced to five");
        assert_eq!(top[0], ("USDC", 5));
        assert_eq!(top[1], ("USDT", 3));
        // 2-count assets keep the order they were first seen in, as V8's stable
        // sort did.
        assert_eq!(top[2].0, "DAI");
        assert_eq!(top[3].0, "WBTC");
        assert_eq!(top[4].0, "METH");
    }

    #[test]
    fn mode_analytics_splits_real_demo_and_combined() {
        let rows = vec![
            analytics_bet(
                "b1", "0xreal", "binomo", 100.0, 0.0, false, "arc", "USDC", 1.9,
            ),
            analytics_bet(
                "demo-b2", "0xreal", "box", 500.0, 0.0, false, "arc", "USDC", 1.9,
            ),
            analytics_bet(
                "b3", "0xdemo7", "binomo", 900.0, 0.0, false, "arc", "USDC", 1.9,
            ),
        ];
        let body = mode_analytics_body(&rows);
        assert_eq!(body["totalBets"], json!(3));
        assert_eq!(body["totalRealBets"], json!(1));
        assert_eq!(body["totalDemoBets"], json!(2));
        // A `demo-` id on a real wallet is play money all the same.
        assert_eq!(body["real"][0]["totalBets"], json!(1));
        assert_eq!(body["demo"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["combined"].as_array().unwrap()[0]["mode"],
            json!("binomo"),
            "2 of 3 bets"
        );
        // The binomo chain bucket holds that mode's two bets only (100 + 900); the
        // box bet lives in the next mode entry.
        assert_eq!(
            body["combined"][0]["byChain"]["ARC"]["totalWagered"],
            json!(1000)
        );
        assert_eq!(
            body["combined"].as_array().unwrap()[1]["mode"],
            json!("box")
        );
        assert_eq!(body["combined"][1]["totalWagered"], json!(500));
        // Real money: just b1, so the demo wallet and the `demo-` id are both out.
        assert_eq!(body["real"][0]["totalWagered"], json!(100));
        assert_eq!(body["demo"].as_array().unwrap()[1]["mode"], json!("binomo"));
        assert_eq!(
            body["demo"].as_array().unwrap()[0]["mode"],
            json!("box"),
            "first seen wins a 1-1 tie"
        );
    }

    // -- projection --------------------------------------------------------

    #[test]
    fn the_projection_ships_named_keys_only() {
        let row = json!({
            "id": "b1", "wallet_address": "0xabc", "asset": "USDC", "direction": "UP",
            "amount": 1.0, "payout": 0.0, "won": false, "mode": "binomo",
            "network": "ARC", "created_at": "2026-01-01T00:00:00.000Z",
            "signature": "0xdeadbeef", "strike_price": 1000.0,
        });
        let projected = project_row(&row, &GAME_ROW_KEYS);
        let serialized = projected.to_string();
        assert!(!serialized.contains("0xdeadbeef"));
        assert!(!serialized.contains("strike_price"));
        assert_eq!(projected.as_object().unwrap().len(), GAME_ROW_KEYS.len());
        // A column the SELECT dropped still arrives as null, not as a missing key.
        let partial = json!({ "id": "b1" });
        assert_eq!(project_row(&partial, &["id", "won"])["won"], Value::Null);
    }
}
