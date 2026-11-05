//! `GET /api/bets/leaderboard` — `app/api/bets/leaderboard/route.ts`.
//!
//! Public all-time/rolling boards come from a bounded scan snapshot cached for
//! 60 s (max 8 boards, insertion-order eviction). A `wallet=` rank lookup is
//! private (guard + no-store) and never returns another wallet's row. Every
//! board build runs under a 10 s fetch timeout; a failure serves a stale
//! snapshot when one exists and 503 otherwise. Param parsing, aggregation,
//! ranking, cache and meta are pure (`strike_core::bets`).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use once_cell::sync::Lazy;
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use strike_core::address::search_variants;
use strike_core::bets::{
    aggregate_rows, cache_key, canonical_address, clamp_limit, is_evm_address, iso_ms, js_num,
    lookup_rank, meta_block, now_ms, number_coerce, parse_leaderboard_window, parse_metric,
    resolve_since_ms, sanitize_asset, snapshot_assets_value, sort_entries, BoardCache, Snapshot,
    LB_MAX_SCAN_ROWS, LB_PAGE_ROWS,
};
use strike_core::error::ApiError;

use crate::http::{json_status, require_balance_session};
use crate::sql;

use super::{column_type, json_cached, Binds};

const SELECT_FIELDS: &str = "id, wallet_address, amount, payout, won, network, asset, created_at";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

const INVALID_WINDOW: &str = "Invalid window parameter (use today, 7d, 30d or all)";
const INVALID_METRIC: &str = "Invalid metric parameter (use netPnl, volume, winRate or bets)";
const STALE_NOTICE: &str = "Upstream leaderboard provider unavailable, serving cached data";
const UNAVAILABLE: &str = "Leaderboard temporarily unavailable, please try again soon.";

static CACHE: Lazy<Mutex<BoardCache>> = Lazy::new(|| Mutex::new(BoardCache::default()));

#[derive(Clone)]
struct Opts {
    window: Option<&'static str>,
    tf: Option<f64>,
    asset: String,
    metric: &'static str,
}

pub fn routes() -> Router {
    Router::new().route("/api/bets/leaderboard", get(handle))
}

async fn handle(headers: HeaderMap, Query(raw): Query<HashMap<String, String>>) -> Response {
    let limit = clamp_limit(raw.get("limit").map(String::as_str));
    let window = parse_leaderboard_window(raw.get("window").map(String::as_str));
    let tf = parse_timeframe_hours(&raw);
    let asset = sanitize_asset(raw.get("asset").map(String::as_str));
    let metric = parse_metric(raw.get("metric").map(String::as_str)).unwrap_or("netPnl");

    // Reject an explicitly-present-but-invalid window/metric with a 400 before
    // touching any data; these are direct responses, not fallback-eligible.
    if let Some(v) = raw.get("window") {
        if !v.is_empty() && parse_leaderboard_window(Some(v.as_str())).is_none() {
            return error_json(400, INVALID_WINDOW);
        }
    }
    if let Some(v) = raw.get("metric") {
        if !v.is_empty() && parse_metric(Some(v.as_str())).is_none() {
            return error_json(400, INVALID_METRIC);
        }
    }

    let opts = Opts {
        window,
        tf,
        asset,
        metric,
    };
    let key = cache_key(opts.window, opts.tf, &opts.asset);

    let branch = match raw.get("wallet") {
        Some(w) if !w.trim().is_empty() => wallet_branch(&headers, w, &opts).await,
        _ => public_branch(&opts, limit).await,
    };

    match branch {
        Ok(response) => response,
        Err(()) => fallback(&opts, &key, limit).await,
    }
}

/// `Number(timeframeHours)`: full parse, finite and > 0, else `null`.
fn parse_timeframe_hours(raw: &HashMap<String, String>) -> Option<f64> {
    let value = raw.get("timeframeHours")?;
    if value.is_empty() {
        return None;
    }
    number_coerce(&Value::String(value.clone())).filter(|n| n.is_finite() && *n > 0.0)
}

/// Run `get_snapshot` under the 10 s upstream timeout; any failure (timeout or
/// data error) becomes `Err(())` so the caller can serve a stale board.
async fn timed_snapshot(opts: &Opts) -> Result<(Snapshot, bool), ()> {
    let now = now_ms();
    match tokio::time::timeout(FETCH_TIMEOUT, get_snapshot(opts, now)).await {
        Ok(inner) => inner,
        Err(_elapsed) => Err(()),
    }
}

