//! Address handling. The database stores lowercase keys; the chain speaks
//! EIP-55 checksum. Every comparison goes through one of these.

use tiny_keccak::{Hasher, Keccak};

/// keccak256, used for both EIP-55 hashing and EIP-191 personal_sign.
pub fn keccak256(input: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut hasher = Keccak::v256();
    hasher.update(input);
    hasher.finalize(&mut out);
    out
}

/// True for a 0x-prefixed 40-hex-character address.
pub fn is_address_shape(value: &str) -> bool {
    let Some(hex_part) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    else {
        return false;
    };
    hex_part.len() == 40 && hex_part.chars().all(|c| c.is_ascii_hexdigit())
}

/// `isValidAddress()` = `ethers.isAddress()`, including its checksum rule.
///
/// The rule (verified against the installed ethers): the shape is
/// `^(0x)?[0-9a-fA-F]{40}$` - a `0X` prefix is not accepted, no prefix is - and
/// a mixed-case body (at least one `[A-F]` AND one `[a-f]`) must match the
/// EIP-55 checksum exactly. An all-lowercase or all-uppercase body is accepted
/// unchecked, which is why every ledger write still goes through `canonical()`.
///
/// Deliberate deviation: ethers also accepts valid IBAN/ICAP (`XE…`) addresses.
/// Those are rejected here - the house only ever pays to an EVM hex address, and
/// a form that the ledger cannot key on is worse refused than mishandled.
pub fn is_address(value: &str) -> bool {
    let body = match value.strip_prefix("0x") {
        Some(stripped) => stripped,
        None => value,
    };
    if body.len() != 40 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let has_upper_letter = body
        .chars()
        .any(|c| c.is_ascii_alphabetic() && c.is_ascii_uppercase());
    let has_lower_letter = body
        .chars()
        .any(|c| c.is_ascii_alphabetic() && c.is_ascii_lowercase());
    if has_upper_letter && has_lower_letter {
        let prefixed = if value.starts_with("0x") {
            value.to_string()
        } else {
            format!("0x{body}")
        };
        return to_checksum(&prefixed) == prefixed;
    }
    true
}

/// Lowercase `0x…` form — the storage key used across the ledger.
///
/// `canonicalHouseUserAddress.ts` lowercases only what starts with a lowercase
/// `0x`; anything else (Privy external accounts, a `0X…` spelling) is trimmed
/// and left alone, so comparisons stay byte-identical to what the TS service
/// wrote into the ledger.
pub fn canonical(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with("0x") {
        return trimmed.to_lowercase();
    }
    trimmed.to_string()
}

/// EIP-55 checksummed form, for display and for RPC calls.
pub fn to_checksum(value: &str) -> String {
    let trimmed = value.trim();
    let body = match trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        Some(b) if b.len() == 40 && b.chars().all(|c| c.is_ascii_hexdigit()) => b.to_lowercase(),
        _ => return trimmed.to_string(),
    };
    let hash = keccak256(body.as_bytes());
    let hash_hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();

    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in body.chars().enumerate() {
        if c.is_ascii_alphabetic() {
            let nibble = u8::from_str_radix(&hash_hex[i..i + 1], 16).unwrap_or(0);
            out.push(if nibble >= 8 {
                c.to_ascii_uppercase()
            } else {
                c
            });
        } else {
            out.push(c);
        }
    }
    out
}

/// Every spelling the admin lookups try for one wallet
/// (`walletAddressSearchVariants`). Order matters: the TS set iterates
/// original spelling first, then the canonical one.
pub fn search_variants(address: &str) -> Vec<String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut variants: Vec<String> = Vec::with_capacity(2);
    push_unique(&mut variants, trimmed.to_string());
    push_unique(&mut variants, canonical(trimmed));
    // Non-EVM identifiers: some code paths stored them lowercased.
    if !trimmed.starts_with("0x") && trimmed.chars().count() >= 32 {
        push_unique(&mut variants, trimmed.to_lowercase());
    }
    variants
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.iter().any(|existing| existing == &value) {
        list.push(value);
    }
}

