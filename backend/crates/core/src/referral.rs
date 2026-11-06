//! Pure logic behind `/api/referral`.
//!
//! Everything that decides *what the response says* lives here: code minting,
//! address truncation, referrer resolution, the demo-row exclusions and the
//! qualification arithmetic that turns ledger rows into `pending` / `qualified`.
//! The handler in the server crate only owns SQL and HTTP.
//!
//! Money honesty, unchanged from the TS: a referee counts as qualified only when
//! the bet ledger holds a real-money bet for them, so `demo-…` bet ids and
//! `0xDEMO…` wallets are dropped with the same predicates the public leaderboard
//! and the bet history use (`crate::bets`). A dashboard can therefore never show
//! an "earned" reward ahead of a qualifying trade.

use serde_json::Value;

use crate::admin_writes::{json_like, take_utf16, utf16_len};
use crate::bets::{
    canonical_address, is_demo_bet_row, is_demo_wallet_address, is_evm_address, js_num, to_number,
    value_to_string,
};

/// 30 symbols, no `I`, `O`, `0` or `1`, so a code cannot be misread. The TS
/// comment claims 32 and indexes with `b & 31`; see `random_code_suffix`.
pub const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ234567";

/// One page of referees. `totals.joined` is the DB count, not this cap.
pub const FRIENDS_PAGE_CAP: i64 = 100;
/// Bounded scan of the ledger for the referees' real-money bets.
pub const BET_SCAN_CAP: i64 = 2000;
/// Rows read for the public top-20, so demo wallets can't crowd it out.
pub const LEADERBOARD_SCAN_CAP: i64 = 60;
/// Rows fetched per request at most, even for a `.limit(2000)`. The scan
/// below therefore can never report `scanned === BET_SCAN_CAP`, which is why
/// `qualifiedExact` stays true by construction rather than by luck.
pub const MAX_ROWS_PER_QUERY: i64 = 1000;
/// `referral_code.trim().slice(0, 64)`.
pub const REFERRAL_CODE_MAX_LEN: usize = 64;

// ── Address shaping ─────────────────────────────────────────────────────────

/// The POST body's address gate: `/^0x[a-fA-F0-9]{40}$/` applied to
/// `String(address).trim()`, i.e. a lowercase `0x` prefix is required and
/// checksum casing is allowed. `crate::bets::is_evm_address` is the same regex.
pub fn is_referral_address(value: &str) -> bool {
    is_evm_address(value)
}

/// `truncate()` — `0x1234…7890`, counted in UTF-16 code units like JS
/// `.length`/`.slice`. Anything shorter than 12 units (including the empty
/// string) is returned untouched.
pub fn truncate_address(addr: &str) -> String {
    if addr.is_empty() || utf16_len(addr) < 12 {
        return addr.to_string();
    }
    format!("{}…{}", take_utf16(addr, 6), tail_utf16(addr, 4))
}

/// `addr.slice(-n)` in UTF-16 units. Whole code points only: a real address is
/// ASCII, and a Rust `String` cannot hold half a surrogate pair anyway.
fn tail_utf16(value: &str, units: usize) -> String {
    let mut used = 0usize;
    let mut taken: Vec<char> = Vec::new();
    for ch in value.chars().rev() {
        let cost = if (ch as u32) > 0xFFFF { 2 } else { 1 };
        if used + cost > units {
            break;
        }
        used += cost;
        taken.push(ch);
    }
    taken.iter().rev().collect()
}

/// `addrKey.slice(-4).toUpperCase()` — the last four units of the canonical
/// address, upper-cased, as the readable half of the code.
pub fn code_tail(addr_key: &str) -> String {
    tail_utf16(addr_key, 4).to_uppercase()
}

