//! Server-authoritative rounds: the terms frozen at bet time and the outcome
//! computed from them. Nothing a client sends after the bet can change a result,
//! and before it only the tolerance checks here read client numbers.
//!
//! The lifecycle, all of it in `bet_rounds`:
//!   * [`freeze_bet`] takes the strike from the sampler's newest tick and refuses
//!     a stale feed, a client strike off by more than `BET_PRICE_TOLERANCE_BPS`,
//!     a multiplier the game would not offer, and a band round closing inside
//!     [`BET_CUTOFF_MS`]. `rpc::place_bet_locked` writes the row in the same
//!     transaction as the debit.
//!   * [`settle`] looks up the end price, and `rpc::settle_round` does the rest in
//!     one transaction, on the single writer: payout lock, bet claim, [`decide`],
//!     credit, result. `/api/balance/win` and [`run_sweeper`] are its two callers,
//!     so a round settles whether or not a client ever comes back.
//!
//! The end price is the newest tick at or before `end_time`, no older than
//! [`end_tick_tolerance_ms`], from the venue the strike came from. Anything else
//! is the refund rule: the stake comes back and the outcome says
//! `refund_no_price`. Prices are never guessed. That covers an upstream outage
//! and a restart, because the rings are the only source read here and a restart
//! empties them; the refund is what makes that safe.

use std::time::Duration;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::bets::iso_ms;
use crate::config::config;
use crate::db::{db, Db};
use crate::error::ApiResult;
use crate::ledger::{exact_amount, Rejection};
use crate::money::{from_fixed, parse_decimal, to_fixed, MONEY_SCALE};
use crate::prices;
use crate::ticks::{self, TickBuffer};

/// `NUMERIC(20,8)` in `bet_rounds`.
pub const PRICE_SCALE: u32 = 8;
/// `NUMERIC(10,4)`.
pub const MULTIPLIER_SCALE: u32 = 4;

/// A band round must close at least this far ahead of the bet reaching us.
pub const BET_CUTOFF_MS: i64 = 2_000;
/// The furthest column or box the chart can reach, and the ring's default span.
pub const MAX_ROUND_MS: i64 = 900_000;
/// Yahoo quotes refresh every 15 s at source.
const SLOW_TICK_TOLERANCE_MS: i64 = 20_000;
/// A band can be at most this share of the recent range. The chart caps a drawn
/// box at 20% of its height, and a grid row is 10%.
const BAND_MAX_WIDTH: f64 = 0.25;
/// Scanning this far back never understates what a chart shows.
const BAND_WIDTH_WINDOW_MS: i64 = 300_000;
/// The narrowest window a chart fits its axis to; slow assets print 4 ticks in it.
const FAST_RANGE_WINDOW_MS: i64 = 30_000;
const SLOW_RANGE_WINDOW_MS: i64 = 120_000;
/// The grid's in-row 1.01 plus its largest time bonus.
const IN_BAND_CEILING: f64 = 1.30;

/// The classic game's fixed payout table (`getMultiplier` in GameBoard.tsx).
pub fn binomo_multiplier(seconds: i64) -> Option<Decimal> {
    match seconds {
        5 => Some(Decimal::new(175, 2)),
        10 => Some(Decimal::new(180, 2)),
        15 => Some(Decimal::new(185, 2)),
        30 => Some(Decimal::new(190, 2)),
        60 => Some(Decimal::new(195, 2)),
        _ => None,
    }
}

/// What a bet was placed on, as the fixed-point integers `bet_rounds` stores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Terms {
    pub asset: String,
    pub mode: String,
    pub direction: String,
    pub multiplier: i64,
    pub strike_price: i64,
    pub strike_at_us: i64,
    pub strike_source: String,
    pub price_top: Option<i64>,
    pub price_bottom: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub struct Frozen {
    pub terms: Terms,
    pub end_ms: i64,
    pub max_payout: Decimal,
}

fn refuse(status: u16, code: &str, message: &str) -> Rejection {
    (status, json!({ "error": message, "code": code }))
}

/// Text first, so the fixed point holds the decimal the double was written as.
fn fixed_price(price: f64) -> Option<i64> {
    to_fixed(parse_decimal(&format!("{price}")).ok()?, PRICE_SCALE).ok()
}

fn positive_number(body: &Value, key: &str) -> Option<f64> {
    body.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
}

