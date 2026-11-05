//! Differential check of the ledger port: replays one call script against the
//! plpgsql functions and against `strike_core::rpc`, and fails on any difference
//! in the returned JSON, the error text, or the rows left behind.
//!
//!   PG_URL=postgres://localhost/empty_db_with_migrations \
//!     cargo run -p migrate_pg_to_sqlite --example rpc_parity
//!
//! Point it only at a disposable database: the script writes real ledger rows.

use strike_core::db::Db;
use strike_core::money::from_fixed;
use serde_json::{json, Value};
use sqlx::postgres::PgConnection;
use sqlx::Connection;

const A: &str = "0xaaaa000000000000000000000000000000000001";
const B: &str = "0xbbbb000000000000000000000000000000000002";
const BANNED: &str = "Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4";

type Call = (&'static str, Vec<(&'static str, Value)>);

fn deposit(user: &str, amount: Value, hash: &str) -> Call {
    (
        "update_balance_for_deposit",
        vec![
            ("p_user_address", json!(user)),
            ("p_deposit_amount", amount),
            ("p_currency", json!("USDC")),
            ("p_transaction_hash", json!(hash)),
        ],
    )
}

fn bet(user: &str, amount: Value, key: Value, bet_id: &str, token: Value) -> Call {
    (
        "place_bet_locked",
        vec![
            ("p_user_address", json!(user)),
            ("p_bet_amount", amount),
            ("p_currency", json!("USDC")),
            ("p_idempotency_key", key),
            ("p_bet_id", json!(bet_id)),
            ("p_max_payout", json!(19.5)),
            ("p_end_time", json!("2026-01-01T00:00:00.000Z")),
            ("p_settlement_token", token),
        ],
    )
}

fn withdraw(user: &str, amount: Value, hash: &str) -> Call {
    (
        "update_balance_for_withdrawal",
        vec![
            ("p_user_address", json!(user)),
            ("p_withdrawal_amount", amount),
            ("p_currency", json!("USDC")),
            ("p_transaction_hash", json!(hash)),
        ],
    )
}

fn deduct(user: &str, amount: Value) -> Call {
    (
        "deduct_balance_for_bet",
        vec![
            ("p_user_address", json!(user)),
            ("p_bet_amount", amount),
            ("p_currency", json!("USDC")),
        ],
    )
}

fn credit(user: &str, amount: Value, bet_id: &str) -> Call {
    (
        "credit_balance_for_payout",
        vec![
            ("p_user_address", json!(user)),
            ("p_payout_amount", amount),
            ("p_currency", json!("USDC")),
            ("p_bet_id", json!(bet_id)),
        ],
    )
}

fn script() -> Vec<Call> {
    let token = json!("signed-token");
    vec![
        deposit(A, json!(0), "0xz1"),
        deposit(A, json!(-5), "0xz2"),
        deposit(A, Value::Null, "0xz3"),
        deposit(BANNED, json!(5), "0xz4"),
        deposit(&format!("  {BANNED} "), json!(5), "0xz5"),
        deposit(A, json!(100), "0xd1"),
        deposit(A, json!(100), "0xd1"),
        // Float noise from JS addition, the smallest fee, and sub-scale ties.
        deposit(A, json!(0.1 + 0.2), "0xd2"),
        deposit(A, json!("0.00000001"), "0xd3"),
        deposit(A, json!(1e-8), "0xd4"),
        deposit(A, json!("0.12345678905"), "0xd5"),
        deposit(A, json!("0.00000000005"), "0xd6"),
        deposit(A, json!("123456.7890123456"), "0xd7"),
        // Whole-number deposit answers a float, not an integer.
        deposit(B, json!(7), "0xd8"),
        deduct(A, json!(0)),
        deduct("0xnobody", json!(1)),
        deduct(B, json!(1000)),
        deduct(B, Value::Null),
        deduct(B, json!(0.1)),
        bet(A, json!(10), json!("r1"), "b1", token.clone()),
        bet(A, json!(10), json!("r1"), "b1-retry", token.clone()),
        bet(A, json!(10), Value::Null, "b2", token.clone()),
        bet(A, json!(0), json!("r3"), "b3", token.clone()),
        bet(A, json!(-1), json!("r3"), "b3", token.clone()),
        // Past the fixed-point limit the lock insert errors instead; see the
        // overflow test in crates/core/tests/sqlite_ledger.rs.
        bet(A, json!(9e8), json!("r3"), "b3", token.clone()),
        bet(A, json!(1.5), json!("r3"), "b3", token.clone()),
        bet(A, json!(1), json!("r-no-token"), "b4", Value::Null),
        bet(A, json!(1), json!("r-no-token"), "b4b", Value::Null),
        bet("0xnobody", json!(1), json!("r5"), "b5", token.clone()),
        bet(BANNED, json!(1), json!("r6"), "b6", token.clone()),
        withdraw(A, json!(0), "0xw0"),
        withdraw("0xnobody", json!(1), "0xw1"),
        withdraw(A, json!(1e9), "0xw2"),
        withdraw(A, json!("1.5"), "0xw3"),
        withdraw(A, json!(1), "0xw3"),
        withdraw(BANNED, json!(1), "0xw4"),
        credit(A, json!(0), "c0"),
        credit(A, json!(2.5), "c1"),
        credit("0xfresh", json!(3.25), "c2"),
        credit(BANNED, json!(1), "c3"),
        (
            "increment_referral_count",
            vec![("referrer_address", json!(A))],
        ),
        ("normalize_ban_address", vec![("p", json!("  0xABC "))]),
        ("normalize_ban_address", vec![("p", json!("0XABC"))]),
        ("normalize_ban_address", vec![("p", Value::Null)]),
        (
            "is_wallet_globally_banned",
            vec![("p_address", json!(BANNED))],
        ),
        ("is_wallet_globally_banned", vec![("p_address", json!(A))]),
        (
            "is_wallet_globally_banned",
            vec![("p_address", Value::Null)],
        ),
    ]
}

