//! World ID step-up that unlocks a YOLO agent. A start saves a pending attempt
//! bound to the signed terms, the human proves in World App with IDKit, the
//! browser posts the proof and developer.world.org verifies it. The session is
//! created in the same write that spends the attempt. With no IDKit app
//! configured there is no gate, the same way jev is off without its key.

mod attempt;
mod humans;
mod request;
mod verify;

use rust_decimal::Decimal;

use crate::config::{config, IdkitApp};
use crate::error::{ApiError, ApiResult};

pub use attempt::{attempt_for, deny, idkit_error_outcome, Attempt};
pub(crate) use humans::{approve, claim};
pub use humans::{checkpoint_passed, human_of, resume};
pub use request::{begin, begin_checkpoint, browser_hash, Challenge};
pub use verify::{check_proof, verify_proof, Failure, HumanGrant};

pub const WORLD_COOKIE: &str = "strike_world";
/// An attempt that resumes a paused YOLO session instead of starting one.
pub const CHECKPOINT: &str = "checkpoint";
/// World's authorization codes live 5 minutes, so the attempt does too.
pub const ATTEMPT_TTL_MS: i64 = 5 * 60 * 1000;
pub const ACR_PREFIX: &str = "https://world.org/oidc/acr/";
/// Weakest first. `WORLD_ACR_FLOOR` and the budget tiers cut from the left.
const CLASSES: [&str; 3] = ["selfie", "orb", "orb-face"];

pub const NOT_CONFIGURED: &str = "Human checks are not configured on this server";
pub const VERIFIED: &str = "Human verified";
pub const CANCELLED: &str = "You cancelled in World App";
pub const ALREADY_USED: &str = "This approval link was already used";
pub const EXPIRED: &str = "Human check expired";
pub const SUPERSEDED: &str = "A newer human check replaced this one";
pub const UNAVAILABLE: &str = "World ID unavailable, nothing started";
pub const MISMATCH: &str = "A different human approved this";
pub const BANNED_HUMAN: &str = "This human is banned";
pub const ONE_PER_HUMAN: &str = "This human already runs a YOLO agent";
pub const NOT_PAUSED: &str = "The agent is not waiting for a human";
pub const AGENT_GONE: &str = "The agent already stopped";

/// The IDKit action for every check, so the nullifier is one stable id per human.
pub const ACTION: &str = "strike-yolo";

/// Whether YOLO agents need a human check at all on this server.
pub fn enabled() -> bool {
    config().world_idkit.is_some()
}

pub fn idkit() -> ApiResult<&'static IdkitApp> {
    config()
        .world_idkit
        .as_ref()
        .ok_or_else(|| ApiError::unavailable(NOT_CONFIGURED))
}

/// The proof classes a budget may be backed by, weakest first.
pub fn accepted_classes(
    budget: Decimal,
    selfie_max: Decimal,
    orb_max: Decimal,
    floor: Option<&str>,
) -> Result<&'static [&'static str], String> {
    if selfie_max > orb_max {
        return Err(format!(
            "WORLD_SELFIE_MAX {selfie_max} is above WORLD_ORB_MAX {orb_max}"
        ));
    }
    let tier = if budget <= selfie_max {
        0
    } else if budget <= orb_max {
        1
    } else {
        2
    };
    let floor = match floor {
        None => 0,
        Some(name) => CLASSES.iter().position(|c| *c == name).ok_or_else(|| {
            format!("WORLD_ACR_FLOOR is {name}, it must be selfie, orb or orb-face")
        })?,
    };
    Ok(&CLASSES[tier.max(floor)..])
}

fn classes_for(budget: Decimal) -> ApiResult<&'static [&'static str]> {
    let cfg = config();
    accepted_classes(
        budget,
        cfg.world_selfie_max,
        cfg.world_orb_max,
        cfg.world_acr_floor.as_deref(),
    )
    .map_err(|err| {
        tracing::error!("[world] {err}");
        ApiError::unavailable(NOT_CONFIGURED)
    })
}

fn full_acr(classes: &[&str]) -> Vec<String> {
    classes.iter().map(|c| format!("{ACR_PREFIX}{c}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_picks_the_proof_class() {
        let (selfie, orb) = (Decimal::from(10), Decimal::from(50));
        let tier = |budget: i64, floor| {
            accepted_classes(Decimal::from(budget), selfie, orb, floor).unwrap()
        };
        assert_eq!(tier(10, None), ["selfie", "orb", "orb-face"]);
        assert_eq!(tier(11, None), ["orb", "orb-face"]);
        assert_eq!(tier(50, None), ["orb", "orb-face"]);
        assert_eq!(tier(51, None), ["orb-face"]);
        assert_eq!(tier(5, Some("orb")), ["orb", "orb-face"]);
        assert_eq!(tier(60, Some("selfie")), ["orb-face"]);
        assert!(accepted_classes(Decimal::ONE, selfie, orb, Some("passkey")).is_err());
        assert!(accepted_classes(Decimal::from(30), orb, selfie, None).is_err());
    }
}
