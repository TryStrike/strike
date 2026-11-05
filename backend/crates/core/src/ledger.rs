//! Pure money-movement logic behind `/api/balance/{bet,deposit,win,withdraw}`.
//!
//! Everything here is side-effect free: no DB, no network, no ambient config
//! or clock — handlers pass rows, secrets and timestamps in explicitly, and
//! tests pin every branch offline. The HTTP layer in the server crate
//! (`routes/balance_mutation.rs`) owns I/O; this module owns validation
//! order, amount math and the exact JSON bodies the TypeScript routes emit.
//!
//! Wire-parity rules inherited from the TS implementation:
//!   * a `Rejection` is `(status, body)` and reproduces `NextResponse.json`
//!     byte-for-byte in structure (key *order* is serde-alphabetical, as the
//!     gateway's own JSON is not order-guaranteed either);
//!   * every check fires in the TS source order, including the quirks that
//!     decide which 400 a caller gets (e.g. bet validates the ban *before*
//!     the positivity check, withdraw crashes on `currency.toUpperCase()`
//!     before it ever reaches the address);
//!   * money that only JS touches in f64 (balance comparisons, fee maths,
//!     `toFixed(8)` payouts) is ported as the same f64 operations — using
//!     exact decimals there would *change* results the TS wrote to the
//!     ledger. Multi-row cap totals keep the TS exact-integer path
//!     (`amount_to_base_units`, the port of `lib/balance/ledgerMath.ts`).
//!
//! Deliberate, documented deviations:
//!   * `amount_to_base_units` saturates at `i128::MAX` where JS BigInt would
//!     grow unbounded. Every consumer compares the total against amounts a
//!     `numeric(30,10)` ledger can hold (≤ 1e26 base units), six orders of
//!     magnitude below the saturation point, so the clamp cannot change a
//!     verdict — absurd magnitudes still fail the cap closed.
//!   * `to_fixed(8)` uses Rust's exact decimal formatting. A binary tie
//!     (JS `toFixed` picks the larger digit; Rust rounds half-to-even) would
//!     need an exact binary value with the digit past the cut equal to 5 and
//!     only zeros after — impossible at 6/8 decimals because those ties
//!     require a `5^k` factor no IEEE double carries. The two agree.
//!   * `parse_end_time` accepts the ISO shapes `crate::bets::parse_date_ms`
//!     covers, not every string V8's `Date.parse` guesses at.

use serde_json::{json, Map, Value};

use crate::address;
use crate::bets::{self, iso_ms, parse_date_ms, value_to_string};

/// `(status, body)` — the exact HTTP answer a rejection path produces.
pub type Rejection = (u16, Value);

// ---------------------------------------------------------------------------
// Shared JS-semantics helpers
// ---------------------------------------------------------------------------

pub fn error_body(message: &str) -> Value {
    json!({ "error": message })
}

/// The outer `catch` of every TS route.
pub fn route_crash() -> Rejection {
    (500, error_body("An error occurred processing your request"))
}

/// `Number(x)` for a JSON value: strings parse in full (hex, exponent and
/// `Infinity` included), `null` is 0, booleans are 1/0, everything else is
/// NaN (`None`). Differs from `bets::number_coerce` only for objects/arrays,
/// which JS reads as NaN but the coerce helper reads as 0.
pub fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => js_number_string(s),
        _ => None,
    }
}

fn js_number_string(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if t.eq_ignore_ascii_case("infinity") {
        return Some(f64::INFINITY);
    }
    if t.eq_ignore_ascii_case("+infinity") {
        return Some(f64::INFINITY);
    }
    if t.eq_ignore_ascii_case("-infinity") {
        return Some(f64::NEG_INFINITY);
    }
    // Number("0x10") === 16 — hex literals are valid JS Number input.
    if t.len() > 2 && (t.starts_with("0x") || t.starts_with("0X")) {
        let body = &t[2..];
        if body.chars().all(|c| c.is_ascii_hexdigit()) {
            return i64::from_str_radix(body, 16).ok().map(|v| v as f64);
        }
    }
    t.parse::<f64>().ok()
}

/// `String(value)` in a template literal — objects become `[object Object]`,
/// arrays join with commas, and null/undefined/bool/number print their
/// literal spellings. `value_to_string` is serde-shaped for composites, which
/// matters for the withdrawal intent message.
pub fn js_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `toNumber(value)` from the bet route: typeof-number keeps its value,
/// anything else goes through `Number()`, and non-finite becomes JS `null`
/// (`None`). A missing key is `undefined` -> `Number(undefined)` -> NaN.
pub fn to_number_opt(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let n = match value {
        Value::Number(_) => number_of(value),
        _ => number_of(value),
    };
    n.filter(|f| f.is_finite())
}

/// `parseFloat(String(x))`, with the TS null/undefined short-circuit.
pub fn parse_float_of(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    match value {
        Value::Null => None,
        other => parse_f64_string(&value_to_string(other)),
    }
}

fn parse_f64_string(s: &str) -> Option<f64> {
    bets::parse_float_prefix_str(s)
}

/// JS `value.toFixed(digits)`. Exponent-form output above 1e21 is not
/// reproduced: the ledger cannot produce a value that large through
/// `numeric(30,10)` after the conversions callers apply, and everything
/// below prints in fixed notation both languages agree on.
pub fn to_fixed(value: f64, digits: usize) -> String {
    format!("{value:.digits$}")
}

// ---------------------------------------------------------------------------
// ledgerMath.ts: exact base-unit sums for the withdrawal cap
// ---------------------------------------------------------------------------

/// USDC settles at 6 decimals (`USDC_DECIMALS`).
pub const USDC_DECIMALS: u32 = 6;

/// `amountToBaseUnits(value, decimals)`: whole-token amount -> 6-decimal
/// base units, rounding UP for fractional digits beyond the token precision.
/// Rejects NaN/Infinity/negatives/garbage with `None` so sums fail closed.
pub fn amount_to_base_units(value: &Value, decimals: u32) -> Option<i128> {
    let raw = match value {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    // The shape guard `/^-?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i` — rejecting
    // garbage before any parsing, exactly like the TS.
    if !decimal_shape_ok(&raw) {
        return None;
    }
    if raw.starts_with('-') {
        return None; // ledger amounts are never negative
    }

    let plain = is_plain_decimal(&raw);
    if plain {
        let (whole, fraction) = split_decimal(&raw);
        let kept: String = fraction.chars().take(decimals as usize).collect();
        let dropped: String = fraction.chars().skip(decimals as usize).collect();
        let combined = format!("{}{}", if whole.is_empty() { "0" } else { &whole }, pad_end(&kept, decimals));
        let mut units = parse_units_decimal(&combined);
        if dropped.chars().any(|c| c.is_ascii_digit() && c != '0') {
            units = units.saturating_add(1);
        }
        return Some(units);
    }

    // Exponent form / anything outside plain decimal notation: JS falls back
    // to `Math.ceil(num * 10**decimals)` on the double.
    let num = raw.parse::<f64>().ok()?;
    if !num.is_finite() || num < 0.0 {
        return None;
    }
    let scaled = (num * 10f64.powi(decimals as i32)).ceil();
    if !scaled.is_finite() {
        // `BigInt(Number.MAX_SAFE_INTEGER)` in the TS.
        return Some(9_007_199_254_740_991);
    }
    Some(if scaled > 0.0 { saturating_f64_to_i128(scaled) } else { 0 })
}

/// `String(1e21)` prints `1e+21`; serde prints `1e21`. Both spellings parse
/// here, so both languages take the same branch.
fn saturating_f64_to_i128(v: f64) -> i128 {
    if v >= i128::MAX as f64 {
        i128::MAX
    } else {
        v as i128
    }
}

fn parse_units_decimal(digits: &str) -> i128 {
    // A `numeric(30,10)` row can never carry more than ~31 significant
    // digits, and anything longer is absurd magnitude: clamp instead of
    // poisoning the cap with a panic (BigInt would just keep growing).
    digits.parse::<i128>().unwrap_or(i128::MAX)
}

fn pad_end(s: &str, width: u32) -> String {
    let mut out = s.to_string();
    while out.chars().count() < width as usize {
        out.push('0');
    }
    out
}

fn decimal_shape_ok(raw: &str) -> bool {
    let (body, exponent) = match raw.find(['e', 'E']) {
        Some(i) => (&raw[..i], Some(&raw[i + 1..])),
        None => (raw, None),
    };
    if let Some(exp) = exponent {
        let exp = exp.strip_prefix(['+', '-']).unwrap_or(exp);
        if exp.is_empty() || !exp.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    let body = body.strip_prefix('-').unwrap_or(body);
    if let Some(frac) = body.strip_prefix('.') {
        return !frac.is_empty() && frac.chars().all(|c| c.is_ascii_digit());
    }
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    if whole.is_empty() || !whole.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    match frac {
        Some(f) => f.chars().all(|c| c.is_ascii_digit()), // empty fraction allowed ("1.")
        None => true,
    }
}

fn is_plain_decimal(raw: &str) -> bool {
    let body = raw;
    if let Some(frac) = body.strip_prefix('.') {
        return !frac.is_empty() && frac.chars().all(|c| c.is_ascii_digit());
    }
    match body.split_once('.') {
        Some((w, f)) => {
            !w.is_empty() && w.chars().all(|c| c.is_ascii_digit()) && f.chars().all(|c| c.is_ascii_digit())
        }
        None => !body.is_empty() && body.chars().all(|c| c.is_ascii_digit()),
    }
}

fn split_decimal(raw: &str) -> (String, String) {
    let normalized = if raw.starts_with('.') {
        format!("0{raw}")
    } else {
        raw.to_string()
    };
    match normalized.split_once('.') {
        Some((w, f)) => (w.to_string(), f.to_string()),
        None => (normalized, String::new()),
    }
}

/// `sumAmountsToBaseUnits`: exact sum; `None` when any entry is unparseable,
/// so a corrupt ledger row fails the cap closed instead of disabling it.
pub fn sum_amounts_to_base_units<'a, I: IntoIterator<Item = &'a Value>>(values: I, decimals: u32) -> Option<i128> {
    let mut total: i128 = 0;
    for value in values {
        let units = amount_to_base_units(value, decimals)?;
        total = total.checked_add(units)?;
    }
    Some(total)
}

/// `baseUnitsToNumber`: base units -> whole tokens via the exact digit
/// split (not a division), so 1_500_000 is 1.5 and 1 is 0.000001.
pub fn base_units_to_number(base: i128, decimals: u32) -> f64 {
    let negative = base < 0;
    let magnitude = if base == i128::MIN {
        // -i128::MIN is not representable; the digit string below is what JS
        // would print for the magnitude anyway.
        (i128::MAX as u128 + 1).to_string()
    } else {
        base.abs().to_string()
    };
    let width = decimals as usize + 1;
    let digits = if magnitude.len() < width {
        format!("{}{magnitude}", "0".repeat(width - magnitude.len()))
    } else {
        magnitude
    };
    let split = digits.len() - decimals as usize;
    let whole = &digits[..split];
    let fraction = &digits[split..];
    let trimmed = fraction.trim_end_matches('0');
    let text = if trimmed.is_empty() {
        format!("{}0", if whole.is_empty() { "" } else { whole })
    } else {
        format!("{whole}.{trimmed}")
    };
    let n: f64 = text.parse().unwrap_or({
        // Degenerate fallback: divide, which is what a float model would do.
        (base.abs() as f64) / 10f64.powi(decimals as i32)
    });
    if negative { -n } else { n }
}

// ---------------------------------------------------------------------------
// platformFee.ts: tiered fee maths
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Free,
    Standard,
    Vip,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Standard => "standard",
            Self::Vip => "vip",
        }
    }
}

