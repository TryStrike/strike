//! Strike backend core: configuration, storage, chain and crypto primitives
//! shared by the Axum handlers.
//!
//! The only web dependency is the error type's `IntoResponse` impl, so a
//! handler can return `Result<T, ApiError>` directly; everything else here is
//! testable without a server.

pub mod address;
pub mod agent;
pub mod arkiv;
pub mod bets;
pub mod binance_ws;
pub mod config;
pub mod copilot;
pub mod crypto;
pub mod db;
pub mod eth;
pub mod jev;
pub mod ledger;
pub mod markets;
pub mod money;
pub mod prices;
pub mod proofs;
pub mod read_auth;
pub mod rpc;
pub mod schema;
pub mod settlement;
pub mod stream;
pub mod ticks;
pub mod treasury_view;
pub mod withdrawals;
pub mod world;

pub use config::config;
pub use error::{ApiError, ApiResult};

pub mod error;
pub mod payout_rules;
