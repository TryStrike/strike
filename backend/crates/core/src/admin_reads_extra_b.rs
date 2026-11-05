//! Admin read helpers for the `/api/admin/*` GET family that
//! [`crate::admin_reads_a`] does not already cover:
//!
//! * `GET /api/admin/currencies` — the token board (categories + latest price),
//! * `GET /api/admin/banned-wallets` — the ban list,
//! * `GET /api/admin/withdrawal-requests/pending` — the pending queue,
//! * `GET /api/admin/export` — RFC-4180 CSV over three datasets,
//! * `GET /api/admin/treasury-balances` — the on-chain treasury snapshot.
//!
//! The users / game-history / transactions reads already live in
//! [`crate::admin_reads_a`] (`load_users`, `load_game_history_*`, the `Binds`
//! and `Prepared` builders); this module reuses those rather than duplicating
//! them. Everything here is either pure (bodies, CSV, category maps) or a thin
//! async read over `crate::db` / `crate::eth::Rpc`, matching the transport
//! conventions the routes depend on.

use std::collections::BTreeMap;

use serde_json::{Map, Number, Value};

use crate::admin_reads_a::{like_pattern, project_row, Binds, ListParams, Prepared};
use crate::config::{config, ARC_ASSETS, ARC_NETWORK_NAME, USDC_DECIMALS};
use crate::crypto::MAX_ACCEPT_INTENT_AGE_MS;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::eth::{self, Rpc};
use crate::platform_stats::is_demo_bet;
use crate::prices::{self, fetch_latest_prices, VALID_ASSETS};
use crate::treasury_view;

/// `text` — the type of every id, ticker, address and status column below.
const TEXT: &str = "text";
/// `timestamp with time zone` — the audited `requested_at` / `created_at` bounds.
const TIMESTAMPTZ: &str = "timestamp with time zone";
const BOOLEAN: &str = "boolean";
/// Paging window type, as in `admin_reads_a` and `routes/withdrawals.rs`.
const INT8: &str = "int8";

/// A JS number as `JSON.stringify` would print it (integral doubles lose the
/// `.0`, non-finite becomes `null`), so numbers in these bodies match the TS.
fn json_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        return Value::Number(Number::from(value as i64));
    }
    prices::number_to_value(value)
}

fn json_int(value: i64) -> Value {
    Value::Number(Number::from(value))
}

// ---------------------------------------------------------------------------
// GET /api/admin/currencies
// ---------------------------------------------------------------------------

/// The four hardcoded category sets the currencies route declares, matched in
/// the route's own order (Forex, Metals, Stocks, then Commodities; else Crypto).
pub fn currency_category(symbol: &str) -> &'static str {
    const FOREX: [&str; 5] = ["EUR", "GBP", "JPY", "AUD", "CAD"];
    const METALS: [&str; 2] = ["GOLD", "SILVER"];
    const COMMODITIES: [&str; 5] = ["WTI", "BRENT", "SPX", "NDX", "DJI"];
    const STOCKS: [&str; 22] = [
        "AAPL", "GOOGL", "AMZN", "MSFT", "NVDA", "TSLA", "META", "NFLX", "AMD", "BABA", "DIS",
        "JPM", "V", "MA", "PYPL", "COIN", "MSTR", "UBER", "PLTR", "CRM", "INTC", "TSM",
    ];
    if FOREX.contains(&symbol) {
        "Forex"
    } else if METALS.contains(&symbol) {
        "Metals"
    } else if STOCKS.contains(&symbol) {
        "Stocks"
    } else if COMMODITIES.contains(&symbol) {
        "Commodities"
    } else {
        "Crypto"
    }
}