fn bet_tick_max_age_ms(asset: &str) -> i64 {
    if prices::is_crypto(asset) {
        config().bet_tick_max_age_ms
    } else {
        SLOW_TICK_TOLERANCE_MS
    }
}

/// How old the end tick may be, measured back from `end_time`.
pub fn end_tick_tolerance_ms(asset: &str) -> i64 {
    if prices::is_crypto(asset) {
        config().settle_tick_tolerance_ms
    } else {
        SLOW_TICK_TOLERANCE_MS
    }
}

/// The widest band [`freeze_bet`] accepts for this asset right now, 0 when unknown.
pub fn max_band_width(ring: &TickBuffer, asset: &str, now_ms: i64) -> f64 {
    ring.range(asset, now_ms - BAND_WIDTH_WINDOW_MS) * BAND_MAX_WIDTH
}

/// The highest multiplier a band may be offered at, whatever the chart showed.
///
/// A chart's multiplier depends on its own axis, which the server cannot see, so
/// this is the draw formula at its most generous size bonus, measured against
/// `range`, a span no wider than the axis. It only has to stop a band being paid
/// like a long shot while sitting on the price.
///
/// ponytail: not a fair price. A real ceiling needs a volatility model and a
/// server-owned quote; until then the house edge on bands is whatever these
/// curves give.
pub fn band_multiplier_ceiling(strike: f64, top: f64, bottom: f64, range: f64) -> f64 {
    if strike >= bottom && strike <= top {
        return IN_BAND_CEILING;
    }
    let distance = (strike - top).abs().min((strike - bottom).abs());
    let normalized = (distance / range).min(1.0);
    ((1.0 + normalized.powf(0.7) * 6.0) * 2.0 + 0.3).min(20.0)
}

/// `(end_ms, top, bottom)` of a band round.
fn freeze_band(
    body: &Value,
    asset: &str,
    strike: f64,
    multiplier: f64,
    ring: &TickBuffer,
    now_ms: i64,
) -> Result<(i64, f64, f64), Rejection> {
    let (Some(top), Some(bottom)) = (
        positive_number(body, "priceTop"),
        positive_number(body, "priceBottom"),
    ) else {
        return Err(refuse(400, "invalid_band", "Invalid price band"));
    };
    if top <= bottom {
        return Err(refuse(400, "invalid_band", "Invalid price band"));
    }
    let Some(end_ms) = positive_number(body, "endTime").map(|ms| ms as i64) else {
        return Err(refuse(400, "invalid_end_time", "Invalid round end time"));
    };
    if end_ms - now_ms < BET_CUTOFF_MS {
        return Err(refuse(
            409,
            "betting_closed",
            "Betting has closed for this round",
        ));
    }
    if end_ms - now_ms > MAX_ROUND_MS {
        return Err(refuse(400, "invalid_end_time", "Round ends too far ahead"));
    }

    let window = if prices::is_crypto(asset) {
        FAST_RANGE_WINDOW_MS
    } else {
        SLOW_RANGE_WINDOW_MS
    };
    let range = ring.range(asset, now_ms - window);
    // A flat tape is a closed market: a band around the price would be a sure win.
    if range <= 0.0 {
        return Err(refuse(
            409,
            "market_quiet",
            "This market is not moving right now",
        ));
    }
    if top - bottom > max_band_width(ring, asset, now_ms) {
        return Err(refuse(400, "band_too_wide", "Price band is too wide"));
    }
    if multiplier > band_multiplier_ceiling(strike, top, bottom, range) {
        return Err(refuse(
            400,
            "multiplier_not_offered",
            "Multiplier is too high for this price band",
        ));
    }
    Ok((end_ms, top, bottom))
}