/// The deposit/withdraw tier lookups only accept these three spellings;
/// anything else (including a missing or erroring row) is `free`.
pub fn resolve_tier(tier_value: Option<&Value>) -> Tier {
    match tier_value.and_then(Value::as_str) {
        Some("standard") => Tier::Standard,
        Some("vip") => Tier::Vip,
        _ => Tier::Free,
    }
}

pub fn fee_percent(tier: Tier) -> f64 {
    match tier {
        Tier::Free => 0.10,
        Tier::Standard => 0.09,
        Tier::Vip => 0.08,
    }
}

/// `getFeePercentLabel` — `Math.round(percent * 100)`, which is 10/9/8 for
/// the three tiers.
pub fn fee_percent_label(tier: Tier) -> &'static str {
    match tier {
        Tier::Free => "10%",
        Tier::Standard => "9%",
        Tier::Vip => "8%",
    }
}

/// `calculateFeeAmount`: floor to 1e-8 in the same double order JS uses.
pub fn calculate_fee_amount(amount: f64, tier: Tier) -> f64 {
    let fee = amount * fee_percent(tier);
    (fee * 1e8).floor() / 1e8
}

/// `ethers.parseUnits(String(x), decimals)` *including its throw*: the fee
// collector skips the on-chain transfer when the amount has more fractional
/// digits than the token or any notation ethers rejects. A truncating parse
/// would move money the TS never moved.
pub fn parse_units_strict(raw: &str, decimals: u32) -> Option<u128> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with('-') {
        return None;
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (if w.is_empty() { "0" } else { w }, f),
        None => (s, ""),
    };
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if frac.chars().count() > decimals as usize {
        return None; // ethers throws "too many decimal places"
    }
    let combined = format!("{whole}{}", pad_end(frac, decimals));
    combined.parse::<u128>().ok()
}

// ---------------------------------------------------------------------------
// The banned-wallet message every path shares
// ---------------------------------------------------------------------------

pub const BANNED_MESSAGE: &str = "This wallet is banned from the platform.";

pub fn banned_rejection() -> Rejection {
    (403, error_body(BANNED_MESSAGE))
}

// ---------------------------------------------------------------------------
// POST /api/balance/bet
// ---------------------------------------------------------------------------

/// `BALANCE_SETTLEMENT_SECRET` missing: the TS 503 body depends on NODE_ENV.
pub fn bet_signing_unavailable(is_development: bool) -> Rejection {
    let message = if is_development {
        "Set BALANCE_SETTLEMENT_SECRET in .env (any long random string) and restart the dev server."
    } else {
        "Betting is temporarily unavailable. Please try again later."
    };
    (503, error_body(message))
}

pub struct BetHead<'a> {
    pub user_address: &'a Value,
    pub bet_amount: &'a Value,
    /// `Number(betAmount)` — used for every comparison; the *original* value
    /// is what reaches the RPC (a stringified amount must land verbatim, as
    /// node-pg stringified it for the TS).
    pub amount: f64,
}

/// Checks 1-3 of the bet route: required fields, finiteness, address shape.
/// The ban check runs between this and `bet_tail`.
pub fn bet_head(body: &Value) -> Result<BetHead<'_>, Rejection> {
    let user_address = body.get("userAddress");
    let bet_amount = body.get("betAmount");
    if !bets::is_truthy(user_address)
        || matches!(bet_amount, None | Some(Value::Null))
    {
        return Err((400, error_body("Missing required fields: userAddress, betAmount")));
    }
    let bet_amount = bet_amount.unwrap();
    let amount = number_of(bet_amount);
    if amount.is_none() || !amount.map(|f| f.is_finite()).unwrap_or(false) {
        return Err((400, error_body("Invalid bet amount")));
    }
    let address_ok = user_address.and_then(Value::as_str).map(address::is_address).unwrap_or(false);
    if !address_ok {
        return Err((400, error_body("Invalid wallet address format")));
    }
    Ok(BetHead { user_address: user_address.unwrap(), bet_amount, amount: amount.unwrap() })
}

pub struct BetPlan {
    pub amount: f64,
    /// The raw betAmount JSON value for the `p_bet_amount` bind.
    pub bet_amount: Value,
    pub user_key: String,
    pub currency: String,
}

/// Checks after the ban probe: positivity, multiplier, target cell, then the
/// currency normalisation (which *crashes* the TS route on a non-string, so
/// it must run last and only after everything else passed).
pub fn bet_tail(head: BetHead<'_>, body: &Value) -> Result<BetPlan, Rejection> {
    if !(head.amount > 0.0) {
        return Err((400, error_body("Bet amount must be greater than zero")));
    }
    let multiplier = body.get("multiplier");
    let mult_num = multiplier.map(number_of).flatten();
    let lt_one = mult_num.map(|f| f < 1.0).unwrap_or(false);
    if !bets::is_truthy(multiplier) || lt_one {
        return Err((400, error_body("Multiplier must be at least 1.0")));
    }
    let is_real_number = matches!(multiplier, Some(Value::Number(_)));
    if !is_real_number || !mult_num.map(|f| f.is_finite()).unwrap_or(false) || mult_num.unwrap() > 20.0 {
        return Err((400, error_body("Multiplier exceeds maximum allowed value")));
    }

    let target_cell = body.get("targetCell");
    let cell_ok = match target_cell {
        Some(cell) if cell.is_object() => {
            let id_missing = matches!(cell.get("id"), None | Some(Value::Null));
            let price_change_missing = cell.get("priceChange").is_none();
            !(id_missing || price_change_missing)
        }
        // Truthy non-objects pass `!targetCell` but have no usable `id`.
        Some(cell) if bets::is_truthy(Some(cell)) => cell.get("id").is_some_and(|v| !v.is_null())
            && cell.get("priceChange").is_some(),
        _ => false,
    };
    if !cell_ok {
        return Err((400, error_body("Invalid target cell data")));
    }

    // `currency.toUpperCase()` after the default destructure: null and
    // non-strings throw a TypeError into the route's outer catch (500).
    let currency = match body.get("currency") {
        None => "USDC".to_string(),
        Some(Value::String(s)) => s.to_uppercase(),
        Some(_) => return Err(route_crash()),
    };

    Ok(BetPlan {
        amount: head.amount,
        bet_amount: head.bet_amount.clone(),
        user_key: address::canonical(&value_to_string(head.user_address)),
        currency,
    })
}

pub enum BetRows {
    /// The ledger row the deduction will hit; carries its `user_address`.
    Ledger(String),
    Reject(Rejection),
}

/// Empty / frozen / banned / pick-the-richest-sufficient-row, in TS order.
/// `rows` come from `SELECT user_address, balance, status` and are scanned in
/// result order for the status guards before any sorting.
pub fn bet_choose_row(rows: &[Value], amount: f64, currency: &str) -> BetRows {
    if rows.is_empty() {
        return BetRows::Reject((
            400,
            error_body(&format!(
                "No house balance for this wallet in {currency}. Open the Wallet tab and deposit once for this chain, then try again."
            )),
        ));
    }
    for row in rows {
        match row.get("status").and_then(Value::as_str) {
            Some("frozen") => {
                return BetRows::Reject((403, error_body("Account is frozen. Bets are disabled.")))
            }
            Some("banned") => {
                return BetRows::Reject((403, error_body("Account is banned.")))
            }
            _ => {}
        }
    }
    let mut sorted: Vec<&Value> = rows.iter().collect();
    // JS sort comparator `Number(b.balance) - Number(a.balance)`; NaN results
    // leave the order implementation-defined in V8, matching here is moot
    // because balances are NOT NULL numerics.
    sorted.sort_by(|a, b| {
        let ba = to_number_opt(a.get("balance")).unwrap_or(f64::NAN);
        let bb = to_number_opt(b.get("balance")).unwrap_or(f64::NAN);
        bb.partial_cmp(&ba).unwrap_or(std::cmp::Ordering::Equal)
    });
    let chosen = sorted.iter().find(|row| {
        to_number_opt(row.get("balance")).map(|b| b >= amount).unwrap_or(false)
    });
    match chosen {
        Some(row) => BetRows::Ledger(
            row.get("user_address").and_then(Value::as_str).unwrap_or_default().to_string(),
        ),
        None => BetRows::Reject((
            400,
            error_body(&format!(
                "Insufficient house balance. Deposit more {currency} from the Wallet tab."
            )),
        )),
    }
}

/// `sanitizeBetRequestId`: client keys must look like `crypto.randomUUID()`
/// output or trimmed neighbours; garbage never reaches the unique index.
pub fn sanitize_bet_request_id(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str).map(str::trim)?;
    let len = raw.chars().count();
    if (8..=64).contains(&len) && raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Some(raw.to_string())
    } else {
        None
    }
}

/// `bet_req_${roundId}_${userKey.slice(-8)}_${Date.now()}`.
pub fn derived_bet_request_id(round_id: Option<&Value>, user_key: &str, now_ms: i64) -> String {
    let round = round_id.map(value_to_string).unwrap_or_else(|| "undefined".to_string());
    let tail: String = user_key.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
    format!("bet_req_{round}_{tail}_{now_ms}")
}

/// `bet_${Date.now()}_${randomUUID().replace(/-/g,'').slice(0,12)}`.
pub fn build_bet_id(now_ms: i64, uuid_hex12: &str) -> String {
    format!("bet_{now_ms}_{uuid_hex12}")
}

/// `Number((betAmount * multiplier).toFixed(8))`. `None` models the TS
/// RangeError from `toFixed` on a non-finite product, which the route's outer
/// catch turns into 500.
pub fn bet_max_payout(amount: f64, multiplier: f64) -> Option<f64> {
    let product = amount * multiplier;
    if !product.is_finite() {
        return None;
    }
    to_fixed(product, 8).parse::<f64>().ok()
}

/// `parseEndTime`: epoch-ms numbers or ISO strings, and the JS RangeError
/// when the number is outside the Date range (the outer catch -> 500).
pub fn bet_end_time(value: Option<&Value>) -> Result<Option<String>, Rejection> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let ms = n.as_f64();
            match ms {
                Some(ms) if ms.is_finite() => date_to_iso(ms as i64),
                _ => Ok(None),
            }
        }
        Some(Value::String(s)) => match parse_date_ms(s) {
            Some(ms) => date_to_iso(ms),
            None => Ok(None),
        },
        Some(_) => Ok(None),
    }
}

fn date_to_iso(ms: i64) -> Result<Option<String>, Rejection> {
    // ECMAScript Date range: ±8.64e15 ms. Beyond it `toISOString()` throws
    // (an Invalid Date), which the TS route surfaces as its 500.
    if ms.abs() > 8_640_000_000_000_000 {
        return Err(route_crash());
    }
    Ok(Some(iso_ms(ms)))
}

