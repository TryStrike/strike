//! `GET /api/admin/{stats,transactions,player-ledger,mode-analytics,wallet-insights}`.
//!
//! The transport half of the admin read family. `strike_core::admin_reads_a`
//! already owns the parameter parsing, the SQL text, the typed binds and the
//! response shapes for `stats` and `mode-analytics` (their heavy logic is shared
//! with the public `/api/stats` aggregate), so this module only adds the
//! `requireAdminAuth` guard and the wire call. `transactions` mirrors its Next
//! route — a fixed, unparameterised 50-row read — and `player-ledger` /
//! `wallet-insights` have no pure counterpart in core (the aggregation was
//! PostgREST-shaped client code), so the money math lives here as private
//! helpers, transcribed field-for-field from the TypeScript.
//!
//! Every handler is `guard → run → Json / err.into_response()`; the guard's
//! 401/503 and the query's 500 ride on `ApiError`'s `IntoResponse`, which
//! produces the `{ error }` body the Next routes answer with. The raw DB error
//! is logged, never echoed (see `crates/core/src/error.rs`): the Next routes
//! returned `error.message` verbatim, which the migration deliberately replaces
//! with the leak-safe `ApiError` message while keeping the status and shape.

use std::cmp::Ordering;
use std::collections::HashMap;

use axum::extract::Query;
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Number, Value};

use strike_core::address::search_variants;
use strike_core::admin_reads_a::{
    canonical_of, json_number, load_admin_stats, load_mode_analytics, load_transactions,
    matches_list_filters_on, parse_list_params, resolve_house_ledger_currency, url_query_pairs,
    ListOptions, ListParams, TRANSACTION_STATUS_VALUES,
};
use strike_core::bets::value_to_string;
use strike_core::error::{ApiError, ApiResult};
use strike_core::platform_stats::{
    is_demo_bet, is_demo_wallet, number_or_zero, parse_epoch_ms, truthy,
};

use crate::bans::is_globally_banned;
use crate::http::require_admin;
use crate::sql::{self, fetch};

/// `POST`/`GET` router: the five admin read endpoints, one guard each.
pub fn routes() -> Router {
    Router::new()
        .route("/api/admin/stats", get(stats))
        .route("/api/admin/transactions", get(transactions))
        .route("/api/admin/player-ledger", get(player_ledger))
        .route("/api/admin/mode-analytics", get(mode_analytics))
        .route("/api/admin/wallet-insights", get(wallet_insights))
}

// ---------------------------------------------------------------------------
// Shared coercion helpers (JS-shaped, used by the two bespoke aggregates)
// ---------------------------------------------------------------------------

/// A whole number, the way `JSON.stringify` writes an integer.
fn icount(value: i64) -> Value {
    Value::Number(Number::from(value))
}

/// `String(x ?? default)` — `??` fires only on null/undefined, so an empty
/// string or a `0` survives as its own spelling.
fn str_or(value: Option<&Value>, default: &str) -> String {
    match value {
        None | Some(Value::Null) => default.to_string(),
        Some(other) => value_to_string(other),
    }
}

/// `map[key] = (map[key] ?? 0) + n` with the route's `currency || 'UNKNOWN'`
/// fallback baked in; accumulators are plain `f64` maps, rendered through
/// [`json_number`] at the end.
fn add_to(map: &mut HashMap<String, f64>, currency: &str, amount: f64) {
    let key = if currency.is_empty() {
        "UNKNOWN".to_string()
    } else {
        currency.to_string()
    };
    *map.entry(key).or_default() += amount;
}

/// An accumulator map as a JSON object of JS numbers.
fn money_object(map: &HashMap<String, f64>) -> Value {
    Value::Object(
        map.iter()
            .map(|(key, value)| (key.clone(), json_number(*value)))
            .collect::<Map<_, _>>(),
    )
}

