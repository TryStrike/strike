//! Checks an IDKit result against its attempt, then has World verify it.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{json, Value};

use super::attempt::Attempt;
use super::request::{hash_to_field, terms_nonce};
use super::{ACR_PREFIX, ACTION, UNAVAILABLE};
use crate::config::IdkitApp;

#[derive(Debug, PartialEq)]
pub enum Failure {
    /// World did not answer. Never an approval.
    Unavailable,
    /// The token endpoint's OAuth `error`.
    Rejected(String),
    /// The ID token failed this check.
    Invalid(&'static str),
}

impl Failure {
    pub fn reason(&self) -> String {
        match self {
            Failure::Unavailable => UNAVAILABLE.to_string(),
            Failure::Rejected(code) => super::attempt::could_not_finish(code),
            Failure::Invalid("acr") => {
                "Your World ID level is too low for this budget, lower it or verify with Orb"
                    .to_string()
            }
            Failure::Invalid(claim) => format!("Approval did not validate ({claim})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HumanGrant {
    pub attempt_id: String,
    pub iss: String,
    pub sub: String,
    pub acr: String,
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        // developer.world.org's Cloudflare answers 403 HTML to a request without one.
        .user_agent("strike-backend")
        .build()
        .expect("reqwest client builds")
});

// ---------------------------------------------------------------------------
// IDKit proof checks and verification
// ---------------------------------------------------------------------------

/// The proof class of an IDKit credential identifier. `face` is World's old
/// name for a selfie, `orb` the 3.0 name for proof of human. An Orb proof
/// with World App's user-presence check passes the orb-face tier.
fn idkit_class(identifier: &str, presence: bool) -> Option<&'static str> {
    match identifier {
        "selfie" | "face" => Some("selfie"),
        "proof_of_human" | "orb" if presence => Some("orb-face"),
        "proof_of_human" | "orb" => Some("orb"),
        _ => None,
    }
}

fn presence(result: &Value) -> bool {
    result.get("user_presence_completed") == Some(&Value::Bool(true))
}

/// A nullifier as 32 byte lowercase 0x hex, from World's hex or decimal form.
fn nullifier_hex(value: &str) -> Option<String> {
    let mut out = [0u8; 32];
    if let Some(hex) = value.strip_prefix("0x") {
        let padded = format!("{hex:0>64}");
        hex::decode_to_slice(&padded, &mut out).ok()?;
    } else {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        for digit in value.bytes() {
            let mut carry = u32::from(digit - b'0');
            for byte in out.iter_mut().rev() {
                let next = u32::from(*byte) * 10 + carry;
                *byte = next as u8;
                carry = next >> 8;
            }
            if carry != 0 {
                return None;
            }
        }
    }
    Some(format!("0x{}", hex::encode(out)))
}

/// Everything about an IDKit result that can be checked before World is
/// asked: environment, action, the signed nonce, the terms signal and the
/// proof class. `Err` names the field that failed.
pub fn check_proof(result: &Value, app: &IdkitApp, attempt: &Attempt) -> Result<(), &'static str> {
    let text = |name: &'static str| result.get(name).and_then(Value::as_str).ok_or(name);
    // A 3.0 proof carries a different nullifier for the same human.
    if text("protocol_version")? != "4.0" {
        return Err("protocol_version");
    }
    if text("environment")? != app.environment {
        return Err("environment");
    }
    if text("action")? != ACTION {
        return Err("action");
    }
    if !text("nonce")?.eq_ignore_ascii_case(&attempt.nonce) {
        return Err("nonce");
    }
    let responses = result
        .get("responses")
        .and_then(Value::as_array)
        .filter(|r| !r.is_empty())
        .ok_or("responses")?;
    let signal = format!(
        "0x{}",
        hex::encode(hash_to_field(
            terms_nonce(&attempt.id, &attempt.message).as_bytes()
        ))
    );
    for response in responses {
        if let Some(hash) = response.get("signal_hash") {
            if !hash
                .as_str()
                .is_some_and(|h| h.eq_ignore_ascii_case(&signal))
            {
                return Err("signal");
            }
        }
        let class = response
            .get("identifier")
            .and_then(Value::as_str)
            .and_then(|id| idkit_class(id, presence(result)));
        if !class.is_some_and(|c| attempt.acr_allowed.contains(&format!("{ACR_PREFIX}{c}"))) {
            return Err("acr");
        }
    }
    Ok(())
}

/// Forwards a checked result to World and turns its answer into a grant.
pub async fn verify_proof(
    app: &IdkitApp,
    result: &Value,
    attempt: &Attempt,
) -> Result<HumanGrant, Failure> {
    let mut body = result.clone();
    body["environment"] = json!(app.environment);
    let sent = HTTP
        .post(format!("{}/api/v4/verify/{}", app.verify_url, app.rp_id))
        .json(&body)
        .send()
        .await;
    let res = sent.map_err(|err| {
        tracing::warn!("[world] verify endpoint unreachable: {}", err.without_url());
        Failure::Unavailable
    })?;
    let status = res.status();
    if status.is_server_error() {
        tracing::warn!("[world] verify endpoint said {status}");
        return Err(Failure::Unavailable);
    }
    let reply: Value = res.json().await.map_err(|_| {
        tracing::warn!("[world] verify endpoint said {status} without JSON");
        Failure::Unavailable
    })?;
    if !status.is_success() || reply.get("success") != Some(&Value::Bool(true)) {
        let code = reply
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("verify_error");
        tracing::warn!("[world] verify endpoint said {status} {code}");
        return Err(Failure::Rejected(code.to_string()));
    }
    // The tier comes from World's answer, never from the flag the browser posted.
    grant_from(&reply, presence(&reply), app, attempt).map_err(Failure::Invalid)
}

/// The human in World's verify answer: the first proof it accepted.
fn grant_from(
    reply: &Value,
    presence: bool,
    app: &IdkitApp,
    attempt: &Attempt,
) -> Result<HumanGrant, &'static str> {
    if reply.get("environment").and_then(Value::as_str) != Some(app.environment.as_str()) {
        return Err("environment");
    }
    let verified = reply
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|r| r.get("success") == Some(&Value::Bool(true)))
        .ok_or("results")?;
    let acr = verified
        .get("identifier")
        .and_then(Value::as_str)
        .and_then(|id| idkit_class(id, presence))
        .map(|c| format!("{ACR_PREFIX}{c}"))
        .filter(|acr| attempt.acr_allowed.contains(acr))
        .ok_or("acr")?;
    let sub = verified
        .get("nullifier")
        .or_else(|| reply.get("nullifier"))
        .and_then(Value::as_str)
        .and_then(nullifier_hex)
        .ok_or("nullifier")?;
    Ok(HumanGrant {
        attempt_id: attempt.id.clone(),
        iss: format!("idkit:{}", app.rp_id),
        sub,
        acr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::request::browser_hash;
    use crate::world::{full_acr, ATTEMPT_TTL_MS, CLASSES};

    const NOW_MS: i64 = 1_800_000_000_000;

    fn attempt() -> Attempt {
        Attempt {
            id: "attempt-1".into(),
            wallet: "0x1111111111111111111111111111111111111111".into(),
            message: "terms".into(),
            nonce: terms_nonce("attempt-1", "terms"),
            browser: browser_hash("secret"),
            acr_allowed: full_acr(&CLASSES[1..]),
            status: "pending".into(),
            reason: None,
            acr: None,
            session_id: None,
            expires_at_ms: NOW_MS + ATTEMPT_TTL_MS,
            created_at_ms: NOW_MS - 20_000,
            kind: "start".into(),
        }
    }

    fn app() -> IdkitApp {
        IdkitApp {
            app_id: "app_test".into(),
            rp_id: "rp_test".into(),
            signing_key: k256::ecdsa::SigningKey::from_slice(&[0xab; 32]).unwrap(),
            environment: "staging".into(),
            verify_url: "https://developer.world.org".into(),
        }
    }

    #[test]
    fn an_idkit_result_must_answer_this_attempt() {
        let mut attempt = attempt();
        attempt.nonce = "0x00ab".into();
        let signal = format!(
            "0x{}",
            hex::encode(hash_to_field(terms_nonce("attempt-1", "terms").as_bytes()))
        );
        let result = json!({
            "protocol_version": "4.0",
            "environment": "staging",
            "action": ACTION,
            "nonce": "0x00AB",
            "responses": [{ "identifier": "proof_of_human", "signal_hash": signal, "nullifier": "255" }],
        });
        assert_eq!(check_proof(&result, &app(), &attempt), Ok(()));
        let cases: Vec<(&str, Value, &str)> = vec![
            ("protocol_version", json!("3.0"), "protocol_version"),
            ("environment", json!("production"), "environment"),
            ("action", json!("other"), "action"),
            ("nonce", json!("0x00ac"), "nonce"),
            ("responses", json!([]), "responses"),
            (
                "responses",
                json!([{ "identifier": "orb", "signal_hash": "0x01" }]),
                "signal",
            ),
            ("responses", json!([{ "identifier": "selfie" }]), "acr"),
            ("responses", json!([{ "identifier": "passport" }]), "acr"),
        ];
        for (name, value, failed) in cases {
            let mut r = result.clone();
            r[name] = value.clone();
            assert_eq!(
                check_proof(&r, &app(), &attempt),
                Err(failed),
                "{name} = {value}"
            );
        }

        let reply = json!({
            "success": true,
            "environment": "staging",
            "results": [
                { "identifier": "selfie", "success": false },
                { "identifier": "proof_of_human", "success": true, "nullifier": "255" },
            ],
        });
        let grant = grant_from(&reply, false, &app(), &attempt).unwrap();
        assert_eq!(grant.iss, "idkit:rp_test");
        assert_eq!(grant.sub, format!("0x{}ff", "0".repeat(62)));
        assert_eq!(grant.acr, format!("{ACR_PREFIX}orb"));
        let mut hex_reply = reply.clone();
        hex_reply["results"][1]["nullifier"] = json!(format!("0x{}FF", "0".repeat(62)));
        assert_eq!(
            grant_from(&hex_reply, false, &app(), &attempt).unwrap().sub,
            grant.sub
        );
        let mut wrong_env = reply.clone();
        wrong_env["environment"] = json!("production");
        assert_eq!(
            grant_from(&wrong_env, false, &app(), &attempt),
            Err("environment")
        );
        let mut face = attempt.clone();
        face.acr_allowed = full_acr(&CLASSES[2..]);
        assert_eq!(check_proof(&result, &app(), &face), Err("acr"));
        let mut present = result.clone();
        present["user_presence_completed"] = json!(true);
        assert_eq!(check_proof(&present, &app(), &face), Ok(()));
        assert_eq!(check_proof(&present, &app(), &attempt), Ok(()));
        assert_eq!(grant_from(&reply, false, &app(), &face), Err("acr"));
        assert_eq!(
            grant_from(&reply, true, &app(), &face).unwrap().acr,
            format!("{ACR_PREFIX}orb-face")
        );
        assert_eq!(nullifier_hex(&"9".repeat(80)), None);
        assert_eq!(nullifier_hex("12a"), None);
    }
}