/// `randomCodeSuffix()`: five random bits per character out of a CSPRNG.
///
/// Deliberate deviation: the alphabet has 30 symbols, so `b & 31` lands past
/// its end 1 time in 16 and the TS appends the literal text `undefined`. The
/// 30 and 31 draws are rejected here instead, which keeps the suffix the
/// documented length and alphabet without biasing any symbol.
pub fn random_code_suffix(length: usize) -> String {
    let alphabet = CODE_ALPHABET.as_bytes();
    let mut out = String::with_capacity(length);
    while out.len() < length {
        let mut byte = [0u8; 1];
        getrandom::fill(&mut byte).expect("OS randomness");
        if let Some(symbol) = alphabet.get(usize::from(byte[0] & 31)) {
            out.push(char::from(*symbol));
        }
    }
    out
}

/// `strike-${addrKey.slice(-4).toUpperCase()}${randomCodeSuffix(4)}`.
pub fn referral_code(addr_key: &str) -> String {
    format!("strike-{}{}", code_tail(addr_key), random_code_suffix(4))
}

// ── Referrer resolution (`resolveReferrer`) ─────────────────────────────────

/// JS truthiness for a JSON cell.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `typeof x === 'string' ? x.trim().slice(0, 64) : ''`, then `if (!code)`.
/// Anything that is not a *string* (a number, an object, a missing key) is "no
/// code supplied", not a stringified one — so `referredByCode: 123` never
/// resolves.
pub fn clean_referral_code(raw: Option<&Value>) -> Option<String> {
    let code = match raw {
        Some(Value::String(s)) => take_utf16(s.trim(), REFERRAL_CODE_MAX_LEN),
        _ => return None,
    };
    (!code.is_empty()).then_some(code)
}

/// The referrer address a POST may write, or `None` for "no referrer".
///
/// `stored_referrer` is the `user_address` of the row the code resolved to.
/// Mirrors the three TS exits: unknown/empty code, code with no row (or a blank
/// `user_address`), and self-referral. The exact DB spelling is returned —
/// `increment_referral_count` matches on the primary key, so a canonicalised
/// guess could silently miss the row.
pub fn resolve_referrer_target(
    raw_code: Option<&Value>,
    self_key: &str,
    stored_referrer: Option<&Value>,
) -> Option<String> {
    clean_referral_code(raw_code)?;
    let stored = stored_referrer.filter(|v| js_truthy(v))?;
    let spelling = value_to_string(stored);
    if canonical_address(&spelling) == self_key {
        return None;
    }
    Some(spelling)
}

// ── Qualification (`realBetSignals`) ────────────────────────────────────────

/// Which referees have actually traded real money, and when they first did.
#[derive(Debug, Clone, PartialEq)]
pub struct RealBetSignal {
    pub real_bets: i64,
    pub first_real_bet_at: Option<String>,
}

impl RealBetSignal {
    fn new() -> Self {
        Self {
            real_bets: 0,
            first_real_bet_at: None,
        }
    }
}

/// The `wallet_address IN (…)` list for the qualification scan: every referee's
/// canonical key plus its original spelling, deduplicated in first-seen order
/// (`[...new Set(keys)]`).
pub fn bet_scan_keys(referee_addresses: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::with_capacity(referee_addresses.len());
    for addr in referee_addresses {
        let canonical = canonical_address(addr);
        push_unique(&mut keys, canonical.clone());
        if canonical != *addr {
            push_unique(&mut keys, addr.clone());
        }
    }
    keys
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.iter().any(|existing| existing == &value) {
        list.push(value);
    }
}

/// `created_at` read the way the TS `if (prev.firstRealBetAt && row.created_at)`
/// truthiness gate reads it: null, `false`, `0` and `""` all mean "no timestamp".
fn created_at_value(row: &Value) -> Option<String> {
    match row.get("created_at") {
        Some(value) if js_truthy(value) => Some(value_to_string(value)),
        _ => None,
    }
}