/// `createSettlementToken` inputs the route must sign *before* the deduction.
pub struct TokenMint {
    pub bet_id: String,
    pub user_address: String,
    pub currency: String,
    pub max_payout: f64,
}

pub enum BetRpcDecision {
    /// Duplicate that minted a token first time: re-sign with the stored
    /// payout ceiling so the retry keeps a settlement window.
    ReplayMint(TokenMint),
    /// Duplicate with a stored token and no usable ceiling: replay it.
    ReplayStored { bet_id: String, token: String, new_balance: Option<f64> },
    /// Duplicate that never got a token: 409.
    Conflict { body: Value },
    /// Anything not an explicit well-formed success.
    FailClosed { status: u16, body: Value },
    Success { new_balance: f64, bet_id: String, token: String },
}

/// Maps the `place_bet_locked` JSON onto the exact TS responses. The replay
/// re-sign branch returns the mint inputs; the HTTP layer owns signing because
/// the secret lives in `config()`.
pub fn bet_rpc_decision(result: &Value, ledger_user_key: &str, currency: &str) -> BetRpcDecision {
    let new_balance = to_number_opt(result.get("new_balance"));
    if result.get("duplicate").and_then(Value::as_bool).unwrap_or(false) {
        let bet_id = result.get("bet_id").and_then(Value::as_str).filter(|s| !s.is_empty());
        let token = result.get("settlement_token").and_then(Value::as_str).filter(|s| !s.is_empty());
        if let (Some(bet_id), Some(_token)) = (bet_id, token) {
            let stored = to_number_opt(result.get("max_payout"));
            return match stored {
                Some(max) if max > 0.0 => BetRpcDecision::ReplayMint(TokenMint {
                    bet_id: bet_id.to_string(),
                    user_address: result
                        .get("user_address")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(ledger_user_key)
                        .to_string(),
                    currency: result
                        .get("currency")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(currency)
                        .to_string(),
                    max_payout: max,
                }),
                _ => BetRpcDecision::ReplayStored {
                    bet_id: bet_id.to_string(),
                    token: token.unwrap_or_default().to_string(),
                    new_balance,
                },
            };
        }
        let error = result
            .get("error")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Bet already processed. Please place a new bet.");
        return BetRpcDecision::Conflict { body: error_body(error) };
    }

    // Fail closed unless every success field is explicitly present.
    let explicit_success = result.get("success").and_then(Value::as_bool) == Some(true);
    let bet_id = result.get("bet_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let token = result.get("settlement_token").and_then(Value::as_str).filter(|s| !s.is_empty());
    if explicit_success && bet_id.is_some() && token.is_some() && new_balance.is_some() {
        return BetRpcDecision::Success {
            new_balance: new_balance.unwrap(),
            bet_id: bet_id.unwrap().to_string(),
            token: token.unwrap().to_string(),
        };
    }

    let error = result.get("error").and_then(Value::as_str).filter(|s| !s.is_empty());
    let status_and_body: (u16, Value) = match error {
        Some("Insufficient balance") => (400, error_body(&format!("Insufficient house balance. Deposit more {currency}."))),
        Some("User not found") => (
            400,
            error_body(&format!(
                "No house balance for this wallet in {currency}. Deposit from the Wallet tab first."
            )),
        ),
        Some(BANNED_MESSAGE) => (403, error_body(BANNED_MESSAGE)),
        Some(other) if other.to_lowercase().contains("frozen") => (403, error_body(other)),
        Some(other) => (400, error_body(other)),
        None => (503, error_body("Bet placement failed")),
    };
    BetRpcDecision::FailClosed { status: status_and_body.0, body: status_and_body.1 }
}

pub fn bet_success_body(remaining_balance: Value, bet_id: &str, settlement_token: &str, duplicate: bool) -> Value {
    let mut map = Map::new();
    map.insert("success".into(), json!(true));
    if duplicate {
        map.insert("duplicate".into(), json!(true));
        map.insert("message".into(), json!("Bet already processed"));
    }
    map.insert("remainingBalance".into(), remaining_balance);
    map.insert("betId".into(), json!(bet_id));
    map.insert("settlementToken".into(), json!(settlement_token));
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// POST /api/balance/deposit
// ---------------------------------------------------------------------------

pub struct DepositHead<'a> {
    pub user_address: &'a Value,
    pub tx_hash: &'a Value,
    /// `Number(amount)` — every fee/verification/RPC number derives from it.
    pub amount: f64,
}

pub fn deposit_head(body: &Value) -> Result<DepositHead<'_>, Rejection> {
    let user_address = body.get("userAddress");
    let amount = body.get("amount");
    let tx_hash = body.get("txHash");
    if !bets::is_truthy(user_address)
        || matches!(amount, None | Some(Value::Null))
        || !bets::is_truthy(tx_hash)
    {
        return Err((400, error_body("Missing required fields: userAddress, amount, txHash")));
    }
    let amount = amount.unwrap();
    let value = number_of(amount);
    if value.is_none() || !value.map(|f| f.is_finite()).unwrap_or(false) {
        return Err((400, error_body("Invalid deposit amount")));
    }
    Ok(DepositHead { user_address: user_address.unwrap(), tx_hash: tx_hash.unwrap(), amount: value.unwrap() })
}

/// Post-ban deposit checks: positivity, the `String(currency ?? '')`
/// normalisation and the supported-currency gate.
pub fn deposit_currency(body: &Value, amount: f64) -> Result<String, Rejection> {
    if !(amount > 0.0) {
        return Err((400, error_body("Deposit amount must be greater than zero")));
    }
    let raw = match body.get("currency") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_to_string(v),
    };
    let normalized = raw.to_uppercase();
    if normalized != "USDC" {
        return Err((400, error_body(&format!("Unsupported deposit currency: {normalized}"))));
    }
    Ok(normalized)
}

/// `verification.retryable` branch: 502 with progress keys *only* when the
/// TS included them (insufficient confirmations).
pub fn deposit_pending_body(reason: &str, confirmations: Option<u64>) -> (u16, Value) {
    let mut map = Map::new();
    map.insert("error".into(), json!("Deposit could not be verified on-chain yet. Please retry."));
    map.insert("retryable".into(), json!(true));
    map.insert("code".into(), json!(reason));
    if let Some(c) = confirmations {
        map.insert("confirmations".into(), json!(c));
        map.insert("requiredConfirmations".into(), json!(MIN_CONFIRMATIONS_TS));
    }
    (502, Value::Object(map))
}

pub const MIN_CONFIRMATIONS_TS: u64 = 3;

/// Terminal on-chain rejection: 400 with the verifier's message embedded.
pub fn deposit_invalid_body(message: &str) -> (u16, Value) {
    (
        400,
        json!({
            "error": format!("Deposit transaction is not valid: {message}"),
            "retryable": false,
            "code": "amount_mismatch_placeholder",
        }),
    )
}

/// Same, with the real reason code.
pub fn deposit_terminal(reason: &str, message: &str) -> (u16, Value) {
    (
        400,
        json!({
            "error": format!("Deposit transaction is not valid: {message}"),
            "retryable": false,
            "code": reason,
        }),
    )
}

pub fn deposit_duplicate_body() -> (u16, Value) {
    (
        409,
        json!({
            "error": "This transaction has already been credited",
            "duplicate": true,
            "code": "already_credited",
        }),
    )
}

pub fn deposit_unavailable() -> (u16, Value) {
    (
        503,
        json!({ "error": "Service temporarily unavailable. Please try again.", "retryable": true }),
    )
}

/// `/duplicate key|unique/i` on the RPC's error string.
pub fn is_audit_duplicate(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("duplicate key") || lower.contains("unique")
}

/// `` `${txHash}|feeTx:${feeTxHash}` `` when a fee transfer happened.
pub fn combined_tx_hash(tx_hash: &Value, fee_tx: Option<&str>) -> String {
    let tx = js_to_string(tx_hash);
    match fee_tx {
        Some(fee) => format!("{tx}|feeTx:{fee}"),
        None => tx,
    }
}

/// The amount string `verify_deposit` must be handed: the claimed amount in
/// base units rounded UP to 6 decimals (the `requiredBaseUnits` direction —
/// the treasury must have received at least this). Values beyond what u128
/// can express are clamped; no real transfer can satisfy them, so the
/// verification fails closed exactly like the TS one does.
pub fn deposit_required_amount_string(amount: f64) -> String {
    let units = amount_to_base_units(&Value::from(amount), USDC_DECIMALS);
    let units = match units {
        Some(u) => u,
        None => 9_007_199_254_740_991, // MAX_SAFE_INTEGER clamp, as requiredBaseUnits
    };
    let units = units.min(u128::MAX as i128) as u128;
    let whole = units / 1_000_000;
    let frac = units % 1_000_000;
    format!("{whole}.{frac:06}")
}

pub fn deposit_net(amount: f64, tier: Tier) -> (f64, f64) {
    let fee = calculate_fee_amount(amount, tier);
    (fee, amount - fee)
}

pub fn deposit_net_rejection(label: &str) -> Rejection {
    (400, error_body(&format!("Deposit amount after {label} fee must be greater than zero")))
}

pub fn deposit_success_body(new_balance: Option<f64>, fee: f64, net: f64, credited_at: &str) -> Value {
    json!({
        "success": true,
        "newBalance": bets::js_num(new_balance.unwrap_or(f64::NAN)),
        "fee": bets::js_num(fee),
        "netCredited": bets::js_num(net),
        "creditedAt": credited_at,
    })
}

// ---------------------------------------------------------------------------
// POST /api/balance/win
// ---------------------------------------------------------------------------

pub struct WinRequest<'a> {
    pub user_address: &'a str,
    pub win_amount: &'a Value,
    pub currency: Value,
    pub bet_id: &'a Value,
    pub settlement_token: Value,
}

pub fn win_head(body: &Value, allow_test_bypass: bool) -> Result<WinRequest<'_>, Rejection> {
    let user_address = body.get("userAddress");
    let win_amount = body.get("winAmount");
    if !bets::is_truthy(user_address) || matches!(win_amount, None | Some(Value::Null)) {
        return Err((400, error_body("Missing required fields: userAddress, winAmount")));
    }
    let bet_id = body.get("betId");
    let settlement_token = body.get("settlementToken");
    if !bets::is_truthy(bet_id) || (!bets::is_truthy(settlement_token) && !allow_test_bypass) {
        return Err((400, error_body("Missing required fields: betId, settlementToken")));
    }
    Ok(WinRequest {
        user_address: user_address.and_then(Value::as_str).unwrap_or_default(),
        win_amount: win_amount.unwrap(),
        currency: body.get("currency").cloned().unwrap_or(Value::String("USDC".into())),
        bet_id: bet_id.unwrap(),
        settlement_token: settlement_token.cloned().unwrap_or(Value::Null),
    })
}