async fn get_snapshot(opts: &Opts, now: i64) -> Result<(Snapshot, bool), ()> {
    let key = cache_key(opts.window, opts.tf, &opts.asset);
    if let Some(hit) = CACHE.lock().await.get_fresh(&key, now).cloned() {
        return Ok((hit, true));
    }
    let snapshot = build_snapshot(opts, now).await?;
    CACHE.lock().await.insert(key, snapshot.clone());
    Ok((snapshot, false))
}

async fn build_snapshot(opts: &Opts, now: i64) -> Result<Snapshot, ()> {
    let since_ms = resolve_since_ms(opts.window, opts.tf, now);
    let since_iso = since_ms.map(iso_ms);
    let (rows, truncated) = fetch_rows(&opts.asset, since_iso, None).await?;
    let agg = aggregate_rows(&rows);
    Ok(Snapshot {
        updated_at: now,
        entries: agg.entries,
        assets: agg.assets,
        scanned_rows: rows.len() as i64,
        real_rows: agg.real_rows,
        demo_rows_dropped: agg.demo_rows_dropped,
        truncated,
        since_ms,
    })
}

/// Paged scan (`PAGE_ROWS` at a time up to `MAX_SCAN_ROWS`); returns the rows
/// and whether the cap truncated the read.
async fn fetch_rows(
    asset: &str,
    since_iso: Option<String>,
    wallet: Option<String>,
) -> Result<(Vec<Value>, bool), ()> {
    let mut collected: Vec<Value> = Vec::new();
    let mut offset: i64 = 0;

    while offset < LB_MAX_SCAN_ROWS {
        let mut binds = Binds::new();
        let mut clauses: Vec<String> = Vec::new();

        if asset != "ALL" {
            let ty = column_type("bet_history", "asset").await.map_err(|_| ())?;
            clauses.push(format!(
                "asset = {}",
                binds.push(ty, Value::String(asset.to_string()))
            ));
        }
        if let Some(since) = &since_iso {
            let ty = column_type("bet_history", "created_at")
                .await
                .map_err(|_| ())?;
            clauses.push(format!(
                "created_at >= {}",
                binds.push(ty, Value::String(since.clone()))
            ));
        }
        if let Some(wallet) = &wallet {
            let ty = column_type("bet_history", "wallet_address")
                .await
                .map_err(|_| ())?;
            clauses.push(format!(
                "pg_ilike(wallet_address, {})",
                binds.push(ty, Value::String(wallet.clone()))
            ));
        }

        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let limit_ph = binds.push_static("bigint", Value::String(LB_PAGE_ROWS.to_string()));
        let offset_ph = binds.push_static("bigint", Value::String(offset.to_string()));

        let statement = format!(
            "SELECT {SELECT_FIELDS} FROM bet_history {where_sql} \
             ORDER BY created_at DESC, id DESC LIMIT {limit_ph} OFFSET {offset_ph}"
        );
        let page = sql::fetch(&statement, &binds.refs()).await.map_err(|err| {
            tracing::error!("Supabase leaderboard error: {err}");
        })?;

        let count = page.len() as i64;
        collected.extend(page);
        if count < LB_PAGE_ROWS {
            return Ok((collected, false));
        }
        offset += LB_PAGE_ROWS;
    }

    Ok((collected, true))
}

/// Usernames for a bounded set of canonical addresses; failures degrade to an
/// empty map (never a stranger's row).
async fn fetch_usernames(addresses: &[String]) -> HashMap<String, Value> {
    let mut map: HashMap<String, Value> = HashMap::new();
    if addresses.is_empty() {
        return map;
    }

    let mut keys: HashSet<String> = HashSet::new();
    for a in addresses {
        for v in search_variants(a) {
            keys.insert(v);
        }
    }
    let keys: Vec<String> = keys.into_iter().collect();

    let ty = match column_type("user_profiles", "user_address").await {
        Ok(ty) => ty,
        Err(err) => {
            tracing::warn!("Supabase leaderboard profile error: {err}");
            return map;
        }
    };
    let placeholders = sql::in_list(1, &ty, keys.len());
    let statement = format!(
        "SELECT user_address, username FROM user_profiles WHERE user_address IN ({placeholders})"
    );

    let bind_values: Vec<Value> = keys.iter().map(|k| Value::String(k.clone())).collect();
    let bind_refs: Vec<(&str, &Value)> = bind_values.iter().map(|v| (ty.as_str(), v)).collect();

    let rows = match sql::fetch(&statement, &bind_refs).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("Supabase leaderboard profile error: {err}");
            return map;
        }
    };

    for profile in rows {
        let canonical = canonical_address(
            &profile
                .get("user_address")
                .map(value_of)
                .unwrap_or_default(),
        );
        let username = profile.get("username").cloned().unwrap_or(Value::Null);
        // `if (map[canonical] == null || !map[canonical]) map[canonical] = p.username`:
        // an existing falsy slot is replaced, an existing truthy username wins.
        let replace = match map.get(&canonical) {
            None => true,
            Some(existing) => !strike_core::bets::is_truthy(Some(existing)),
        };
        if replace {
            map.insert(canonical, username);
        }
    }
    map
}

