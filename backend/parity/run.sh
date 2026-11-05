#!/usr/bin/env sh
# Token parity gate between Rust and the frozen JS algorithms in emit.mjs.
#
#   1. mint fixtures with the JS algorithms (backend/parity/emit.mjs)
#   2. `cargo test` verifies them with the Rust algorithms
#   3. mint the same tokens with Rust
#   4. the JS verifiers check the Rust tokens, including wrong-secret controls
#
# Run from anywhere; paths are resolved from this script.
set -eu
cd "$(dirname "$0")/.."

node parity/emit.mjs
cargo test -p strike-core
cargo run -q -p strike-core --example parity_mint
node parity/emit.mjs --verify parity/rust-tokens.json
