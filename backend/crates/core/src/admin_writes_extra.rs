//! Pure logic for the admin write routes that `admin_writes.rs` does not own.
//!
//! Sibling of `crate::admin_writes`, added by the mutation-porting agent so
//! the existing core modules stay untouched. Today it holds the access-code
//! generator (`app/api/admin/access-codes/route.ts`'s `randomAccessCodeSegment`
//! and the `count` clamp); everything else the admin mutations need already
//! lives in `admin_writes`.

use rand::RngCore;
use serde_json::Value;
use std::collections::HashSet;

use crate::bets::number_coerce;

/// The alphabet the TS route uses: `0-9` plus A-Z minus the ambiguous `I` and
/// `O` — 34 characters, so the byte draw is `mod 34` (the TS shipped exactly
/// this modulo bias; keeping it keeps the two servers behaviour-identical).
const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// `randomAccessCodeSegment(len)`: `randomBytes(len)`, each byte taken mod
/// the alphabet length.
pub fn random_access_code_segment(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}

/// The POST body's `count` clamp, in the TS order: `Number(body.count)` (an
/// absent key is `undefined` and coerces to NaN), then the finite/>=1 gate,
/// then `Math.min(Math.floor(raw), 500)`, with 1 as the default.
pub fn access_code_count(body: &Value) -> i64 {
    let raw = body.get("count").and_then(number_coerce);
    match raw {
        Some(f) if f.is_finite() && f >= 1.0 => f.floor().min(500.0) as i64,
        _ => 1,
    }
}

/// The whole generation loop: `6 + 6` characters per code, the in-batch
/// duplicate guard with its `guard < 20` escape hatch, no de-duplication
/// against the database (a unique violation is the TS route's backstop too).
pub fn generate_access_codes(count: i64) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut new_codes: Vec<String> = Vec::with_capacity(count.max(0) as usize);
    for _ in 0..count {
        let mut guard: i64 = 0;
        let code = loop {
            let candidate = format!(
                "{}{}",
                random_access_code_segment(6),
                random_access_code_segment(6)
            );
            guard += 1;
            if !seen.contains(&candidate) || guard >= 20 {
                break candidate;
            }
        };
        seen.insert(code.clone());
        new_codes.push(code);
    }
    new_codes
}
