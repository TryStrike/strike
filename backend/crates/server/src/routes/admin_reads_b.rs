//! `/api/admin/*` — the read side of the admin dashboard.
//!
//! Transport only, mirroring `app/api/admin/{users,game-history,treasury-balances,
//! currencies,banned-wallets,withdrawal-requests/pending,export}/route.ts`. The
//! heavy lifting is `strike_core::admin_reads_a` (users / game-history loaders and
//! the shared list-param parser) and `strike_core::admin_reads_extra_b` (the reads
//! `admin_reads_a` does not cover). Each handler runs the same steps in the same
//! order as the TS: `requireAdminAuth` first, then query parsing (a rejected
//! param is a client-safe 400 echoed verbatim), then the read, and finally the
//! route's own leak-safe 500 text on failure.
//!
//! Mutations are deliberately absent here — POST /api/admin/users/status, the
//! banned-wallet POST/DELETE and the currency writes belong to another module.

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use strike_core::admin_reads_a::{self, ListOptions};
use strike_core::admin_reads_extra_b as extra;
use strike_core::config::config;
use strike_core::db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::withdrawals;

use crate::http::{json_status, require_admin};

pub fn routes() -> Router {
    Router::new()
        .route("/api/admin/users", get(users))
        .route("/api/admin/game-history", get(game_history))
        .route("/api/admin/treasury-balances", get(treasury_balances))
        .route("/api/admin/currencies", get(currencies))
        .route("/api/admin/banned-wallets", get(banned_wallets))
        .route("/api/admin/withdrawal-requests/pending", get(pending))
        .route("/api/admin/export", get(export))
        .route("/api/admin/ops-health", get(ops_health))
}

/// `new URL(request.url).searchParams` — the raw query decoded into the ordered
/// pair list every admin loader consumes.
fn query_pairs(uri: &Uri) -> Vec<(String, String)> {
    admin_reads_a::url_query_pairs(uri.query().unwrap_or(""))
}

/// The admin fallback the routes hand to `adminErrorResponse`: log the real
/// cause, answer with the sanitized (route-specific) message at 500.
fn admin_fail(err: ApiError, fallback: &str, label: &str) -> ApiError {
    tracing::error!("[admin/{label}] {fallback}: {err}");
    ApiError::internal(admin_reads_a::sanitize_error_message(
        &err.to_string(),
        fallback,
    ))
}

/// `adminBadRequest(message)` — `{ error }` at 400. The message is client-safe by
/// construction (the list parser and dataset resolver never echo internals).
fn bad_request(message: String) -> Response {
    ApiError::bad_request(message).into_response()
}

/// `NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })`.
fn json_no_store(body: Value) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("no-store"),
    );
    (StatusCode::OK, headers, Json(body)).into_response()
}

/// `GET /api/admin/users`.
async fn users(headers: HeaderMap, uri: Uri) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }

    let params = query_pairs(&uri);
    let referrers: [&str; 1] = ["1"];
    let opts = ListOptions {
        status_values: Some(&admin_reads_a::USER_STATUS_VALUES[..]),
        extra_enums: &[("referrers", &referrers[..])],
    };
    let parsed = match admin_reads_a::parse_list_params(&params, &opts) {
        Ok(parsed) => parsed,
        Err(message) => return bad_request(message),
    };

    match admin_reads_a::load_users(&parsed, now_ms()).await {
        Ok(page) => json_status(StatusCode::OK, page.to_value()),
        Err(err) => admin_fail(err, "Failed to load users", "users").into_response(),
    }
}

/// `GET /api/admin/game-history` — DB-paged for `account=all`, the capped
/// in-memory scan for `real`/`demo`.
async fn game_history(headers: HeaderMap, uri: Uri) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }

    let params = query_pairs(&uri);
    let opts = ListOptions {
        status_values: Some(&admin_reads_a::GAME_STATUS_VALUES[..]),
        extra_enums: &[("account", &admin_reads_a::ACCOUNT_VALUES[..])],
    };
    let parsed = match admin_reads_a::parse_list_params(&params, &opts) {
        Ok(parsed) => parsed,
        Err(message) => return bad_request(message),
    };
    let account = parsed.extra("account").unwrap_or("all").to_string();

    let loaded = if account == "all" {
        admin_reads_a::load_game_history_page(&parsed).await
    } else {
        admin_reads_a::load_game_history_account(&parsed, &account).await
    };
    match loaded {
        Ok(body) => json_status(StatusCode::OK, body),
        Err(err) => admin_fail(err, "Failed to load game history", "game-history").into_response(),
    }
}

/// `GET /api/admin/treasury-balances`.
async fn treasury_balances(headers: HeaderMap) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }
    match extra::treasury_balances_body().await {
        Ok(body) => json_no_store(body),
        Err(err) => admin_fail(err, "Snapshot failed", "treasury-balances").into_response(),
    }
}