/// Frozen and banned accounts, run once between the two halves of the script.
const FREEZE: &str = "UPDATE user_balances SET status = 'frozen' WHERE user_address = '0xaaaa000000000000000000000000000000000001'";
const BAN: &str = "UPDATE user_balances SET status = 'banned' WHERE user_address = '0xbbbb000000000000000000000000000000000002'";

fn status_script() -> Vec<Call> {
    let token = json!("signed-token");
    vec![
        deduct(A, json!(1)),
        withdraw(A, json!(1), "0xw5"),
        bet(A, json!(1), json!("r7"), "b7", token.clone()),
        deduct(B, json!(1)),
        withdraw(B, json!(1), "0xw6"),
        bet(B, json!(1), json!("r8"), "b8", token),
        // A win still credits a frozen account, as the SQL did.
        credit(A, json!(1), "c4"),
    ]
}

async fn call_pg(
    pg: &mut PgConnection,
    name: &str,
    args: &[(&str, Value)],
) -> Result<Value, String> {
    let types = |param: &str| match param {
        "p_end_time" => "timestamp with time zone",
        p if p.contains("amount") || p == "p_max_payout" => "numeric",
        _ => "text",
    };
    let named: Vec<String> = args
        .iter()
        .enumerate()
        .map(|(i, (p, _))| format!("\"{p}\" => CAST(${} AS {})", i + 1, types(p)))
        .collect();
    // `to_json` keeps NUMERIC and text results in one decodable shape.
    let sql = format!("SELECT to_json({name}({}))::text", named.join(", "));
    let mut query = sqlx::query_scalar::<_, Option<String>>(&sql);
    for (_, value) in args {
        query = query.bind(strike_core::db::json_bind_text(value));
    }
    match query.fetch_one(pg).await {
        // RETURNS VOID prints as "" here; the server decoded it as NULL.
        Ok(text) => Ok(text
            .filter(|t| t != "\"\"")
            .map(|t| serde_json::from_str(&t).unwrap())
            .unwrap_or(Value::Null)),
        Err(e) => Err(e
            .as_database_error()
            .map(|d| d.message().to_string())
            .unwrap_or_else(|| e.to_string())),
    }
}

async fn run_script(pg: &mut PgConnection, db: &Db, calls: Vec<Call>) -> usize {
    let mut failures = 0;
    for (name, args) in calls {
        let refs: Vec<(&str, &Value)> = args.iter().map(|(p, v)| (*p, v)).collect();
        let expected = call_pg(pg, name, &args).await;
        let actual = db.call_rpc(name, &refs).await.map_err(|e| e.to_string());
        // Only the raised text is contractual; a NOT NULL failure outside the
        // EXCEPTION block is a plain 500 either way.
        let same = match (&expected, &actual) {
            (Err(a), Err(b)) if !a.starts_with("strike_") => {
                a.contains("null value") && b.contains("NOT NULL")
            }
            _ => expected == actual,
        };
        let line = format!(
            "{name}{:?}",
            args.iter().map(|(_, v)| v).collect::<Vec<_>>()
        );
        if same {
            println!("same  {line}");
        } else {
            failures += 1;
            println!("DIFF  {line}\n  postgres {expected:?}\n  sqlite   {actual:?}");
        }
    }
    failures
}

