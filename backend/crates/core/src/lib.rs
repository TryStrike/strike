//! Strike backend core: configuration, storage, chain and crypto primitives
//! shared by the Axum handlers.
//!
//! The only web dependency is the error type's `IntoResponse` impl, so a
//! handler can return `Result<T, ApiError>` directly; everything else here is
//! testable without a server.

pub mod address;
pub mod bets;
pub mod config;
pub mod crypto;
pub mod db;
pub mod eth;
pub mod gateway;
pub mod platform_stats;
pub mod prices;
pub mod read_auth;
pub mod schema;
pub mod stream;
pub mod treasury_view;

pub use config::config;
pub use error::{ApiError, ApiResult};

pub mod error;
pub mod admin_reads_a;
pub mod admin_writes; // TEMP-REGISTRATION admin_writes
pub mod referral; // TEMP-REGISTRATION referral