/// Validates a bet against the feed and fixes its terms. Runs before any money
/// moves; every refusal here leaves the ledger untouched.
pub fn freeze_bet(
    body: &Value,
    stake: Decimal,
    ring: &TickBuffer,
    now_ms: i64,
) -> Result<Frozen, Rejection> {
    let asset = body
        .get("asset")
        .and_then(Value::as_str)
        .map(|asset| asset.trim().to_uppercase())
        .unwrap_or_default();
    if !prices::is_quoted(&asset) {
        return Err(refuse(
            400,
            "unsupported_asset",
            "This asset cannot be traded",
        ));
    }
    let mode = body.get("mode").and_then(Value::as_str).unwrap_or_default();
    if !matches!(mode, "binomo" | "box" | "draw") {
        return Err(refuse(400, "invalid_mode", "Unknown game mode"));
    }
    let target = body.get("targetCell");
    let direction = target
        .and_then(|cell| cell.get("direction"))
        .and_then(Value::as_str)
        .filter(|d| matches!(*d, "UP" | "DOWN"))
        .ok_or_else(|| refuse(400, "invalid_direction", "Unknown bet direction"))?;
    let client_strike = positive_number(body, "strikePrice")
        .ok_or_else(|| refuse(400, "invalid_strike", "Missing strike price"))?;

    // Fail closed: no fresh server price, no round.
    let tick = ring
        .latest(&asset)
        .filter(|tick| now_ms - tick.at_ms <= bet_tick_max_age_ms(&asset))
        .ok_or_else(|| {
            refuse(
                503,
                "price_unavailable",
                "Live price is unavailable. Try again in a moment.",
            )
        })?;
    if (client_strike - tick.price).abs() * 10_000.0 > tick.price * config().bet_price_tolerance_bps
    {
        return Err(refuse(
            409,
            "price_moved",
            "The price moved before your bet arrived",
        ));
    }

    let unavailable = || refuse(503, "price_unavailable", "Live price is unavailable.");
    let multiplier = positive_number(body, "multiplier")
        .and_then(exact_amount)
        .map(|m| m.round_dp_with_strategy(MULTIPLIER_SCALE, RoundingStrategy::ToZero))
        .ok_or_else(|| refuse(400, "multiplier_not_offered", "Invalid multiplier"))?;

    let (end_ms, band) = if mode == "binomo" {
        let seconds = target
            .and_then(|cell| cell.get("timeframe"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if binomo_multiplier(seconds) != Some(multiplier) {
            return Err(refuse(
                400,
                "multiplier_not_offered",
                "Multiplier is not offered for this round length",
            ));
        }
        (now_ms + seconds * 1000, None)
    } else {
        let offered = multiplier.to_f64().ok_or_else(unavailable)?;
        let (end_ms, top, bottom) = freeze_band(body, &asset, tick.price, offered, ring, now_ms)?;
        (end_ms, Some((top, bottom)))
    };

    let stake_fixed = to_fixed(stake, MONEY_SCALE).map_err(|_| unavailable())?;
    let max_payout = exact_payout(
        stake_fixed,
        to_fixed(multiplier, MULTIPLIER_SCALE).unwrap_or(0),
    )
    .map_err(|_| unavailable())?;
    let band_edge = |price| fixed_price(price).ok_or_else(unavailable);
    Ok(Frozen {
        terms: Terms {
            multiplier: to_fixed(multiplier, MULTIPLIER_SCALE).map_err(|_| unavailable())?,
            strike_price: fixed_price(tick.price).ok_or_else(unavailable)?,
            strike_at_us: tick.at_ms * 1_000,
            strike_source: tick.source.to_string(),
            price_top: band.map(|(top, _)| band_edge(top)).transpose()?,
            price_bottom: band.map(|(_, bottom)| band_edge(bottom)).transpose()?,
            mode: mode.to_string(),
            direction: direction.to_string(),
            asset,
        },
        end_ms,
        max_payout: from_fixed(max_payout, MONEY_SCALE),
    })
}

/// `stake * multiplier`, floored to 8 decimals: the house never rounds up.
pub fn exact_payout(stake: i64, multiplier: i64) -> ApiResult<i64> {
    let product = from_fixed(stake, MONEY_SCALE) * from_fixed(multiplier, MULTIPLIER_SCALE);
    to_fixed(
        product.round_dp_with_strategy(8, RoundingStrategy::ToZero),
        MONEY_SCALE,
    )
}

/// A settled round's result. The strings are stored, so they never change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Win,
    Loss,
    /// Up/down ended exactly on the strike: the stake comes back.
    Tie,
    /// No usable price at `end_time`: the stake comes back.
    RefundNoPrice,
    /// The wallet was banned before settlement, so the credit was refused.
    Withheld,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Win => "win",
            Self::Loss => "loss",
            Self::Tie => "tie",
            Self::RefundNoPrice => "refund_no_price",
            Self::Withheld => "withheld",
        }
    }
}

