mod attempt;
mod humans;
mod request;
mod verify;

use crate::config::{config, IdkitApp};
use crate::error::{ApiError, ApiResult};

pub use attempt::{attempt_for, deny, idkit_error_outcome, Attempt};
pub(crate) use humans::{
    any_banned, bet_refusal, human_of_wallet, link_agent_pass, wallets_of_human,
};
pub use humans::{dev_bypass, finish_human, gate_ready, human_status, Human, Refusal};
pub use request::{begin_human, browser_hash, Challenge};
pub use verify::{check_proof, verify_proof, Failure, HumanGrant};

pub const WORLD_COOKIE: &str = "strike_world";
pub const ATTEMPT_TTL_MS: i64 = 5 * 60 * 1000;
pub const ACR_PREFIX: &str = "https://world.org/oidc/acr/";
const CLASSES: [&str; 3] = ["selfie", "orb", "orb-face"];

pub const NOT_CONFIGURED: &str = "Human checks are not configured on this server";
pub const VERIFIED: &str = "Human verified";
pub const CANCELLED: &str = "You cancelled in World App";
pub const EXPIRED: &str = "Human check expired";
pub const SUPERSEDED: &str = "A newer human check replaced this one";
pub const UNAVAILABLE: &str = "World ID unavailable, nothing changed";
pub const MISMATCH: &str = "This wallet is already linked to a different human";
pub const BANNED_HUMAN: &str = "This human is banned";

pub fn enabled() -> bool {
    config().world_idkit.is_some()
}

pub fn idkit() -> ApiResult<&'static IdkitApp> {
    config()
        .world_idkit
        .as_ref()
        .ok_or_else(|| ApiError::coded("world_unconfigured", NOT_CONFIGURED))
}

pub fn classes(orb: bool) -> &'static [&'static str] {
    if orb {
        &CLASSES[1..]
    } else {
        &CLASSES
    }
}

fn full_acr(classes: &[&str]) -> Vec<String> {
    classes.iter().map(|c| format!("{ACR_PREFIX}{c}")).collect()
}

pub fn tier_of(acr: &str) -> &'static str {
    match acr.strip_prefix(ACR_PREFIX).unwrap_or(acr) {
        "orb" | "orb-face" => "orb",
        _ => "selfie",
    }
}