/// `{ tokens: [{ symbol, category, price }], totalTokens }` over
/// `Object.keys(PRICE_FEED_IDS)` in declaration order (== `VALID_ASSETS`).
/// `price` is `currentPrices[symbol] || 0`, so a missing or non-finite quote
/// folds onto `0` exactly as the JS does.
pub fn currencies_body(current: &BTreeMap<String, f64>) -> Value {
    let tokens: Vec<Value> = VALID_ASSETS
        .iter()
        .map(|symbol| {
            let price = current.get(*symbol).copied().unwrap_or(0.0);
            let price = if price.is_finite() { price } else { 0.0 };
            let mut map = Map::new();
            map.insert("symbol".into(), Value::String(symbol.to_string()));
            map.insert(
                "category".into(),
                Value::String(currency_category(symbol).to_string()),
            );
            map.insert("price".into(), json_number(price));
            Value::Object(map)
        })
        .collect();
    let mut body = Map::new();
    body.insert("tokens".into(), Value::Array(tokens));
    body.insert("totalTokens".into(), json_int(VALID_ASSETS.len() as i64));
    Value::Object(body)
}

/// The route's one round trip: quote every feed symbol, then shape the board.
pub async fn load_currencies() -> ApiResult<Value> {
    let symbols: Vec<String> = VALID_ASSETS
        .iter()
        .map(|symbol| symbol.to_string())
        .collect();
    let current = fetch_latest_prices(&symbols, false).await;
    Ok(currencies_body(&current))
}

// ---------------------------------------------------------------------------
// GET /api/admin/banned-wallets
// ---------------------------------------------------------------------------

/// `banned_wallets` columns the route selects, newest ban first.
const BANNED_SELECT: &str =
    "SELECT wallet_address, reason, created_at FROM banned_wallets ORDER BY created_at DESC";
const BANNED_KEYS: [&str; 3] = ["wallet_address", "reason", "created_at"];

/// `{ bans: [...] }` — the row shape the panel already reads, projected so a
/// widened column list cannot leak a future field.
pub fn banned_wallets_body(rows: &[Value]) -> Value {
    let bans: Vec<Value> = rows
        .iter()
        .map(|row| project_row(row, &BANNED_KEYS))
        .collect();
    let mut body = Map::new();
    body.insert("bans".into(), Value::Array(bans));
    Value::Object(body)
}

pub async fn load_banned_wallets() -> ApiResult<Value> {
    let rows = db::fetch(BANNED_SELECT, &[]).await?;
    Ok(banned_wallets_body(&rows))
}

/// Logs the failure and answers a sanitized 500.
pub fn banned_wallets_failure(err: &ApiError, fallback: &str, label: &str) -> ApiError {
    tracing::error!("[admin/{label}] {fallback}: {err}");
    ApiError::internal(crate::admin_reads_a::sanitize_error_message(
        &err.to_string(),
        fallback,
    ))
}

// ---------------------------------------------------------------------------
// GET /api/admin/withdrawal-requests/pending
// ---------------------------------------------------------------------------

/// `SELECT` list for the pending queue. `signed_at` is added (extension only) so
/// the dashboard can disable Accept past the 10-minute window; `decided_by`
/// stays because the admin panel already reads it.
const PENDING_SELECT: &str = "id, user_address, currency, amount, net_amount, fee_amount, \
     requested_at, status, decided_by, tx_hash, created_at, signed_at";
const PENDING_KEYS: [&str; 12] = [
    "id",
    "user_address",
    "currency",
    "amount",
    "net_amount",
    "fee_amount",
    "requested_at",
    "status",
    "decided_by",
    "tx_hash",
    "created_at",
    "signed_at",
];