/// Fold the scanned bet rows into per-referee signals.
///
/// Returns the signals keyed by the **canonical** wallet (the same key the
/// friend rows look up) and the number of rows read. A failed query is not an
/// error here: the TS logs it and returns `{signals: new Map(), scanned: 0}`, so
/// every friend stays `pending` and `qualifiedExact` remains true.
pub fn real_bet_signals(rows: &[Value]) -> (Vec<(String, RealBetSignal)>, usize) {
    let mut signals: Vec<(String, RealBetSignal)> = Vec::new();
    for row in rows {
        if is_demo_bet_row(row) {
            continue;
        }
        let key = canonical_address(
            &row.get("wallet_address")
                .map(value_to_string)
                .unwrap_or_default(),
        );
        let entry = match signals.iter_mut().find(|(k, _)| *k == key) {
            Some((_, signal)) => signal,
            None => {
                signals.push((key.clone(), RealBetSignal::new()));
                &mut signals.last_mut().expect("just pushed").1
            }
        };
        entry.real_bets += 1;
        if entry.first_real_bet_at.is_none() {
            if let Some(at) = created_at_value(row) {
                entry.first_real_bet_at = Some(at);
            }
        }
    }
    (signals, rows.len())
}

/// Look a referee up by their ledger key.
pub fn find_signal<'a>(
    signals: &'a [(String, RealBetSignal)],
    key: &str,
) -> Option<&'a RealBetSignal> {
    signals.iter().find(|(k, _)| k == key).map(|(_, s)| s)
}

// ── Friends list ────────────────────────────────────────────────────────────

/// Play-money wallets are not nodes: they never traded real money. Returns the
/// page rows that survive and how many were dropped, which the `joined` total
/// needs to stay honest.
pub fn split_demo_rows(rows: &[Value]) -> (Vec<Value>, usize) {
    let page_rows: Vec<Value> = rows
        .iter()
        .filter(|row| !is_demo_wallet_address(row.get("user_address")))
        .cloned()
        .collect();
    let dropped = rows.len() - page_rows.len();
    (page_rows, dropped)
}

/// One `ReferralFriendRow`. `joinedAt` is the DB column verbatim (null allowed),
/// exactly like the TS pass-through.
pub fn friend_row(row: &Value, signal: Option<&RealBetSignal>) -> Value {
    let real_bets = signal.map(|s| s.real_bets).unwrap_or(0);
    json_like(&[
        (
            "address",
            row.get("user_address").cloned().unwrap_or(Value::Null),
        ),
        (
            "joinedAt",
            row.get("created_at").cloned().unwrap_or(Value::Null),
        ),
        (
            "status",
            Value::String(
                if real_bets > 0 {
                    "qualified"
                } else {
                    "pending"
                }
                .to_string(),
            ),
        ),
        ("realBets", Value::Number(real_bets.into())),
        (
            "firstRealBetAt",
            signal
                .and_then(|s| s.first_real_bet_at.clone())
                .map(Value::String)
                .unwrap_or(Value::Null),
        ),
    ])
}

/// `friends.map(...)` over the page, each looked up by its canonical key.
pub fn friends_json(page_rows: &[Value], signals: &[(String, RealBetSignal)]) -> Vec<Value> {
    page_rows
        .iter()
        .map(|row| {
            let address = row
                .get("user_address")
                .map(value_to_string)
                .unwrap_or_default();
            friend_row(row, find_signal(signals, &canonical_address(&address)))
        })
        .collect()
}

/// Qualified nodes on the page, from the rows the response itself carries — so
/// the numerator can never drift from what was rendered.
pub fn count_qualified(friends: &[Value]) -> usize {
    friends
        .iter()
        .filter(|f| f.get("status").and_then(Value::as_str) == Some("qualified"))
        .count()
}

/// The `totals` block, key order as in the TS literal.
///
/// `joined` is the DB's exact count minus the demo rows that were dropped from
/// this page, floored at the page size (the count and the page can disagree
/// while a referee is being deleted). `qualified`/`pending` always describe
/// THIS page. `qualifiedExact` is false only when the bounded scan hit its cap.
pub fn friends_totals(
    db_count: Option<i64>,
    demo_rows_dropped: usize,
    page_len: usize,
    qualified: usize,
    scanned: usize,
) -> Value {
    let from_count = db_count.unwrap_or(page_len as i64) - demo_rows_dropped as i64;
    let joined = from_count.max(page_len as i64);
    json_like(&[
        ("joined", Value::Number(joined.into())),
        ("pageJoined", Value::Number((page_len as i64).into())),
        ("qualified", Value::Number((qualified as i64).into())),
        (
            "pending",
            Value::Number((page_len as i64 - qualified as i64).into()),
        ),
        ("truncated", Value::Bool(joined > page_len as i64)),
        (
            "qualifiedExact",
            Value::Bool((scanned as i64) < BET_SCAN_CAP),
        ),
    ])
}