fn value_of(v: &Value) -> String {
    strike_core::bets::value_to_string(v)
}

/// `usernameMap[address] || null` — JS truthiness, so a blank username is null
/// on the wire rather than `""`.
fn username_for(map: &HashMap<String, Value>, address: &str) -> Option<String> {
    map.get(address)
        .filter(|v| strike_core::bets::is_truthy(Some(v)))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Public board: top `limit` slice, usernames, back-compat keys and meta.
async fn public_branch(opts: &Opts, limit: i64) -> Result<Response, ()> {
    let (snapshot, cached) = timed_snapshot(opts).await?;
    let ranked = take_ranked(&snapshot, opts, limit);
    let addresses: Vec<String> = ranked.iter().map(|e| e.wallet_address.clone()).collect();
    let usernames = fetch_usernames(&addresses).await;

    let leaderboard: Vec<Value> = ranked
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            entry.public_row(
                (i + 1) as i64,
                username_for(&usernames, &entry.wallet_address),
            )
        })
        .collect();

    let extras = vec![
        ("window".to_string(), opt_str(opts.window)),
        (
            "timeframeHours".to_string(),
            opts.tf.map(js_num).unwrap_or(Value::Null),
        ),
        ("asset".to_string(), Value::String(opts.asset.clone())),
        ("metric".to_string(), Value::String(opts.metric.to_string())),
        ("limit".to_string(), Value::from(limit)),
        (
            "walletsOnBoard".to_string(),
            Value::from(snapshot.entries.len() as i64),
        ),
        ("shown".to_string(), Value::from(leaderboard.len() as i64)),
    ];
    let meta = meta_block(&snapshot, now_ms(), cached, extras);

    let mut body = Map::new();
    body.insert("leaderboard".into(), Value::Array(leaderboard));
    body.insert("cached".into(), Value::Bool(cached));
    body.insert("assets".into(), snapshot_assets_value(&snapshot.assets));
    body.insert("meta".into(), meta);
    Ok(json_cached(
        StatusCode::OK,
        Value::Object(body),
        super::PUBLIC_BOARD_CACHE,
    ))
}