/// The pending-filtered, paged statement with an exact count over the same
/// WHERE prefix — the `.eq('status','pending')` plus the uniform list filters
/// the route applies before `order + range`.
pub fn withdrawal_pending_statement(p: &ListParams) -> Prepared {
    let mut binds = Binds::new();
    let mut clauses: Vec<String> = Vec::new();

    let status_ph = binds.push(TEXT, Value::String("pending".to_string()));
    clauses.push(format!("status = {status_ph}"));
    if let Some(q) = &p.q {
        let ph = binds.push(TEXT, Value::String(like_pattern(q)));
        clauses.push(format!("pg_ilike(user_address, {ph})"));
    }
    if let Some(currency) = &p.currency {
        let ph = binds.push(TEXT, Value::String(currency.clone()));
        clauses.push(format!("currency = {ph}"));
    }
    if let Some(from) = &p.from {
        let ph = binds.push(TIMESTAMPTZ, Value::String(from.clone()));
        clauses.push(format!("requested_at >= {ph}"));
    }
    if let Some(to) = &p.to {
        let ph = binds.push(TIMESTAMPTZ, Value::String(to.clone()));
        clauses.push(format!("requested_at <= {ph}"));
    }

    let where_sql = format!("WHERE {}", clauses.join(" AND "));
    let filter_binds = binds.len();
    let limit_ph = binds.push(INT8, json_int(p.limit));
    let offset_ph = binds.push(INT8, json_int(p.offset));

    Prepared {
        sql: format!(
            "SELECT {PENDING_SELECT} FROM withdrawal_requests {where_sql} \
             ORDER BY requested_at DESC, id DESC LIMIT {limit_ph} OFFSET {offset_ph}"
        ),
        count_sql: Some(format!(
            "SELECT COUNT(*) AS count FROM withdrawal_requests {where_sql}"
        )),
        binds,
        filter_binds,
    }
}

/// `{ requests, total, limit, offset, maxAcceptAgeMs }` — the dashboard's
/// existing keys plus the paging four and the accept-window length.
pub async fn load_withdrawal_pending(p: &ListParams) -> ApiResult<Value> {
    let prepared = withdrawal_pending_statement(p);
    let rows = db::fetch(&prepared.sql, &prepared.row_refs()).await?;
    let total = match &prepared.count_sql {
        Some(count_sql) => {
            let value = db::fetch_scalar(count_sql, &prepared.count_refs()).await?;
            value.as_i64().unwrap_or(rows.len() as i64)
        }
        None => rows.len() as i64,
    };

    let requests: Vec<Value> = rows
        .iter()
        .map(|row| project_row(row, &PENDING_KEYS))
        .collect();
    // Unfiltered and not paged: what is debited but not settled has to stay in
    // view until someone is done with it. An accept keeps running after the admin's
    // request is gone, so this is where they see how it ended.
    let unresolved = db::fetch(
        "SELECT id, user_address, currency, amount, net_amount, status, notes, decided_at \
         FROM withdrawal_requests \
         WHERE (status = 'accepted' AND tx_hash IS NULL) OR status = 'paid_needs_reconciliation' \
         ORDER BY decided_at DESC LIMIT 200",
        &[],
    )
    .await?;
    let mut body = Map::new();
    body.insert("requests".into(), Value::Array(requests));
    body.insert("unresolved".into(), Value::Array(unresolved));
    body.insert("total".into(), json_int(total));
    body.insert("limit".into(), json_int(p.limit));
    body.insert("offset".into(), json_int(p.offset));
    body.insert("maxAcceptAgeMs".into(), json_int(MAX_ACCEPT_INTENT_AGE_MS));
    Ok(Value::Object(body))
}

// ---------------------------------------------------------------------------
// GET /api/admin/export
// ---------------------------------------------------------------------------

/// `EXPORT_ROW_CAP`: a single export never returns more than this many rows.
pub const EXPORT_ROW_CAP: i64 = 5_000;
/// `SCAN_PAGE`: rows pulled per page while walking the query-capped builder.
const EXPORT_SCAN_PAGE: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportDataset {
    Transactions,
    GameHistory,
}

impl ExportDataset {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transactions => "transactions",
            Self::GameHistory => "game_history",
        }
    }
}