/// `isAddressCompatible` from `player-ledger`: reject zero/test addresses and
/// demand a bare 40-hex EVM account. Transcribed without a regex engine, so the
/// three patterns' exact case rules survive: the first `/i`, the second and the
/// shape test requiring a lowercase `0x`.
fn is_address_compatible(address: &str) -> bool {
    let a = address.trim();
    // /^0x0+1?$/i  — 0x (either case) then >=1 zero, then at most one trailing 1.
    if let Some(body) = a.strip_prefix("0x").or_else(|| a.strip_prefix("0X")) {
        let trimmed_one = body.strip_suffix('1').unwrap_or(body);
        if !trimmed_one.is_empty() && trimmed_one.chars().all(|c| c == '0') {
            return false;
        }
    }
    // /^0x0{60,}/  — a lowercase 0x followed by 60 or more zeros.
    if let Some(rest) = a.strip_prefix("0x") {
        if rest.chars().take(60).all(|c| c == '0') && rest.chars().count() >= 60 {
            return false;
        }
    }
    // /^0x[0-9a-fA-F]{40}$/  — exactly 40 hex characters after a lowercase 0x.
    match a.strip_prefix("0x") {
        Some(body) => body.len() == 40 && body.chars().all(|c| c.is_ascii_hexdigit()),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// GET /api/admin/stats
// ---------------------------------------------------------------------------

/// `computePlatformStats()` + the demo/real sum the Next route spells out. The
/// whole aggregate and its response shape are `admin_reads_a::load_admin_stats`;
/// the only thing added here is the guard and the wall clock.
async fn stats(headers: HeaderMap) -> Response {
    match run_stats(&headers).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn run_stats(headers: &HeaderMap) -> ApiResult<Value> {
    require_admin(headers)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    load_admin_stats(now_ms).await
}

// ---------------------------------------------------------------------------
// GET /api/admin/mode-analytics
// ---------------------------------------------------------------------------

/// Every bet, paged past the old 1 000-row ceiling, split real/demo/combined.
/// `load_mode_analytics` owns the scan and the whole response shape.
async fn mode_analytics(headers: HeaderMap) -> Response {
    match run_mode_analytics(&headers).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn run_mode_analytics(headers: &HeaderMap) -> ApiResult<Value> {
    require_admin(headers)?;
    load_mode_analytics().await
}

// ---------------------------------------------------------------------------
// GET /api/admin/transactions
// ---------------------------------------------------------------------------

/// The recent deposit/withdrawal feed: server-side filtering + paging over the
/// audit log, exactly as `app/api/admin/transactions/route.ts` (`parseListParams`
/// with `statusValues: ['deposit','withdrawal']`, currency/q/from/to filters,
/// `created_at DESC, id DESC`, `{transactions,total,limit,offset}` body).
async fn transactions(headers: HeaderMap, uri: Uri) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }
    let params = url_query_pairs(uri.query().unwrap_or(""));
    let opts = ListOptions {
        status_values: Some(&TRANSACTION_STATUS_VALUES[..]),
        extra_enums: &[],
    };
    let parsed = match parse_list_params(&params, &opts) {
        Ok(parsed) => parsed,
        Err(message) => return ApiError::bad_request(message).into_response(),
    };
    match load_transactions(&parsed).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => {
            tracing::error!("[admin/transactions] {err}");
            ApiError::internal("Failed to load transactions").into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/admin/player-ledger
// ---------------------------------------------------------------------------

/// `PAGE` from the route: the window the bet scan walks past the 1 000 cap.
const LEDGER_PAGE: i64 = 1_000;

async fn player_ledger(headers: HeaderMap, uri: Uri) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }
    let params = url_query_pairs(uri.query().unwrap_or(""));
    let parsed = match parse_list_params(&params, &ListOptions::default()) {
        Ok(parsed) => parsed,
        Err(message) => return ApiError::bad_request(message).into_response(),
    };
    match run_player_ledger(&parsed).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => {
            tracing::error!("[admin/player-ledger] {err}");
            ApiError::internal("Failed to load player ledger").into_response()
        }
    }
}

async fn run_player_ledger(params: &ListParams) -> ApiResult<Value> {
    // Every deposit / withdrawal / fee event, no filter beyond the operation set.
    // In insertion order, as Postgres read them: it decides ties in the sort below,
    // and SQLite would otherwise walk the operation_type index.
    let audit = fetch(
        "SELECT user_address, currency, operation_type, amount, created_at \
         FROM balance_audit_log \
         WHERE operation_type IN ('deposit', 'withdrawal', 'platform_fee') ORDER BY id",
        &[],
    )
    .await?;

    // Current spendable balance per (wallet, currency).
    let balances = fetch(
        "SELECT user_address, currency, balance FROM user_balances ORDER BY rowid",
        &[],
    )
    .await?;

    // Real bet stats, paginated to walk past the old row cap.
    let bets = scan_bets().await?;

    // Display names. `user_profiles` errors are swallowed (the TS destructured
    // only `data`), degrading to "no usernames" rather than a 500.
    let profiles = match fetch("SELECT user_address, username FROM user_profiles", &[]).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(
                "[admin/player-ledger] user_profiles read failed, usernames dropped: {err}"
            );
            Vec::new()
        }
    };

    let mut players = build_players(&audit, &balances, &bets, &profiles);
    // The range is over the first deposit, so a wallet with none drops out of it.
    players.retain(|row| matches_list_filters_on(row, params, "first_deposit_at"));
    let total = players.len();
    let page: Vec<Value> = players
        .into_iter()
        .skip(params.offset as usize)
        .take(params.limit as usize)
        .collect();

    let mut body = Map::new();
    body.insert("players".into(), Value::Array(page));
    body.insert("total".into(), Value::from(total));
    body.insert("limit".into(), Value::from(params.limit));
    body.insert("offset".into(), Value::from(params.offset));
    Ok(Value::Object(body))
}