/// `GET /api/admin/currencies`.
async fn currencies(headers: HeaderMap) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }
    match extra::load_currencies().await {
        Ok(body) => json_status(StatusCode::OK, body),
        Err(err) => admin_fail(err, "Failed to load market prices", "currencies").into_response(),
    }
}

/// `GET /api/admin/banned-wallets`. The Supabase service-key prod guard has no
/// analog on the direct Postgres pool, so it is not reproduced; the missing-table
/// (503) vs. failure (500) split is.
async fn banned_wallets(headers: HeaderMap) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }
    match extra::load_banned_wallets().await {
        Ok(body) => json_status(StatusCode::OK, body),
        Err(err) => {
            extra::banned_wallets_failure(&err, "Failed to load banned wallets", "banned-wallets")
                .into_response()
        }
    }
}

/// `GET /api/admin/withdrawal-requests/pending`.
async fn pending(headers: HeaderMap, uri: Uri) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }

    let params = query_pairs(&uri);
    let status_values: [&str; 1] = ["pending"];
    let opts = ListOptions {
        status_values: Some(&status_values[..]),
        extra_enums: &[],
    };
    let parsed = match admin_reads_a::parse_list_params(&params, &opts) {
        Ok(parsed) => parsed,
        Err(message) => return bad_request(message),
    };

    match extra::load_withdrawal_pending(&parsed).await {
        Ok(body) => json_status(StatusCode::OK, body),
        Err(err) => admin_fail(
            err,
            "Failed to load pending withdrawals",
            "withdrawal-requests/pending",
        )
        .into_response(),
    }
}

/// `GET /api/admin/export` — CSV over the three whitelisted datasets. Pagination
/// is parsed for validation but ignored: an export always streams from row 0.
async fn export(headers: HeaderMap, uri: Uri) -> Response {
    if let Err(err) = require_admin(&headers) {
        return err.into_response();
    }

    let params = query_pairs(&uri);
    let dataset = match extra::resolve_dataset(admin_reads_a::param(&params, "dataset")) {
        Some(dataset) => dataset,
        None => {
            return bad_request(
                "Unknown dataset. Allowed: transactions, game_history, access_codes.".to_string(),
            )
        }
    };

    let (status_values, with_account) = match dataset {
        extra::ExportDataset::Transactions => {
            (Some(&admin_reads_a::TRANSACTION_STATUS_VALUES[..]), false)
        }
        extra::ExportDataset::GameHistory => (Some(&admin_reads_a::GAME_STATUS_VALUES[..]), true),
        extra::ExportDataset::AccessCodes => (Some(&extra::ACCESS_CODE_STATUS_VALUES[..]), false),
    };
    let account_enums: [(&str, &[&str]); 1] = [("account", &admin_reads_a::ACCOUNT_VALUES[..])];
    let no_enums: [(&str, &[&str]); 0] = [];
    let opts = ListOptions {
        status_values,
        extra_enums: if with_account {
            &account_enums[..]
        } else {
            &no_enums[..]
        },
    };
    let parsed = match admin_reads_a::parse_list_params(&params, &opts) {
        Ok(parsed) => parsed,
        Err(message) => return bad_request(message),
    };

    match extra::build_export(dataset, &parsed).await {
        Ok((body, file_name)) => csv_response(body, &file_name),
        Err(err) => admin_fail(err, "Export failed", "export").into_response(),
    }
}

/// The CSV response: a `text/csv` body with an attachment disposition built from
/// the whitelisted filename, `no-store` and `nosniff`, exactly as the route sets.
fn csv_response(body: String, file_name: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    headers.insert(
        HeaderName::from_static("content-disposition"),
        HeaderValue::from_str(&format!("attachment; filename=\"{file_name}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    (StatusCode::OK, headers, body).into_response()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Not a TS route. What an operator needs at a glance: withdrawals debited with
/// no transfer on record, and how well the writer is batching.
async fn ops_health(headers: HeaderMap) -> Response {
    if let Err(deny) = require_admin(&headers) {
        return deny.into_response();
    }
    let report = async {
        let database = db::db().await?;
        let stuck = withdrawals::stuck(database, withdrawals::stuck_cutoff_us()).await?;
        ApiResult::Ok((stuck, database.writer_stats()))
    };
    match report.await {
        Ok((stuck, (commits, jobs))) => axum::Json(json!({
            "stuckWithdrawals": {
                "count": stuck.len(),
                "ids": stuck,
                "timeoutSeconds": config().withdrawal_stuck_secs,
            },
            "writer": {
                "commits": commits,
                "jobs": jobs,
                "averageBatch": jobs as f64 / commits.max(1) as f64,
            },
        }))
        .into_response(),
        Err(err) => {
            tracing::error!("[admin/ops-health] {err}");
            ApiError::internal("Failed to load ops health").into_response()
        }
    }
}
