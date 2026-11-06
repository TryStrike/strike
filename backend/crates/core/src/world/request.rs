use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{classes, full_acr, idkit, ATTEMPT_TTL_MS, SUPERSEDED};
use crate::address::{canonical, keccak256};
use crate::config::config;
use crate::db::Db;
use crate::error::ApiResult;

const RP_TTL_S: u64 = 300;

fn random_b64() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn browser_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

pub(super) fn hash_to_field(bytes: &[u8]) -> [u8; 32] {
    let hash = keccak256(bytes);
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&hash[..31]);
    out
}

fn rp_sign(
    key: &k256::ecdsa::SigningKey,
    action: Option<&str>,
    random: &[u8; 32],
    created_at: u64,
    ttl_s: u64,
) -> (String, String) {
    let nonce = hash_to_field(random);
    let mut msg = vec![0x01];
    msg.extend_from_slice(&nonce);
    msg.extend_from_slice(&created_at.to_be_bytes());
    msg.extend_from_slice(&(created_at + ttl_s).to_be_bytes());
    if let Some(action) = action {
        msg.extend_from_slice(&hash_to_field(action.as_bytes()));
    }
    let mut framed = format!("\x19Ethereum Signed Message:\n{}", msg.len()).into_bytes();
    framed.extend_from_slice(&msg);
    let (sig, recovery) = key
        .sign_prehash_recoverable(&keccak256(&framed))
        .expect("secp256k1 signs a 32 byte digest");
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(recovery.to_byte() + 27);
    (
        format!("0x{}", hex::encode(nonce)),
        format!("0x{}", hex::encode(bytes)),
    )
}

pub(super) fn signal(wallet: &str, attempt_id: &str) -> String {
    hex::encode(Sha256::digest(
        format!("{}{attempt_id}", wallet.to_lowercase()).as_bytes(),
    ))
}

pub struct Challenge {
    pub attempt_id: String,
    pub request: Value,
    pub expires_at_ms: i64,
    pub classes: &'static [&'static str],
    pub browser_secret: String,
}

impl Challenge {
    pub fn to_json(&self) -> Value {
        json!({
            "attempt": self.attempt_id,
            "world": self.request,
            "expiresAt": self.expires_at_ms,
            "acr": self.classes,
        })
    }
}

pub async fn begin_human(db: &Db, wallet: &str, orb: bool, now_ms: i64) -> ApiResult<Challenge> {
    let app = idkit()?;
    let wallet = canonical(wallet);
    let classes = classes(orb);
    let id = uuid::Uuid::new_v4().to_string();
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).expect("OS randomness");
    let created_at = (now_ms / 1_000) as u64;
    let action = &config().world_action;
    let (nonce, signature) = rp_sign(
        &app.signing_key,
        Some(action),
        &random,
        created_at,
        RP_TTL_S,
    );
    let request = json!({
        "app_id": app.app_id,
        "action": action,
        "signal": signal(&wallet, &id),
        "environment": app.environment,
        "preset": if orb { "orb" } else { "selfie" },
        "rp_context": {
            "rp_id": app.rp_id,
            "nonce": nonce,
            "created_at": created_at,
            "expires_at": created_at + RP_TTL_S,
            "signature": signature,
        },
    });
    let challenge = Challenge {
        request,
        attempt_id: id,
        expires_at_ms: now_ms + ATTEMPT_TTL_MS,
        classes,
        browser_secret: random_b64(),
    };
    let row = (
        challenge.attempt_id.clone(),
        format!(
            "Strike human check
Wallet: {wallet}
Attempt: {}",
            challenge.attempt_id
        ),
        browser_hash(&challenge.browser_secret),
        full_acr(classes).join(" "),
        challenge.expires_at_ms,
    );
    db.write(move |conn| {
        conn.execute(
            "UPDATE world_attempts SET status = 'expired', reason = ?2, done_at = ?3              WHERE wallet = ?1 AND status = 'pending'",
            params![wallet, SUPERSEDED, now_ms * 1_000],
        )?;
        conn.execute(
            "INSERT INTO world_attempts (id, wallet, message, nonce, browser, acr_allowed,              status, expires_at, created_at, kind)              VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, 'human')",
            params![
                row.0,
                wallet,
                row.1,
                nonce,
                row.2,
                row.3,
                row.4 * 1_000,
                now_ms * 1_000
            ],
        )?;
        Ok(())
    })
    .await?;
    Ok(challenge)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rp_signatures_match_worlds_vectors() {
        assert_eq!(
            hex::encode(hash_to_field(b"")),
            "00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4"
        );
        assert_eq!(
            hex::encode(hash_to_field(b"hello")),
            "001c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36dea"
        );
        let key = k256::ecdsa::SigningKey::from_slice(&[0xab; 32]).unwrap();
        let random: [u8; 32] = std::array::from_fn(|i| i as u8);
        let nonce = "0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd";
        assert_eq!(
            rp_sign(&key, None, &random, 1_700_000_000, 300),
            (nonce.to_string(), "0x14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9e4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa4021b".to_string())
        );
        assert_eq!(
            rp_sign(&key, Some("test-action"), &random, 1_700_000_000, 300),
            (nonce.to_string(), "0x05594adb6c1495768a38d523d7d6ee6356b2c31231919198794ed022ade7d08f73753f83bd167067d99c9b969d28e9222315837c66af25867b041273a6d5056f1b".to_string())
        );
    }
}