/// `betRows` from the route: the seven columns the ledger folds, ordered by id
/// ascending and windowed so no row is missed or double-counted.
async fn scan_bets() -> ApiResult<Vec<Value>> {
    let statement = "SELECT id, wallet_address, amount, payout, won, network, asset \
         FROM bet_history ORDER BY id ASC LIMIT CAST($1 AS int8) OFFSET CAST($2 AS int8)";
    let mut rows: Vec<Value> = Vec::new();
    let mut from = 0_i64;
    loop {
        let page = Value::from(LEDGER_PAGE);
        let offset = Value::from(from);
        let chunk = fetch(statement, &[("int8", &page), ("int8", &offset)]).await?;
        let short = (chunk.len() as i64) < LEDGER_PAGE;
        rows.extend(chunk);
        if short {
            break;
        }
        from += LEDGER_PAGE;
    }
    Ok(rows)
}

/// One `(wallet, currency)` accumulator, mirroring the route's `Row` type.
struct LedgerRow {
    user_address: Value,
    currency: Value,
    total_deposited: f64,
    total_withdrawn: f64,
    current_balance: f64,
    total_bets: i64,
    total_wins: i64,
    total_wagered: f64,
    total_payout: f64,
    total_fees_paid: f64,
    /// True when `platform_fee` rows exist; otherwise fees are estimated.
    has_explicit_fee: bool,
    username: Value,
    first_deposit_at: Option<String>,
}

impl LedgerRow {
    fn new(user_address: Value, currency: Value, username: Value) -> Self {
        Self {
            user_address,
            currency,
            total_deposited: 0.0,
            total_withdrawn: 0.0,
            current_balance: 0.0,
            total_bets: 0,
            total_wins: 0,
            total_wagered: 0.0,
            total_payout: 0.0,
            total_fees_paid: 0.0,
            has_explicit_fee: false,
            username,
            first_deposit_at: None,
        }
    }
}

