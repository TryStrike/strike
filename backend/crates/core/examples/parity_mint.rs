//! Mints session/settlement/admin tokens with the Rust implementation and
//! writes them for `backend/parity/emit.mjs --verify` to check under the
//! TypeScript verifier.
//!
//!   cargo run -p core --example parity_mint
//!
//! Secrets come from `backend/parity/vectors.json` (written by emit.mjs), so
//! the two implementations are always checked against the same keys.

use strike_core::crypto;

fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../parity/vectors.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{path} not found (run node backend/parity/emit.mjs): {e}"));
    let vectors: serde_json::Value = serde_json::from_str(&raw).expect("valid vectors.json");

    let internal = vectors["secrets"]["internal"].as_str().expect("secrets.internal");
    let settlement_secret = vectors["secrets"]["settlement"].as_str().expect("secrets.settlement");
    let dashboard = vectors["secrets"]["dashboard"].as_str().expect("secrets.dashboard");

    let session = crypto::mint_balance_session_with(Some(internal)).expect("mint session");
    let settlement = crypto::create_settlement_token_with(
        Some(settlement_secret),
        "bet-parity-1",
        "0x1111111111111111111111111111111111111111",
        "USDC",
        7.25,
        300,
    )
    .expect("mint settlement");
    let admin = crypto::issue_admin_token_with(Some(dashboard)).expect("mint admin");

    let out = serde_json::json!({
        "session": session,
        "settlement": settlement,
        "admin": admin,
        "expectedBetId": "bet-parity-1",
    });

    let out_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../parity/rust-tokens.json");
    std::fs::write(out_path, format!("{out}\n")).expect("write rust-tokens.json");
    println!("wrote {out_path}");
}
