//! The paper edge model: a win chance for each momentum signal, from the last
//! five minutes of Binance trades. It only writes to the shadow log, so it can
//! prove itself on live data before it touches a trade.
//!
//! Weights come from an offline logistic fit in `edge_model.json`. Every feature
//! here has to match the training code, including the one second bars.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;

const FEATURES: usize = 17;
const SECONDS: usize = 301;
const EPSILON: f64 = 1e-9;
const SECONDS_PER_DAY: f64 = 86_400.0;

#[derive(Deserialize)]
struct Model {
    mean: Vec<f64>,
    scale: Vec<f64>,
    coef: Vec<f64>,
    intercept: f64,
}

static MODEL: LazyLock<Model> = LazyLock::new(|| {
    serde_json::from_str(include_str!("edge_model.json")).expect("edge_model.json parses")
});

#[derive(Debug, Clone, Copy)]
struct Bar {
    second: i64,
    close: f64,
    volume: f64,
    taker_buy: f64,
    trades: f64,
}

static BARS: [Mutex<VecDeque<Bar>>; 2] = [Mutex::new(VecDeque::new()), Mutex::new(VecDeque::new())];

fn slot(asset: &str) -> Option<usize> {
    match asset {
        "BTC" => Some(0),
        "ETH" => Some(1),
        _ => None,
    }
}

fn add_trade(bars: &mut VecDeque<Bar>, second: i64, price: f64, qty: f64, taker_buy: bool) {
    let bought = if taker_buy { qty } else { 0.0 };
    match bars.back_mut() {
        Some(bar) if bar.second >= second => {
            if bar.second == second {
                bar.close = price;
            }
            bar.volume += qty;
            bar.taker_buy += bought;
            bar.trades += 1.0;
        }
        _ => bars.push_back(Bar {
            second,
            close: price,
            volume: qty,
            taker_buy: bought,
            trades: 1.0,
        }),
    }
    while bars
        .front()
        .is_some_and(|bar| bar.second < second - 2 * SECONDS as i64)
    {
        bars.pop_front();
    }
}

pub fn record_trade(asset: &str, price: f64, qty: f64, taker_buy: bool, traded_at_ms: i64) {
    let Some(slot) = slot(asset) else { return };
    if let Ok(mut bars) = BARS[slot].lock() {
        add_trade(
            &mut bars,
            traded_at_ms.div_euclid(1_000),
            price,
            qty,
            taker_buy,
        );
    }
}

/// A reconnect loses trades, and silence can't tell that from a quiet market, so
/// the window starts over and the model waits for five clean minutes.
pub fn reset() {
    for bars in &BARS {
        if let Ok(mut bars) = bars.lock() {
            bars.clear();
        }
    }
}

/// One bar per second ending at `end`, quiet seconds filled with the last close.
/// `None` until a bar reaches back past the start.
fn window(bars: &VecDeque<Bar>, end: i64) -> Option<Vec<Bar>> {
    let start = end - SECONDS as i64 + 1;
    let mut stored = bars.iter().peekable();
    let mut last = None;
    while stored.peek().is_some_and(|bar| bar.second < start) {
        last = stored.next().copied();
    }
    let mut filled: Vec<Bar> = Vec::with_capacity(SECONDS);
    for second in start..=end {
        match stored.peek() {
            Some(bar) if bar.second == second => {
                last = Some(**bar);
                filled.push(**bar);
                stored.next();
            }
            _ => filled.push(Bar {
                second,
                volume: 0.0,
                taker_buy: 0.0,
                trades: 0.0,
                ..last?
            }),
        }
    }
    Some(filled)
}

