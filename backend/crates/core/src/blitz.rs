//! Blitz: a one-minute window in every three, when a pass doubles the chart cap on
//! box bets. The schedule is the server's clock; the pass is one fee debit and one
//! row in `blitz_passes`, both written in the same transaction.
//!
//! The boost only raises the chart half of the band ceiling. The odds cap in
//! `settlement::band_multiplier_ceiling` still holds expected return under 95%.

use rusqlite::{params, OptionalExtension};
use rust_decimal::Decimal;
use serde_json::{json, Value};

use crate::address::canonical;
use crate::db::{now_us, Db};
use crate::error::{status_of, ApiResult};
use crate::ledger::{coded_body, Rejection};
use crate::money::{to_fixed, MONEY_SCALE};
use crate::prices;
use crate::rpc;
use crate::settlement::band_range;
use crate::ticks::{TickBuffer, HISTORY_MS};
use crate::world;

pub const CYCLE_MS: i64 = 180_000;
const ACTIVE_FROM_MS: i64 = 120_000;
pub const LENGTH_MS: i64 = 60_000;
pub const BOOST: f64 = 2.0;
const FEE: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub starts_at: i64,
    pub ends_at: i64,
    pub active: bool,
}

/// The window running at `now_ms`, or the next one.
pub fn window(now_ms: i64) -> Window {
    let phase = now_ms.rem_euclid(CYCLE_MS);
    let starts_at = now_ms - phase + ACTIVE_FROM_MS;
    Window {
        starts_at,
        ends_at: starts_at + LENGTH_MS,
        active: phase >= ACTIVE_FROM_MS,
    }
}

fn refuse(status: u16, code: &str, message: &str) -> Rejection {
    (status, coded_body(code, message))
}

/// The body of `GET /api/market/state` and of the stream's `market` event.
pub fn market_state(ring: &TickBuffer, now_ms: i64) -> Value {
    let assets: serde_json::Map<String, Value> = prices::default_assets()
        .into_iter()
        .map(|asset| {
            let (range, window_ms) = band_range(ring, &asset, now_ms);
            let state = json!({ "range": range, "windowMs": window_ms, "quiet": range <= 0.0 });
            (asset, state)
        })
        .collect();
    let blitz = window(now_ms);
    json!({
        "serverTime": now_ms,
        "assets": assets,
        "blitz": {
            "active": blitz.active,
            "startsAt": blitz.starts_at,
            "endsAt": blitz.ends_at,
            "boost": BOOST,
            "fee": FEE.to_string(),
        },
    })
}

pub fn market_frame(ring: &TickBuffer, now_ms: i64) -> String {
    format!("event: market\ndata: {}\n\n", market_state(ring, now_ms))
}

pub fn history_frame(ring: &TickBuffer, asset: &str, now_ms: i64) -> String {
    let points: Vec<Value> = ring
        .history(asset, now_ms - HISTORY_MS)
        .into_iter()
        .map(|(at, price)| json!([at, price]))
        .collect();
    let body = json!({ "asset": asset, "points": points });
    format!("event: history\ndata: {body}\n\n")
}

fn has_pass_in(
    conn: &rusqlite::Connection,
    wallet: &str,
    starts_at: i64,
) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT 1 FROM blitz_passes WHERE wallet = ?1 AND window_start = ?2")?
        .query_row(params![wallet, starts_at], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
}

/// `GET /api/blitz/pass`: whether `wallet` holds the pass for the current or next window.
pub async fn pass_status(db: &Db, wallet: &str, now_ms: i64) -> ApiResult<Value> {
    let (wallet, starts_at) = (canonical(wallet), window(now_ms).starts_at);
    let has = db
        .read(move |conn| Ok(has_pass_in(conn, &wallet, starts_at)?))
        .await?;
    Ok(json!({ "hasPass": has, "windowStartsAt": has.then_some(starts_at) }))
}

/// The band boost a bet earns: 1 without `"blitz": true` or on a classic round,
/// [`BOOST`] with an active pass, and a refusal for `blitz` without one.
pub async fn boost_for(
    db: &Db,
    body: &Value,
    wallet: &str,
    now_ms: i64,
) -> ApiResult<Result<f64, Rejection>> {
    let asked = body.get("blitz").and_then(Value::as_bool) == Some(true);
    if !asked || body.get("mode").and_then(Value::as_str) != Some("box") {
        return Ok(Ok(1.0));
    }
    let current = window(now_ms);
    let wallet = canonical(wallet);
    let held = current.active
        && db
            .read(move |conn| Ok(has_pass_in(conn, &wallet, current.starts_at)?))
            .await?;
    Ok(if held {
        Ok(BOOST)
    } else {
        Err(refuse(
            409,
            "blitz_inactive",
            "Blitz is not active for this wallet right now",
        ))
    })
}

/// `POST /api/blitz/enter`. `ledger_key` is the balance row to debit.
pub async fn enter(
    db: &Db,
    wallet: &str,
    ledger_key: &str,
    currency: &str,
    now_ms: i64,
) -> ApiResult<Result<Value, Rejection>> {
    let (wallet, ledger_key, currency) = (
        canonical(wallet),
        ledger_key.to_string(),
        currency.to_string(),
    );
    let current = window(now_ms);
    db.write(move |conn| {
        let tx = conn.savepoint()?;
        let reply = |charged: &str| {
            json!({ "windowStartsAt": current.starts_at, "endsAt": current.ends_at, "charged": charged })
        };
        if has_pass_in(&tx, &wallet, current.starts_at)? {
            return Ok(Ok(reply("0")));
        }
        let fee = Decimal::from(FEE);
        if let Some(r) = world::bet_refusal(&tx, &wallet, fee, now_ms)? {
            let mut body = coded_body(r.code, &r.message);
            if let Some(until) = r.until {
                body["until"] = json!(until);
            }
            return Ok(Err((status_of(r.code), body)));
        }
        let hash = format!("blitz:{wallet}:{}", current.starts_at);
        let debit = rpc::debit_blitz_fee(&tx, &ledger_key, fee, &currency, &hash)?;
        if debit["success"] != json!(true) {
            return Ok(Err(debit_refusal(debit["error"].as_str().unwrap_or_default())));
        }
        tx.prepare_cached(
            "INSERT INTO blitz_passes (wallet, window_start, currency, fee, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?
        .execute(params![
            wallet,
            current.starts_at,
            currency,
            to_fixed(fee, MONEY_SCALE)?,
            now_us()
        ])?;
        tx.commit()?;
        Ok(Ok(reply("1")))
    })
    .await
}

fn debit_refusal(error: &str) -> Rejection {
    match error {
        "Insufficient balance" | "User not found" => refuse(
            400,
            "insufficient_balance",
            "Insufficient house balance for the Blitz fee. Deposit from the Wallet tab.",
        ),
        e if e.to_lowercase().contains("banned") => refuse(403, "banned", e),
        e if e.to_lowercase().contains("frozen") => refuse(403, "frozen", e),
        e => refuse(400, "blitz_fee_failed", e),
    }
}