type LedgerRow = Vec<Option<String>>;

async fn pg_rows(pg: &mut PgConnection, sql: &str) -> Vec<LedgerRow> {
    use sqlx::Row;
    sqlx::query(sql)
        .fetch_all(pg)
        .await
        .unwrap()
        .iter()
        .map(|row| {
            (0..row.len())
                .map(|i| row.get::<Option<String>, _>(i))
                .collect()
        })
        .collect()
}

/// Reads rows as the same text Postgres prints for NUMERIC(30,10).
async fn sqlite_rows(
    db: &Db,
    sql: &'static str,
    money_columns: &'static [usize],
) -> Vec<LedgerRow> {
    db.read(move |c| {
        let mut stmt = c.prepare(sql)?;
        let count = stmt.column_count();
        let rows = stmt.query_map([], |row| {
            (0..count)
                .map(|i| {
                    Ok(match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => None,
                        rusqlite::types::ValueRef::Integer(v) if money_columns.contains(&i) => {
                            Some(from_fixed(v, 10).to_string())
                        }
                        rusqlite::types::ValueRef::Integer(v) => Some(v.to_string()),
                        rusqlite::types::ValueRef::Text(t) => {
                            Some(String::from_utf8_lossy(t).into_owned())
                        }
                        other => panic!("unexpected cell {other:?}"),
                    })
                })
                .collect()
        })?;
        Ok(rows.collect::<Result<Vec<LedgerRow>, _>>()?)
    })
    .await
    .unwrap()
}

#[tokio::main]
async fn main() {
    let url = std::env::var("PG_URL").expect("PG_URL");
    let mut pg = PgConnection::connect(&url).await.unwrap();

    let dir = std::env::temp_dir().join(format!("rpc-parity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("parity.sqlite"), 2, 8_000).unwrap();

    for statement in [
        "INSERT INTO user_referrals (user_address, referral_code) VALUES \
         ('0xaaaa000000000000000000000000000000000001', 'CODE')",
    ] {
        sqlx::query(statement).execute(&mut pg).await.unwrap();
        db.write(move |c| {
            c.execute(statement, [])?;
            Ok(())
        })
        .await
        .unwrap();
    }

    let mut failures = run_script(&mut pg, &db, script()).await;
    for statement in [FREEZE, BAN] {
        sqlx::query(statement).execute(&mut pg).await.unwrap();
        db.write(move |c| {
            c.execute(statement, [])?;
            Ok(())
        })
        .await
        .unwrap();
    }
    failures += run_script(&mut pg, &db, status_script()).await;

    let audit_pg = pg_rows(
        &mut pg,
        "SELECT user_address, currency, operation_type, amount::text, balance_before::text, \
                balance_after::text, transaction_hash, bet_id, idempotency_key, settlement_token, \
                max_payout::text, (consumed_at IS NOT NULL)::text \
         FROM balance_audit_log ORDER BY id",
    )
    .await;
    let audit_sqlite = sqlite_rows(
        &db,
        "SELECT user_address, currency, operation_type, amount, balance_before, balance_after, \
                transaction_hash, bet_id, idempotency_key, settlement_token, max_payout, \
                CASE WHEN consumed_at IS NOT NULL THEN 'true' ELSE 'false' END \
         FROM balance_audit_log ORDER BY id",
        &[3, 4, 5, 10],
    )
    .await;
    if audit_pg != audit_sqlite {
        failures += 1;
        println!(
            "DIFF  balance_audit_log ({} vs {} rows)",
            audit_pg.len(),
            audit_sqlite.len()
        );
        for (a, b) in audit_pg.iter().zip(&audit_sqlite) {
            if a != b {
                println!("  postgres {a:?}\n  sqlite   {b:?}");
            }
        }
    }

    let balances_pg = pg_rows(
        &mut pg,
        "SELECT user_address, currency, balance::text, status FROM user_balances ORDER BY 1, 2",
    )
    .await;
    let balances_sqlite = sqlite_rows(
        &db,
        "SELECT user_address, currency, balance, status FROM user_balances ORDER BY 1, 2",
        &[2],
    )
    .await;
    if balances_pg != balances_sqlite {
        failures += 1;
        println!("DIFF  user_balances\n  postgres {balances_pg:?}\n  sqlite   {balances_sqlite:?}");
    }

    println!(
        "{} audit rows, {} balances compared; {failures} differences",
        audit_pg.len(),
        balances_pg.len()
    );
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
    std::process::exit((failures > 0) as i32);
}