/// `Response.json({ friends, totals })`.
pub fn friends_response(friends: Vec<Value>, totals: Value) -> Value {
    json_like(&[("friends", Value::Array(friends)), ("totals", totals)])
}

// ── Public leaderboard ──────────────────────────────────────────────────────

/// Top referrers: demo wallets dropped, then the visible 20, then the address
/// truncated. Nothing that lets someone claim another user's referrals leaves
/// the server — no code, no `referred_by`.
pub fn leaderboard_json(rows: &[Value], visible: usize) -> Value {
    let board: Vec<Value> = rows
        .iter()
        .filter(|row| !is_demo_wallet_address(row.get("user_address")))
        .take(visible)
        .map(|row| {
            let address = row
                .get("user_address")
                .map(value_to_string)
                .unwrap_or_default();
            json_like(&[
                ("user_address", Value::String(truncate_address(&address))),
                (
                    "referral_count",
                    row.get("referral_count").cloned().unwrap_or(Value::Null),
                ),
            ])
        })
        .collect();
    json_like(&[("leaderboard", Value::Array(board))])
}

// ── Single-wallet projection and registration responses ─────────────────────

/// `{ referral: {referral_code, referral_count, referred_by} | null }`. The
/// projection lists exactly these three columns, so a widened SELECT cannot
/// start shipping the row's `id` or timestamps.
pub fn single_referral_json(row: Option<&Value>) -> Value {
    let referral = match row {
        None => Value::Null,
        Some(row) => json_like(&[
            (
                "referral_code",
                row.get("referral_code").cloned().unwrap_or(Value::Null),
            ),
            (
                "referral_count",
                row.get("referral_count").cloned().unwrap_or(Value::Null),
            ),
            (
                "referred_by",
                row.get("referred_by").cloned().unwrap_or(Value::Null),
            ),
        ]),
    };
    json_like(&[("referral", referral)])
}

/// The POST success body: `{referral_code, referral_count}` and nothing else.
pub fn register_response(code: Value, count: Value) -> Value {
    json_like(&[("referral_code", code), ("referral_count", count)])
}

/// Late attribution may only be attempted when a referrer was named and the
/// existing row has none — `referredByAddress && !existing.referred_by`.
pub fn should_attempt_bind(referrer: Option<&str>, existing: Option<&Value>) -> bool {
    match (referrer, existing) {
        (Some(_), Some(row)) => !row.get("referred_by").map(js_truthy).unwrap_or(false),
        _ => false,
    }
}