/// A short label like `0x1234…abcd` for the UI.
pub fn shorten(value: &str, prefix: usize, suffix: usize) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= prefix + suffix {
        return trimmed.to_string();
    }
    format!(
        "{}…{}",
        &trimmed[..prefix],
        &trimmed[trimmed.len() - suffix..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_matches_eip55_vectors() {
        // The three worked examples published in EIP-55, plus two addresses
        // whose checksum was recomputed here rather than recalled.
        for addr in [
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xd1220A0Cf47c7B9be7A2E6Ba89F429762B72dB5B",
            "0x52908400098527886E0F7030069857D2E4169EE7",
        ] {
            assert_eq!(to_checksum(addr), addr, "checksum drift for {addr}");
            // Idempotent from lowercase too.
            assert_eq!(to_checksum(&addr.to_lowercase()), addr);
        }
    }

    #[test]
    fn canonical_lowercases_and_trims() {
        assert_eq!(canonical(" 0xAbC123 "), "0xabc123");
        assert_eq!(canonical(""), "");
        assert!(is_address_shape(
            "0x1111111111111111111111111111111111111111"
        ));
        assert!(!is_address_shape("0x123"));
        assert!(!is_address_shape("vitalik.eth"));
    }

    #[test]
    fn variants_match_the_ts_helper() {
        let mixed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
        assert_eq!(
            search_variants(mixed),
            vec![mixed.to_string(), mixed.to_lowercase()]
        );
        // Already canonical: one spelling, not two identical rows in an IN list.
        assert_eq!(
            search_variants(&mixed.to_lowercase()),
            vec![mixed.to_lowercase()]
        );
        assert_eq!(search_variants("  "), Vec::<String>::new());
        // Non-EVM identifier of the length some code paths lowercased.
        let external = "APrivyStyleExternalIdWithALongBody";
        assert_eq!(
            search_variants(external),
            vec![external.to_string(), external.to_lowercase()]
        );
        // Short non-EVM values keep only their original spelling.
        assert_eq!(search_variants("demo-1"), vec!["demo-1".to_string()]);
    }

    /// The matrix below was produced by the installed ethers (`isAddress` /
    /// `getAddress`) rather than recalled, because a checksum rule that is
    /// wrong in one direction either blocks a deposit or admits a typo.
    #[test]
    fn is_address_follows_ethers_rules() {
        let lower = "0xd1220a0cf47c7b9be7a2e6ba89f429762b72db5b";
        let mixed = "0xd1220A0Cf47c7B9be7A2E6Ba89F429762B72dB5B";
        assert!(is_address(lower), "lowercase must be accepted");
        assert!(
            is_address(&lower[2..]),
            "missing 0x prefix is still an address"
        );
        assert!(
            is_address(mixed),
            "a correct mixed-case checksum must be accepted"
        );
        assert!(
            !is_address("0xd1220A0Cf47c7B9be7A2E6Ba89F429762B72dB5a"),
            "bad checksum must be rejected"
        );
        // `0X` prefix: rejected by the shape regex.
        assert!(!is_address(&lower.replace("0x", "0X")));
        assert!(!is_address("0x123"));
        assert!(!is_address("vitalik.eth"));
        assert!(!is_address(""));
        // ICAP is accepted by ethers and refused here (see the doc comment).
        assert!(!is_address("XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS"));
        // One-case-only spellings skip the checksum check, exactly as ethers does.
        assert!(is_address("0xD1220A0CF47C7B9BE7A2E6BA89F429762B72DB5B"));
    }

    #[test]
    fn shorten_keeps_ends() {
        let addr = "0x1234567890123456789012345678901234567890";
        assert_eq!(shorten(addr, 6, 4), "0x1234…7890");
        assert_eq!(shorten("0x12", 6, 4), "0x12");
    }
}