/// `resolveDataset`: trims, lower-cases, maps `-` to `_`, and matches the
/// whitelisted names. Anything else is `None` (the route answers 400).
pub fn resolve_dataset(raw: Option<&str>) -> Option<ExportDataset> {
    let value = raw.unwrap_or("").trim().to_lowercase().replace('-', "_");
    match value.as_str() {
        "transactions" => Some(ExportDataset::Transactions),
        "game_history" => Some(ExportDataset::GameHistory),
        _ => None,
    }
}

const TX_COLUMNS: [&str; 10] = [
    "id",
    "created_at",
    "user_address",
    "operation_type",
    "currency",
    "amount",
    "balance_before",
    "balance_after",
    "transaction_hash",
    "bet_id",
];
const BET_COLUMNS: [&str; 10] = [
    "id",
    "created_at",
    "wallet_address",
    "asset",
    "direction",
    "amount",
    "payout",
    "won",
    "mode",
    "network",
];
fn dataset_columns(dataset: ExportDataset) -> &'static [&'static str] {
    match dataset {
        ExportDataset::Transactions => &TX_COLUMNS,
        ExportDataset::GameHistory => &BET_COLUMNS,
    }
}

fn dataset_table(dataset: ExportDataset) -> &'static str {
    match dataset {
        ExportDataset::Transactions => "balance_audit_log",
        ExportDataset::GameHistory => "bet_history",
    }
}

/// One `collectRows` page: the dataset's filters, ordered newest-first, a fixed
/// `EXPORT_SCAN_PAGE` window at `from`, and no count statement (export never
/// counts).
pub fn export_statement(dataset: ExportDataset, p: &ListParams, from: i64) -> Prepared {
    let mut binds = Binds::new();
    let mut clauses: Vec<String> = Vec::new();

    match dataset {
        ExportDataset::Transactions => {
            // `.in('operation_type', p.status ? [p.status] : ['deposit','withdrawal'])`:
            // a chosen status narrows to that one operation, otherwise both.
            let operations: Vec<&str> = match p.status.as_deref() {
                Some(status) => vec![status],
                None => vec!["deposit", "withdrawal"],
            };
            let list: Vec<String> = operations
                .iter()
                .map(|op| binds.push(TEXT, Value::String(op.to_string())))
                .collect();
            clauses.push(format!("operation_type IN ({})", list.join(", ")));
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
            push_created_bounds(&mut binds, &mut clauses, p);
        }
        ExportDataset::GameHistory => {
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
            push_created_bounds(&mut binds, &mut clauses, p);
        }
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let columns = dataset_columns(dataset).join(", ");
    let filter_binds = binds.len();
    let page_ph = binds.push(INT8, json_int(EXPORT_SCAN_PAGE));
    let offset_ph = binds.push(INT8, json_int(from));

    Prepared {
        sql: format!(
            "SELECT {columns} FROM {} {where_sql} ORDER BY created_at DESC, id DESC \
             LIMIT {page_ph} OFFSET {offset_ph}",
            dataset_table(dataset)
        ),
        count_sql: None,
        binds,
        filter_binds,
    }
}

fn push_created_bounds(binds: &mut Binds, clauses: &mut Vec<String>, p: &ListParams) {
    if let Some(from) = &p.from {
        let ph = binds.push(TIMESTAMPTZ, Value::String(from.clone()));
        clauses.push(format!("created_at >= {ph}"));
    }
    if let Some(to) = &p.to {
        let ph = binds.push(TIMESTAMPTZ, Value::String(to.clone()));
        clauses.push(format!("created_at <= {ph}"));
    }
}

/// The real/demo split the `game_history` dataset applies in JS (SQL has no
/// cheap NOT-LIKE), then the export row cap.
pub async fn collect_export_rows(dataset: ExportDataset, p: &ListParams) -> ApiResult<Vec<Value>> {
    let mut rows: Vec<Value> = Vec::new();
    let mut from = 0_i64;
    while from < EXPORT_ROW_CAP {
        let prepared = export_statement(dataset, p, from);
        let chunk = db::fetch(&prepared.sql, &prepared.row_refs()).await?;
        let chunk_len = chunk.len() as i64;
        rows.extend(chunk);
        if chunk_len < EXPORT_SCAN_PAGE {
            break;
        }
        from += EXPORT_SCAN_PAGE;
    }

    if dataset == ExportDataset::GameHistory {
        let account = p.extra("account").unwrap_or("all");
        if account != "all" {
            let wanted = account == "demo";
            rows.retain(|row| is_demo_bet(row) == wanted);
        }
    }
    rows.truncate(EXPORT_ROW_CAP as usize);
    Ok(rows)
}

/// `cellToString` for a decoded Postgres column: null / absent is the empty
/// cell, a bool is `true`/`false`, a finite number is JS's plain spelling, and
/// a nested value is JSON (never `[object Object]`).
fn cell_to_string(value: &Value) -> (bool, String) {
    match value {
        Value::Null => (false, String::new()),
        Value::Bool(b) => (false, b.to_string()),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => (true, prices::number_to_json(f)),
            _ => (false, String::new()),
        },
        Value::String(s) => (false, s.clone()),
        other => (false, other.to_string()),
    }
}

