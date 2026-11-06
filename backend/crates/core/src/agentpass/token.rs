use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

pub const ORB: &str = "https://world.org/oidc/acr/orb";

pub fn requests_acr() -> bool {
    !std::env::var("WORLD_AP_ACR").is_ok_and(|v| v.contains("client"))
}

pub fn any_account() -> bool {
    std::env::var("WORLD_AP_ACR").is_ok_and(|v| v.contains("any"))
        && std::env::var("WORLD_AP_ISSUER").is_ok_and(|i| i.starts_with("https://sandbox."))
}

pub fn accepted_acr() -> &'static [String] {
    static ACR: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ACR.get_or_init(|| {
        let raw = std::env::var("WORLD_AP_ACR").unwrap_or_default();
        let raw = raw.replace("client", "selfie,orb");
        let picked: Vec<String> = raw
            .split([',', ' '])
            .filter(|c| matches!(*c, "orb" | "selfie"))
            .map(|c| format!("https://world.org/oidc/acr/{c}"))
            .collect();
        if picked.is_empty() {
            vec![ORB.to_string()]
        } else {
            picked
        }
    })
}
const SKEW_S: i64 = 30;

#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub auth_time: i64,
    #[serde(default)]
    pub acr: Option<String>,
    #[serde(default)]
    pub amr: Vec<String>,
}

pub fn kid(token: &str) -> Option<String> {
    decode_header(token).ok()?.kid
}

pub fn verify(
    token: &str,
    keys: &JwkSet,
    issuer: &str,
    client_id: &str,
    acr_allowed: &[&str],
    started_ms: i64,
    now_ms: i64,
) -> Result<Claims, &'static str> {
    let header = decode_header(token).map_err(|_| "Malformed ID token")?;
    if header.alg != Algorithm::RS256 {
        return Err("ID token is not RS256");
    }
    let jwk = header
        .kid
        .as_deref()
        .and_then(|kid| keys.find(kid))
        .ok_or("ID token signed by an unknown key")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| "Unusable signing key")?;
    let mut rules = Validation::new(Algorithm::RS256);
    rules.set_issuer(&[issuer]);
    rules.set_audience(&[client_id]);
    rules.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    rules.leeway = SKEW_S as u64;
    let claims = decode::<Claims>(token, &key, &rules)
        .map_err(|err| match err.kind() {
            ErrorKind::InvalidSignature => "ID token signature is invalid",
            ErrorKind::ExpiredSignature => "ID token expired",
            ErrorKind::InvalidIssuer => "ID token is from another issuer",
            ErrorKind::InvalidAudience => "ID token is for another client",
            _ => "ID token is invalid",
        })?
        .claims;
    if claims.auth_time < started_ms / 1_000 - SKEW_S || claims.auth_time > now_ms / 1_000 + SKEW_S
    {
        return Err("Authentication is not from this approval");
    }
    if any_account() {
        return Ok(claims);
    }
    if !claims
        .acr
        .as_deref()
        .is_some_and(|acr| acr_allowed.contains(&acr))
    {
        return Err("World ID level is too low");
    }
    let has = |method: &str| claims.amr.iter().any(|m| m == method);
    if !has("pop") {
        return Err("Approval needs a World ID proof");
    }
    Ok(claims)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::{json, Value};

    pub const KEY_PEM: &str = include_str!("test_key.pem");
    const OTHER_PEM: &str = include_str!("test_key_other.pem");
    pub const KEY_N: &str = include_str!("test_key.n");
    pub const KID: &str = "test-1";
    const ISS: &str = "https://auth.example";
    const AUD: &str = "client-1";

    pub fn jwks() -> JwkSet {
        serde_json::from_value(json!({ "keys": [{
            "kty": "RSA", "kid": KID, "alg": "RS256", "use": "sig",
            "n": KEY_N.trim(), "e": "AQAB",
        }]}))
        .unwrap()
    }

    pub fn sign(pem: &str, claims: &Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(KID.into());
        encode(
            &header,
            claims,
            &EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    fn now_s() -> i64 {
        chrono::Utc::now().timestamp()
    }

    fn good() -> Value {
        json!({
            "iss": ISS, "aud": AUD, "sub": "human-sub",
            "exp": now_s() + 300, "iat": now_s(), "auth_time": now_s(),
            "acr": ORB, "amr": ["pop"],
        })
    }

    fn check(pem: &str, edit: impl FnOnce(&mut Value)) -> Result<Claims, &'static str> {
        let mut claims = good();
        edit(&mut claims);
        let now_ms = now_s() * 1_000;
        verify(
            &sign(pem, &claims),
            &jwks(),
            ISS,
            AUD,
            &[ORB],
            now_ms - 60_000,
            now_ms,
        )
    }

    #[test]
    fn only_a_fresh_orb_proof_from_world_for_us_passes() {
        assert_eq!(check(KEY_PEM, |_| {}).unwrap().sub, "human-sub");
        assert_eq!(
            check(KEY_PEM, |c| c["amr"] = json!(["pop", "face", "user"]))
                .unwrap()
                .sub,
            "human-sub"
        );
        let refused = |pem, edit: fn(&mut Value)| check(pem, edit).unwrap_err();
        assert_eq!(refused(OTHER_PEM, |_| {}), "ID token signature is invalid");
        assert_eq!(
            refused(KEY_PEM, |c| c["aud"] = json!("someone-else")),
            "ID token is for another client"
        );
        assert_eq!(
            refused(KEY_PEM, |c| c["iss"] = json!("https://evil.example")),
            "ID token is from another issuer"
        );
        assert_eq!(
            refused(KEY_PEM, |c| c["exp"] = json!(now_s() - 120)),
            "ID token expired"
        );
        assert_eq!(
            refused(KEY_PEM, |c| c["auth_time"] = json!(now_s() - 600)),
            "Authentication is not from this approval"
        );
        assert_eq!(
            refused(KEY_PEM, |c| c["auth_time"] = json!(now_s() + 600)),
            "Authentication is not from this approval"
        );
        assert!(check(KEY_PEM, |c| c["amr"] = json!(["pop", "user", "mfa"])).is_ok());
        assert_eq!(
            refused(KEY_PEM, |c| c["amr"] = json!(["user"])),
            "Approval needs a World ID proof"
        );
        assert_eq!(
            refused(KEY_PEM, |c| c["acr"] =
                json!("https://world.org/oidc/acr/selfie")),
            "World ID level is too low"
        );
        assert_eq!(
            refused(KEY_PEM, |c| {
                c.as_object_mut().unwrap().remove("acr");
            }),
            "World ID level is too low"
        );
    }
}