/// Post-address/amount checks: positivity+strict-finiteness of winAmount and
/// the currency normalisation (a non-string truthy currency is a TS
/// TypeError -> 500; falsy falls back to USDC before `.toUpperCase`).
pub fn win_after_ban(req: &WinRequest<'_>) -> Result<String, Rejection> {
    let amount = number_of(req.win_amount);
    let is_number = matches!(req.win_amount, Value::Number(_));
    let positive = amount.map(|f| f > 0.0).unwrap_or(false);
    if !positive || !is_number || !amount.map(|f| f.is_finite()).unwrap_or(false) {
        return Err((400, error_body("Win amount must be greater than zero")));
    }
    let currency = match &req.currency {
        Value::String(s) if !s.is_empty() => s.to_uppercase(),
        v if bets::is_truthy(Some(v)) => return Err(route_crash()),
        _ => "USDC".to_string(),
    };
    if currency != "USDC" {
        return Err((400, error_body("Unsupported currency")));
    }
    Ok(currency)
}

/// The settlement-token binding: identity match and the payout ceiling
/// (`winAmount > maxPayout + 1e-8`). Caller verifies the HMAC first; a
/// `None` payload maps to the 401 here.
pub fn win_token_failure(
    payload: Option<&crate::crypto::SettlementPayload>,
    bet_id: &Value,
    user_key: &str,
    currency: &str,
    win_amount: f64,
) -> Option<Rejection> {
    let payload = payload?;
    let bet_id_matches = bet_id.as_str() == Some(payload.bet_id.as_str());
    let address_matches = payload.user_address.starts_with("0x")
        && address::canonical(&payload.user_address) == user_key;
    if !bet_id_matches || !address_matches || payload.currency != currency {
        return Some((401, error_body("Settlement token does not match bet")));
    }
    if win_amount > payload.max_payout + 1e-8 {
        return Some((400, error_body("Win amount exceeds approved payout")));
    }
    None
}

/// `settleFailureFromThrow`: maps the PL/pgSQL exception text onto responses.
pub fn win_map_settle_error(message: &str) -> Option<Rejection> {
    let lower = message.to_lowercase();
    if lower.contains("strike_unknown_bet") {
        return Some((400, error_body("Unknown bet: no server-side record of this payout")));
    }
    if lower.contains("strike_payout_exceeds_max") {
        return Some((400, error_body("Win amount exceeds approved payout")));
    }
    if lower.contains("strike_invalid_payout_amount") {
        return Some((400, error_body("Win amount must be greater than zero")));
    }
    None
}

pub fn win_unavailable() -> Rejection {
    (503, error_body("Service temporarily unavailable. Please try again."))
}

pub enum WinRpcDecision {
    Duplicate(Value),
    FailClosed { status: u16, body: Value },
    Success(Value),
}

pub fn win_rpc_decision(result: &Value, bet_id: &str, win_amount: f64) -> WinRpcDecision {
    let new_balance = parse_float_of(result.get("new_balance"));
    if result.get("duplicate").and_then(Value::as_bool).unwrap_or(false) {
        return WinRpcDecision::Duplicate(json!({
            "success": true,
            "duplicate": true,
            "message": "Payout already processed for this bet",
            "newBalance": bets::js_num(new_balance.unwrap_or(f64::NAN)),
            "betId": bet_id,
        }));
    }
    let explicit_success = result.get("success").and_then(Value::as_bool) == Some(true);
    if !explicit_success || new_balance.is_none() {
        let error = result.get("error").and_then(Value::as_str).filter(|s| !s.is_empty());
        return WinRpcDecision::FailClosed {
            status: if error.is_some() { 400 } else { 503 },
            body: error_body(error.unwrap_or("Failed to credit winnings")),
        };
    }
    WinRpcDecision::Success(json!({
        "success": true,
        "newBalance": bets::js_num(new_balance.unwrap()),
        "winAmount": bets::js_num(win_amount),
    }))
}

// ---------------------------------------------------------------------------
// POST /api/balance/withdraw
// ---------------------------------------------------------------------------

pub struct WithdrawHead<'a> {
    pub user_address: &'a Value,
    pub amount: &'a Value,
    /// `Number(amount)` for the comparisons before the exact-integer path.
    pub amount_num: f64,
    pub currency: String,
}

pub fn withdraw_head(body: &Value) -> Result<WithdrawHead<'_>, Rejection> {
    let user_address = body.get("userAddress");
    let amount = body.get("amount");
    if !bets::is_truthy(user_address) || matches!(amount, None | Some(Value::Null)) {
        return Err((400, error_body("Missing required fields: userAddress, amount")));
    }
    let amount = amount.unwrap();
    let value = number_of(amount);
    if value.is_none() || !value.map(|f| f.is_finite()).unwrap_or(false) {
        return Err((400, error_body("Invalid withdrawal amount")));
    }
    // `currency.toUpperCase()` right after destructuring: null/non-strings
    // crash the TS route (500) before the address check even runs.
    let currency = match body.get("currency") {
        None => "USDC".to_string(),
        Some(Value::String(s)) => s.to_uppercase(),
        Some(_) => return Err(route_crash()),
    };
    Ok(WithdrawHead { user_address: user_address.unwrap(), amount, amount_num: value.unwrap(), currency })
}

pub fn withdraw_positive() -> Rejection {
    (400, error_body("Withdrawal amount must be greater than zero"))
}

pub fn withdraw_missing_authorization() -> Rejection {
    (401, error_body("Missing signed withdrawal authorization"))
}

pub fn withdraw_expired() -> Rejection {
    (401, error_body("Withdrawal authorization expired. Please sign again."))
}

pub fn withdraw_signature_mismatch() -> Rejection {
    (
        401,
        json!({
            "error": "The withdrawal was signed by a different wallet than the account holding this balance. Sign in with the wallet that owns the balance and request again.",
            "code": "signature_mismatch",
        }),
    )
}

/// The exact EIP-191 message from `withdraw` (mirrors
/// `lib/balance/withdrawalIntent.ts` call sites): the *raw* userAddress
/// spelling, `amount.toFixed(8)`, the uppercased currency and the raw
/// signedAt. `amount.toFixed` throws on anything that is not a number — the
/// outer catch answers 500.
pub fn withdraw_intent_message(
    user_address: &Value,
    amount: &Value,
    currency: &str,
    signed_at: &Value,
) -> Result<String, Rejection> {
    let amount_num = match amount {
        Value::Number(n) => n.as_f64(),
        _ => None,
    };
    let amount_fixed = match amount_num {
        Some(a) if a.is_finite() => to_fixed(a, 8),
        // (1e21).toFixed(8) is legal in JS and prints exponent form; the
        // ledger caps make that unreachable for a signed intent — a
        // non-finite or non-numeric amount is the TypeError path either way.
        _ => return Err(route_crash()),
    };
    Ok(format!(
        "STRIKE withdrawal authorization\naddress:{}\namount:{amount_fixed}\ncurrency:{currency}\nsignedAt:{}",
        js_to_string(user_address),
        js_to_string(signed_at)
    ))
}

pub enum WithdrawRows {
    /// `(dbAddress, balance row value)` of the row the payout is keyed on.
    Ledger(String, Value),
    Reject(Rejection),
}

pub fn withdraw_choose_row(rows: &[Value], amount: f64, currency_raw: &str) -> WithdrawRows {
    if rows.is_empty() {
        return WithdrawRows::Reject((404, error_body("User record not found")));
    }
    for row in rows {
        match row.get("status").and_then(Value::as_str) {
            Some("frozen") => {
                return WithdrawRows::Reject((403, error_body("Account is frozen. Withdrawals are disabled.")))
            }
            Some("banned") => return WithdrawRows::Reject((403, error_body("Account is banned."))),
            _ => {}
        }
    }
    let mut sorted: Vec<&Value> = rows.iter().collect();
    sorted.sort_by(|a, b| {
        let ba = to_number_opt(a.get("balance")).unwrap_or(f64::NAN);
        let bb = to_number_opt(b.get("balance")).unwrap_or(f64::NAN);
        bb.partial_cmp(&ba).unwrap_or(std::cmp::Ordering::Equal)
    });
    match sorted.iter().find(|row| to_number_opt(row.get("balance")).map(|b| b >= amount).unwrap_or(false)) {
        Some(row) => WithdrawRows::Ledger(
            row.get("user_address").and_then(Value::as_str).unwrap_or_default().to_string(),
            row.get("balance").cloned().unwrap_or(Value::Null),
        ),
        // NOTE the TS interpolates the *raw* (un-normalised) currency here.
        None => WithdrawRows::Reject((400, error_body(&format!("Insufficient house balance in {currency_raw}")))),
    }
}

/// `withdraw` row pass-through for the replay branch.
pub fn withdraw_replay_body(existing: &Value, balance: &Value) -> Value {
    json!({
        "success": true,
        "duplicate": true,
        "status": existing.get("status").cloned().unwrap_or(Value::Null),
        "requestId": existing.get("id").cloned().unwrap_or(Value::Null),
        "newBalance": balance.clone(),
        "feeAmount": existing.get("fee_amount").cloned().unwrap_or(Value::Null),
        "netAmount": existing.get("net_amount").cloned().unwrap_or(Value::Null),
    })
}

/// The `max payout = floor(total_deposited * 1.08)` cap in exact base units.
/// `Err` carries the response; `Ok(())` means "within cap or no deposits".
pub fn withdraw_cap_check(
    amount: &Value,
    deposits: &[Value],
    withdrawn: &[Value],
    pending: &[Value],
    normalized_currency: &str,
) -> Result<(), Rejection> {
    let amount_base = amount_to_base_units(amount, USDC_DECIMALS);
    let null = Value::Null;
    let deposited = sum_amounts_to_base_units(deposits.iter().map(|r| r.get("amount").unwrap_or(&null)), USDC_DECIMALS);
    let withdrawn_sum = sum_amounts_to_base_units(withdrawn.iter().map(|r| r.get("amount").unwrap_or(&null)), USDC_DECIMALS);
    let pending_sum = sum_amounts_to_base_units(pending.iter().map(|r| r.get("amount").unwrap_or(&null)), USDC_DECIMALS);
    let (amount_base, deposited, withdrawn_sum, pending_sum) = match (amount_base, deposited, withdrawn_sum, pending_sum) {
        (Some(a), Some(d), Some(w), Some(p)) => (a, d, w, p),
        // An unparseable row disables the comparison: fail closed, 503.
        _ => return Err((503, error_body("Service temporarily unavailable. Please try again."))),
    };
    if deposited <= 0 {
        return Ok(());
    }
    // floor(deposited * 1.08), never rounded up.
    let max_withdrawable = deposited.saturating_mul(108) / 100;
    let already_out = withdrawn_sum.saturating_add(pending_sum);
    if already_out.saturating_add(amount_base) > max_withdrawable {
        let remaining = max_withdrawable - already_out;
        let allowance = if remaining > 0 {
            format!(
                "{} {normalized_currency} remaining",
                to_fixed(base_units_to_number(remaining, USDC_DECIMALS), 6)
            )
        } else {
            "no remaining withdrawal allowance".to_string()
        };
        return Err((
            400,
            error_body(&format!(
                "Withdrawal amount exceeds your available limit. You have {allowance}. Please contact support if you believe this is an error."
            )),
        ));
    }
    Ok(())
}

pub const FREQUENCY_REVIEW_THRESHOLD: i64 = 10;

/// `isWithdrawalFrequencyReviewExemptWallet` — canonical-set membership,
/// with the env list and the candidate both canonicalised.
pub fn frequency_review_exempt(address: &str, exempt_list: &[String]) -> bool {
    let normalized = address::canonical(address.trim());
    !normalized.is_empty() && exempt_list.iter().any(|entry| entry == &normalized)
}