fn normalize_line_breaks(input: &str) -> String {
    // `\r\n?` -> `\n`, then `\n` -> `\r\n`, exactly as the TS does.
    input
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n")
}

/// `csvEscape`: RFC-4180 quoting with the formula-injection guard. A finite
/// numeric cell is emitted plain (a negative amount is never treated as a
/// formula); every other formula-lead character gets a leading `'`.
pub fn csv_escape(value: &Value) -> String {
    let (is_numeric, raw) = cell_to_string(value);
    if raw.is_empty() {
        return String::new();
    }
    let mut s = normalize_line_breaks(&raw);

    let injection = !is_numeric && s.starts_with(['=', '+', '-', '@', '\t', '\r']);
    if injection {
        s = format!("'{s}");
    }

    let needs_quote = s.contains(['"', ',', '\r', '\n'])
        || s.starts_with([' ', '\t'])
        || s.ends_with([' ', '\t']);
    if !needs_quote && !injection {
        return s;
    }
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn csv_row(cells: &[Value]) -> String {
    cells.iter().map(csv_escape).collect::<Vec<_>>().join(",") + "\r\n"
}

/// `buildCsv`: header row then one row per record, CRLF throughout. Column
/// order is the dataset's declared whitelist; a missing column is the empty cell.
pub fn build_csv(columns: &[&str], rows: &[Value]) -> String {
    let header: Vec<Value> = columns
        .iter()
        .map(|c| Value::String(c.to_string()))
        .collect();
    let mut out = csv_row(&header);
    for row in rows {
        let cells: Vec<Value> = columns
            .iter()
            .map(|c| row.get(*c).cloned().unwrap_or(Value::Null))
            .collect();
        out.push_str(&csv_row(&cells));
    }
    out
}

/// `utcDateStamp` — today's UTC date as `YYYY-MM-DD`.
pub fn utc_date_stamp() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// `exportFileName` — a whitelist name plus the UTC date, so nothing the client
/// controls ever reaches `Content-Disposition`.
pub fn export_file_name(dataset: Option<ExportDataset>) -> String {
    let name = dataset.map_or("export", |d| d.as_str());
    format!("strike_{name}_{}.csv", utc_date_stamp())
}

/// The whole export: collect the filtered rows and render them as CSV. Returns
/// the document body and the file name for `Content-Disposition`.
pub async fn build_export(dataset: ExportDataset, p: &ListParams) -> ApiResult<(String, String)> {
    let rows = collect_export_rows(dataset, p).await?;
    let body = build_csv(dataset_columns(dataset), &rows);
    Ok((body, export_file_name(Some(dataset))))
}

// ---------------------------------------------------------------------------
// GET /api/admin/treasury-balances  (buildTreasuryBalanceSnapshot + treasuryBalanceUsd)
// ---------------------------------------------------------------------------

/// `usdPerUnit`: USDC is pegged at $1; anything else has no invented quote.
pub fn usd_per_unit(asset: &str) -> Option<f64> {
    if asset.to_uppercase() == "USDC" {
        Some(1.0)
    } else {
        None
    }
}

/// `balanceTimesUsd`: null when either side is missing or non-finite.
pub fn balance_times_usd(balance: Option<f64>, unit_usd: Option<f64>) -> Option<f64> {
    match (balance, unit_usd) {
        (Some(balance), Some(unit)) if balance.is_finite() && unit.is_finite() => {
            Some(balance * unit)
        }
        _ => None,
    }
}

/// The grouping half of `toLocaleString(undefined, {min,max}imumFractionDigits)`
/// — thousands separators with a fixed minimum number of fraction digits and a
/// rounded maximum. The separator is hard-wired to the en-US comma; matching the
/// runtime's ambient locale byte-for-byte is not possible here and the numeric
/// fields, not these display strings, are the contract.
fn fmt_grouped(value: f64, min_frac: usize, max_frac: usize) -> String {
    let negative = value < 0.0;
    let magnitude = value.abs();

    let scale = 10f64.powi(max_frac as i32);
    let scaled = (magnitude * scale).round();
    let mut integer = (scaled / scale).floor() as i64;
    let mut fraction = (scaled - (integer as f64) * scale).round() as i64;
    if fraction >= scale as i64 {
        integer += 1;
        fraction -= scale as i64;
    }

    let grouped = group_thousands(integer);
    let sign = if negative && (integer != 0 || fraction != 0) {
        "-"
    } else {
        ""
    };
    if max_frac == 0 || (fraction == 0 && min_frac == 0) {
        return format!("{sign}{grouped}");
    }

    // Zero-pad to the maximum, then trim back to the minimum on the right.
    let mut digits = format!("{:0>1$}", fraction, max_frac);
    let keep = min_frac.max(1);
    while digits.len() > keep && digits.ends_with('0') {
        digits.pop();
    }
    format!("{sign}{grouped}.{digits}")
}

/// Inserts a `,` every three digits left of the decimal point.
fn group_thousands(mut value: i64) -> String {
    if value < 0 {
        value = -value;
    }
    let digits = value.to_string();
    let mut out = String::new();
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (digits.len() - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn fmt_balance(balance: Option<f64>) -> String {
    match balance {
        None => "—".to_string(),
        Some(value) if !value.is_finite() => "—".to_string(),
        Some(0.0) => "0".to_string(),
        Some(value) if value.abs() >= 1e9 => format!("{value:e}"),
        Some(value) => fmt_grouped(value, 0, 6),
    }
}

/// `formatUsd`: `<$0.01` for a tiny positive figure, exponential past a billion,
/// else two fixed decimals with thousands grouping and a leading `$`.
pub fn format_usd(balance_usd: Option<f64>) -> String {
    match balance_usd {
        None => "—".to_string(),
        Some(value) if !value.is_finite() => "—".to_string(),
        Some(value) if value > 0.0 && value < 0.01 => "<$0.01".to_string(),
        Some(value) if value.abs() >= 1e9 => format!("${value:e}"),
        Some(value) => format!("${}", fmt_grouped(value, 2, 2)),
    }
}

fn iso_now() -> String {
    crate::bets::iso_ms(chrono::Utc::now().timestamp_millis())
}

/// A snapshot row: the fixed `base` fields, the balance (or its absence), the
/// display string and the per-row error, best-effort as the TS is.
fn treasury_row(
    asset: &str,
    address: &str,
    balance: Option<f64>,
    error: Option<String>,
    explorer_url: Option<String>,
) -> Value {
    let mut map = Map::new();
    map.insert("chain".into(), Value::String("ARC".to_string()));
    map.insert("label".into(), Value::String(ARC_NETWORK_NAME.to_string()));
    map.insert("address".into(), Value::String(address.to_string()));
    map.insert("asset".into(), Value::String(asset.to_string()));
    map.insert(
        "balance".into(),
        balance.map(json_number).unwrap_or(Value::Null),
    );
    map.insert("formatted".into(), Value::String(fmt_balance(balance)));
    map.insert(
        "explorerUrl".into(),
        explorer_url.map(Value::String).unwrap_or(Value::Null),
    );
    map.insert(
        "error".into(),
        error.map(Value::String).unwrap_or(Value::Null),
    );
    Value::Object(map)
}

/// The snapshot rows: one best-effort read per playable Arc asset. An unset
/// treasury is reported as configured-error rows (not a 500); an RPC failure
/// poisons only its own row.
pub async fn build_treasury_balance_snapshot() -> Vec<Value> {
    let cfg = config();
    let address = cfg.treasury_address.trim().to_string();

    if address.is_empty() {
        return ARC_ASSETS
            .iter()
            .map(|asset| {
                treasury_row(
                    asset,
                    "",
                    None,
                    Some("NEXT_PUBLIC_TREASURY_ADDRESS is not configured".to_string()),
                    None,
                )
            })
            .collect();
    }

    // `explorerAddressUrl(address)` — `${explorer}/address/${trimmed}`.
    let explorer_url = Some(format!("{}/address/{}", cfg.arc_explorer, address));
    let rpc = Rpc::from_config();
    let usdc = cfg.arc_usdc.clone();
    let calldata = treasury_view::balance_of_calldata(&address);

    let mut rows = Vec::new();
    for asset in ARC_ASSETS {
        // A single read per asset; with only USDC playable this is one call, and
        // `Promise.all` in the TS was effectively serial too.
        match rpc.call_uint256(&usdc, &calldata).await {
            Ok(raw) => {
                let balance = eth::format_units(raw, USDC_DECIMALS);
                rows.push(treasury_row(
                    asset,
                    &address,
                    Some(balance),
                    None,
                    explorer_url.clone(),
                ));
            }
            Err(err) => {
                let message = err.to_string();
                let message = if message.is_empty() {
                    "failed".to_string()
                } else {
                    message
                };
                rows.push(treasury_row(
                    asset,
                    &address,
                    None,
                    Some(message),
                    explorer_url.clone(),
                ));
            }
        }
    }
    rows
}

/// `{ generatedAt, rows, usdNote }` where each row is a base snapshot row
/// widened with `unitUsd`, `balanceUsd` and `formattedUsd`. The route attaches
/// `Cache-Control: no-store`; that header is transport, not part of the body.
pub async fn treasury_balances_body() -> ApiResult<Value> {
    let snapshot = build_treasury_balance_snapshot().await;
    let rows: Vec<Value> = snapshot
        .iter()
        .map(|row| {
            let mut map = row.as_object().cloned().unwrap_or_default();
            let asset = map
                .get("asset")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let balance = map.get("balance").and_then(Value::as_f64);
            let unit = usd_per_unit(&asset);
            let balance_usd = balance_times_usd(balance, unit);
            map.insert(
                "unitUsd".into(),
                unit.map(json_number).unwrap_or(Value::Null),
            );
            map.insert(
                "balanceUsd".into(),
                balance_usd.map(json_number).unwrap_or(Value::Null),
            );
            map.insert(
                "formattedUsd".into(),
                Value::String(format_usd(balance_usd)),
            );
            Value::Object(map)
        })
        .collect();

    let mut body = Map::new();
    body.insert("generatedAt".into(), Value::String(iso_now()));
    body.insert("rows".into(), Value::Array(rows));
    body.insert(
        "usdNote".into(),
        Value::String("USD is indicative. USDC is quoted at $1.".to_string()),
    );
    Ok(Value::Object(body))
}