/// `(existing.referral_count ?? 0) + 1` after a successful bind: the counter the
/// RPC just moved, reported from the pre-update read rather than re-read.
pub fn bumped_referral_count(existing: &Value) -> Value {
    let current = existing
        .get("referral_count")
        .filter(|v| **v != Value::Null)
        .map(to_number)
        .unwrap_or(0.0);
    js_num(current + 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ADDR: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

    #[test]
    fn the_address_gate_is_the_evm_regex_not_a_loose_prefix() {
        assert!(is_referral_address(ADDR));
        assert!(is_referral_address(&ADDR.to_lowercase()));
        // 42 characters but not 40 hex digits.
        assert!(!is_referral_address("0x123"));
        assert!(!is_referral_address(
            "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
        ));
        // A capital `0X` prefix is outside `/^0x[0-9a-fA-F]{40}$/`.
        assert!(!is_referral_address(&ADDR.replacen("0x", "0X", 1)));
        assert!(!is_referral_address(""));
    }

    #[test]
    fn codes_are_minted_from_the_tail_of_the_canonical_address() {
        let lower = ADDR.to_lowercase();
        let code = referral_code(&lower);
        assert!(code.starts_with("strike-EAED"), "{code}");
        // `strike-` (7) + the 4-char tail + the 4-char suffix.
        assert_eq!(code.chars().count(), 15);
        // Suffix alphabet: no I/O/0/1 look-alikes.
        for ch in code["strike-EAED".len()..].chars() {
            assert!(CODE_ALPHABET.contains(ch), "unexpected {ch} in {code}");
            assert!(!ch.is_ascii_digit() || matches!(ch, '2'..='7'), "{ch}");
        }
        assert_ne!(
            referral_code(&lower),
            referral_code(&lower),
            "the suffix is random"
        );
        // A short key cannot be padded out of its own tail.
        assert_eq!(code_tail("0xab"), "0XAB");
    }

    #[test]
    fn a_random_suffix_never_leaves_the_alphabet() {
        for _ in 0..200 {
            let suffix = random_code_suffix(4);
            assert_eq!(suffix.chars().count(), 4);
            assert!(
                suffix.chars().all(|c| CODE_ALPHABET.contains(c)),
                "{suffix}"
            );
        }
    }

    #[test]
    fn only_string_codes_are_even_considered() {
        assert_eq!(
            clean_referral_code(Some(&json!(" strike-ABCD1234 "))).as_deref(),
            Some("strike-ABCD1234")
        );
        assert_eq!(
            clean_referral_code(Some(&json!(""))),
            None,
            "empty trims away"
        );
        assert_eq!(clean_referral_code(Some(&json!("   "))), None);
        assert_eq!(clean_referral_code(Some(&json!(123))), None, "not a string");
        assert_eq!(clean_referral_code(Some(&json!(null))), None);
        assert_eq!(clean_referral_code(Some(&json!(["x"]))), None);
        assert_eq!(clean_referral_code(None), None);
        // `.slice(0, 64)` — the tail is cut, not the whole thing rejected.
        assert_eq!(
            clean_referral_code(Some(&json!("c".repeat(100)))).map(|c| c.len()),
            Some(64)
        );
    }

    #[test]
    fn self_referral_and_unknown_codes_resolve_to_no_referrer() {
        let self_key = canonical_address(ADDR);
        let code = Some(json!("strike-ABCD12"));

        // Unknown code (no row) or a row with a blank/null address.
        assert_eq!(
            resolve_referrer_target(code.as_ref(), &self_key, None),
            None
        );
        assert_eq!(
            resolve_referrer_target(code.as_ref(), &self_key, Some(&json!(""))),
            None,
            "an empty user_address is falsy in the TS"
        );
        assert_eq!(
            resolve_referrer_target(code.as_ref(), &self_key, Some(&json!(null))),
            None
        );
        // Referring yourself — checked on the canonical form, so any casing of
        // the same wallet is refused.
        assert_eq!(
            resolve_referrer_target(code.as_ref(), &self_key, Some(&json!(ADDR))),
            None,
            "checksummed self"
        );
        assert_eq!(
            resolve_referrer_target(code.as_ref(), &self_key, Some(&json!(self_key.clone()))),
            None,
            "lowercased self"
        );
        // A genuine other wallet: the exact DB spelling is kept, because
        // `increment_referral_count` matches the primary key.
        let referrer = ADDR.replacen("5aAe", "ffff", 1);
        assert_ne!(canonical_address(&referrer), self_key);
        assert_eq!(
            resolve_referrer_target(code.as_ref(), &self_key, Some(&json!(referrer.clone())))
                .as_deref(),
            Some(referrer.as_str()),
            "spelling preserved verbatim"
        );
        // No code at all means no lookup was even attempted.
        assert_eq!(
            resolve_referrer_target(None, &self_key, Some(&json!(ADDR))),
            None
        );
    }

    #[test]
    fn scan_keys_carry_both_spellings_without_duplicates() {
        let lower = ADDR.to_lowercase();
        let keys = bet_scan_keys(&[ADDR.to_string(), lower.clone(), ADDR.to_string()]);
        // Canonical first, then the original spelling — and the repeat plus the
        // already-canonical wallet add nothing (`[...new Set(keys)]`).
        assert_eq!(keys, vec![lower.clone(), ADDR.to_string()]);
        assert_eq!(bet_scan_keys(&[]), Vec::<String>::new());
    }

    #[test]
    fn qualification_counts_only_real_money_bets() {
        let lower = ADDR.to_lowercase();
        let rows = vec![
            json!({"id": "bet-1", "wallet_address": lower, "created_at": "2026-01-01T00:00:00.000Z"}),
            // A demo bet id for the SAME real wallet must not qualify anyone.
            json!({"id": "demo-1700000000", "wallet_address": lower, "created_at": "2026-01-02T00:00:00.000Z"}),
            json!({"id": "bet-2", "wallet_address": ADDR.to_string(), "created_at": "2026-01-03T00:00:00.000Z"}),
            json!({"id": "bet-3", "wallet_address": "0xDEMO1111111111111111111111111111111111", "created_at": "2026-01-04T00:00:00.000Z"}),
        ];
        let (signals, scanned) = real_bet_signals(&rows);
        assert_eq!(
            scanned, 4,
            "the cap compares against rows READ, demo rows included"
        );
        assert_eq!(
            signals.len(),
            1,
            "both spellings fold into one canonical key"
        );
        let signal = find_signal(&signals, &canonical_address(ADDR)).expect("keyed canonically");
        assert_eq!(signal.real_bets, 2);
        assert_eq!(
            signal.first_real_bet_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z"),
            "created_at ASC means the first row wins; it is a pass-through value"
        );
        assert!(find_signal(&signals, "0xDEMO1111111111111111111111111111111111").is_none());
    }

    #[test]
    fn demo_referees_are_dropped_before_the_totals() {
        let rows = vec![
            json!({"user_address": ADDR, "created_at": "2026-01-01T00:00:00.000Z"}),
            json!({"user_address": "0xDEMO2222222222222222222222222222222222", "created_at": null}),
            json!({"user_address": ADDR.to_lowercase(), "created_at": null}),
        ];
        let (page_rows, dropped) = split_demo_rows(&rows);
        assert_eq!(page_rows.len(), 2);
        assert_eq!(dropped, 1);
        assert_eq!(split_demo_rows(&[]).1, 0);
    }

    #[test]
    fn totals_reconcile_the_db_count_against_the_page() {
        // count = 7 DB rows, 2 of them demo and dropped from this page of 5.
        let totals = friends_totals(Some(7), 2, 5, 2, 30);
        assert_eq!(
            keys(&totals),
            vec![
                "joined",
                "pageJoined",
                "qualified",
                "pending",
                "truncated",
                "qualifiedExact"
            ]
        );
        assert_eq!(totals["joined"], json!(5), "7 - 2 demo rows");
        assert_eq!(totals["pageJoined"], json!(5));
        assert_eq!(totals["qualified"], json!(2));
        assert_eq!(
            totals["pending"],
            json!(3),
            "the page denominators always sum"
        );
        assert_eq!(totals["truncated"], json!(false));
        assert_eq!(totals["qualifiedExact"], json!(true));

        // A longer network than one page.
        let big = friends_totals(Some(140), 0, 100, 10, 500);
        assert_eq!(big["joined"], json!(140));
        assert_eq!(big["truncated"], json!(true));

        // `Math.max(count - dropped, pageRows.length)`: a count that raced low
        // can never claim fewer referees than are on the page.
        assert_eq!(friends_totals(Some(3), 2, 5, 0, 0)["joined"], json!(5));
        // No count (a head-less query) falls back to the page length.
        assert_eq!(friends_totals(None, 2, 5, 0, 0)["joined"], json!(5));
        // The scan cap: `scanned === BET_SCAN_CAP` makes `qualified` a floor.
        assert_eq!(
            friends_totals(Some(5), 0, 5, 1, BET_SCAN_CAP as usize)["qualifiedExact"],
            json!(false)
        );
        // A `.limit(2000)` is clamped to MAX_ROWS_PER_QUERY rows, so a real
        // scan can never reach the cap: `qualifiedExact` is true by construction.
        const _: () = assert!(MAX_ROWS_PER_QUERY < BET_SCAN_CAP);
    }

    #[test]
    fn the_leaderboard_truncates_and_never_leaks_a_code() {
        let mut rows: Vec<Value> = Vec::new();
        for i in 0..60 {
            rows.push(json!({
                "user_address": format!("0x{:040x}", i + 1),
                "referral_count": 60 - i,
                "referral_code": "strike-SECRET1",
            }));
        }
        rows.push(json!({"user_address": "0xDEMO3333333333333333333333333333333333", "referral_count": 99}));

        let body = leaderboard_json(&rows, 20);
        let board = body["leaderboard"].as_array().unwrap();
        assert_eq!(
            board.len(),
            20,
            "the scan cap is 60, the visible slice is 20"
        );
        assert_eq!(keys(&board[0]), vec!["user_address", "referral_count"]);
        assert_eq!(
            board[0]["referral_count"],
            json!(60),
            "order is the DB's, desc"
        );
        assert_eq!(board[0]["user_address"], json!("0x0000…0001"));
        let serialized = body.to_string();
        assert!(
            !serialized.contains("SECRET"),
            "no referral code may reach the public board"
        );
        assert!(
            !serialized.contains("0xDEMO"),
            "demo wallets cannot crowd the board out"
        );

        // Fewer rows than the visible window, and an all-demo scan page.
        assert_eq!(
            leaderboard_json(&rows[..3], 20)["leaderboard"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            leaderboard_json(&[json!({"user_address": "0xDEMO4444444444444444444444444444444444", "referral_count": 1})], 20)["leaderboard"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(leaderboard_json(&[], 20), json!({"leaderboard": []}));
    }

    #[test]
    fn registration_responses_carry_only_the_two_public_fields() {
        let body = register_response(json!("strike-ABCD1234"), json!(0));
        assert_eq!(keys(&body), vec!["referral_code", "referral_count"]);
        assert_eq!(
            body,
            json!({"referral_code": "strike-ABCD1234", "referral_count": 0})
        );
        assert_eq!(
            keys(&friends_response(
                vec![json!({})],
                friends_totals(Some(1), 0, 1, 0, 0)
            )),
            vec!["friends", "totals"]
        );
    }

    #[test]
    fn late_attribution_fires_once_and_only_for_an_unclaimed_row() {
        let referrer = "0x9999999999999999999999999999999999999999";
        let unclaimed = json!({"referral_code": "c", "referral_count": 2, "referred_by": null});
        let claimed = json!({"referral_code": "c", "referral_count": 2, "referred_by": referrer});

        assert!(should_attempt_bind(Some(referrer), Some(&unclaimed)));
        assert!(
            !should_attempt_bind(Some(referrer), Some(&claimed)),
            "already attributed: never re-bound"
        );
        // `!existing.referred_by`: "" is falsy, so the row reads as unclaimed. The
        // `referred_by IS NULL` guard on the UPDATE still stops it being bound.
        assert!(
            should_attempt_bind(Some(referrer), Some(&json!({"referred_by": ""}))),
            "empty is falsy in the TS"
        );
        assert!(
            !should_attempt_bind(None, Some(&unclaimed)),
            "no referrer named"
        );
        assert!(
            !should_attempt_bind(Some(referrer), None),
            "the insert race lost and no row exists yet"
        );

        assert_eq!(bumped_referral_count(&unclaimed), js_num(3.0));
        assert_eq!(
            bumped_referral_count(&json!({"referral_count": null})),
            json!(1)
        );
        assert_eq!(
            bumped_referral_count(&json!({})),
            json!(1),
            "missing column counts as 0"
        );
        assert_eq!(
            bumped_referral_count(&json!({"referral_count": "4"})),
            json!(5)
        );
    }

    fn keys(value: &Value) -> Vec<String> {
        value
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }
}
