//! The shadow log: every signal the agent rule sees, with jev's score, settled
//! on paper the way a real round settles. It places no bet and touches no
//! balance, so a rule or a score can prove itself on our own ticks first.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use rusqlite::params;
use rust_decimal::prelude::ToPrimitive;

use crate::agent::{self, Signal};
use crate::bets::now_ms;
use crate::db;
use crate::jev::{self, Gate, Proposal};
use crate::settlement::{binomo_multiplier, end_tick, fixed_price};
use crate::ticks;

const ASSETS: [&str; 2] = ["BTC", "ETH"];
/// One reference trade, so every score answers the same question.
const STAKE: f64 = 1.0;
const BUDGET: f64 = 5.0;
const STOP_LOSS: f64 = 3.0;
/// The end tick lands up to one sample after the round ends.
const END_GRACE: Duration = Duration::from_millis(1_500);

struct Observed {
    asset: &'static str,
    direction: &'static str,
    signal_at_ms: i64,
    signal_price: f64,
    move_pct: f64,
    range_share: f64,
    range_pct: f64,
}

/// Holds one paper round per asset at a time, like the agent's one open bet.
pub async fn run() {
    let round_ms = agent::ROUND_SECONDS * 1_000;
    let mut every = tokio::time::interval(Duration::from_millis(agent::CHECK_EVERY_MS));
    let mut free_at: HashMap<&str, i64> = HashMap::new();
    loop {
        every.tick().await;
        let now = now_ms();
        for asset in ASSETS {
            if free_at.get(asset).is_some_and(|at| now < *at) {
                continue;
            }
            let Signal::Trade {
                direction,
                strike,
                move_pct,
                range_share,
                range_pct,
                ..
            } = agent::signal(ticks::buffer(), asset, now)
            else {
                continue;
            };
            free_at.insert(asset, now + round_ms + agent::CHECK_EVERY_MS as i64);
            let observed = Observed {
                asset,
                direction,
                signal_at_ms: now,
                signal_price: strike,
                move_pct,
                range_share,
                range_pct,
            };
            tokio::spawn(async move {
                if let Err(why) = settle_on_paper(observed).await {
                    tracing::warn!("[shadow] {asset}: {why}");
                }
            });
        }
    }
}

async fn settle_on_paper(o: Observed) -> Result<(), String> {
    let payout = binomo_multiplier(agent::ROUND_SECONDS)
        .and_then(|multiplier| multiplier.to_f64())
        .expect("the payout table offers the agent's round length");
    let proposal = Proposal {
        asset: o.asset.to_string(),
        direction: o.direction,
        move_15s_pct: o.move_pct,
        move_share_of_2m_range: o.range_share,
        range_2m_pct: o.range_pct,
        stake_usdc: STAKE,
        budget_left_usdc: BUDGET,
        stop_loss_headroom_usdc: STOP_LOSS,
        payout_multiplier: payout,
    };
    let asked = Instant::now();
    let gate = jev::review(&proposal).await;
    let jev_ms = jev::enabled().then(|| asked.elapsed().as_millis() as i64);
    let (status, score) = match gate {
        Gate::Off => ("off", None),
        Gate::Pass(score) => ("passed", Some(score)),
        Gate::Block(score) => ("blocked", Some(score)),
        Gate::Failed(_) => ("failed", None),
    };
    let needed = jev::enabled().then(|| jev::needed(payout));

    let ring = ticks::buffer();
    let strike = ring
        .latest(o.asset)
        .ok_or("no tick to strike on after the jev call")?;
    let end_ms = strike.at_ms + agent::ROUND_SECONDS * 1_000;
    let id = uuid::Uuid::new_v4().to_string();
    let database = db::db().await.map_err(|err| err.to_string())?;
    let row = id.clone();
    database
        .write(move |conn| {
            conn.execute(
                "INSERT INTO signal_shadow (id, asset, signal_at, direction, move_pct, range_share, \
                 range_pct, signal_price, strike, jev_status, jev_score, jev_needed, jev_ms, end_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    row,
                    o.asset,
                    o.signal_at_ms * 1_000,
                    o.direction,
                    o.move_pct,
                    o.range_share,
                    o.range_pct,
                    o.signal_price,
                    strike.price,
                    status,
                    score,
                    needed,
                    jev_ms,
                    end_ms * 1_000,
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|err| err.to_string())?;

    tokio::time::sleep(Duration::from_millis((end_ms - now_ms()).max(0) as u64) + END_GRACE).await;
    let end = end_tick(ring, o.asset, end_ms).ok_or("no usable end tick")?;
    let start = fixed_price(strike.price).ok_or("the strike is not a price")?;
    let outcome = match (end.price.cmp(&start), o.direction) {
        (Ordering::Equal, _) => "tie",
        (Ordering::Greater, "UP") | (Ordering::Less, "DOWN") => "win",
        _ => "loss",
    };
    database
        .write(move |conn| {
            conn.execute(
                "UPDATE signal_shadow SET outcome = ?2 WHERE id = ?1",
                params![id, outcome],
            )?;
            Ok(())
        })
        .await
        .map_err(|err| err.to_string())
}