/// The end of a round as the ledger stores it.
#[derive(Debug, Clone, PartialEq)]
pub struct EndTick {
    pub price: i64,
    pub at_us: i64,
    pub source: String,
}

/// `(outcome, payout)` from nothing but frozen terms and the server's end tick.
pub fn decide(terms: &Terms, stake: i64, end: Option<&EndTick>) -> ApiResult<(Outcome, i64)> {
    // Two venues print different prices, so comparing across them could decide a
    // 5 s round on the basis alone.
    let Some(end) = end.filter(|end| end.source == terms.strike_source) else {
        return Ok((Outcome::RefundNoPrice, stake));
    };
    let won = match (terms.price_top, terms.price_bottom) {
        (Some(top), Some(bottom)) => end.price >= bottom && end.price <= top,
        _ if end.price == terms.strike_price => return Ok((Outcome::Tie, stake)),
        _ if terms.direction == "UP" => end.price > terms.strike_price,
        _ => end.price < terms.strike_price,
    };
    if won {
        Ok((Outcome::Win, exact_payout(stake, terms.multiplier)?))
    } else {
        Ok((Outcome::Loss, 0))
    }
}

/// The newest usable tick at or before `end_ms`, if there is one.
pub fn end_tick(ring: &TickBuffer, asset: &str, end_ms: i64) -> Option<EndTick> {
    let tick = ring
        .at_or_before(asset, end_ms)
        .filter(|tick| end_ms - tick.at_ms <= end_tick_tolerance_ms(asset))?;
    Some(EndTick {
        price: fixed_price(tick.price)?,
        at_us: tick.at_ms * 1_000,
        source: tick.source.to_string(),
    })
}

#[derive(Debug)]
pub enum Settled {
    /// `rpc::settle_round`'s answer; `duplicate` when it was already settled.
    Done(Value),
    Open {
        end_ms: i64,
    },
    Unknown,
}

/// Settles `bet_id` if it can be. Safe to race: every caller lands on the same
/// row through the single writer and exactly one of them finds it open.
pub async fn settle(database: &Db, bet_id: &str, by: &str, now_ms: i64) -> ApiResult<Settled> {
    let id = bet_id.to_string();
    let row: Option<(String, i64, bool)> = database
        .read(move |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT asset, end_time, outcome IS NOT NULL FROM bet_rounds WHERE bet_id = ?1",
            )?;
            let mut rows = statement.query([&id])?;
            Ok(match rows.next()? {
                Some(row) => Some((row.get(0)?, row.get(1)?, row.get(2)?)),
                None => None,
            })
        })
        .await?;
    let Some((asset, end_time_us, settled)) = row else {
        return Ok(Settled::Unknown);
    };
    let end_ms = end_time_us.div_euclid(1_000);
    if !settled && now_ms < end_ms {
        return Ok(Settled::Open { end_ms });
    }

    let end = end_tick(ticks::buffer(), &asset, end_ms);
    let result = database
        .call_rpc(
            "settle_round",
            &[
                ("p_bet_id", &json!(bet_id)),
                ("p_end_price", &json!(end.as_ref().map(|e| e.price))),
                ("p_end_at", &json!(end.as_ref().map(|e| e.at_us))),
                ("p_source", &json!(end.as_ref().map(|e| e.source.as_str()))),
                ("p_settled_by", &json!(by)),
            ],
        )
        .await?;
    Ok(Settled::Done(result))
}

/// Open rounds past their end, oldest first, a bounded batch per pass.
pub async fn sweep_once(database: &Db, now_ms: i64) -> ApiResult<usize> {
    let due: Vec<String> = database
        .read(move |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT bet_id FROM bet_rounds WHERE outcome IS NULL AND end_time <= ?1 \
                 ORDER BY end_time LIMIT 500",
            )?;
            let ids = statement
                .query_map([now_ms * 1_000], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(ids)
        })
        .await?;
    let count = due.len();
    for bet_id in due {
        // One round's failure stays open for the next pass and blocks no other.
        if let Err(err) = settle(database, &bet_id, "sweep", now_ms).await {
            tracing::error!("[settlement] {bet_id} not settled, will retry: {err}");
        }
    }
    Ok(count)
}