/// Wallet-scoped rank lookup. Guard/EVM failures answer directly; only the
/// data fetch can bubble to the stale fallback.
async fn wallet_branch(headers: &HeaderMap, wallet_raw: &str, opts: &Opts) -> Result<Response, ()> {
    if let Err(err) = require_balance_session(headers) {
        return Ok(err.into_response());
    }
    let wallet = wallet_raw.trim();
    if !is_evm_address(wallet) {
        tracing::warn!("[bets/leaderboard] rejected malformed wallet param");
        return Ok(error_json(400, "Invalid wallet parameter"));
    }
    let address = canonical_address(wallet);

    let (snapshot, cached) = timed_snapshot(opts).await?;
    let ranked = sort_entries(&snapshot.entries, opts.metric);
    let own = ranked.iter().find(|e| e.wallet_address == address).cloned();

    let mut own_entry = own;
    let mut estimated = false;
    if snapshot.truncated {
        // Board scan hit the row cap: re-read this one wallet directly and flag
        // the result as estimated rather than reporting a wrong rank.
        let since_ms = resolve_since_ms(opts.window, opts.tf, snapshot.updated_at);
        let since_iso = since_ms.map(iso_ms);
        let (rows, _) = fetch_rows(&opts.asset, since_iso, Some(address.clone())).await?;
        let agg = aggregate_rows(&rows);
        own_entry = agg
            .entries
            .into_iter()
            .find(|e| e.wallet_address == address)
            .or(own_entry);
        estimated = true;
    }

    let Some(own_entry) = own_entry else {
        let extras = vec![
            ("window".to_string(), opt_str(opts.window)),
            ("asset".to_string(), Value::String(opts.asset.clone())),
            ("metric".to_string(), Value::String(opts.metric.to_string())),
            (
                "reason".to_string(),
                Value::String("no_settled_bets_in_window".to_string()),
            ),
        ];
        let meta = meta_block(&snapshot, now_ms(), cached, extras);
        let mut body = Map::new();
        body.insert("me".into(), Value::Null);
        body.insert("meta".into(), meta);
        return Ok(json_cached(
            StatusCode::OK,
            Value::Object(body),
            super::PRIVATE_NO_STORE,
        ));
    };

    // Defence in depth: never serialise a row that is not the caller's own.
    if canonical_address(&own_entry.wallet_address) != address {
        return Ok(error_json(500, "Internal server error"));
    }

    let rank = lookup_rank(&ranked, &own_entry, opts.metric);
    let usernames = fetch_usernames(std::slice::from_ref(&address)).await;

    let mut me = own_entry.public_row(rank.rank, username_for(&usernames, &address));
    if let Some(m) = me.as_object_mut() {
        m.insert("rank".into(), Value::from(rank.rank));
        m.insert("peopleAhead".into(), Value::from(rank.people_ahead));
        m.insert("walletsOnBoard".into(), Value::from(rank.total_ranked));
        m.insert(
            "nextRank".into(),
            rank.next_rank.map(Value::from).unwrap_or(Value::Null),
        );
        m.insert(
            "nextRankValue".into(),
            rank.next_rank_value.map(js_num).unwrap_or(Value::Null),
        );
        m.insert(
            "gapToNextRank".into(),
            rank.gap_to_next_rank.map(js_num).unwrap_or(Value::Null),
        );
        m.insert("metric".into(), Value::String(opts.metric.to_string()));
        m.insert("estimated".into(), Value::Bool(rank.estimated || estimated));
    }

    let extras = vec![
        ("window".to_string(), opt_str(opts.window)),
        ("asset".to_string(), Value::String(opts.asset.clone())),
        ("metric".to_string(), Value::String(opts.metric.to_string())),
    ];
    let meta = meta_block(&snapshot, now_ms(), cached, extras);

    let mut body = Map::new();
    body.insert("me".into(), me);
    body.insert("meta".into(), meta);
    Ok(json_cached(
        StatusCode::OK,
        Value::Object(body),
        super::PRIVATE_NO_STORE,
    ))
}

/// Serve the last known snapshot for this exact board variant (any age), or 503.
async fn fallback(opts: &Opts, key: &str, limit: i64) -> Response {
    let stale = CACHE.lock().await.get(key).cloned();
    let Some(snapshot) = stale else {
        return ApiError::unavailable(UNAVAILABLE).into_response();
    };

    let ranked = take_ranked(&snapshot, opts, limit);
    let leaderboard: Vec<Value> = ranked
        .iter()
        .enumerate()
        .map(|(i, entry)| entry.public_row((i + 1) as i64, None))
        .collect();

    let mut meta = meta_block(&snapshot, now_ms(), true, vec![]);
    if let Some(m) = meta.as_object_mut() {
        m.insert("stale".into(), Value::Bool(true));
    }

    let mut body = Map::new();
    body.insert("leaderboard".into(), Value::Array(leaderboard));
    body.insert("cached".into(), Value::Bool(true));
    body.insert("stale".into(), Value::Bool(true));
    body.insert("assets".into(), snapshot_assets_value(&snapshot.assets));
    body.insert("meta".into(), meta);
    body.insert("error".into(), Value::String(STALE_NOTICE.to_string()));
    json_status(StatusCode::OK, Value::Object(body))
}

fn take_ranked(snapshot: &Snapshot, opts: &Opts, limit: i64) -> Vec<strike_core::bets::Entry> {
    sort_entries(&snapshot.entries, opts.metric)
        .into_iter()
        .take(limit.max(0) as usize)
        .collect()
}

fn opt_str(value: Option<&str>) -> Value {
    value
        .map(|v| Value::String(v.to_string()))
        .unwrap_or(Value::Null)
}

fn error_json(status: u16, message: &str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = Value::Object(Map::from_iter([(
        "error".to_string(),
        Value::String(message.to_string()),
    )]));
    json_status(code, body)
}
