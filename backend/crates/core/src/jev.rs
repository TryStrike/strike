//! The jev gate: one typed review of each trade the rule proposes.
//!
//! jev only ever blocks. It sees numbers and no free text, its answer can't add
//! a trade or change a size, and limits still run after it. A timeout or any
//! error skips the trade. With no key set the gate is off and the rule decides.
//!
//! The score is jev's opinion of the proposal, not a win chance. In testing it
//! marked down a wrong direction and an oversized stake, but it did not separate
//! a strong move from a weak one, so it stays labelled "jev confidence".

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::config;

pub const ENDPOINT: &str = "https://openrouter.ai/api/alpha/decisions";
const MODEL: &str = "typesafe/jev-1.14";
/// Calls measured about 450 ms from a laptop, so the PRD's 300 ms would skip all.
const TIMEOUT: Duration = Duration::from_millis(800);
/// Real scores topped out near 0.65, so the PRD's 0.8 for normal mode would
/// block every trade. Normal mode has a person approving each trade anyway.
pub const THRESHOLD: f64 = 0.6;
/// No new review once a 30 s round could outlive the session.
pub const CLOSING_MS: i64 = 35_000;
const INSTRUCTIONS: &str = "Does this proposed trade follow a 15 second momentum strategy, \
     and is the size safe, given the numbers in the state? Answer yes only if both hold.";
pub const BLOCKED: &str = "jev confidence was too low";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .expect("reqwest client builds")
});

#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    pub asset: String,
    pub direction: &'static str,
    pub move_15s_pct: f64,
    pub move_share_of_2m_range: f64,
    pub range_2m_pct: f64,
    pub stake_usdc: f64,
    pub budget_left_usdc: f64,
    pub stop_loss_headroom_usdc: f64,
    pub payout_multiplier: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Gate {
    /// No key is set, so the rule decides alone.
    Off,
    Pass(f64),
    Block(f64),
    Failed(&'static str),
}

pub fn enabled() -> bool {
    config().openrouter_api_key.is_some()
}

fn request_body(proposal: &Proposal) -> Value {
    json!({
        "model": MODEL,
        "state": {
            "asset": proposal.asset,
            "direction": proposal.direction,
            "move_15s_pct": proposal.move_15s_pct,
            "move_share_of_2m_range": proposal.move_share_of_2m_range,
            "range_2m_pct": proposal.range_2m_pct,
            "stake_usdc": proposal.stake_usdc,
            "budget_left_usdc": proposal.budget_left_usdc,
            "stop_loss_headroom_usdc": proposal.stop_loss_headroom_usdc,
            "payout_multiplier": proposal.payout_multiplier,
            "breakeven": 1.0 / proposal.payout_multiplier,
        },
        "questions": { "pass": { "type": "noul", "instructions": INSTRUCTIONS } },
    })
}

fn confidence_of(response: &Value) -> Option<f64> {
    response
        .pointer("/answers/pass/noul")?
        .as_f64()
        .filter(|score| (0.0..=1.0).contains(score))
}

/// The score has to clear the threshold and the payout's breakeven.
fn verdict(confidence: f64, payout_multiplier: f64) -> Gate {
    if confidence >= THRESHOLD.max(1.0 / payout_multiplier) {
        Gate::Pass(confidence)
    } else {
        Gate::Block(confidence)
    }
}

pub async fn review(proposal: &Proposal) -> Gate {
    let cfg = config();
    let Some(key) = cfg.openrouter_api_key.as_deref() else {
        return Gate::Off;
    };
    let sent = CLIENT
        .post(&cfg.jev_endpoint)
        .bearer_auth(key)
        .json(&request_body(proposal))
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(err) if err.is_timeout() => return Gate::Failed("jev timed out"),
        Err(err) => {
            tracing::warn!("[jev] request failed: {err}");
            return Gate::Failed("jev is unavailable");
        }
    };
    let status = response.status();
    if !status.is_success() {
        tracing::warn!("[jev] answered {status}");
        return Gate::Failed("jev is unavailable");
    }
    match response
        .json::<Value>()
        .await
        .ok()
        .as_ref()
        .and_then(confidence_of)
    {
        Some(confidence) => verdict(confidence, proposal.payout_multiplier),
        None => {
            tracing::warn!("[jev] answer had no usable score");
            Gate::Failed("jev gave no usable answer")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal() -> Proposal {
        Proposal {
            asset: "BTC".to_string(),
            direction: "UP",
            move_15s_pct: 0.08,
            move_share_of_2m_range: 0.9,
            range_2m_pct: 0.1,
            stake_usdc: 1.0,
            budget_left_usdc: 20.0,
            stop_loss_headroom_usdc: 10.0,
            payout_multiplier: 1.9,
        }
    }

    #[test]
    fn the_request_is_numbers_and_one_fixed_question() {
        let body = request_body(&proposal());
        assert_eq!(body["model"], "typesafe/jev-1.14");
        assert_eq!(body["questions"]["pass"]["type"], "noul");
        assert_eq!(body["state"]["direction"], "UP");
        assert_eq!(body["state"]["stake_usdc"], 1.0);
    }

    #[test]
    fn a_real_answer_gives_its_score() {
        let real = json!({
            "model": "typesafe/jev-1.14-20261014",
            "answers": { "pass": { "type": "noul", "noul": 0.74 } },
            "usage": { "input_tokens": 445, "output_tokens": 35, "cost": 0.00001869 },
        });
        assert_eq!(confidence_of(&real), Some(0.74));
    }

    #[test]
    fn a_missing_or_impossible_score_is_no_answer() {
        assert_eq!(confidence_of(&json!({ "error": "x" })), None);
        for bad in [json!(1.2), json!(-0.1), json!("0.7"), Value::Null] {
            let response = json!({ "answers": { "pass": { "noul": bad } } });
            assert_eq!(confidence_of(&response), None);
        }
    }

    #[test]
    fn a_score_must_clear_the_threshold_and_the_breakeven() {
        assert_eq!(verdict(0.61, 1.9), Gate::Pass(0.61));
        assert_eq!(verdict(0.6, 1.9), Gate::Pass(0.6));
        assert_eq!(verdict(0.59, 1.9), Gate::Block(0.59));
        // A 1.5x payout breaks even at 66.7%, above the threshold.
        assert_eq!(verdict(0.61, 1.5), Gate::Block(0.61));
    }
}
