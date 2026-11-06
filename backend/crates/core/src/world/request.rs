//! The signed IDKit request a start or checkpoint hands the browser, and the
//! pending attempt saved for it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::humans::{link_of, running};
use super::{
    classes_for, full_acr, idkit, ACTION, ATTEMPT_TTL_MS, CHECKPOINT, NOT_PAUSED, SUPERSEDED,
};
use crate::address::{canonical, keccak256};
use crate::agent::{self, refuse, Session, StartTerms};
use crate::config::IdkitApp;
use crate::db::{is_unique_violation, Db};
use crate::error::ApiResult;
use crate::ledger::Rejection;

/// How long World accepts a signed proof request.
const RP_TTL_S: u64 = 300;

fn random_b64() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// What the browser stores is the secret, what the row stores is its hash.
pub fn browser_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// keccak256 shifted into the BN254 field, as World hashes signals and actions.
pub(super) fn hash_to_field(bytes: &[u8]) -> [u8; 32] {
    let hash = keccak256(bytes);
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&hash[..31]);
    out
}

/// `(nonce, signature)` of an RP context, both 0x hex. World checks the
/// signature against the app's registered signer.
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

/// The ID token carries this, so an approval is for these exact terms only.
pub(super) fn terms_nonce(attempt_id: &str, message: &str) -> String {
    hex::encode(Sha256::digest(format!("{attempt_id}{message}").as_bytes()))
}

pub struct Challenge {
    pub attempt_id: String,
    /// The signed IDKit request the widget opens.
    pub request: Value,
    pub expires_at_ms: i64,
    pub classes: &'static [&'static str],
    /// Goes to the browser as the `strike_world` cookie, never stored.
    pub browser_secret: String,
}

impl Challenge {
    /// RFC 9470 step-up challenge.
    pub fn www_authenticate(&self) -> String {
        format!(
            "Bearer error=\"insufficient_user_authentication\", max_age=\"0\", acr_values=\"{}\"",
            full_acr(self.classes).join(" ")
        )
    }

    pub fn to_json(&self) -> Value {
        let mut body = json!({
            "error": "Human check required",
            "attempt": self.attempt_id,
            "expiresAt": self.expires_at_ms,
            "acr": self.classes,
        });
        body["world"] = self.request.clone();
        body
    }
}

/// Saves a pending attempt for a signed, checked YOLO start.
pub async fn begin(
    db: &Db,
    terms: &StartTerms,
    message: &str,
    now_ms: i64,
) -> ApiResult<Result<Challenge, Rejection>> {
    let app = idkit()?;
    let classes = classes_for(terms.budget)?;
    let expires_at_ms = (now_ms + ATTEMPT_TTL_MS).min(terms.expires_ms);
    let draft = Draft::new(app, classes, now_ms, expires_at_ms, |_| message.to_string());
    let (wallet, start_nonce) = (canonical(&terms.wallet), terms.nonce.clone());
    db.write(move |conn| {
        if let Some(refused) = agent::start_blocked(conn, &start_nonce, &wallet)? {
            return Ok(Err(refused));
        }
        match draft.save(conn, &wallet, "start", None, now_ms) {
            Err(err) if is_unique_violation(&err) => {
                Ok(Err(refuse(409, "Start message already used")))
            }
            Err(err) => Err(err.into()),
            Ok(_) => Ok(Ok(draft.challenge)),
        }
    })
    .await
}

/// Saves a checkpoint for a YOLO session paused until `until_ms`. World lets
/// only the human linked to its wallet approve it.
pub async fn begin_checkpoint(
    db: &Db,
    session: &Session,
    until_ms: i64,
    now_ms: i64,
) -> ApiResult<Result<Challenge, Rejection>> {
    let app = idkit()?;
    let classes = classes_for(session.budget)?;
    let (session_id, wallet) = (session.id.clone(), session.wallet.clone());
    db.write(move |conn| {
        if until_ms <= now_ms || !running(conn, &session_id)? {
            return Ok(Err(refuse(409, NOT_PAUSED)));
        }
        if link_of(conn, &wallet)?.is_none() {
            return Ok(Err(refuse(409, "No human is linked to this wallet")));
        }
        let draft = Draft::new(
            app,
            classes,
            now_ms,
            (now_ms + ATTEMPT_TTL_MS).min(until_ms),
            |id| format!("Strike checkpoint\nSession: {session_id}\nAttempt: {id}"),
        );
        draft.save(conn, &wallet, CHECKPOINT, Some(&session_id), now_ms)?;
        Ok(Ok(draft.challenge))
    })
    .await
}

/// A pending attempt before it is saved.
struct Draft {
    challenge: Challenge,
    message: String,
    /// The signed RP nonce. The terms nonce rides along as the IDKit signal.
    nonce: String,
}

impl Draft {
    /// `message` is what the approval is for, given the attempt id.
    fn new(
        app: &IdkitApp,
        classes: &'static [&'static str],
        now_ms: i64,
        expires_at_ms: i64,
        message: impl FnOnce(&str) -> String,
    ) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let message = message(&id);
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).expect("OS randomness");
        let created_at = (now_ms / 1_000) as u64;
        let (nonce, signature) = rp_sign(
            &app.signing_key,
            Some(ACTION),
            &random,
            created_at,
            RP_TTL_S,
        );
        let request = json!({
            "app_id": app.app_id,
            "action": ACTION,
            "signal": terms_nonce(&id, &message),
            "environment": app.environment,
            "preset": if classes[0] == "selfie" { "selfie" } else { "orb" },
            "require_user_presence": classes[0] == "orb-face",
            "rp_context": {
                "rp_id": app.rp_id,
                "nonce": nonce,
                "created_at": created_at,
                "expires_at": created_at + RP_TTL_S,
                "signature": signature,
            },
        });
        Draft {
            challenge: Challenge {
                request,
                attempt_id: id,
                expires_at_ms,
                classes,
                browser_secret: random_b64(),
            },
            message,
            nonce,
        }
    }

    /// Supersedes the wallet's pending attempt and saves this one.
    fn save(
        &self,
        conn: &Connection,
        wallet: &str,
        kind: &str,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> rusqlite::Result<usize> {
        conn.execute(
            "UPDATE world_attempts SET status = 'expired', reason = ?2, done_at = ?3 \
             WHERE wallet = ?1 AND status = 'pending'",
            params![wallet, SUPERSEDED, now_ms * 1_000],
        )?;
        conn.execute(
            "INSERT INTO world_attempts (id, wallet, message, nonce, browser, \
             acr_allowed, status, expires_at, created_at, kind, session_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10)",
            params![
                self.challenge.attempt_id,
                wallet,
                self.message,
                self.nonce,
                browser_hash(&self.challenge.browser_secret),
                full_acr(self.challenge.classes).join(" "),
                self.challenge.expires_at_ms * 1_000,
                now_ms * 1_000,
                kind,
                session_id
            ],
        )
    }
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
