//! The wallet-bound proof that scopes
//! `GET /api/withdrawals`.
//!
//! The header used to be an `address` query parameter guarded by a global,
//! wallet-agnostic cookie, which made the list an enumeration oracle. The
//! replacement is a signature: the route scopes the ledger by the **recovered**
//! signer and never by an address the client typed. A captured proof is
//! worthless after its freshness window and grants no mutation.

use serde_json::Value;

use crate::address::canonical;
use crate::crypto::MAX_CLOCK_SKEW_MS;
use crate::eth::verify_personal_signature;

/// `WITHDRAWAL_READ_AUTH_HEADER`.
pub const READ_AUTH_HEADER: &str = "x-strike-withdrawal-read-auth";
/// A read proof is a standing query licence; keep it short-lived.
pub const READ_AUTH_MAX_AGE_MS: i64 = 10 * 60 * 1000;
/// Clients re-sign before the hard cut-off so polling never trips on skew.
pub const READ_AUTH_REFRESH_AFTER_MS: i64 = READ_AUTH_MAX_AGE_MS - 60 * 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct ReadAuthProof {
    pub address: String,
    pub issued_at: f64,
    pub nonce: String,
    pub signature: String,
}

/// `buildWithdrawalReadAuthMessage`. The exact bytes the wallet signed, so a
/// re-format here would silently reject every real signature.
pub fn read_auth_message(address: &str, issued_at: f64, nonce: &str) -> String {
    format!(
        "STRIKE withdrawal read authorization\naddress:{address}\nissuedAt:{}\nnonce:{nonce}",
        js_number_string(issued_at)
    )
}

/// JS's `String(n)` for the values that can appear here: integers lose the
/// decimal point, everything else keeps its shortest round-trip form.
fn js_number_string(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadAuthFailure {
    Malformed,
    Stale,
    InvalidSignature,
}

impl ReadAuthFailure {
    pub fn message(self) -> &'static str {
        match self {
            Self::Malformed => "Missing or malformed withdrawal read authorization",
            Self::Stale => "Withdrawal read authorization has expired. Please sign again.",
            Self::InvalidSignature => "Invalid withdrawal read authorization",
        }
    }

    /// `code: read_auth_<code>` in the route body.
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Stale => "stale",
            Self::InvalidSignature => "invalid_signature",
        }
    }
}

/// Strict decode of the header value; never throws, never panics on junk.
pub fn parse_read_auth_header(raw: Option<&str>) -> Option<ReadAuthProof> {
    let value: Value = serde_json::from_str(raw?).ok()?;
    let map = value.as_object()?;

    let address = map.get("address").and_then(Value::as_str)?;
    if !is_address_string(address) {
        return None;
    }
    let issued_at = map.get("issuedAt").and_then(Value::as_f64)?;
    if !issued_at.is_finite() {
        return None;
    }
    let nonce = map.get("nonce").and_then(Value::as_str)?;
    if !is_nonce(nonce) {
        return None;
    }
    let signature = map.get("signature").and_then(Value::as_str)?;
    if !is_signature(signature) {
        return None;
    }

    Some(ReadAuthProof {
        address: address.to_string(),
        issued_at,
        nonce: nonce.to_string(),
        signature: signature.to_string(),
    })
}