/// The whole in-memory aggregate: audit folds into deposited/withdrawn/fees,
/// balances fill `current_balance`, real bets add the wagering columns, a
/// back-calculation estimates historical fees, then each row gains its P&L and
/// the list is sorted by earliest deposit.
fn build_players(
    audit: &[Value],
    balances: &[Value],
    bets: &[Value],
    profiles: &[Value],
) -> Vec<Value> {
    // profileMap[canonical(addr)] = username — last row wins, as the TS forEach.
    let mut profile_map: HashMap<String, Value> = HashMap::new();
    for row in profiles {
        let key = canonical_of(row.get("user_address").unwrap_or(&Value::Null));
        let username = row.get("username").cloned().unwrap_or(Value::Null);
        profile_map.insert(key, username);
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, LedgerRow> = HashMap::new();

    // Audit events → deposited / withdrawn / fees per (wallet, currency).
    for row in audit {
        let raw_address = row.get("user_address").cloned().unwrap_or(Value::Null);
        let address_text = raw_address.as_str().unwrap_or("");
        if !is_address_compatible(address_text) {
            continue;
        }
        let address = canonical_of(&raw_address);
        let currency = row.get("currency").cloned().unwrap_or(Value::Null);
        let key = format!("{}::{}", address, value_to_string(&currency));
        let username = profile_map.get(&address).cloned().unwrap_or(Value::Null);
        let entry = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            LedgerRow::new(Value::String(address), currency.clone(), username)
        });

        let amount = number_or_zero(row.get("amount"));
        match row
            .get("operation_type")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "deposit" => {
                entry.total_deposited += amount;
                // Earliest deposit timestamp across the row's own deposits.
                if let Some(created) = row.get("created_at").and_then(Value::as_str) {
                    if entry
                        .first_deposit_at
                        .as_deref()
                        .is_none_or(|prev| created < prev)
                    {
                        entry.first_deposit_at = Some(created.to_string());
                    }
                }
            }
            "withdrawal" => entry.total_withdrawn += amount,
            "platform_fee" => {
                entry.total_fees_paid += amount;
                entry.has_explicit_fee = true;
            }
            _ => {}
        }
    }

    // Current balances — folds in wallets that have no audit rows yet.
    for row in balances {
        let raw_address = row.get("user_address").cloned().unwrap_or(Value::Null);
        if !is_address_compatible(raw_address.as_str().unwrap_or("")) {
            continue;
        }
        let address = canonical_of(&raw_address);
        let currency = row.get("currency").cloned().unwrap_or(Value::Null);
        let key = format!("{}::{}", address, value_to_string(&currency));
        let username = profile_map.get(&address).cloned().unwrap_or(Value::Null);
        let entry = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            LedgerRow::new(Value::String(address), currency.clone(), username)
        });
        entry.current_balance += number_or_zero(row.get("balance"));
    }

    // Real bets (demo excluded) — one wallet + resolved house currency per bet.
    for row in bets.iter().filter(|b| !is_demo_bet(b)) {
        let wallet = canonical_of(row.get("wallet_address").unwrap_or(&Value::Null));
        if !is_address_compatible(&wallet) {
            continue;
        }
        // Arc settles in native USDC; `resolve_house_ledger_currency` folds any
        // asset onto the one playable ticker.
        let currency =
            resolve_house_ledger_currency(row.get("asset")).unwrap_or_else(|_| "USDC".to_string());
        let key = format!("{wallet}::{currency}");
        let username = profile_map.get(&wallet).cloned().unwrap_or(Value::Null);
        let entry = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            LedgerRow::new(
                Value::String(wallet.clone()),
                Value::String(currency.clone()),
                username,
            )
        });
        entry.total_bets += 1;
        entry.total_wagered += number_or_zero(row.get("amount"));
        entry.total_payout += number_or_zero(row.get("payout"));
        if truthy(row.get("won")) {
            entry.total_wins += 1;
        }
    }

    // Estimate historical fees only where none were logged explicitly: the
    // deposit RPC stored the net (post-10%) amount, so gross = net / 0.9 and the
    // fee is net / 9; withdrawals are a flat 10%.
    for row in map.values_mut() {
        if row.total_fees_paid == 0.0 && !row.has_explicit_fee && row.total_deposited > 0.0 {
            row.total_fees_paid = row.total_deposited / 9.0 + row.total_withdrawn * 0.10;
        }
    }

    let mut players: Vec<LedgerRow> = order.iter().filter_map(|key| map.remove(key)).collect();

    // Build each output row, then sort by earliest deposit (nulls last), keeping
    // insertion order for ties via a stable sort — matching V8's `Array#sort`.
    players.sort_by(|a, b| match (&a.first_deposit_at, &b.first_deposit_at) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            if x < y {
                Ordering::Less
            } else {
                // The TS comparator returns 1 for equal strings; mirror it so a
                // genuine tie is not silently treated as strictly ordered.
                Ordering::Greater
            }
        }
    });

    players
        .into_iter()
        .map(|row| {
            // net_pnl is the player's perspective (money out minus money in,
            // including what is still parked in their balance); house_pnl is the
            // house's mirror image.
            let net_pnl = (row.total_withdrawn + row.current_balance) - row.total_deposited;
            let house_pnl = row.total_deposited - (row.total_withdrawn + row.current_balance);
            let first_deposit_at = match row.first_deposit_at {
                Some(value) => Value::String(value),
                None => Value::Null,
            };
            let mut obj = Map::new();
            obj.insert("user_address".into(), row.user_address);
            obj.insert("currency".into(), row.currency);
            obj.insert("total_deposited".into(), json_number(row.total_deposited));
            obj.insert("total_withdrawn".into(), json_number(row.total_withdrawn));
            obj.insert("current_balance".into(), json_number(row.current_balance));
            obj.insert("total_bets".into(), icount(row.total_bets));
            obj.insert("total_wins".into(), icount(row.total_wins));
            obj.insert("total_wagered".into(), json_number(row.total_wagered));
            obj.insert("total_payout".into(), json_number(row.total_payout));
            obj.insert("total_fees_paid".into(), json_number(row.total_fees_paid));
            obj.insert(
                "_has_explicit_fee".into(),
                Value::Bool(row.has_explicit_fee),
            );
            obj.insert("username".into(), row.username);
            obj.insert("first_deposit_at".into(), first_deposit_at);
            obj.insert("net_pnl".into(), json_number(net_pnl));
            obj.insert("house_pnl".into(), json_number(house_pnl));
            Value::Object(obj)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// GET /api/admin/wallet-insights
// ---------------------------------------------------------------------------

/// `AUDIT_CAP` / `BETS_CAP`: the explicit row caps the Next route applied.
const AUDIT_CAP: usize = 15_000;
const BETS_CAP: usize = 25_000;
/// A session is never counted above 4 h; stale unclosed rows cannot inflate it.
const SESSION_CAP_SECONDS: i64 = 4 * 3600;

async fn wallet_insights(
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    match run_wallet_insights(&headers, &params).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn run_wallet_insights(
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> ApiResult<Value> {
    require_admin(headers)?;

    let address = params
        .get("address")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if address.chars().count() < 3 {
        return Err(ApiError::bad_request(
            "Query param address is required (min 3 chars).",
        ));
    }
    if address.chars().count() > 256 {
        return Err(ApiError::bad_request("Address too long."));
    }

    let variants = search_variants(&address);
    if variants.is_empty() {
        return Err(ApiError::bad_request("Invalid address."));
    }

    // `bannedGlobally` is true if any spelling of the wallet is banned.
    let mut banned_globally = false;
    for variant in &variants {
        if is_globally_banned(variant).await {
            banned_globally = true;
        }
    }

    let variant_values: Vec<Value> = variants.iter().map(|v| Value::String(v.clone())).collect();
    let variant_refs: Vec<(&str, &Value)> = variant_values.iter().map(|v| ("text", v)).collect();
    let in_clause = sql::in_list(1, "text", variant_values.len());

    // Seven reads, each scoped to the wallet's variants. Six are fatal, the
    // sessions table is optional (it may not exist yet).
    let balances = fetch(
        &format!(
            "SELECT user_address, currency, balance, status, user_tier, updated_at, created_at \
             FROM user_balances WHERE user_address IN ({in_clause})"
        ),
        &variant_refs,
    )
    .await?;

    let audit = fetch(
        &format!(
            "SELECT id, user_address, currency, operation_type, amount, balance_before, \
             balance_after, transaction_hash, bet_id, created_at \
             FROM balance_audit_log WHERE user_address IN ({in_clause}) \
             ORDER BY created_at DESC LIMIT 15000"
        ),
        &variant_refs,
    )
    .await?;

    let bets = fetch(
        &format!(
            "SELECT id, wallet_address, asset, direction, amount, multiplier, strike_price, \
             end_price, payout, won, mode, network, resolved_at, created_at \
             FROM bet_history WHERE wallet_address IN ({in_clause}) \
             ORDER BY created_at DESC LIMIT 25000"
        ),
        &variant_refs,
    )
    .await?;

    let withdrawals = fetch(
        &format!(
            "SELECT id, user_address, currency, amount, net_amount, fee_amount, requested_at, \
             status, decided_by, tx_hash, created_at \
             FROM withdrawal_requests WHERE user_address IN ({in_clause}) \
             ORDER BY requested_at DESC LIMIT 500"
        ),
        &variant_refs,
    )
    .await?;

    let profile_rows = fetch(
        &format!(
            "SELECT user_address, username, access_code, updated_at FROM user_profiles \
             WHERE user_address IN ({in_clause}) LIMIT 1"
        ),
        &variant_refs,
    )
    .await?;

    let referral_rows = fetch(
        &format!(
            "SELECT user_address, referral_code, referral_count, referred_by, created_at \
             FROM user_referrals WHERE user_address IN ({in_clause}) LIMIT 1"
        ),
        &variant_refs,
    )
    .await?;

    let sessions = match fetch(
        &format!(
            "SELECT id, network, started_at, last_ping_at, ended_at FROM user_sessions \
             WHERE wallet_address IN ({in_clause}) ORDER BY started_at DESC LIMIT 200"
        ),
        &variant_refs,
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("[wallet-insights] user_sessions read failed, treated as empty: {err}");
            Vec::new()
        }
    };

    // --- balances: one row per currency, the newest `updated_at` wins -------
    let mut bal_order: Vec<String> = Vec::new();
    let mut bal_map: HashMap<String, Value> = HashMap::new();
    for row in &balances {
        let key = str_or(row.get("currency"), "null");
        match bal_map.get(&key) {
            None => {
                bal_order.push(key.clone());
                bal_map.insert(key, row.clone());
            }
            Some(existing) => {
                let fresh = parse_epoch_ms(row.get("updated_at"));
                let held = parse_epoch_ms(existing.get("updated_at"));
                if fresh > held {
                    bal_map.insert(key, row.clone());
                }
            }
        }
    }

    let mut withdrawable_by_currency: HashMap<String, f64> = HashMap::new();
    let mut balance_rows_out: Vec<Value> = Vec::new();
    for key in &bal_order {
        let row = &bal_map[key];
        let balance = number_or_zero(row.get("balance"));
        let is_active = row.get("status").and_then(Value::as_str) == Some("active");
        let can = if !banned_globally && is_active {
            balance
        } else {
            0.0
        };
        *withdrawable_by_currency.entry(key.clone()).or_default() += can;

        let mut obj = Map::new();
        obj.insert(
            "currency".into(),
            row.get("currency").cloned().unwrap_or(Value::Null),
        );
        obj.insert("balance".into(), json_number(balance));
        obj.insert(
            "status".into(),
            row.get("status").cloned().unwrap_or(Value::Null),
        );
        obj.insert(
            "user_tier".into(),
            Value::String(str_or(row.get("user_tier"), "free")),
        );
        obj.insert(
            "updated_at".into(),
            row.get("updated_at").cloned().unwrap_or(Value::Null),
        );
        obj.insert("withdrawableNow".into(), json_number(can));
        balance_rows_out.push(Value::Object(obj));
    }

    // --- audit aggregates ---------------------------------------------------
    let mut total_deposits: HashMap<String, f64> = HashMap::new();
    let mut total_withdrawals: HashMap<String, f64> = HashMap::new();
    let mut deposit_count = 0_i64;
    let mut withdrawal_count = 0_i64;
    let mut bet_placed_count = 0_i64;
    let mut payout_count = 0_i64;
    for row in &audit {
        let amount = number_or_zero(row.get("amount"));
        let currency = str_or(row.get("currency"), "USDC");
        match row
            .get("operation_type")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "deposit" => {
                add_to(&mut total_deposits, &currency, amount);
                deposit_count += 1;
            }
            "withdrawal" => {
                add_to(&mut total_withdrawals, &currency, amount);
                withdrawal_count += 1;
            }
            "bet_placed" => bet_placed_count += 1,
            "payout" => payout_count += 1,
            _ => {}
        }
    }

    // --- betting aggregates (all / real / demo, wallet-address demo test) ----
    let real_bets: Vec<Value> = bets
        .iter()
        .filter(|b| !is_demo_wallet(b.get("wallet_address")))
        .cloned()
        .collect();
    let demo_bets: Vec<Value> = bets
        .iter()
        .filter(|b| is_demo_wallet(b.get("wallet_address")))
        .cloned()
        .collect();
    let betting_all = aggregate_bets(&bets);
    let betting_real = aggregate_bets(&real_bets);
    let betting_demo = aggregate_bets(&demo_bets);

    // --- withdrawals by status ---------------------------------------------
    let status_of = |row: &Value| {
        row.get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let pending: Vec<Value> = withdrawals
        .iter()
        .filter(|w| status_of(w) == "pending")
        .cloned()
        .collect();
    let accepted: Vec<Value> = withdrawals
        .iter()
        .filter(|w| status_of(w) == "accepted")
        .cloned()
        .collect();
    let rejected: Vec<Value> = withdrawals
        .iter()
        .filter(|w| status_of(w) == "rejected")
        .cloned()
        .collect();
    let mut pending_total: HashMap<String, f64> = HashMap::new();
    for row in &pending {
        let amount = number_or_zero(row.get("amount"));
        let currency = str_or(row.get("currency"), "");
        add_to(&mut pending_total, &currency, amount);
    }

    // --- time on platform ---------------------------------------------------
    let time_on_platform = compute_time_on_platform(&sessions);

    let audit_rows = audit.len();
    let bets_rows = bets.len();

    let mut audit_agg = Map::new();
    audit_agg.insert(
        "totalDepositsByCurrency".into(),
        money_object(&total_deposits),
    );
    audit_agg.insert(
        "totalWithdrawalsByCurrency".into(),
        money_object(&total_withdrawals),
    );
    audit_agg.insert("depositCount".into(), icount(deposit_count));
    audit_agg.insert("withdrawalCount".into(), icount(withdrawal_count));
    audit_agg.insert("betPlacedAuditCount".into(), icount(bet_placed_count));
    audit_agg.insert("payoutAuditCount".into(), icount(payout_count));
    audit_agg.insert("rowsReturned".into(), icount(audit_rows as i64));
    audit_agg.insert("cappedAt".into(), icount(AUDIT_CAP as i64));
    audit_agg.insert(
        "auditTruncated".into(),
        Value::Bool(audit_rows >= AUDIT_CAP),
    );

    let mut betting_agg = Map::new();
    betting_agg.insert("all".into(), bet_agg_value(&betting_all));
    betting_agg.insert("real".into(), bet_agg_value(&betting_real));
    betting_agg.insert("demo".into(), bet_agg_value(&betting_demo));
    betting_agg.insert("betsRowsReturned".into(), icount(bets_rows as i64));
    betting_agg.insert("betsCappedAt".into(), icount(BETS_CAP as i64));
    betting_agg.insert("betsTruncated".into(), Value::Bool(bets_rows >= BETS_CAP));

    let mut withdrawal_agg = Map::new();
    withdrawal_agg.insert("pending".into(), Value::Array(pending));
    withdrawal_agg.insert("accepted".into(), Value::Array(accepted));
    withdrawal_agg.insert("rejected".into(), Value::Array(rejected));
    withdrawal_agg.insert(
        "pendingTotalByCurrency".into(),
        money_object(&pending_total),
    );

    let mut summary = Map::new();
    summary.insert(
        "netBettingProfitLoss".into(),
        json_number(betting_all.net_pl),
    );
    summary.insert(
        "houseEdgeFromBets".into(),
        json_number(betting_all.wagered - betting_all.payout),
    );

    let mut aggregates = Map::new();
    aggregates.insert("audit".into(), Value::Object(audit_agg));
    aggregates.insert("betting".into(), Value::Object(betting_agg));
    aggregates.insert("withdrawals".into(), Value::Object(withdrawal_agg));
    aggregates.insert(
        "withdrawableByCurrency".into(),
        money_object(&withdrawable_by_currency),
    );
    aggregates.insert("summary".into(), Value::Object(summary));

    // --- profile / referral projections (three / three fields) --------------
    let profile = profile_rows
        .first()
        .map(|row| {
            let mut obj = Map::new();
            obj.insert(
                "username".into(),
                row.get("username").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "access_code".into(),
                row.get("access_code").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "updated_at".into(),
                row.get("updated_at").cloned().unwrap_or(Value::Null),
            );
            Value::Object(obj)
        })
        .unwrap_or(Value::Null);

    let referral = referral_rows
        .first()
        .map(|row| {
            let mut obj = Map::new();
            obj.insert(
                "referral_code".into(),
                row.get("referral_code").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "referral_count".into(),
                row.get("referral_count").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "referred_by".into(),
                row.get("referred_by").cloned().unwrap_or(Value::Null),
            );
            Value::Object(obj)
        })
        .unwrap_or(Value::Null);

    let mut body = Map::new();
    body.insert("query".into(), Value::String(address));
    body.insert(
        "variantsUsed".into(),
        Value::Array(variants.into_iter().map(Value::String).collect()),
    );
    body.insert("bannedGlobally".into(), Value::Bool(banned_globally));
    body.insert("balances".into(), Value::Array(balance_rows_out));
    body.insert("aggregates".into(), Value::Object(aggregates));
    body.insert("profile".into(), profile);
    body.insert("referral".into(), referral);
    body.insert(
        "recentAudit".into(),
        Value::Array(audit.into_iter().take(80).collect()),
    );
    body.insert(
        "recentBets".into(),
        Value::Array(bets.into_iter().take(80).collect()),
    );
    body.insert("withdrawalHistory".into(), Value::Array(withdrawals));
    body.insert("timeOnPlatform".into(), time_on_platform);
    Ok(Value::Object(body))
}

/// The `aggregateBets` result of the route: totals, the user-perspective P&L,
/// a win *fraction* (this route, unlike mode-analytics, does not scale to a
/// percentage) and a per-network breakdown.
struct NetAgg {
    bets: i64,
    wins: i64,
    losses: i64,
    wagered: f64,
    payout: f64,
    net: f64,
}

impl Default for NetAgg {
    fn default() -> Self {
        Self {
            bets: 0,
            wins: 0,
            losses: 0,
            wagered: 0.0,
            payout: 0.0,
            net: 0.0,
        }
    }
}

struct BetAgg {
    total_bets: i64,
    wins: i64,
    losses: i64,
    wagered: f64,
    payout: f64,
    net_pl: f64,
    win_rate: f64,
    by_network: HashMap<String, NetAgg>,
}

fn aggregate_bets(rows: &[Value]) -> BetAgg {
    let mut wins = 0_i64;
    let mut losses = 0_i64;
    let mut wagered = 0.0_f64;
    let mut payout = 0.0_f64;
    let mut by_network: HashMap<String, NetAgg> = HashMap::new();

    for row in rows {
        let wager = number_or_zero(row.get("amount"));
        let pay = number_or_zero(row.get("payout"));
        let won = truthy(row.get("won"));
        let net = if won { pay - wager } else { -wager };
        wagered += wager;
        payout += pay;
        if won {
            wins += 1;
        } else {
            losses += 1;
        }

        let key = str_or(row.get("network"), "UNKNOWN");
        let entry = by_network.entry(key).or_default();
        entry.bets += 1;
        if won {
            entry.wins += 1;
        } else {
            entry.losses += 1;
        }
        entry.wagered += wager;
        entry.payout += pay;
        entry.net += net;
    }

    let total_bets = rows.len() as i64;
    BetAgg {
        total_bets,
        wins,
        losses,
        wagered,
        payout,
        net_pl: payout - wagered,
        win_rate: if total_bets > 0 {
            wins as f64 / total_bets as f64
        } else {
            0.0
        },
        by_network,
    }
}

fn bet_agg_value(agg: &BetAgg) -> Value {
    let networks: Map<String, Value> = agg
        .by_network
        .iter()
        .map(|(network, stat)| {
            let mut obj = Map::new();
            obj.insert("bets".into(), icount(stat.bets));
            obj.insert("wins".into(), icount(stat.wins));
            obj.insert("losses".into(), icount(stat.losses));
            obj.insert("wagered".into(), json_number(stat.wagered));
            obj.insert("payout".into(), json_number(stat.payout));
            obj.insert("net".into(), json_number(stat.net));
            (network.clone(), Value::Object(obj))
        })
        .collect();

    let mut obj = Map::new();
    obj.insert("totalBets".into(), icount(agg.total_bets));
    obj.insert("wins".into(), icount(agg.wins));
    obj.insert("losses".into(), icount(agg.losses));
    obj.insert("totalWagered".into(), json_number(agg.wagered));
    obj.insert("totalPayoutReceived".into(), json_number(agg.payout));
    obj.insert("netBettingPLUser".into(), json_number(agg.net_pl));
    obj.insert("winRate".into(), json_number(agg.win_rate));
    obj.insert("byNetwork".into(), Value::Object(networks));
    Value::Object(obj)
}

/// The dwell block: `end - start` per session, capped at 4 h, with the newest
/// ping and oldest start surfaced and the first twenty sessions detailed.
fn compute_time_on_platform(sessions: &[Value]) -> Value {
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let mut total_seconds = 0_i64;
    for session in sessions {
        let raw = session_duration(session, now);
        total_seconds += raw.min(SESSION_CAP_SECONDS as f64) as i64;
    }

    let last_seen = sessions
        .first()
        .and_then(|s| s.get("last_ping_at"))
        .cloned()
        .unwrap_or(Value::Null);
    let first_seen = sessions
        .last()
        .and_then(|s| s.get("started_at"))
        .cloned()
        .unwrap_or(Value::Null);

    let recent: Vec<Value> = sessions
        .iter()
        .take(20)
        .map(|session| {
            let raw = session_duration(session, now);
            let ended_at = match session.get("ended_at") {
                None | Some(Value::Null) => Value::Null,
                Some(value) => value.clone(),
            };
            let mut obj = Map::new();
            obj.insert(
                "id".into(),
                session.get("id").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "network".into(),
                session.get("network").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "started_at".into(),
                session.get("started_at").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "last_ping_at".into(),
                session.get("last_ping_at").cloned().unwrap_or(Value::Null),
            );
            obj.insert("ended_at".into(), ended_at);
            obj.insert(
                "durationSeconds".into(),
                icount(raw.min(SESSION_CAP_SECONDS as f64) as i64),
            );
            obj.insert(
                "capped".into(),
                Value::Bool(raw > SESSION_CAP_SECONDS as f64),
            );
            Value::Object(obj)
        })
        .collect();

    let mut obj = Map::new();
    obj.insert("totalSessions".into(), icount(sessions.len() as i64));
    obj.insert("totalSeconds".into(), icount(total_seconds));
    obj.insert(
        "formatted".into(),
        Value::String(fmt_duration(total_seconds)),
    );
    obj.insert("lastSeen".into(), last_seen);
    obj.insert("firstSeen".into(), first_seen);
    obj.insert("recentSessions".into(), Value::Array(recent));
    Value::Object(obj)
}

/// `Math.max(0, Math.floor((end - start) / 1000))` in seconds, where `end` is
/// the session's `ended_at` or its last ping plus the 90 s idle tail (never past
/// now). A malformed timestamp is folded to 0 rather than poisoning the total.
fn session_duration(session: &Value, now: f64) -> f64 {
    let started = parse_epoch_ms(session.get("started_at"));
    let ended = match session.get("ended_at") {
        Some(Value::String(text)) if !text.is_empty() => parse_epoch_ms(session.get("ended_at")),
        _ => (parse_epoch_ms(session.get("last_ping_at")) + 90_000.0).min(now),
    };
    let delta = (ended - started) / 1000.0;
    if delta.is_finite() {
        delta.floor().max(0.0)
    } else {
        0.0
    }
}

/// `fmtDuration`: `1h 2m 3s`, omitting empty leading units, always a seconds
/// tail, and `0s` for anything non-positive.
fn fmt_duration(seconds: i64) -> String {
    if seconds <= 0 {
        return "0s".to_string();
    }
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;
    let mut parts: Vec<String> = Vec::new();
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    parts.push(format!("{secs}s"));
    parts.join(" ")
}