fn features(bars: &[Bar], side: f64, flag: f64, end: i64) -> [f64; FEATURES] {
    let n = bars.len() - 1;
    let close = |back: usize| bars[n - back].close;
    let now = close(0);
    let moved = now - close(15);
    let range_bars = &bars[n - 120..];
    let high = range_bars.iter().map(|b| b.close).fold(f64::MIN, f64::max);
    let low = range_bars.iter().map(|b| b.close).fold(f64::MAX, f64::min);
    let range = high - low;
    let tail = |w: usize| &bars[n + 1 - w..];
    let total = |w: usize, field: fn(&Bar) -> f64| tail(w).iter().map(field).sum::<f64>();
    let signed_move = |w: usize| (now - close(w)) / now * 1e4 * side;
    let imbalance = |w: usize| {
        let volume = total(w, |b| b.volume);
        if volume > 0.0 {
            (2.0 * total(w, |b| b.taker_buy) - volume) / volume * side
        } else {
            0.0
        }
    };
    let volatility = |w: usize| {
        let squared: f64 = (n + 1 - w..=n)
            .map(|i| (bars[i].close / bars[i - 1].close).ln().powi(2))
            .sum();
        (squared / w as f64).sqrt() * 1e4
    };
    let pace = |field: fn(&Bar) -> f64| {
        (total(15, field) / 15.0 + EPSILON) / (total(300, field) / 300.0 + EPSILON)
    };
    let hour =
        std::f64::consts::TAU * end.rem_euclid(SECONDS_PER_DAY as i64) as f64 / SECONDS_PER_DAY;
    [
        moved.abs() / now * 1e4,
        moved.abs() / range,
        range / now * 1e4,
        signed_move(5),
        signed_move(60),
        signed_move(300),
        volatility(60),
        volatility(300),
        volatility(60) / (volatility(300) + EPSILON),
        imbalance(15),
        imbalance(60),
        imbalance(300),
        pace(|b| b.volume),
        pace(|b| b.trades),
        hour.sin(),
        hour.cos(),
        flag,
    ]
}

fn score(x: &[f64; FEATURES]) -> f64 {
    let model = &*MODEL;
    let logit = (0..FEATURES).fold(model.intercept, |sum, i| {
        sum + model.coef[i] * (x[i] - model.mean[i]) / model.scale[i]
    });
    1.0 / (1.0 + (-logit).exp())
}

/// The chance this signal wins. `None` until the stream holds five clean minutes.
pub fn win_chance(asset: &str, direction: &str, now_ms: i64) -> Option<f64> {
    let slot = slot(asset)?;
    let end = now_ms.div_euclid(1_000) - 1;
    let bars = window(&*BARS[slot].lock().ok()?, end)?;
    let side = if direction == "UP" { 1.0 } else { -1.0 };
    let x = features(&bars, side, slot as f64, end);
    x.iter().all(|value| value.is_finite()).then(|| score(&x))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(seconds: i64) -> VecDeque<Bar> {
        let mut bars = VecDeque::new();
        for second in 0..seconds {
            let price = 100.0 + (second % 7) as f64 * 0.1;
            add_trade(&mut bars, second, price, 1.0, second % 2 == 0);
        }
        bars
    }

    #[test]
    fn the_model_file_has_a_weight_for_every_feature() {
        assert_eq!(MODEL.mean.len(), FEATURES);
        assert_eq!(MODEL.scale.len(), FEATURES);
        assert_eq!(MODEL.coef.len(), FEATURES);
    }

    #[test]
    fn a_short_stream_gives_no_window() {
        assert!(window(&stream(100), 99).is_none());
        assert!(window(&stream(400), 399).is_some());
    }

    #[test]
    fn a_quiet_second_keeps_the_close_and_adds_no_volume() {
        let mut bars = stream(400);
        bars.retain(|bar| bar.second != 300);
        let filled = window(&bars, 399).unwrap();
        let quiet = filled.iter().find(|bar| bar.second == 300).unwrap();
        assert_eq!(quiet.close, 100.0 + (299 % 7) as f64 * 0.1);
        assert_eq!(quiet.volume, 0.0);
    }

    #[test]
    fn the_old_bars_are_dropped() {
        assert_eq!(stream(2_000).len(), 2 * SECONDS + 1);
    }
}