/// `/^0x[0-9a-fA-F]{40}$/` — the lowercase `0x` prefix is required, which is
/// stricter than `address::is_address_shape` and matches the TS regex.
pub fn is_address_string(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("0x") else {
        return false;
    };
    hex.len() == 40 && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// `/^[0-9a-f]{8,64}$/` — lowercase hex only, so an uppercase nonce is
/// malformed rather than silently normalised.
pub fn is_nonce(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// `/^0x[0-9a-fA-F]{130}$/` — 65 bytes, either casing.
/// A 65 byte EOA signature, or a longer smart account one (ERC-1271 or ERC-6492).
pub fn is_signature(value: &str) -> bool {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    value.starts_with("0x")
        && (130..=8192).contains(&hex.len())
        && hex.len().is_multiple_of(2)
        && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// `verifyWithdrawalReadAuth`.
pub async fn verify_read_auth(
    raw: Option<&str>,
    now_ms: i64,
) -> Result<ReadAuthProof, ReadAuthFailure> {
    let proof = parse_read_auth_header(raw).ok_or(ReadAuthFailure::Malformed)?;

    let age_ms = now_ms - proof.issued_at as i64;
    if !(-MAX_CLOCK_SKEW_MS..=READ_AUTH_MAX_AGE_MS).contains(&age_ms) {
        return Err(ReadAuthFailure::Stale);
    }

    let message = read_auth_message(&proof.address, proof.issued_at, &proof.nonce);
    match verify_personal_signature(&proof.address, &message, &proof.signature).await {
        Ok(true) => {}
        Ok(false) => return Err(ReadAuthFailure::InvalidSignature),
        Err(err) => {
            tracing::error!("[read_auth] could not check the signature: {err}");
            return Err(ReadAuthFailure::InvalidSignature);
        }
    }

    Ok(proof)
}

/// The ledger scoping key: the recovered signer, canonical for the query. The
/// proof's own `address` field is never used to filter rows — it only names the
/// message that was signed.
pub fn scope_key(proof: &ReadAuthProof) -> String {
    canonical(&proof.address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::address::{keccak256, to_checksum};
    use k256::ecdsa::SigningKey;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000_000;

    /// The address `SigningKey::from_slice(&[0x11; 32])` controls, and a
    /// signature over exactly `message`.
    fn signer() -> SigningKey {
        SigningKey::from_slice(&[0x11u8; 32]).unwrap()
    }

    fn address_of(key: &SigningKey) -> String {
        let point = key.verifying_key().to_encoded_point(false);
        let hash = keccak256(&point.as_bytes()[1..]);
        to_checksum(&format!("0x{}", hex::encode(&hash[12..])))
    }

    fn sign(key: &SigningKey, message: &str) -> String {
        let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
        let mut framed = prefix.into_bytes();
        framed.extend_from_slice(message.as_bytes());
        let hash = keccak256(&framed);
        let (sig, id) = key.sign_prehash_recoverable(&hash).unwrap();
        let mut raw = sig.to_bytes().to_vec();
        raw.push(id.to_byte() + 27);
        format!("0x{}", hex::encode(raw))
    }

    fn header(address: &str, issued_at: f64, nonce: &str, signature: &str) -> String {
        json!({ "address": address, "issuedAt": issued_at, "nonce": nonce, "signature": signature })
            .to_string()
    }

    /// A valid proof for `signer()`, signed at `issued_at`.
    fn valid(key: &SigningKey, issued_at: i64) -> (String, String) {
        let address = address_of(key);
        let message = read_auth_message(&address, issued_at as f64, "deadbeef01");
        let signature = sign(key, &message);
        (
            header(&address, issued_at as f64, "deadbeef01", &signature),
            address,
        )
    }

    #[test]
    fn the_message_is_the_exact_bytes_the_wallet_signed() {
        // Changing this format silently rejects every signature in the wild.
        assert_eq!(
            read_auth_message("0xAbC", 1_700_000_000_000.0, "beef"),
            "STRIKE withdrawal read authorization\naddress:0xAbC\nissuedAt:1700000000000\nnonce:beef"
        );
        // An integer epoch never gains a `.0`, which is what JS would print.
        assert!(!read_auth_message("0xAbC", 5.0, "beef").contains("5.0"));
    }

    #[tokio::test]
    async fn a_proof_recovering_its_own_address_verifies() {
        let key = signer();
        let (raw, address) = valid(&key, NOW);
        let proof = verify_read_auth(Some(&raw), NOW)
            .await
            .expect("valid proof");
        assert_eq!(proof.address, address);
        assert_eq!(scope_key(&proof), canonical(&address));
    }

    #[tokio::test]
    async fn junk_headers_are_malformed_rather_than_a_panic() {
        for raw in [
            None,
            Some(""),
            Some("not json"),
            Some("[]"),
            Some("null"),
            Some("{\"address\":\"0x1\"}"),
        ] {
            assert_eq!(
                verify_read_auth(raw, NOW).await.unwrap_err(),
                ReadAuthFailure::Malformed,
                "{raw:?}"
            );
        }
    }

    #[test]
    fn every_field_is_shape_checked_before_the_signature_is_considered() {
        let key = signer();
        let address = address_of(&key);
        let good_nonce = "deadbeef01";
        let message = read_auth_message(&address, NOW as f64, good_nonce);
        let signature = sign(&key, &message);

        // Address must be a full 0x + 40 hex.
        assert!(
            parse_read_auth_header(Some(&header("0xabc", NOW as f64, good_nonce, &signature)))
                .is_none()
        );
        // Nonce is lowercase hex, 8..64 long.
        assert!(!is_nonce("DEADBEEF"), "uppercase is not the declared shape");
        assert!(!is_nonce("abcdef"));
        assert!(is_nonce("00000000"));
        assert!(is_nonce(&"a".repeat(64)));
        assert!(!is_nonce(&"a".repeat(65)));
        // Signature must be exactly 65 bytes with the 0x prefix.
        assert!(is_signature(&signature));
        assert!(!is_signature("0xdead"));
        // `issuedAt` must be a finite JSON number, not a stringified one.
        assert!(parse_read_auth_header(Some(
            &json!({ "address": address, "issuedAt": "1700000000000", "nonce": good_nonce,
                     "signature": signature })
            .to_string()
        ))
        .is_none());
    }

    #[tokio::test]
    async fn an_expired_or_future_proof_is_stale() {
        let key = signer();
        let (raw, _) = valid(&key, NOW);
        // `ageMs > MAX_AGE`: the boundary itself is still accepted.
        assert_eq!(
            verify_read_auth(Some(&raw), NOW + READ_AUTH_MAX_AGE_MS)
                .await
                .map(|_| ()),
            Ok(()),
            "exactly ten minutes old is the last valid instant"
        );
        assert_eq!(
            verify_read_auth(Some(&raw), NOW + READ_AUTH_MAX_AGE_MS + 1)
                .await
                .unwrap_err(),
            ReadAuthFailure::Stale
        );
        // Clock skew tolerance, then hard rejection.
        assert!(verify_read_auth(Some(&raw), NOW - MAX_CLOCK_SKEW_MS)
            .await
            .is_ok());
        assert_eq!(
            verify_read_auth(Some(&raw), NOW - MAX_CLOCK_SKEW_MS - 1)
                .await
                .unwrap_err(),
            ReadAuthFailure::Stale
        );
    }

    #[tokio::test]
    async fn a_proof_signed_by_someone_else_is_rejected_even_with_a_plausible_address() {
        // The invariant: the ledger is scoped to the recovered signer, so a
        // valid signature can never be pointed at a different wallet.
        let attacker = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let victim_address = address_of(&signer());
        let message = read_auth_message(&victim_address, NOW as f64, "deadbeef01");
        let raw = header(
            &victim_address,
            NOW as f64,
            "deadbeef01",
            &sign(&attacker, &message),
        );
        assert_eq!(
            verify_read_auth(Some(&raw), NOW).await.unwrap_err(),
            ReadAuthFailure::InvalidSignature
        );

        // A tampered nonce breaks the message the same way.
        let (good, _) = valid(&signer(), NOW);
        let tampered = good.replace("deadbeef01", "cafebabeff");
        assert_eq!(
            verify_read_auth(Some(&tampered), NOW).await.unwrap_err(),
            ReadAuthFailure::InvalidSignature
        );
    }

    #[test]
    fn failure_codes_match_the_route_body() {
        assert_eq!(ReadAuthFailure::Malformed.code(), "malformed");
        assert_eq!(ReadAuthFailure::Stale.code(), "stale");
        assert_eq!(
            ReadAuthFailure::InvalidSignature.code(),
            "invalid_signature"
        );
        for failure in [
            ReadAuthFailure::Malformed,
            ReadAuthFailure::Stale,
            ReadAuthFailure::InvalidSignature,
        ] {
            assert!(!failure.message().contains('%'), "no interpolated value");
        }
    }

    #[test]
    fn the_refresh_window_is_shorter_than_the_hard_cut_off() {
        const _: () = assert!(READ_AUTH_REFRESH_AFTER_MS < READ_AUTH_MAX_AGE_MS);
        assert_eq!(READ_AUTH_MAX_AGE_MS, 10 * 60 * 1000);
    }
}
