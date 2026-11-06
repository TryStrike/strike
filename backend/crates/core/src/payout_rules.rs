//! Rules behind auto-paid withdrawals: the signed-intent message and its
//! verification, the acceptance window, the fee plan, and the error sanitiser.
//! Pure where it can be, so it tests offline; `routes::payout` does the I/O.

use crate::address::{is_address_shape, to_checksum};
use crate::crypto::{is_within_accept_window_at, MAX_ACCEPT_INTENT_AGE_MS};
use crate::eth::verify_personal_signature;
use crate::ledger::{floor_to_token, split_fee, Tier};
use rust_decimal::Decimal;

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
    if crate::config::arc_asset(Some(&normalized)).is_none() {
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

/// `NEEDS_RECONCILIATION:${reason}` sliced to 500 UTF-16 code units like JS
/// `.slice(0, 500)`.
pub fn reconciliation_note(reason: &str) -> String {
    take_utf16(&format!("NEEDS_RECONCILIATION:{reason}"), 500)
}

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