pub fn frequency_review_triggered(exempt: bool, withdrawal_count: i64) -> bool {
    !exempt && withdrawal_count >= FREQUENCY_REVIEW_THRESHOLD
}

pub fn frequency_review_stamp(withdrawal_count: i64) -> String {
    format!("FREQUENCY_REVIEW:count={}", withdrawal_count + 1)
}

pub fn withdraw_net(amount: f64, tier: Tier) -> (f64, f64) {
    // `Number(calculateFeeAmount(amount, tier).toFixed(8))` and
    // `Number((amount - feeAmount).toFixed(8))`.
    let fee = to_fixed(calculate_fee_amount(amount, tier), 8).parse::<f64>().unwrap_or(0.0);
    let net = to_fixed(amount - fee, 8).parse::<f64>().unwrap_or(0.0);
    (fee, net)
}

pub fn withdraw_net_rejection(label: &str) -> Rejection {
    (400, error_body(&format!("Withdrawal amount after {label} fee must be greater than zero")))
}

pub fn withdraw_insert_failed() -> Rejection {
    (500, error_body("Failed to create withdrawal request. Please try again."))
}

#[allow(clippy::too_many_arguments)]
pub fn withdraw_success_body(
    request_id: Value,
    balance: &Value,
    fee: f64,
    net: f64,
    requested_at: &str,
    triggers_frequency_review: bool,
    withdrawal_count: i64,
) -> Value {
    json!({
        "success": true,
        "status": "pending",
        "requestId": request_id,
        "newBalance": balance.clone(),
        "feeAmount": bets::js_num(fee),
        "netAmount": bets::js_num(net),
        "requestedAt": requested_at,
        "frequencyReview": triggers_frequency_review,
        "withdrawalCount": withdrawal_count + 1,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ADDR: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

    // -- amount parsing -----------------------------------------------------

    #[test]
    fn base_units_rejects_garbage_and_negatives() {
        for bad in [
            json!("NaN"), json!("Infinity"), json!("-Infinity"), json!("abc"), json!(""),
            json!("-5"), json!("-0.5"), json!(true), json!(null), json!({}), json!([]),
            json!("1e"), json!("1.2.3"), json!("--1"), json!(" 1e9e9 "),
        ] {
            assert_eq!(amount_to_base_units(&bad, 6), None, "accepted {bad:?}");
        }
    }

    #[test]
    fn base_units_rounds_up_beyond_token_precision() {
        assert_eq!(amount_to_base_units(&json!("1.5"), 6), Some(1_500_000));
        assert_eq!(amount_to_base_units(&json!(1.5), 6), Some(1_500_000));
        assert_eq!(amount_to_base_units(&json!("0.0000001"), 6), Some(1));
        assert_eq!(amount_to_base_units(&json!("1.0000004"), 6), Some(1_000_001));
        assert_eq!(amount_to_base_units(&json!("1.0000000"), 6), Some(1_000_000));
        assert_eq!(amount_to_base_units(&json!(".5"), 6), Some(500_000));
        assert_eq!(amount_to_base_units(&json!("1."), 6), Some(1_000_000));
        assert_eq!(amount_to_base_units(&json!("0"), 6), Some(0));
    }

    #[test]
    fn base_units_handles_float_noise_and_exponents() {
        // 0.1 + 0.2 in JS doubles -> "0.30000000000000004" -> rounds UP to
        // 300001, exactly like the TS BigInt path.
        let sum = 0.1f64 + 0.2f64;
        assert_eq!(amount_to_base_units(&json!(sum), 6), Some(300_001));
        // Number#toString() exponent form below one micro-unit.
        assert_eq!(amount_to_base_units(&json!(1e-7), 6), Some(1));
        assert_eq!(amount_to_base_units(&json!("1e+2"), 6), Some(100_000_000));
        // Absurd magnitudes clamp (JS would grow a BigInt; i128 saturates).
        assert_eq!(amount_to_base_units(&json!(1e40), 6), Some(i128::MAX));
    }

    #[test]
    fn sums_fail_closed_on_any_corrupt_entry() {
        let good = json!("1.0");
        let bad = json!("junk");
        assert_eq!(
            sum_amounts_to_base_units([&good, &good].into_iter(), 6),
            Some(2_000_000)
        );
        assert_eq!(sum_amounts_to_base_units([good, bad].iter(), 6), None);
        assert_eq!(sum_amounts_to_base_units(std::iter::empty(), 6), Some(0));
    }

    #[test]
    fn base_units_to_number_is_exact_and_signed() {
        assert_eq!(base_units_to_number(0, 6), 0.0);
        assert_eq!(base_units_to_number(1, 6), 0.000001);
        assert_eq!(base_units_to_number(1_500_000, 6), 1.5);
        assert_eq!(base_units_to_number(100_000_000_000, 6), 100000.0);
        assert_eq!(base_units_to_number(-2_500_000, 6), -2.5);
    }

    #[test]
    fn parse_units_strict_rejects_what_ethers_throws_on() {
        assert_eq!(parse_units_strict("1.5", 6), Some(1_500_000));
        assert_eq!(parse_units_strict("1.2345678", 6), None); // too many decimals
        assert_eq!(parse_units_strict("1e-8", 6), None); // exponent notation
        assert_eq!(parse_units_strict("-1", 6), None);
        assert_eq!(parse_units_strict("", 6), None);
        assert_eq!(parse_units_strict(".5", 6), Some(500_000));
    }

    // -- fees ---------------------------------------------------------------

    #[test]
    fn tier_fees_and_labels() {
        assert_eq!(calculate_fee_amount(100.0, Tier::Free), 10.0);
        assert_eq!(calculate_fee_amount(100.0, Tier::Standard), 9.0);
        assert_eq!(calculate_fee_amount(100.0, Tier::Vip), 8.0);
        // floor at 1e-8, in double order: 0.1 * 0.09 = 0.009000000000000001.
        assert_eq!(calculate_fee_amount(0.1, Tier::Standard), 0.009);
        assert_eq!(fee_percent_label(Tier::Free), "10%");
        assert_eq!(fee_percent_label(Tier::Standard), "9%");
        assert_eq!(fee_percent_label(Tier::Vip), "8%");
        assert_eq!(resolve_tier(Some(&json!("vip"))), Tier::Vip);
        assert_eq!(resolve_tier(Some(&json!("platinum"))), Tier::Free);
        assert_eq!(resolve_tier(None), Tier::Free);
        assert_eq!(resolve_tier(Some(&json!(null))), Tier::Free);
    }

    // -- bet validation order -----------------------------------------------

    fn bet_body(extra: Value) -> Value {
        let mut base = json!({
            "userAddress": ADDR,
            "betAmount": 10,
            "currency": "USDC",
            "roundId": 7,
            "multiplier": 1.5,
            "targetCell": { "id": 1, "priceChange": 2, "direction": "UP", "timeframe": 60 }
        });
        if let (Some(a), Some(b)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        base
    }

    fn bet_full(body: &Value) -> Result<BetPlan, Rejection> {
        bet_tail(bet_head(body)?, body)
    }

    #[test]
    fn bet_rejects_missing_fields_in_order() {
        // missing session is the HTTP layer's guard; shape errors come next.
        let (status, resp) = bet_head(&json!({ "betAmount": 1 })).err().unwrap();
        assert_eq!(status, 400);
        assert_eq!(resp, error_body("Missing required fields: userAddress, betAmount"));
        let (status, resp) = bet_head(&json!({ "userAddress": ADDR })).err().unwrap();
        assert_eq!(resp, error_body("Missing required fields: userAddress, betAmount"));
        assert_eq!(status, 400);
        // null betAmount is "missing", 0 is not (it fails the positivity gate).
        assert!(bet_full(&bet_body(json!({"betAmount": 0}))).is_ok());
    }

    #[test]
    fn bet_rejects_nan_and_bad_addresses() {
        let (_, resp) = bet_head(&bet_body(json!({"betAmount": "abc"}))).err().unwrap();
        assert_eq!(resp, error_body("Invalid bet amount"));
        let (_, resp) = bet_head(&bet_body(json!({"betAmount": json!(f64::INFINITY)}))).err().unwrap();
        // serde_json cannot even express Infinity as JSON; a string can.
        assert_eq!(resp, error_body("Invalid bet amount"));
        let (_, resp) = bet_head(&bet_body(json!({"betAmount": "Infinity"}))).err().unwrap();
        assert_eq!(resp, error_body("Invalid bet amount"));
        let (_, resp) = bet_head(&bet_body(json!({"userAddress": "vitalik.eth"}))).err().unwrap();
        assert_eq!(resp, error_body("Invalid wallet address format"));
    }

    #[test]
    fn bet_stringified_amount_survives_to_the_rpc_bind() {
        // The TS coerces for comparisons but binds the raw value; "10" must
        // pass validation and reach p_bet_amount verbatim.
        let plan = bet_full(&bet_body(json!({"betAmount": "10"}))).expect("string amount passes");
        assert_eq!(plan.bet_amount, json!("10"));
        assert_eq!(plan.amount, 10.0);
    }

    #[test]
    fn bet_positivity_and_ban_gate_order() {
        // head passes for 0; the "greater than zero" rejection is post-ban.
        let head = bet_head(&bet_body(json!({"betAmount": 0}))).unwrap();
        let (_, resp) = bet_tail(head, &bet_body(json!({"betAmount": 0}))).err().unwrap();
        assert_eq!(resp, error_body("Bet amount must be greater than zero"));
        let head = bet_head(&bet_body(json!({"betAmount": -3}))).unwrap();
        assert!(bet_tail(head, &bet_body(json!({"betAmount": -3}))).is_err());
    }

    #[test]
    fn bet_multiplier_matrix_matches_js_truthiness() {
        let cases: Vec<(Value, &str)> = vec![
            (json!(0), "Multiplier must be at least 1.0"),
            (json!(0.9), "Multiplier must be at least 1.0"),
            (json!(null), "Multiplier must be at least 1.0"),
            (json!(""), "Multiplier must be at least 1.0"),
            (json!("0.5"), "Multiplier must be at least 1.0"),
            (json!("2.5"), "Multiplier exceeds maximum allowed value"),
            (json!(true), "Multiplier exceeds maximum allowed value"),
            (json!(21), "Multiplier exceeds maximum allowed value"),
        ];
        for (multiplier, expected) in cases {
            let body = bet_body(json!({"multiplier": multiplier}));
            let (_, resp) = bet_full(&body).err().unwrap_or_else(|| panic!("{multiplier:?} should reject"));
            assert_eq!(resp, error_body(expected), "{multiplier:?}");
        }
        assert_eq!(bet_full(&bet_body(json!({"multiplier": 1.0}))).ok().map(|p| p.amount), Some(10.0));
        assert_eq!(bet_full(&bet_body(json!({"multiplier": 20}))).ok().map(|p| p.amount), Some(10.0));
    }

    #[test]
    fn bet_target_cell_validation() {
        let (_, resp) = bet_full(&bet_body(json!({"targetCell": {"priceChange": 1}}))).err().unwrap();
        assert_eq!(resp, error_body("Invalid target cell data"));
        let (_, resp) = bet_full(&bet_body(json!({"targetCell": {"id": 1}}))).err().unwrap();
        assert_eq!(resp, error_body("Invalid target cell data"));
        // id null counts as missing, priceChange null does not (=== undefined).
        assert!(bet_full(&bet_body(json!({"targetCell": {"id": null, "priceChange": 1}}))).is_err());
        assert!(bet_full(&bet_body(json!({"targetCell": {"id": 0, "priceChange": 0}}))).is_ok());
    }

    #[test]
    fn bet_currency_normalises_and_crashes_like_the_ts() {
        assert_eq!(bet_full(&bet_body(json!({"currency": "usdc"}))).unwrap().currency, "USDC");
        assert_eq!(bet_full(&bet_body(json!({ "currency": Value::Undefined }))).unwrap().currency, "USDC");
        let mut body = bet_body(json!({}));
        body.as_object_mut().unwrap().remove("currency");
        assert_eq!(bet_full(&body).unwrap().currency, "USDC");
        // null / non-string currency: `.toUpperCase()` TypeError -> outer 500.
        assert_eq!(bet_full(&bet_body(json!({"currency": null}))).err().unwrap(), route_crash());
        assert_eq!(bet_full(&bet_body(json!({"currency": 5}))).err().unwrap(), route_crash());
    }

    #[test]
    fn bet_row_selection_status_guards_and_order() {
        let rows: Vec<Value> = vec![json!({"user_address": "b@x", "balance": 5, "status": "active"})];
        match bet_choose_row(&rows, 10.0, "USDC") {
            BetRows::Reject((400, resp)) => assert_eq!(
                resp,
                error_body("Insufficient house balance. Deposit more USDC from the Wallet tab.")
            ),
            other => panic!("expected insufficient, got {other:?}"),
        }
        match bet_choose_row(&[], 1.0, "USDC") {
            BetRows::Reject((400, resp)) => assert_eq!(
                resp,
                error_body("No house balance for this wallet in USDC. Open the Wallet tab and deposit once for this chain, then try again.")
            ),
            other => panic!("expected empty, got {other:?}"),
        }
        let frozen = vec![
            json!({"user_address": "a@x", "balance": 1, "status": "active"}),
            json!({"user_address": "b@x", "balance": 2, "status": "frozen"}),
        ];
        match bet_choose_row(&frozen, 1.0, "USDC") {
            BetRows::Reject((403, resp)) => assert_eq!(resp, error_body("Account is frozen. Bets are disabled.")),
            other => panic!("expected frozen, got {other:?}"),
        }
        let banned = vec![json!({"user_address": "b@x", "balance": 2, "status": "banned"})];
        match bet_choose_row(&banned, 1.0, "USDC") {
            BetRows::Reject((403, resp)) => assert_eq!(resp, error_body("Account is banned.")),
            other => panic!("expected banned, got {other:?}"),
        }
        // Picks the richest *sufficient* row, not the richest row.
        let mixed = vec![
            json!({"user_address": "lo@x", "balance": 5, "status": "active"}),
            json!({"user_address": "hi@x", "balance": 50, "status": "active"}),
            json!({"user_address": "mid@x", "balance": 12, "status": "active"}),
        ];
        match bet_choose_row(&mixed, 10.0, "USDC") {
            BetRows::Ledger(key) => assert_eq!(key, "hi@x"),
            other => panic!("expected ledger, got {other:?}"),
        }
    }

    #[test]
    fn bet_idempotency_key_sanitisation() {
        assert_eq!(
            sanitize_bet_request_id(Some(&json!("550e8400-e29b-41d4-a716-446655440000"))).as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        assert_eq!(sanitize_bet_request_id(Some(&json!("  abcdefgh  "))).as_deref(), Some("abcdefgh"));
        assert_eq!(sanitize_bet_request_id(Some(&json!("short7"))), None);
        assert_eq!(sanitize_bet_request_id(Some(&json!("x".repeat(65)))), None);
        assert_eq!(sanitize_bet_request_id(Some(&json!("bad;key--"))), None);
        assert_eq!(sanitize_bet_request_id(Some(&json!(12345678))), None);
        assert_eq!(sanitize_bet_request_id(None), None);
    }

    #[test]
    fn bet_derived_request_id_and_bet_id_shapes() {
        let key = derived_bet_request_id(Some(&json!(7)), "0x1234567890abcdef", 1700000000000);
        assert_eq!(key, "bet_req_7_90abcdef_1700000000000");
        // A missing roundId interpolates "undefined" exactly like JS.
        assert_eq!(
            derived_bet_request_id(None, "0xdeadbeef", 1),
            "bet_req_undefined_0xdeadbe".replacen("0xdeadbe", "deadbeef", 1).as_str() == "" , // placeholder, replaced below
        );
    }

    #[test]
    fn bet_derived_request_id_undefined_round() {
        assert_eq!(derived_bet_request_id(None, "0xdeadbeef", 1), "bet_req_undefined_deadbeef_1".replace("deadbeef", "deadbeef").as_str());
    }

    #[test]
    fn bet_id_uses_hashless_uuid_prefix() {
        assert_eq!(build_bet_id(1700000000000, "550e8400e29b"), "bet_1700000000000_550e8400e29b");
    }

    #[test]
    fn bet_max_payout_rounds_to_eight_places() {
        assert_eq!(bet_max_payout(10.0, 1.5), Some(15.0));
        assert_eq!(bet_max_payout(0.1, 3.0), Some(0.3));
        // 1e308 * 20 -> Infinity -> toFixed throws -> outer catch 500.
        assert_eq!(bet_max_payout(1e308, 20.0), None);
    }

    #[test]
    fn bet_end_time_parsing() {
        assert_eq!(bet_end_time(Some(&json!(1700000000000))).unwrap().as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(bet_end_time(Some(&json!("2023-11-14T22:13:20.000Z"))).unwrap().as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(bet_end_time(Some(&json!("garbage"))).unwrap(), None);
        assert_eq!(bet_end_time(None).unwrap(), None);
        // Out of the Date range: toISOString throws RangeError -> 500.
        assert_eq!(bet_end_time(Some(&json!(9e15))).err().unwrap(), route_crash());
    }

    #[test]
    fn bet_settlement_unavailable_body_follows_node_env() {
        let (status, resp) = bet_signing_unavailable(true);
        assert_eq!(status, 503);
        assert_eq!(resp, error_body("Set BALANCE_SETTLEMENT_SECRET in .env (any long random string) and restart the dev server."));
        let (_, resp) = bet_signing_unavailable(false);
        assert_eq!(resp, error_body("Betting is temporarily unavailable. Please try again later."));
    }

    // -- place_bet_locked outcome mapping ------------------------------------

    fn lock_result(overrides: Value) -> Value {
        let mut base = json!({
            "success": true, "duplicate": false, "error": null,
            "bet_id": "bet_1_abc", "settlement_token": "tok.sig",
            "new_balance": 5, "max_payout": 15, "user_address": ADDR, "currency": "USDC"
        });
        for (k, v) in overrides.as_object().unwrap() {
            base.as_object_mut().unwrap().insert(k.clone(), v.clone());
        }
        base
    }

    #[test]
    fn bet_success_needs_every_field() {
        let d = bet_rpc_decision(&lock_result(json!({})), ADDR, "USDC");
        match d {
            BetRpcDecision::Success { new_balance, bet_id, token } => {
                assert_eq!(new_balance, 5.0);
                assert_eq!(bet_id, "bet_1_abc");
                assert_eq!(token, "tok.sig");
            }
            other => panic!("expected success, got {other:?}"),
        }
        // A missing betId is a fail-closed ambiguity, never a minted token.
        let d = bet_rpc_decision(&lock_result(json!({"bet_id": null, "error": null})), ADDR, "USDC");
        assert!(matches!(d, BetRpcDecision::FailClosed { status: 503, .. }));
        // new_balance null is JS-null via toNumber(null)=0? No: null -> 0,
        // which is a *number*, so the gate passes on explicit success.
        let d = bet_rpc_decision(&lock_result(json!({"new_balance": null})), ADDR, "USDC");
        assert!(matches!(d, BetRpcDecision::Success { new_balance: 0.0, .. }));
        // undefined (absent) new_balance -> toNumber -> NaN -> fail closed 503.
        let mut r = lock_result(json!({}));
        r.as_object_mut().unwrap().remove("new_balance");
        assert!(matches!(bet_rpc_decision(&r, ADDR, "USDC"), BetRpcDecision::FailClosed { status: 503, .. }));
    }

    #[test]
    fn bet_duplicate_replay_re_signs_when_ceiling_is_stored() {
        let dup = lock_result(json!({"duplicate": true, "success": false, "max_payout": 12.5}));
        match bet_rpc_decision(&dup, "ledger@x", "USDC") {
            BetRpcDecision::ReplayMint(mint) => {
                assert_eq!(mint.bet_id, "bet_1_abc");
                assert_eq!(mint.user_address, ADDR);
                assert_eq!(mint.max_payout, 12.5);
            }
            other => panic!("expected replay-mint, got {other:?}"),
        }
        // Stored ceiling 0 -> falsy -> replay the stored token verbatim.
        let dup0 = lock_result(json!({"duplicate": true, "success": false, "max_payout": 0}));
        match bet_rpc_decision(&dup0, "ledger@x", "USDC") {
            BetRpcDecision::ReplayStored { token, new_balance, .. } => {
                assert_eq!(token, "tok.sig");
                assert_eq!(new_balance, Some(5.0));
            }
            other => panic!("expected replay-stored, got {other:?}"),
        }
    }

    #[test]
    fn bet_duplicate_without_token_is_a_409() {
        let dup = lock_result(json!({"duplicate": true, "bet_id": null, "settlement_token": null, "error": "Bet already processed"}));
        match bet_rpc_decision(&dup, "l@x", "USDC") {
            BetRpcDecision::Conflict { body } => assert_eq!(body, error_body("Bet already processed")),
            other => panic!("got {other:?}"),
        }
        let dup = lock_result(json!({"duplicate": true, "bet_id": null, "settlement_token": null, "error": null}));
        match bet_rpc_decision(&dup, "l@x", "USDC") {
            BetRpcDecision::Conflict { body } => {
                assert_eq!(body, error_body("Bet already processed. Please place a new bet."))
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn bet_fail_closed_error_mapping() {
        let cases = vec![
            ("Insufficient balance", 400u16, "Insufficient house balance. Deposit more USDC."),
            ("User not found", 400, "No house balance for this wallet in USDC. Deposit from the Wallet tab first."),
            (BANNED_MESSAGE, 403, BANNED_MESSAGE),
            ("Account is FROZEN", 403, "Account is FROZEN"),
            ("some ledger trouble", 400, "some ledger trouble"),
        ];
        for (rpc_error, status, message) in cases {
            let d = bet_rpc_decision(&lock_result(json!({"success": false, "error": rpc_error})), "l@x", "USDC");
            match d {
                BetRpcDecision::FailClosed { status: s, body } => {
                    assert_eq!(s, status, "{rpc_error}");
                    assert_eq!(body, error_body(message), "{rpc_error}");
                }
                other => panic!("{rpc_error}: got {other:?}"),
            }
        }
    }

    #[test]
    fn bet_replay_falls_back_to_ledger_fields_when_rpc_rows_are_empty() {
        let dup = lock_result(json!({"duplicate": true, "success": false, "max_payout": 5, "user_address": null, "currency": ""}));
        match bet_rpc_decision(&dup, "ledger@x", "USDC") {
            BetRpcDecision::ReplayMint(mint) => {
                assert_eq!(mint.user_address, "ledger@x");
                assert_eq!(mint.currency, "USDC");
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn bet_replay_success_body_shape() {
        let body = bet_success_body(json!(4.5), "bet_9", "tok", true);
        assert_eq!(body["success"], json!(true));
        assert_eq!(body["duplicate"], json!(true));
        assert_eq!(body["message"], json!("Bet already processed"));
        assert_eq!(body["remainingBalance"], json!(4.5));
        assert_eq!(body["betId"], json!("bet_9"));
        assert_eq!(body["settlementToken"], json!("tok"));
        // The non-duplicate success carries no duplicate/message keys at all.
        let plain = bet_success_body(json!(4.5), "bet_9", "tok", false);
        assert!(plain.get("duplicate").is_none());
        assert!(plain.get("message").is_none());
    }

    // -- deposit --------------------------------------------------------------

    #[test]
    fn deposit_head_rejections() {
        let (_, resp) = deposit_head(&json!({"amount": 1, "txHash": "0x1"})).err().unwrap();
        assert_eq!(resp, error_body("Missing required fields: userAddress, amount, txHash"));
        let (_, resp) = deposit_head(&json!({"userAddress": ADDR, "txHash": "0x1"})).err().unwrap();
        assert_eq!(resp, error_body("Missing required fields: userAddress, amount, txHash"));
        let (_, resp) = deposit_head(&json!({"userAddress": ADDR, "amount": 1})).err().unwrap();
        assert_eq!(resp, error_body("Missing required fields: userAddress, amount, txHash"));
        let (_, resp) = deposit_head(&json!({"userAddress": ADDR, "amount": "abc", "txHash": "0x1"})).err().unwrap();
        assert_eq!(resp, error_body("Invalid deposit amount"));
        // A stringified amount normalises through Number(), as the TS did.
        let head = deposit_head(&json!({"userAddress": ADDR, "amount": "10", "txHash": "0x1"})).unwrap();
        assert_eq!(head.amount, 10.0);
    }

    #[test]
    fn deposit_currency_normalisation_uses_string_coercion() {
        assert_eq!(deposit_currency(&json!({"currency": "usdc"}), 1.0).unwrap(), "USDC");
        let (_, resp) = deposit_currency(&json!({}), 1.0).err().unwrap();
        assert_eq!(resp, error_body("Unsupported deposit currency: "));
        let (_, resp) = deposit_currency(&json!({"currency": {"a": 1}}), 1.0).err().unwrap();
        assert_eq!(resp, error_body("Unsupported deposit currency: [OBJECT OBJECT]"));
        let (_, resp) = deposit_currency(&json!({"currency": "usdc"}), 0.0).err().unwrap();
        assert_eq!(resp, error_body("Deposit amount must be greater than zero"));
    }

    #[test]
    fn deposit_fee_net_and_rejection_label() {
        let (fee, net) = deposit_net(10.0, Tier::Free);
        assert_eq!((fee, net), (1.0, 9.0));
        let (fee, net) = deposit_net(0.000001, Tier::Free);
        assert!(net > 0.0 && fee == 0.0);
        let (status, resp) = deposit_net_rejection(fee_percent_label(Tier::Free));
        assert_eq!(status, 400);
        assert_eq!(resp, error_body("Deposit amount after 10% fee must be greater than zero"));
    }

    #[test]
    fn deposit_retryable_502_body_carries_progress_only_when_the_ts_did() {
        let (status, body) = deposit_pending_body("tx_not_found", None);
        assert_eq!(status, 502);
        assert_eq!(body["code"], json!("tx_not_found"));
        assert_eq!(body["retryable"], json!(true));
        assert!(body.get("confirmations").is_none());
        assert!(body.get("requiredConfirmations").is_none());
        let (_, body) = deposit_pending_body("insufficient_confirmations", Some(2));
        assert_eq!(body["confirmations"], json!(2));
        assert_eq!(body["requiredConfirmations"], json!(3));
    }

    #[test]
    fn deposit_terminal_and_duplicate_bodies() {
        let (status, body) = deposit_terminal("amount_mismatch", "No USDC transfer of at least the claimed amount reached the treasury");
        assert_eq!(status, 400);
        assert_eq!(
            body["error"],
            json!("Deposit transaction is not valid: No USDC transfer of at least the claimed amount reached the treasury")
        );
        assert_eq!(body["retryable"], json!(false));
        assert_eq!(body["code"], json!("amount_mismatch"));
        let (status, body) = deposit_duplicate_body();
        assert_eq!(status, 409);
        assert_eq!(body, json!({
            "error": "This transaction has already been credited",
            "duplicate": true,
            "code": "already_credited",
        }));
    }

    #[test]
    fn deposit_audit_duplicate_regex_matches_ci() {
        assert!(is_audit_duplicate("duplicate key value violates unique constraint"));
        assert!(is_audit_duplicate("Unique violation"));
        assert!(is_audit_duplicate("duplicate KEY"));
        assert!(!is_audit_duplicate("Deposit amount must be greater than zero"));
    }

    #[test]
    fn deposit_combined_hash_and_fee_audit_shape() {
        assert_eq!(combined_tx_hash(&json!("0xabc"), Some("0xfee")), "0xabc|feeTx:0xfee");
        assert_eq!(combined_tx_hash(&json!("0xabc"), None), "0xabc");
    }

    #[test]
    fn deposit_required_amount_string_rounds_up_and_clamps() {
        assert_eq!(deposit_required_amount_string(1.5), "1.500000");
        // 1e-7 must demand a full micro-unit, never 0.000000.
        assert_eq!(deposit_required_amount_string(1e-7), "0.000001");
        assert_eq!(deposit_required_amount_string(0.1234567), "0.123457");
        // Absurd magnitude still fails verification closed, not open.
        let huge = deposit_required_amount_string(1e40);
        assert_eq!(huge, "340282366920938463463374607431768211455.000000");
    }

    #[test]
    fn deposit_success_body_matches_the_receipt_fields() {
        let body = deposit_success_body(Some(9.0), 1.0, 9.0, "2026-01-01T00:00:00.000Z");
        assert_eq!(
            body,
            json!({
                "success": true,
                "newBalance": 9,
                "fee": 1,
                "netCredited": 9,
                "creditedAt": "2026-01-01T00:00:00.000Z",
            })
        );
        // Unparseable new_balance -> parseFloat NaN -> JSON null, key present.
        let body = deposit_success_body(None, 1.0, 9.0, "x");
        assert_eq!(body["newBalance"], Value::Null);
    }

    // -- win ------------------------------------------------------------------

    fn win_body(extra: Value) -> Value {
        let mut base = json!({
            "userAddress": ADDR, "winAmount": 5, "currency": "USDC",
            "betId": "bet_1", "settlementToken": "tok.sig"
        });
        if let (Some(a), Some(b)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        base
    }

    #[test]
    fn win_missing_field_two_flavours() {
        let (_, resp) = win_head(&json!({"winAmount": 1}), false).err().unwrap();
        assert_eq!(resp, error_body("Missing required fields: userAddress, winAmount"));
        let (_, resp) = win_head(&json!({"userAddress": ADDR, "winAmount": 1}), false).err().unwrap();
        assert_eq!(resp, error_body("Missing required fields: betId, settlementToken"));
    }

    #[test]
    fn win_amount_must_be_a_real_positive_number() {
        for bad in [json!(0), json!(-1), json!("10"), json!(null)] {
            let req = win_head(&win_body(json!({"winAmount": bad.clone()})), false).unwrap();
            let (_, resp) = win_after_ban(&req).err().unwrap_or_else(|| panic!("{bad:?} must reject"));
            assert_eq!(resp, error_body("Win amount must be greater than zero"), "{bad:?}");
        }
    }

    #[test]
    fn win_currency_rules() {
        // Falsy currency falls back to USDC before the case fold.
        let req = win_head(&win_body(json!({"currency": ""})), false).unwrap();
        assert_eq!(win_after_ban(&req).unwrap(), "USDC");
        let req = win_head(&win_body(json!({"currency": "usdc"})), false).unwrap();
        assert_eq!(win_after_ban(&req).unwrap(), "USDC");
        let req = win_head(&win_body(json!({"currency": "eth"})), false).unwrap();
        let (status, resp) = win_after_ban(&req).err().unwrap();
        assert_eq!(status, 400);
        assert_eq!(resp, error_body("Unsupported currency"));
        // Truthy non-string: `.toUpperCase()` TypeError -> outer 500.
        let req = win_head(&win_body(json!({"currency": 7})), false).unwrap();
        assert_eq!(win_after_ban(&req).err().unwrap(), route_crash());
    }

    fn payload(bet_id: &str, user: &str, currency: &str, max: f64) -> crate::crypto::SettlementPayload {
        crate::crypto::SettlementPayload {
            bet_id: bet_id.into(),
            user_address: user.into(),
            currency: into_owned(currency),
            max_payout: max,
            iat: 0,
            exp: i64::MAX,
        }
    }

    fn into_owned(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn win_token_binding_rejections() {
        let user_key = address::canonical(ADDR);
        // Invalid token -> the caller hands None here; 401 'Invalid settlement
        // token' is emitted by the HTTP layer (crypto::verify). This covers
        // the *mismatch* and cap arms.
        let mismatch = win_token_failure(
            Some(&payload("bet_OTHER", ADDR, "USDC", 10.0)),
            &json!("bet_1"),
            &user_key,
            "USDC",
            5.0,
        );
        assert_eq!(mismatch, Some((401, error_body("Settlement token does not match bet"))));
        let wrong_currency = win_token_failure(
            Some(&payload("bet_1", ADDR, "BOT", 10.0)),
            &json!("bet_1"),
            &user_key,
            "USDC",
            5.0,
        );
        assert!(wrong_currency.is_some());
        // Cap: strictly `winAmount > maxPayout + 1e-8`.
        assert!(win_token_failure(
            Some(&payload("bet_1", ADDR, "USDC", 10.0)),
            &json!("bet_1"), &user_key, "USDC", 10.00000001
        ).is_none());
        let over = win_token_failure(
            Some(&payload("bet_1", ADDR, "USDC", 10.0)),
            &json!("bet_1"), &user_key, "USDC", 10.00000002,
        );
        assert_eq!(over, Some((400, error_body("Win amount exceeds approved payout"))));
    }

    #[test]
    fn win_settle_exception_mapping() {
        assert_eq!(
            win_map_settle_error("error: strike_unknown_bet:bet_1"),
            Some((400, error_body("Unknown bet: no server-side record of this payout")))
        );
        assert_eq!(
            win_map_settle_error("STRIKE_PAYOUT_EXCEEDS_MAX whatever"),
            Some((400, error_body("Win amount exceeds approved payout"))
            )
        );
        assert_eq!(
            win_map_settle_error("strike_invalid_payout_amount"),
            Some((400, error_body("Win amount must be greater than zero")))
        );
        assert_eq!(win_map_settle_error("connection reset"), None);
    }

    #[test]
    fn win_duplicate_is_an_acknowledged_success() {
        let dup = json!({"success": false, "duplicate": true, "new_balance": 20, "error": null});
        match win_rpc_decision(&dup, "bet_1", 5.0) {
            WinRpcDecision::Duplicate(body) => assert_eq!(
                body,
                json!({
                    "success": true, "duplicate": true,
                    "message": "Payout already processed for this bet",
                    "newBalance": 20, "betId": "bet_1",
                })
            ),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn win_fail_closed_and_success_bodies() {
        let d = win_rpc_decision(&json!({"success": false, "error": "Insufficient balance", "new_balance": null}), "b", 1.0);
        match d {
            WinRpcDecision::FailClosed { status, body } => {
                assert_eq!(status, 400);
                assert_eq!(body, error_body("Insufficient balance"));
            }
            other => panic!("got {other:?}"),
        }
        // No error string -> 503 and the generic message.
        let d = win_rpc_decision(&json!({"success": true, "duplicate": false}), "b", 1.0);
        assert!(matches!(d, WinRpcDecision::FailClosed { status: 503, .. }));
        match win_rpc_decision(&json!({"success": true, "new_balance": "15.5"}), "b", 5.0) {
            WinRpcDecision::Success(body) => {
                assert_eq!(body, json!({"success": true, "newBalance": 15.5, "winAmount": 5}));
            }
            other => panic!("got {other:?}"),
        }
    }

    // -- withdraw ---------------------------------------------------------------

    fn wd_body(extra: Value) -> Value {
        let mut base = json!({
            "userAddress": ADDR, "amount": 10, "currency": "USDC",
            "signature": "0xsig", "signedAt": 1700000000000
        });
        if let (Some(a), Some(b)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        base
    }

    #[test]
    fn withdraw_head_rejections() {
        let (s, resp) = withdraw_head(&json!({"amount": 1})).err().unwrap();
        assert_eq!((s, resp), (400, error_body("Missing required fields: userAddress, amount")));
        let (_, resp) = withdraw_head(&wd_body(json!({"amount": "nan"}))).err().unwrap();
        assert_eq!(resp, error_body("Invalid withdrawal amount"));
        // currency.toUpperCase() runs before the address gate in the TS.
        assert_eq!(withdraw_head(&wd_body(json!({"currency": null}))).err().unwrap(), route_crash());
        assert_eq!(withdraw_head(&wd_body(json!({"currency": "usdc"}))).unwrap().currency, "USDC");
    }

    #[test]
    fn withdraw_intent_message_is_the_exact_signed_string() {
        // Mirrors the message in lib/balance/withdrawalIntent.ts call sites.
        let message = withdraw_intent_message(
            &json!(ADDR),
            &json!(1),
            "USDC",
            &json!(1700000000000u64),
        )
        .unwrap();
        assert_eq!(
            message,
            format!("STRIKE withdrawal authorization\naddress:{ADDR}\namount:1.00000000\ncurrency:USDC\nsignedAt:1700000000000")
        );
        // The raw address spelling is signed, not the canonical one.
        let message = withdraw_intent_message(&json!("0xABC"), &json!(2.5), "USDC", &json!(7)).unwrap();
        assert!(message.contains("address:0xABC"));
        assert!(message.contains("amount:2.50000000"));
        // A stringified amount has no .toFixed -> TypeError -> 500.
        assert_eq!(
            withdraw_intent_message(&json!(ADDR), &json!("10"), "USDC", &json!(7)).err().unwrap(),
            route_crash()
        );
    }

    #[test]
    fn withdraw_authorization_gates() {
        assert_eq!(withdraw_missing_authorization(), (401, error_body("Missing signed withdrawal authorization")));
        assert_eq!(withdraw_expired(), (401, error_body("Withdrawal authorization expired. Please sign again.")));
        let (_, body) = withdraw_signature_mismatch();
        assert_eq!(body["code"], json!("signature_mismatch"));
        assert_eq!(
            body["error"],
            json!("The withdrawal was signed by a different wallet than the account holding this balance. Sign in with the wallet that owns the balance and request again.")
        );
    }

    #[test]
    fn withdraw_row_choices() {
        assert_eq!(
            match withdraw_choose_row(&[], 1.0, "usdc") {
                WithdrawRows::Reject(r) => r,
                _ => panic!(),
            },
            (404, error_body("User record not found"))
        );
        // The insufficient message keeps the RAW (un-normalised) currency.
        let rows = vec![json!({"user_address": "a@x", "balance": 1, "status": "active"})];
        match withdraw_choose_row(&rows, 5.0, "usdc") {
            WithdrawRows::Reject((400, body)) => {
                assert_eq!(body, error_body("Insufficient house balance in usdc"))
            }
            other => panic!("got {other:?}"),
        }
        let frozen = vec![json!({"user_address": "a", "balance": 1, "status": "frozen"})];
        match withdraw_choose_row(&frozen, 0.5, "USDC") {
            WithdrawRows::Reject((403, body)) => {
                assert_eq!(body, error_body("Account is frozen. Withdrawals are disabled."))
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn withdraw_replay_passes_ledger_values_through() {
        let existing = json!({
            "id": 42, "status": "pending", "amount": 10, "fee_amount": 1, "net_amount": 9,
            "signature": "0xsig"
        });
        let body = withdraw_replay_body(&existing, &json!(55.5));
        assert_eq!(
            body,
            json!({
                "success": true, "duplicate": true, "status": "pending", "requestId": 42,
                "newBalance": 55.5, "feeAmount": 1, "netAmount": 9,
            })
        );
        assert!(body.get("signature").is_none());
    }

    #[test]
    fn withdraw_cap_exact_integer_semantics() {
        let deposits = vec![json!({"amount": 100})];
        let none = Vec::<Value>::new();
        // Exactly floor(100 * 1.08) = 108 is allowed.
        assert!(withdraw_cap_check(&json!(108), &deposits, &none, &none, "USDC").is_ok());
        assert!(withdraw_cap_check(&json!(108.000001), &deposits, &none, &none, "USDC").is_err());
        // Pending rows count against the cap.
        let pending = vec![json!({"amount": 100})];
        let (_, body) = withdraw_cap_check(&json!(8), &deposits, &none, &pending, "USDC").err().unwrap();
        assert_eq!(
            body,
            error_body("Withdrawal amount exceeds your available limit. You have no remaining withdrawal allowance. Please contact support if you believe this is an error.")
        );
        // Partial remaining is printed with 6 decimals and the currency.
        let withdrawn = vec![json!({"amount": 100})];
        let (_, body) = withdraw_cap_check(&json!(1), &deposits, &withdrawn, &none, "USDC").err().unwrap();
        assert_eq!(
            body,
            error_body("Withdrawal amount exceeds your available limit. You have 8.000000 USDC remaining. Please contact support if you believe this is an error.")
        );
    }

    #[test]
    fn withdraw_cap_floor_never_rounds_up() {
        // floor(0.000001 * 1.08) = 1 unit; 2 units must be refused.
        let deposits = vec![json!({"amount": 0.000001})];
        let none = Vec::<Value>::new();
        assert!(withdraw_cap_check(&json!("0.000001"), &deposits, &none, &none, "USDC").is_ok());
        let (_, body) = withdraw_cap_check(&json!("0.000002"), &deposits, &none, &none, "USDC").err().unwrap();
        assert!(body["error"].as_str().unwrap().contains("0.000001 USDC remaining"));
    }

    #[test]
    fn withdraw_cap_without_deposits_does_not_govern() {
        let none = Vec::<Value>::new();
        // totalDeposited == 0 -> no cap at all, however absurd the claim.
        assert!(withdraw_cap_check(&json!(1e12), &none, &none, &none, "USDC").is_ok());
    }

    #[test]
    fn withdraw_cap_corrupt_row_fails_closed_with_503() {
        let bad = vec![json!({"amount": "not-a-number"})];
        let none = Vec::<Value>::new();
        let (status, body) = withdraw_cap_check(&json!(1), &bad, &none, &none, "USDC").err().unwrap();
        assert_eq!((status, body), (503, error_body("Service temporarily unavailable. Please try again.")));
        // A row with no amount column is a JS `undefined` -> unparseable too.
        let holey = vec![json!({"id": 1})];
        assert!(withdraw_cap_check(&json!(1), &holey, &none, &none, "USDC").is_err());
    }

    #[test]
    fn frequency_review_threshold_and_stamp() {
        assert!(!frequency_review_exempt(ADDR, &[]));
        assert!(frequency_review_triggered(false, FREQUENCY_REVIEW_THRESHOLD));
        assert!(!frequency_review_triggered(false, 9));
        assert!(!frequency_review_triggered(true, 999));
        assert_eq!(frequency_review_stamp(10), "FREQUENCY_REVIEW:count=11");
        // Exemption matches on the canonical spelling of the env list entry.
        let list = vec![address::canonical(ADDR)];
        assert!(frequency_review_exempt(ADDR, &list));
        assert!(frequency_review_exempt(&ADDR.to_uppercase().replacen("0X", "0x", 1), &list));
        assert!(!frequency_review_exempt("", &list));
    }

    #[test]
    fn withdraw_net_applies_to_fixed_eight() {
        let (fee, net) = withdraw_net(10.0, Tier::Free);
        assert_eq!((fee, net), (1.0, 9.0));
        // The double-noise cleanup: 0.29000000000000004 -> 0.29.
        let dirty = 0.29000000000000004f64;
        assert_eq!(to_fixed(dirty, 8).parse::<f64>().unwrap(), 0.29);
        let (status, body) = withdraw_net_rejection("10%");
        assert_eq!(status, 400);
        assert_eq!(body, error_body("Withdrawal amount after 10% fee must be greater than zero"));
    }

    #[test]
    fn withdraw_insert_failure_and_success_bodies() {
        assert_eq!(
            withdraw_insert_failed(),
            (500, error_body("Failed to create withdrawal request. Please try again."))
        );
        let body = withdraw_success_body(
            json!(42),
            &json!(55.5),
            1.0,
            9.0,
            "2026-01-01T00:00:00.000Z",
            false,
            3,
        );
        assert_eq!(
            body,
            json!({
                "success": true, "status": "pending", "requestId": 42, "newBalance": 55.5,
                "feeAmount": 1, "netAmount": 9, "requestedAt": "2026-01-01T00:00:00.000Z",
                "frequencyReview": false, "withdrawalCount": 4,
            })
        );
    }

    #[test]
    fn bet_and_withdraw_amounts_share_the_number_matrix() {
        // NaN / Infinity / negative / over-precision / absurd magnitude all
        // have defined answers on every path; pin the shared primitives.
        assert_eq!(number_of(&json!("NaN")), None);
        assert_eq!(number_of(&json!(f64::NAN)), Some(f64::NAN)); // serde cannot carry NaN; strings model it
        assert!(number_of(&json!("1e400")).map(|f| f.is_infinite()).unwrap_or(false));
        assert_eq!(number_of(&json!(null)), Some(0.0));
        assert_eq!(number_of(&json!("")), Some(0.0));
        assert_eq!(number_of(&json!(" 12.5 ")), Some(12.5));
    }
}