/// Runs for the life of the process, so a result never waits for a client. The
/// first pass after a restart refunds what ended while the rings were down.
pub async fn run_sweeper() {
    let mut every = tokio::time::interval(Duration::from_secs(1));
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        let swept = match db().await {
            Ok(database) => sweep_once(database, crate::bets::now_ms()).await,
            Err(err) => Err(err),
        };
        if let Err(err) = swept {
            tracing::error!("[settlement] sweep failed: {err}");
        }
    }
}

/// `end_time` of a frozen bet, in the form `place_bet_locked` reads.
pub fn end_time_iso(frozen: &Frozen) -> String {
    iso_ms(frozen.end_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn dec(text: &str) -> Decimal {
        parse_decimal(text).unwrap()
    }

    fn ring(prices: &[f64]) -> TickBuffer {
        let ring = TickBuffer::new(600);
        for (i, price) in prices.iter().enumerate() {
            let at = NOW - (prices.len() - 1 - i) as i64 * 1_000;
            ring.record("BTC", *price, at, "binance");
        }
        ring
    }

    fn classic(multiplier: f64, seconds: i64, strike: f64) -> Value {
        json!({
            "asset": "BTC", "mode": "binomo", "strikePrice": strike, "multiplier": multiplier,
            "targetCell": { "direction": "UP", "timeframe": seconds },
            // Sent by the client and ignored: the round starts when it reaches us.
            "endTime": 1,
        })
    }

    fn band(multiplier: f64, top: f64, bottom: f64, end_ms: i64) -> Value {
        json!({
            "asset": "BTC", "mode": "box", "strikePrice": 100.0, "multiplier": multiplier,
            "priceTop": top, "priceBottom": bottom, "endTime": end_ms,
            "targetCell": { "direction": "UP", "timeframe": 5 },
        })
    }

    fn code(rejection: Rejection) -> (u16, String) {
        (
            rejection.0,
            rejection.1["code"].as_str().unwrap().to_string(),
        )
    }

    fn up_terms() -> Terms {
        Terms {
            asset: "BTC".into(),
            mode: "binomo".into(),
            direction: "UP".into(),
            multiplier: 17_500,
            strike_price: 100 * 100_000_000,
            strike_at_us: 0,
            strike_source: "binance".into(),
            price_top: None,
            price_bottom: None,
        }
    }

    fn end_at(whole: i64) -> EndTick {
        EndTick {
            price: whole * 100_000_000,
            at_us: 0,
            source: "binance".into(),
        }
    }

    const STAKE: i64 = 10 * 10_000_000_000;

    #[test]
    fn the_strike_and_clock_are_the_servers() {
        let frozen = freeze_bet(&classic(1.75, 5, 100.1), dec("10"), &ring(&[100.0]), NOW).unwrap();
        assert_eq!(frozen.terms.strike_price, 100 * 100_000_000);
        assert_eq!(frozen.terms.strike_source, "binance");
        assert_eq!(frozen.end_ms, NOW + 5_000);
        assert_eq!(frozen.max_payout, dec("17.5"));
    }

    #[test]
    fn a_strike_beyond_the_tolerance_is_refused() {
        // 50 bps of 100 is 0.5.
        let ring = ring(&[100.0]);
        assert!(freeze_bet(&classic(1.75, 5, 100.5), dec("10"), &ring, NOW).is_ok());
        let far = freeze_bet(&classic(1.75, 5, 100.51), dec("10"), &ring, NOW).unwrap_err();
        assert_eq!(code(far), (409, "price_moved".to_string()));
    }

    #[test]
    fn a_stale_or_missing_price_fails_closed() {
        let ring = ring(&[100.0]);
        let body = classic(1.75, 5, 100.0);
        assert!(freeze_bet(&body, dec("10"), &ring, NOW + 3_000).is_ok());
        let stale = freeze_bet(&body, dec("10"), &ring, NOW + 3_001).unwrap_err();
        assert_eq!(code(stale), (503, "price_unavailable".to_string()));
        let empty = TickBuffer::new(10);
        let none = freeze_bet(&body, dec("10"), &empty, NOW).unwrap_err();
        assert_eq!(code(none), (503, "price_unavailable".to_string()));
    }

    #[test]
    fn only_the_table_multiplier_is_offered_on_a_classic_round() {
        let ring = ring(&[100.0]);
        for (multiplier, seconds) in [(20.0, 5), (1.76, 5), (1.75, 6), (1.75, 0)] {
            let forged = freeze_bet(&classic(multiplier, seconds, 100.0), dec("1"), &ring, NOW);
            assert_eq!(
                code(forged.unwrap_err()),
                (400, "multiplier_not_offered".to_string())
            );
        }
        for seconds in [5, 10, 15, 30, 60] {
            let multiplier = binomo_multiplier(seconds).unwrap().to_f64().unwrap();
            assert!(freeze_bet(&classic(multiplier, seconds, 100.0), dec("1"), &ring, NOW).is_ok());
        }
    }

    #[test]
    fn unknown_inputs_are_refused() {
        let ring = ring(&[100.0]);
        let mut body = classic(1.75, 5, 100.0);
        body["asset"] = json!("LINK"); // listed, but nothing quotes it
        assert_eq!(
            code(freeze_bet(&body, dec("1"), &ring, NOW).unwrap_err()).1,
            "unsupported_asset"
        );
        let mut body = classic(1.75, 5, 100.0);
        body["mode"] = json!("nope");
        assert_eq!(
            code(freeze_bet(&body, dec("1"), &ring, NOW).unwrap_err()).1,
            "invalid_mode"
        );
        let mut body = classic(1.75, 5, 100.0);
        body["targetCell"]["direction"] = json!("SIDEWAYS");
        assert_eq!(
            code(freeze_bet(&body, dec("1"), &ring, NOW).unwrap_err()).1,
            "invalid_direction"
        );
        let mut body = classic(1.75, 5, 100.0);
        body["strikePrice"] = Value::Null;
        assert_eq!(
            code(freeze_bet(&body, dec("1"), &ring, NOW).unwrap_err()).1,
            "invalid_strike"
        );
    }

    #[test]
    fn a_band_is_frozen_with_its_edges() {
        let ring = ring(&[100.0, 104.0, 100.0]);
        let body = band(3.0, 102.0, 101.5, NOW + 10_000);
        let frozen = freeze_bet(&body, dec("10"), &ring, NOW).unwrap();
        assert_eq!(frozen.terms.price_top, Some(102 * 100_000_000));
        assert_eq!(
            frozen.terms.price_bottom,
            Some(101 * 100_000_000 + 50_000_000)
        );
        assert_eq!(frozen.end_ms, NOW + 10_000);
    }

    #[test]
    fn a_late_or_distant_band_is_refused() {
        let ring = ring(&[100.0, 104.0, 100.0]);
        let late = freeze_bet(&band(1.2, 100.5, 99.5, NOW + 1_999), dec("1"), &ring, NOW);
        assert_eq!(code(late.unwrap_err()), (409, "betting_closed".to_string()));
        assert!(freeze_bet(&band(1.2, 100.5, 99.5, NOW + 2_000), dec("1"), &ring, NOW).is_ok());
        let far = band(1.2, 100.5, 99.5, NOW + MAX_ROUND_MS + 1);
        assert_eq!(
            code(freeze_bet(&far, dec("1"), &ring, NOW).unwrap_err()),
            (400, "invalid_end_time".to_string())
        );
    }

    #[test]
    fn a_wide_band_at_a_long_shot_multiplier_is_refused() {
        // The forgery: nearly half the market at 20x.
        let ring = ring(&[100.0, 104.0, 100.0]);
        let wide = band(20.0, 200.0, 100.01, NOW + 10_000);
        assert_eq!(
            code(freeze_bet(&wide, dec("1"), &ring, NOW).unwrap_err()).1,
            "band_too_wide"
        );
        // Narrow, but priced like a far cell while sitting next to the price.
        let adjacent = band(20.0, 100.5, 100.01, NOW + 10_000);
        assert_eq!(
            code(freeze_bet(&adjacent, dec("1"), &ring, NOW).unwrap_err()).1,
            "multiplier_not_offered"
        );
        // Around the price it pays like the in-row cell it is.
        let inside = band(2.0, 100.5, 99.5, NOW + 10_000);
        assert_eq!(
            code(freeze_bet(&inside, dec("1"), &ring, NOW).unwrap_err()).1,
            "multiplier_not_offered"
        );
    }

    #[test]
    fn what_the_chart_offers_passes_the_ceiling() {
        // Grid row at the far edge of a 4-wide axis, boosted by blitz, and a drawn box.
        let range = 4.0;
        let row = (1.05 + 3.95_f64) * 2.0;
        assert!(row <= band_multiplier_ceiling(100.0, 104.4, 104.0, range));
        assert!(1.06 <= band_multiplier_ceiling(100.0, 100.8, 100.4, range));
        assert!(1.21 <= band_multiplier_ceiling(100.0, 100.2, 99.8, range));
    }

    #[test]
    fn a_flat_market_takes_no_band_bets() {
        let ring = ring(&[100.0, 100.0, 100.0]);
        let flat = band(1.2, 100.5, 99.5, NOW + 10_000);
        assert_eq!(
            code(freeze_bet(&flat, dec("1"), &ring, NOW).unwrap_err()),
            (409, "market_quiet".to_string())
        );
    }

    #[test]
    fn up_down_outcomes_and_exact_payouts() {
        let up = up_terms();
        let down = Terms {
            direction: "DOWN".into(),
            ..up_terms()
        };
        let win = (Outcome::Win, 175 * 1_000_000_000);
        assert_eq!(decide(&up, STAKE, Some(&end_at(101))).unwrap(), win);
        assert_eq!(decide(&down, STAKE, Some(&end_at(99))).unwrap(), win);
        assert_eq!(
            decide(&up, STAKE, Some(&end_at(99))).unwrap(),
            (Outcome::Loss, 0)
        );
        assert_eq!(
            decide(&down, STAKE, Some(&end_at(101))).unwrap(),
            (Outcome::Loss, 0)
        );
        for side in [&up, &down] {
            assert_eq!(
                decide(side, STAKE, Some(&end_at(100))).unwrap(),
                (Outcome::Tie, STAKE)
            );
        }
    }

    #[test]
    fn a_payout_is_exact_and_rounds_towards_the_house() {
        // 0.1234567891 * 1.75 = 0.216049380925 -> 0.21604938.
        assert_eq!(exact_payout(1_234_567_891, 17_500).unwrap(), 2_160_493_800);
        // 0.1 * 1.9 in doubles is 0.19000000000000003.
        assert_eq!(exact_payout(1_000_000_000, 19_000).unwrap(), 1_900_000_000);
    }

    #[test]
    fn a_band_wins_inside_its_edges_inclusive() {
        let terms = Terms {
            mode: "box".into(),
            price_top: Some(102 * 100_000_000),
            price_bottom: Some(101 * 100_000_000),
            ..up_terms()
        };
        for whole in [101, 102] {
            let (outcome, _) = decide(&terms, STAKE, Some(&end_at(whole))).unwrap();
            assert_eq!(outcome, Outcome::Win);
        }
        for whole in [100, 103] {
            let (outcome, payout) = decide(&terms, STAKE, Some(&end_at(whole))).unwrap();
            assert_eq!((outcome, payout), (Outcome::Loss, 0));
        }
    }

    #[test]
    fn no_price_or_another_venue_refunds_the_stake() {
        let up = up_terms();
        assert_eq!(
            decide(&up, STAKE, None).unwrap(),
            (Outcome::RefundNoPrice, STAKE)
        );
        let other_venue = EndTick {
            source: "yahoo".into(),
            ..end_at(200)
        };
        assert_eq!(
            decide(&up, STAKE, Some(&other_venue)).unwrap(),
            (Outcome::RefundNoPrice, STAKE)
        );
    }

    #[test]
    fn the_end_tick_is_at_or_before_the_end_and_within_tolerance() {
        let ring = TickBuffer::new(60);
        ring.record("BTC", 100.0, NOW, "binance");
        ring.record("BTC", 200.0, NOW + 2_000, "binance");
        // Never a later tick, however close.
        assert_eq!(
            end_tick(&ring, "BTC", NOW + 1_999).unwrap().price,
            100 * 100_000_000
        );
        assert_eq!(
            end_tick(&ring, "BTC", NOW + 2_000).unwrap().price,
            200 * 100_000_000
        );
        assert!(end_tick(&ring, "BTC", NOW - 1).is_none());
        // The default crypto tolerance is 5 s.
        assert!(end_tick(&ring, "BTC", NOW + 7_000).is_some());
        assert!(end_tick(&ring, "BTC", NOW + 7_001).is_none());
        assert!(end_tick(&ring, "ETH", NOW).is_none());
    }
}
