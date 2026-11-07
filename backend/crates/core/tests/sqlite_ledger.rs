use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use rusqlite::params;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use strike_core::blitz;
use strike_core::db::Db;
use strike_core::error::{ApiError, ApiResult};
use strike_core::money::{to_fixed, MONEY_SCALE};
use strike_core::withdrawals::{
    claim_and_debit, expire_pending, finalize, park, queue, refund, stuck, Claim, QueueRequest,
    Queued,
};

const USER: &str = "0xaaaa000000000000000000000000000000000001";
const USDC: &str = "USDC";

struct TempDb {
    dir: PathBuf,
    db: Arc<Db>,
}

impl TempDb {
    fn new() -> Self {
        std::env::set_var("STRIKE_DEV_NO_WORLD", "1");
        std::env::set_var("WORLD_ORB_OPEN_CAP", "1000000");
        std::env::set_var("WORLD_ORB_DAILY_LOSS", "1000000");
        let dir = std::env::temp_dir().join(format!("strike-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Arc::new(Db::open(dir.join("test.sqlite"), 4, 8_000).unwrap());
        Self { dir, db }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("test.sqlite")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn s(text: &str) -> Value {
    Value::String(text.to_string())
}

async fn deposit(db: &Db, user: &str, amount: &str, hash: &str) -> Value {
    db.call_rpc(
        "update_balance_for_deposit",
        &[
            ("p_user_address", &s(user)),
            ("p_deposit_amount", &s(amount)),
            ("p_currency", &s(USDC)),
            ("p_transaction_hash", &s(hash)),
        ],
    )
    .await
    .unwrap()
}

async fn place_bet(db: &Db, user: &str, amount: &str, key: &str, bet_id: &str) -> Value {
    db.call_rpc(
        "place_bet_locked",
        &[
            ("p_user_address", &s(user)),
            ("p_bet_amount", &s(amount)),
            ("p_currency", &s(USDC)),
            ("p_idempotency_key", &s(key)),
            ("p_bet_id", &s(bet_id)),
            ("p_max_payout", &s("19")),
            ("p_end_time", &s("2026-01-01T00:00:00.000Z")),
            ("p_settlement_token", &s("token")),
            (
                "p_round",
                &json!({
                    "asset": "BTC", "mode": "binomo", "direction": "UP", "multiplier": 19_000,
                    "strike_price": PRICE_100, "strike_at_us": 1, "strike_source": "binance",
                    "price_top": null, "price_bottom": null,
                }),
            ),
        ],
    )
    .await
    .unwrap()
}

const PRICE_100: i64 = 10_000_000_000;

async fn settle_at(db: &Db, bet_id: &str, end_price: Option<i64>) -> Result<Value, ApiError> {
    db.call_rpc(
        "settle_round",
        &[
            ("p_bet_id", &s(bet_id)),
            ("p_end_price", &json!(end_price)),
            ("p_end_at", &json!(end_price.map(|_| 2))),
            ("p_source", &json!(end_price.map(|_| "binance"))),
            ("p_settled_by", &s("claim")),
        ],
    )
    .await
}

async fn settle(db: &Db, bet_id: &str) -> Result<Value, ApiError> {
    settle_at(db, bet_id, Some(PRICE_100 + 1)).await
}

async fn stored_round(db: &Db, bet_id: &str) -> (Option<String>, i64, Option<i64>, Option<String>) {
    let id = bet_id.to_string();
    db.read(move |c| {
        Ok(c.query_row(
            "SELECT outcome, payout, end_price, end_source FROM bet_rounds WHERE bet_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    })
    .await
    .unwrap()
}

async fn withdraw(db: &Db, amount: &str, hash: &str) -> Value {
    db.call_rpc(
        "update_balance_for_withdrawal",
        &[
            ("p_user_address", &s(USER)),
            ("p_withdrawal_amount", &s(amount)),
            ("p_currency", &s(USDC)),
            ("p_transaction_hash", &s(hash)),
        ],
    )
    .await
    .unwrap()
}

async fn balance(db: &Db, user: &str) -> i64 {
    let user = user.to_string();
    db.read(move |c| {
        Ok(c.query_row(
            "SELECT balance FROM user_balances WHERE user_address = ?1 AND currency = 'USDC'",
            params![user],
            |r| r.get(0),
        )?)
    })
    .await
    .unwrap()
}

async fn audit_count(db: &Db, operation: &str) -> i64 {
    let operation = operation.to_string();
    db.read(move |c| {
        Ok(c.query_row(
            "SELECT count(*) FROM balance_audit_log WHERE operation_type = ?1",
            params![operation],
            |r| r.get(0),
        )?)
    })
    .await
    .unwrap()
}

async fn assert_reconciles(db: &Db, user: &str) {
    let owner = user.to_string();
    let (ledger, last_after, chained) = db
        .read(move |c| {
            let mut stmt = c.prepare(
                "SELECT operation_type, amount, balance_before, balance_after \
                 FROM balance_audit_log \
                 WHERE user_address = ?1 AND currency = 'USDC' \
                   AND operation_type IN ('deposit', 'withdrawal', 'bet_placed', 'payout', 'refund') \
                 ORDER BY id",
            )?;
            let rows: Vec<(String, i64, i64, i64)> = stmt
                .query_map(params![owner], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<_, _>>()?;
            let mut sum: i128 = 0;
            let mut chained = true;
            let mut previous = 0;
            for (op, amount, before, after) in rows {
                let delta = match op.as_str() {
                    "deposit" | "payout" | "refund" => i128::from(amount),
                    _ => -i128::from(amount),
                };
                sum += delta;
                chained &= before == previous && i128::from(after) == i128::from(before) + delta;
                previous = after;
            }
            Ok((sum, previous, chained))
        })
        .await
        .unwrap();
    let stored = balance(db, user).await;
    assert_eq!(ledger, i128::from(stored), "audit sum vs balance");
    assert_eq!(last_after, stored, "last audit row vs balance");
    assert!(chained, "audit rows must chain before -> after");
}

fn units(whole: i64) -> i64 {
    whole * 10_000_000_000
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_identical_bets_debit_once() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;

    let mut tasks = Vec::new();
    for i in 0..64 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            place_bet(&db, USER, "10", "request-1", &format!("bet-{i}")).await
        }));
    }
    let mut firsts = 0;
    let mut bet_ids = std::collections::HashSet::new();
    for task in tasks {
        let result = task.await.unwrap();
        assert_eq!(result["success"], json!(true), "{result}");
        if result["duplicate"] == json!(false) {
            firsts += 1;
        }
        bet_ids.insert(result["bet_id"].as_str().unwrap().to_string());
    }
    assert_eq!(firsts, 1, "exactly one attempt deducts");
    assert_eq!(bet_ids.len(), 1, "duplicates replay the original bet id");
    assert_eq!(balance(&t.db, USER).await, units(90));
    assert_eq!(audit_count(&t.db, "bet_placed").await, 1);
    assert_eq!(audit_count(&t.db, "bet_lock").await, 1);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_bets_cannot_overdraw() {
    let t = TempDb::new();
    deposit(&t.db, USER, "10", "0xdep1").await;

    let mut tasks = Vec::new();
    for i in 0..64 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            place_bet(&db, USER, "3", &format!("r{i}"), &format!("b{i}")).await
        }));
    }
    let mut won = 0;
    for task in tasks {
        let result = task.await.unwrap();
        if result["success"] == json!(true) {
            won += 1;
        } else {
            assert_eq!(result["error"], json!("Insufficient balance"));
            assert_eq!(result["duplicate"], json!(false));
        }
    }
    assert_eq!(won, 3);
    assert_eq!(balance(&t.db, USER).await, units(1));
    assert_eq!(audit_count(&t.db, "bet_lock").await, 3);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_settlement_pays_once() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;

    let mut tasks = Vec::new();
    for _ in 0..64 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(
            async move { settle(&db, "bet-1").await.unwrap() },
        ));
    }
    let mut paid = 0;
    for task in tasks {
        let result = task.await.unwrap();
        assert_eq!(result["outcome"], json!("win"));
        if result["duplicate"] == json!(false) {
            paid += 1;
        }
    }
    assert_eq!(paid, 1);
    assert_eq!(balance(&t.db, USER).await, units(109));
    assert_eq!(audit_count(&t.db, "payout").await, 1);
    assert_eq!(audit_count(&t.db, "payout_lock").await, 1);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn deposit_replay_credits_once() {
    let t = TempDb::new();
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            deposit(&db, USER, "25", "0xsame").await
        }));
    }
    let mut credited = 0;
    for task in tasks {
        let result = task.await.unwrap();
        if result["success"] == json!(true) {
            credited += 1;
        } else {
            assert_eq!(
                result["error"],
                json!(
                    "duplicate key value violates unique constraint \
                     \"idx_balance_audit_tx_hash_unique\""
                )
            );
            assert!(strike_core::ledger::is_audit_duplicate(
                result["error"].as_str().unwrap()
            ));
            assert_eq!(result["new_balance"], json!(0));
        }
    }
    assert_eq!(credited, 1);
    assert_eq!(balance(&t.db, USER).await, units(25));
    assert_eq!(audit_count(&t.db, "deposit").await, 1);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_withdrawals_cannot_exceed_balance() {
    let t = TempDb::new();
    deposit(&t.db, USER, "10", "0xdep1").await;

    let mut tasks = Vec::new();
    for i in 0..48 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            withdraw(&db, "4", &format!("0xw{i}")).await
        }));
    }
    let mut paid = 0;
    for task in tasks {
        let result = task.await.unwrap();
        if result["success"] == json!(true) {
            paid += 1;
        } else {
            assert_eq!(result["error"], json!("Insufficient balance"));
        }
    }
    assert_eq!(paid, 2);
    assert_eq!(balance(&t.db, USER).await, units(2));
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_settlements_roll_everything_back() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;
    let before = balance(&t.db, USER).await;

    let err = settle(&t.db, "no-such-bet").await.unwrap_err();
    assert_eq!(err.to_string(), "strike_unknown_bet:no-such-bet");
    assert_eq!(audit_count(&t.db, "payout_lock").await, 0);

    let id = "bet-open".to_string();
    t.db.write(move |c| {
        c.execute(
            "INSERT INTO bet_rounds (bet_id, user_address, currency, asset, mode, direction, \
             stake, multiplier, strike_price, strike_at, strike_source, end_time) \
             VALUES (?1, ?2, 'USDC', 'BTC', 'binomo', 'UP', 1, 19000, 1, 1, 'binance', ?3)",
            params![id, USER, i64::MAX],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let err = settle(&t.db, "bet-open").await.unwrap_err();
    assert_eq!(err.to_string(), "strike_round_open");
    assert_eq!(balance(&t.db, USER).await, before);
    assert_eq!(audit_count(&t.db, "payout_lock").await, 0);

    let paid = settle(&t.db, "bet-1").await.unwrap();
    assert_eq!(paid["success"], json!(true));
    assert_eq!(paid["bet_id"], json!("bet-1"));
    assert_eq!(balance(&t.db, USER).await, before + units(19));
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_loss_pays_nothing_and_is_final() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;

    let lost = settle_at(&t.db, "bet-1", Some(PRICE_100 - 1))
        .await
        .unwrap();
    assert_eq!(
        (&lost["outcome"], &lost["payout"]),
        (&json!("loss"), &json!(0.0))
    );
    assert_eq!(balance(&t.db, USER).await, units(90));
    assert_eq!(audit_count(&t.db, "payout").await, 0);

    let again = settle(&t.db, "bet-1").await.unwrap();
    assert_eq!(again["duplicate"], json!(true));
    assert_eq!(again["outcome"], json!("loss"));
    assert_eq!(balance(&t.db, USER).await, units(90));
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_price_at_the_end_refunds_the_stake_and_says_so() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;

    let refunded = settle_at(&t.db, "bet-1", None).await.unwrap();
    assert_eq!(refunded["outcome"], json!("refund_no_price"));
    assert_eq!(balance(&t.db, USER).await, units(100));
    assert_eq!(audit_count(&t.db, "refund").await, 1);
    assert_eq!(audit_count(&t.db, "payout").await, 0);
    assert_eq!(
        stored_round(&t.db, "bet-1").await,
        (Some("refund_no_price".to_string()), units(10), None, None)
    );
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_banned_wallet_is_withheld_once_not_retried_forever() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;
    let banned = s(USER);
    t.db.write(move |c| {
        c.execute(
            "INSERT INTO banned_wallets (wallet_address) VALUES (?1)",
            params![banned.as_str()],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let result = settle(&t.db, "bet-1").await.unwrap();
    assert_eq!(result["outcome"], json!("withheld"));
    assert_eq!(balance(&t.db, USER).await, units(90));
    assert_eq!(audit_count(&t.db, "payout").await, 0);
    let (outcome, payout, price, source) = stored_round(&t.db, "bet-1").await;
    assert_eq!(outcome.as_deref(), Some("withheld"));
    assert_eq!(payout, 0);
    assert_eq!(
        (price, source.as_deref()),
        (Some(PRICE_100 + 1), Some("binance"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settled_round_cannot_be_rewritten_and_no_round_can_be_deleted() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;
    settle(&t.db, "bet-1").await.unwrap();

    for statement in [
        "UPDATE bet_rounds SET payout = 1000 WHERE bet_id = 'bet-1'",
        "DELETE FROM bet_rounds WHERE bet_id = 'bet-1'",
    ] {
        let err =
            t.db.write(move |c| {
                c.execute(statement, [])?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("permanent"), "{err}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_debit_and_the_round_commit_together() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    place_bet(&t.db, USER, "10", "r1", "bet-1").await;

    let clash =
        t.db.call_rpc(
            "place_bet_locked",
            &[
                ("p_user_address", &s(USER)),
                ("p_bet_amount", &s("10")),
                ("p_currency", &s(USDC)),
                ("p_idempotency_key", &s("r2")),
                ("p_bet_id", &s("bet-1")),
                ("p_max_payout", &s("19")),
                ("p_end_time", &s("2026-01-01T00:00:00.000Z")),
                ("p_settlement_token", &s("token")),
                (
                    "p_round",
                    &json!({
                        "asset": "BTC", "mode": "binomo", "direction": "UP", "multiplier": 19_000,
                        "strike_price": PRICE_100, "strike_at_us": 1, "strike_source": "binance",
                        "price_top": null, "price_bottom": null,
                    }),
                ),
            ],
        )
        .await;
    assert!(clash.is_err(), "{clash:?}");
    assert_eq!(balance(&t.db, USER).await, units(90));
    assert_eq!(audit_count(&t.db, "bet_lock").await, 1);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panic_mid_transaction_rolls_back_and_the_writer_lives_on() {
    let t = TempDb::new();
    deposit(&t.db, USER, "50", "0xdep1").await;

    let result =
        t.db.write(|c| -> Result<(), ApiError> {
            let tx = c.savepoint()?;
            tx.execute("UPDATE user_balances SET balance = 0", [])?;
            panic!("simulated bug mid-transaction");
        })
        .await;
    assert!(result.is_err());
    assert_eq!(balance(&t.db, USER).await, units(50));

    let result =
        t.db.write(|c| -> Result<(), ApiError> {
            let tx = c.savepoint()?;
            tx.execute("UPDATE user_balances SET balance = 0", [])?;
            Err(ApiError::Other("simulated failure".to_string()))
        })
        .await;
    assert!(result.is_err());
    assert_eq!(balance(&t.db, USER).await, units(50));

    deposit(&t.db, USER, "1", "0xdep2").await;
    assert_eq!(balance(&t.db, USER).await, units(51));
}

#[test]
fn crash_child() {
    let Ok(path) = std::env::var("STRIKE_CRASH_DB") else {
        return;
    };
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.pragma_update(None, "synchronous", "FULL").unwrap();
    conn.execute_batch(
        "BEGIN IMMEDIATE;
         UPDATE user_balances SET balance = 7;
         COMMIT;
         BEGIN IMMEDIATE;
         UPDATE user_balances SET balance = 0;
         INSERT INTO balance_audit_log (user_address, operation_type, amount)
           VALUES ('ghost', 'deposit', 1);",
    )
    .unwrap();
    std::process::abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_killed_process_keeps_commits_and_loses_only_the_open_transaction() {
    let t = TempDb::new();
    deposit(&t.db, USER, "50", "0xdep1").await;

    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["crash_child", "--exact", "--nocapture"])
        .env("STRIKE_CRASH_DB", t.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success(), "the child must die abnormally");

    assert_eq!(balance(&t.db, USER).await, 7, "committed write survives");
    let ghosts: i64 =
        t.db.read(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM balance_audit_log WHERE user_address = 'ghost'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(ghosts, 0, "the open transaction is gone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_mixed_load_reconciles_to_the_last_fixed_point_unit() {
    let t = TempDb::new();
    deposit(&t.db, USER, "1000", "0xdep1").await;

    let mut tasks = Vec::new();
    for i in 0..200 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            match i % 4 {
                0 => {
                    deposit(&db, USER, "0.00000001", &format!("0xfee{i}")).await;
                }
                1 => {
                    place_bet(&db, USER, "1.23456789", &format!("r{i}"), &format!("b{i}")).await;
                    settle(&db, &format!("b{i}")).await.unwrap();
                }
                2 => {
                    withdraw(&db, "0.1", &format!("0xw{i}")).await;
                }
                _ => {
                    place_bet(&db, USER, "0.3", &format!("r{i}"), &format!("b{i}")).await;
                }
            }
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }

    let fixed = |text: &str| to_fixed(text.parse::<Decimal>().unwrap(), MONEY_SCALE).unwrap();
    let expected =
        units(1000) + 50 * fixed("0.00000001") + 50 * (fixed("2.34567899") - fixed("1.23456789"))
            - 50 * fixed("0.1")
            - 50 * fixed("0.3");
    assert_eq!(balance(&t.db, USER).await, expected);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test]
async fn return_shapes_and_refusals_match_the_sql_functions() {
    let t = TempDb::new();
    let db = &t.db;

    assert_eq!(
        deposit(db, USER, "0", "0xz").await,
        json!({"success": false, "error": "Deposit amount must be greater than zero", "new_balance": 0})
    );
    let first = deposit(db, USER, "1.5", "0xd1").await;
    assert_eq!(
        first,
        json!({"success": true, "error": null, "new_balance": 1.5})
    );
    assert_eq!(
        serde_json::to_string(&first).unwrap(),
        r#"{"success":true,"error":null,"new_balance":1.5}"#,
        "key order is part of the shape"
    );

    let refusal = db
        .call_rpc(
            "deduct_balance_for_bet",
            &[
                ("p_user_address", &s("0xnobody")),
                ("p_bet_amount", &s("1")),
                ("p_currency", &s(USDC)),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        refusal,
        json!({"success": false, "error": "User not found", "new_balance": 0})
    );

    let user = USER.to_string();
    db.write(move |c| {
        c.execute(
            "UPDATE user_balances SET status = 'frozen' WHERE user_address = ?1",
            params![user],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        withdraw(db, "1", "0xw").await,
        json!({"success": false, "error": "Account is frozen. Withdrawals are disabled.", "new_balance": 1.5})
    );
    let bet = place_bet(db, USER, "1", "r9", "b9").await;
    assert_eq!(
        bet,
        json!({
            "success": false,
            "duplicate": false,
            "error": "Account is frozen. Please contact support.",
            "new_balance": 1.5
        })
    );
    assert_eq!(audit_count(db, "bet_lock").await, 0, "lock voided");

    let missing = db
        .call_rpc(
            "place_bet_locked",
            &[
                ("p_user_address", &s(USER)),
                ("p_bet_amount", &s("1")),
                ("p_currency", &s(USDC)),
                ("p_idempotency_key", &Value::Null),
                ("p_bet_id", &s("b")),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        missing["error"],
        json!("Bet placement requires an idempotency key")
    );

    let other = "0xbbbb000000000000000000000000000000000002";
    deposit(db, other, "5", "0xd2").await;
    let no_token = db
        .call_rpc(
            "place_bet_locked",
            &[
                ("p_user_address", &s(other)),
                ("p_bet_amount", &s("1")),
                ("p_currency", &s(USDC)),
                ("p_idempotency_key", &s("r-no-token")),
                ("p_bet_id", &s("b-no-token")),
            ],
        )
        .await
        .unwrap();
    assert_eq!(no_token["max_payout"], json!(0), "DEFAULT 0");
    let replay = place_bet(db, other, "1", "r-no-token", "b-other").await;
    assert_eq!(
        replay,
        json!({
            "success": false,
            "duplicate": true,
            "error": "Bet already processed",
            "bet_id": "b-no-token",
            "settlement_token": null,
            "new_balance": 4.0,
            "max_payout": 0.0,
            "user_address": other,
            "currency": USDC
        })
    );

    assert_eq!(
        db.call_rpc("normalize_ban_address", &[("p", &s("  0xABC "))])
            .await
            .unwrap(),
        json!("0xabc")
    );
    let seeded = s(" Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4 ");
    assert_eq!(
        db.call_rpc("is_wallet_globally_banned", &[("p_address", &seeded)])
            .await
            .unwrap(),
        json!(true)
    );
}

#[tokio::test]
async fn overflow_is_refused_and_changes_nothing() {
    let t = TempDb::new();
    deposit(&t.db, USER, "922337203", "0xd1").await;

    let refused = deposit(&t.db, USER, "1", "0xd2").await;
    assert_eq!(
        refused,
        json!({"success": false, "error": "numeric field overflow", "new_balance": 0})
    );
    assert_eq!(balance(&t.db, USER).await, units(922_337_203));
    assert_eq!(audit_count(&t.db, "deposit").await, 1);

    let err =
        t.db.call_rpc(
            "update_balance_for_deposit",
            &[
                ("p_user_address", &s(USER)),
                ("p_deposit_amount", &s("NaN")),
            ],
        )
        .await;
    assert!(err.is_err());
}

#[tokio::test]
async fn sub_scale_amounts_round_only_at_the_column() {
    let t = TempDb::new();
    deposit(&t.db, USER, "1", "0xd1").await;
    let bet = place_bet(&t.db, USER, "1.00000000004", "r1", "b1").await;
    assert_eq!(bet["error"], json!("Insufficient balance"));
    assert_eq!(balance(&t.db, USER).await, units(1));

    let credited = deposit(&t.db, USER, "0.12345678905", "0xd2").await;
    assert_eq!(credited["new_balance"], json!(1.12345678905));
    assert_eq!(balance(&t.db, USER).await, 11_234_567_891);
}

#[tokio::test]
async fn statements_read_and_write_like_postgres() {
    let t = TempDb::new();
    let db = &t.db;

    let (rows, changed) = db
        .run(
            "INSERT INTO user_sessions (wallet_address) VALUES (CAST($1 AS text)) RETURNING id, network, started_at",
            vec![rusqlite::types::Value::Text("0xW".into())],
        )
        .await
        .unwrap();
    assert_eq!(changed, 1);
    let row = rows[0].as_object().unwrap();
    assert_eq!(row["network"], json!("BNB"));
    assert!(uuid::Uuid::parse_str(row["id"].as_str().unwrap()).is_ok());
    let created = row["started_at"].as_str().unwrap();
    assert!(created.ends_with('Z') && created.len() == 24, "{created}");

    let v = |text: &str| rusqlite::types::Value::Text(text.to_string());
    for (id, resolved) in [("a", "1"), ("b", "2")] {
        db.run(
            "INSERT INTO bet_history (id, wallet_address, resolved_at) VALUES (?1, ?2, ?3)",
            vec![
                v(id),
                v("0xW"),
                rusqlite::types::Value::Integer(resolved.parse().unwrap()),
            ],
        )
        .await
        .unwrap();
    }
    db.run(
        "INSERT INTO bet_history (id, wallet_address) VALUES (?1, ?2)",
        vec![v("c"), v("0xw")],
    )
    .await
    .unwrap();

    let (rows, _) = db
        .run("SELECT * FROM bet_history WHERE id = ?1", vec![v("c")])
        .await
        .unwrap();
    assert_eq!(rows[0]["multiplier"].to_string(), "1.9");
    assert_eq!(rows[0]["amount"].to_string(), "0.0");
    assert_eq!(rows[0]["won"], json!(false));
    assert_eq!(rows[0]["resolved_at"], Value::Null);
    let keys: Vec<&String> = rows[0].as_object().unwrap().keys().collect();
    assert_eq!(keys[..3], ["id", "wallet_address", "asset"]);

    let (rows, _) = db
        .run(
            "SELECT id FROM bet_history ORDER BY resolved_at DESC NULLS FIRST",
            vec![],
        )
        .await
        .unwrap();
    let order: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(order, ["c", "b", "a"]);

    let count =
        |sql: &'static str| async move { db.run(sql, vec![v("0xw")]).await.unwrap().0.len() };
    assert_eq!(
        count("SELECT id FROM bet_history WHERE pg_ilike(wallet_address, ?1)").await,
        3
    );
    assert_eq!(
        count("SELECT id FROM bet_history WHERE pg_like(wallet_address, ?1)").await,
        1
    );

    assert!(db
        .run("SELECT \"nope\" FROM bet_history", vec![])
        .await
        .is_err());
    let float = db
        .run(
            "UPDATE bet_history SET amount = ?1 WHERE id = ?2",
            vec![rusqlite::types::Value::Real(1.5), v("a")],
        )
        .await;
    assert!(float.is_err());
    let misrouted = db
        .read(|c| {
            c.execute("DELETE FROM bet_history", [])?;
            Ok(())
        })
        .await;
    assert!(misrouted.is_err());
    let negative = db
        .write(|c| {
            c.execute(
                "INSERT INTO user_balances (user_address, currency, balance) VALUES ('x', 'USDC', -1)",
                [],
            )?;
            Ok(())
        })
        .await;
    assert!(matches!(negative, Err(ApiError::Db(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn the_deposit_lock_is_claimed_once() {
    let t = TempDb::new();
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            let (hash, user, currency, amount) = (s("0xraw"), s(USER), s(USDC), json!(9.9));
            db.fetch(
                "INSERT INTO deposit_locks (\"transaction_hash\", \"user_address\", \"currency\", \"amount\") \
                 VALUES (CAST($1 AS text), CAST($2 AS text), CAST($3 AS text), CAST($4 AS numeric(30,10)))",
                &[
                    ("text", &hash),
                    ("text", &user),
                    ("text", &currency),
                    ("numeric(30,10)", &amount),
                ],
            )
            .await
        }));
    }
    let mut claimed = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => claimed += 1,
            Err(ApiError::Db(err)) => {
                assert!(strike_core::db::is_unique_violation(&err), "{err}");
                assert_eq!(
                    strike_core::db::pg_error_code(&err).as_deref(),
                    Some("23505")
                );
            }
            Err(other) => panic!("{other}"),
        }
    }
    assert_eq!(claimed, 1);
}

fn queue_request(amount: f64, signed_at: i64, signature: &str) -> QueueRequest {
    QueueRequest {
        user_key: USER.to_string(),
        variants: vec![USER.to_string()],
        ledger_address: USER.to_string(),
        currency: USDC.to_string(),
        amount: json!(amount),
        amount_num: amount,
        signature: json!(signature),
        signed_at: json!(signed_at),
        frequency_exempt: true,
    }
}

async fn request_count(db: &Db, status: &str) -> i64 {
    let status = status.to_string();
    db.read(move |c| {
        Ok(c.query_row(
            "SELECT count(*) FROM withdrawal_requests WHERE status = ?1",
            params![status],
            |r| r.get(0),
        )?)
    })
    .await
    .unwrap()
}

async fn seed_requests(db: &Db, count: i64, amount: i64) {
    db.write(move |c| {
        for i in 0..count {
            c.execute(
                "INSERT INTO withdrawal_requests (user_address, currency, amount, net_amount, signed_at) \
                 VALUES (?1, 'USDC', ?2, ?2, ?3)",
                params![USER, amount, i + 1],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
}

async fn accept(db: Arc<Db>, id: i64, amount: &str, paid: Arc<AtomicI64>, fail: bool) -> Claim {
    let claim = claim_and_debit(&db, id, json!(USER), amount.to_string(), USDC.to_string())
        .await
        .unwrap();
    if matches!(claim, Claim::Debited { .. }) {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        if fail {
            assert!(park(&db, id, "NEEDS_RECONCILIATION:transfer".into(), None)
                .await
                .unwrap());
        } else {
            paid.fetch_add(1, Ordering::SeqCst);
            assert!(finalize(&db, id, format!("0xpaid{id}"), None)
                .await
                .unwrap());
        }
    }
    claim
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_withdraw_requests_cannot_pass_the_cap() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;

    let mut tasks = Vec::new();
    for i in 0..32 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            queue(&db, queue_request(40.0, 1000 + i, &format!("0xsig{i}"))).await
        }));
    }
    let mut created = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(Queued::Created { .. }) => created += 1,
            Ok(Queued::Replay(row)) => panic!("distinct intents replayed: {row}"),
            Err((status, _)) => assert_eq!(status, 400),
        }
    }
    assert_eq!(created, 2);
    assert_eq!(request_count(&t.db, "pending").await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_replayed_intent_queues_one_row() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;

    let mut tasks = Vec::new();
    for i in 0..32 {
        let db = t.db.clone();
        tasks.push(tokio::spawn(async move {
            let signature = if i % 2 == 0 { "0xabc1b" } else { "0xABC00" };
            queue(&db, queue_request(10.0, 777, signature)).await
        }));
    }
    let (mut created, mut replayed) = (0, 0);
    for task in tasks {
        match task.await.unwrap().unwrap() {
            Queued::Created { .. } => created += 1,
            Queued::Replay(row) => {
                assert_eq!(row["status"], json!("pending"));
                replayed += 1;
            }
        }
    }
    assert_eq!((created, replayed), (1, 31));
    assert_eq!(request_count(&t.db, "pending").await, 1);

    let dup = t
        .db
        .write(|c| {
            c.execute(
                "INSERT INTO withdrawal_requests (user_address, currency, amount, net_amount, signed_at) \
                 VALUES (?1, 'USDC', 1, 1, 777)",
                params![USER],
            )?;
            Ok(())
        })
        .await;
    assert!(matches!(dup, Err(ApiError::Db(ref e)) if strike_core::db::is_unique_violation(e)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_accepts_pay_only_what_was_debited() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 8, units(40)).await;

    let paid = Arc::new(AtomicI64::new(0));
    let mut tasks = Vec::new();
    for round in 0..32 {
        let (db, paid) = (t.db.clone(), paid.clone());
        let id = round % 8 + 1;
        tasks.push(tokio::spawn(accept(db, id, "40", paid, false)));
    }
    let mut debited = 0;
    for task in tasks {
        match task.await.unwrap() {
            Claim::Debited { .. } => debited += 1,
            Claim::NotPending => {}
            Claim::Refused(reason) => assert_eq!(reason, "Insufficient balance"),
        }
    }
    assert_eq!(debited, 2, "100 covers two payouts of 40");
    assert_eq!(
        paid.load(Ordering::SeqCst),
        2,
        "no transfer without a debit"
    );
    assert_eq!(balance(&t.db, USER).await, units(20));
    assert_eq!(audit_count(&t.db, "withdrawal").await, 2);
    assert_eq!(request_count(&t.db, "pending").await, 6);
    assert_eq!(request_count(&t.db, "accepted").await, 2);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn one_request_accepted_in_parallel_debits_and_pays_once() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 1, units(10)).await;

    let paid = Arc::new(AtomicI64::new(0));
    let mut tasks = Vec::new();
    for _ in 0..32 {
        tasks.push(tokio::spawn(accept(
            t.db.clone(),
            1,
            "10",
            paid.clone(),
            false,
        )));
    }
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(paid.load(Ordering::SeqCst), 1);
    assert_eq!(balance(&t.db, USER).await, units(90));
    assert_reconciles(&t.db, USER).await;
    assert_eq!(audit_hash(&t.db).await, "0xpaid1");
}

async fn audit_hash(db: &Db) -> String {
    db.read(|c| {
        Ok(c.query_row(
            "SELECT transaction_hash FROM balance_audit_log WHERE operation_type = 'withdrawal'",
            [],
            |r| r.get(0),
        )?)
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_transfer_parks_keeps_the_debit_and_cannot_pay_again() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 1, units(30)).await;

    let paid = Arc::new(AtomicI64::new(0));
    let first = accept(t.db.clone(), 1, "30", paid.clone(), true).await;
    assert!(matches!(first, Claim::Debited { .. }));

    assert_eq!(request_count(&t.db, "paid_needs_reconciliation").await, 1);
    assert_eq!(
        balance(&t.db, USER).await,
        units(70),
        "never silently re-credited"
    );
    assert_eq!(
        audit_hash(&t.db).await,
        "withdrawal:1",
        "the debit stays traceable"
    );
    assert_reconciles(&t.db, USER).await;

    let retry = accept(t.db.clone(), 1, "30", paid.clone(), false).await;
    assert_eq!(retry, Claim::NotPending);
    assert_eq!(paid.load(Ordering::SeqCst), 0);
    assert_eq!(balance(&t.db, USER).await, units(70));
    assert!(!finalize(&t.db, 1, "0xlate".into(), None).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_parked_transfer_keeps_its_tx_hash_for_the_operator() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 1, units(30)).await;
    let claim = claim_and_debit(&t.db, 1, json!(USER), "30".into(), USDC.to_string());
    assert!(matches!(claim.await.unwrap(), Claim::Debited { .. }));

    assert!(park(&t.db, 1, "timeout".into(), Some("0xsent".into()))
        .await
        .unwrap());

    let hash: Option<String> =
        t.db.read(|c| {
            Ok(c.query_row(
                "SELECT tx_hash FROM withdrawal_requests WHERE id = 1",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(hash.as_deref(), Some("0xsent"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_broadcast_is_refunded_once_and_the_ledger_reconciles() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 1, units(30)).await;
    let claim = claim_and_debit(&t.db, 1, json!(USER), "30".into(), USDC.to_string());
    assert!(matches!(claim.await.unwrap(), Claim::Debited { .. }));
    assert_eq!(balance(&t.db, USER).await, units(70));

    let undo = || refund(&t.db, 1, json!(USER), "30".into(), USDC.to_string());
    assert!(undo().await.unwrap());
    assert!(!undo().await.unwrap(), "a second refund is a no-op");

    assert_eq!(balance(&t.db, USER).await, units(100));
    assert_eq!(request_count(&t.db, "rejected").await, 1);
    assert_reconciles(&t.db, USER).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_pending_requests_are_rejected_and_nothing_else() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 2, units(10)).await;
    let claim = claim_and_debit(&t.db, 2, json!(USER), "10".into(), USDC.to_string());
    assert!(matches!(claim.await.unwrap(), Claim::Debited { .. }));
    let later = strike_core::db::now_us() + 1_000_000;

    assert!(expire_pending(&t.db, 0).await.unwrap().is_empty());
    assert_eq!(expire_pending(&t.db, later).await.unwrap(), vec![1]);
    assert_eq!(request_count(&t.db, "rejected").await, 1);
    assert_eq!(
        request_count(&t.db, "accepted").await,
        1,
        "debited rows stay"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_debit_leaves_the_request_pending() {
    let t = TempDb::new();
    deposit(&t.db, USER, "10", "0xdep1").await;
    seed_requests(&t.db, 1, units(30)).await;

    let paid = Arc::new(AtomicI64::new(0));
    let claim = accept(t.db.clone(), 1, "30", paid.clone(), false).await;
    assert_eq!(claim, Claim::Refused("Insufficient balance".to_string()));
    assert_eq!(paid.load(Ordering::SeqCst), 0);
    assert_eq!(request_count(&t.db, "pending").await, 1);
    assert_eq!(balance(&t.db, USER).await, units(10));
}

async fn queue_behind_a_gate(
    db: &Arc<Db>,
) -> (tokio::task::JoinHandle<()>, std::sync::mpsc::Sender<()>) {
    let (open, gate) = std::sync::mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let db = db.clone();
    let holder = tokio::spawn(async move {
        db.write(move |_| {
            started.send(()).unwrap();
            gate.recv().unwrap();
            Ok(())
        })
        .await
        .unwrap();
    });
    running.await.unwrap();
    (holder, open)
}

fn insert_user(user: String) -> impl FnOnce(&mut rusqlite::Connection) -> Result<(), ApiError> {
    move |c| {
        c.execute(
            "INSERT INTO user_balances (user_address, currency, balance) VALUES (?1, 'USDC', 1)",
            params![user],
        )?;
        Ok(())
    }
}

async fn user_count(db: &Db) -> i64 {
    db.read(|c| Ok(c.query_row("SELECT count(*) FROM user_balances", [], |r| r.get(0))?))
        .await
        .unwrap()
}

async fn let_queue() {
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_failure_or_panic_rolls_back_only_itself_in_a_batch() {
    let t = TempDb::new();
    let (holder, open) = queue_behind_a_gate(&t.db).await;
    let (batches_before, _) = t.db.writer_stats();

    let good = |n: usize| {
        let db = t.db.clone();
        tokio::spawn(async move { db.write(insert_user(format!("good{n}"))).await })
    };
    let first = good(0);
    let_queue().await;
    let failing = {
        let db = t.db.clone();
        tokio::spawn(async move {
            db.write(|c| {
                insert_user("failed".to_string())(c)?;
                Err::<(), _>(ApiError::Other("caller error".to_string()))
            })
            .await
        })
    };
    let_queue().await;
    let panicking = {
        let db = t.db.clone();
        tokio::spawn(async move {
            db.write(|c| {
                insert_user("panicked".to_string())(c)?;
                panic!("simulated bug");
            })
            .await
            .map(|_: ()| ())
        })
    };
    let_queue().await;
    let last = good(1);
    let_queue().await;

    open.send(()).unwrap();
    holder.await.unwrap();
    assert!(first.await.unwrap().is_ok());
    assert!(last.await.unwrap().is_ok());
    let failed = failing.await.unwrap().unwrap_err();
    assert_eq!(failed.to_string(), "caller error");
    assert!(panicking.await.unwrap().is_err());

    assert_eq!(user_count(&t.db).await, 2);
    assert_eq!(t.db.writer_stats().0 - batches_before, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_commit_fails_every_caller_in_the_batch() {
    let t = TempDb::new();
    t.db.write(|c| {
        c.execute_batch(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT; \
             CREATE TABLE child (p INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;",
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (holder, open) = queue_behind_a_gate(&t.db).await;
    let innocent = {
        let db = t.db.clone();
        tokio::spawn(async move { db.write(insert_user("innocent".to_string())).await })
    };
    let_queue().await;
    let violator = {
        let db = t.db.clone();
        tokio::spawn(async move {
            db.write(|c| {
                c.execute("INSERT INTO child VALUES (404)", [])?;
                Ok(())
            })
            .await
        })
    };
    let_queue().await;
    open.send(()).unwrap();
    holder.await.unwrap();

    assert!(innocent.await.unwrap().is_err());
    assert!(violator.await.unwrap().is_err());
    assert_eq!(user_count(&t.db).await, 0);

    t.db.write(insert_user("after".to_string())).await.unwrap();
    assert_eq!(user_count(&t.db).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transaction_lost_mid_batch_fails_everyone_in_it_and_nobody_after() {
    let t = TempDb::new();
    let (holder, open) = queue_behind_a_gate(&t.db).await;
    let spawn = |user: &str| {
        let (db, user) = (t.db.clone(), user.to_string());
        tokio::spawn(async move { db.write(insert_user(user)).await })
    };
    let before = spawn("before");
    let_queue().await;
    let killer = {
        let db = t.db.clone();
        tokio::spawn(async move {
            db.write(|c| {
                c.execute_batch("ROLLBACK")?;
                Ok(())
            })
            .await
        })
    };
    let_queue().await;
    let after = spawn("after");
    let_queue().await;
    open.send(()).unwrap();
    holder.await.unwrap();

    assert!(before.await.unwrap().is_err(), "its commit never happened");
    assert!(killer.await.unwrap().is_err());
    assert!(after.await.unwrap().is_ok());
    assert_eq!(user_count(&t.db).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn no_caller_is_answered_before_its_batch_is_committed() {
    let t = TempDb::new();
    let writers: Vec<_> = (0..64)
        .map(|n| {
            let db = t.db.clone();
            tokio::spawn(async move {
                let user = format!("u{n}");
                db.write(insert_user(user.clone())).await.unwrap();
                db.read(move |c| {
                    Ok(c.query_row(
                        "SELECT count(*) FROM user_balances WHERE user_address = ?1",
                        params![user],
                        |r| r.get::<_, i64>(0),
                    )?)
                })
                .await
                .unwrap()
            })
        })
        .collect();
    for writer in writers {
        assert_eq!(writer.await.unwrap(), 1);
    }
    let (batches, jobs) = t.db.writer_stats();
    assert!(jobs >= 64 && batches <= jobs);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stuck_rows_are_reported_and_left_alone() {
    let t = TempDb::new();
    deposit(&t.db, USER, "100", "0xdep1").await;
    seed_requests(&t.db, 3, units(10)).await;
    let ids: Vec<i64> =
        t.db.read(|c| {
            let mut rows = c.prepare("SELECT id FROM withdrawal_requests ORDER BY id")?;
            let ids = rows
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(ids)
        })
        .await
        .unwrap();
    for id in &ids {
        let claim = claim_and_debit(&t.db, *id, s(USER), "10".to_string(), USDC.to_string());
        assert!(matches!(claim.await.unwrap(), Claim::Debited { .. }));
    }
    let later = strike_core::db::now_us() + 1_000_000;

    assert!(stuck(&t.db, 0).await.unwrap().is_empty(), "not old enough");
    assert_eq!(stuck(&t.db, later).await.unwrap(), ids);

    assert!(finalize(&t.db, ids[0], "0xpaid".to_string(), None)
        .await
        .unwrap());
    assert!(park(&t.db, ids[1], "note".to_string(), None).await.unwrap());
    assert_eq!(stuck(&t.db, later).await.unwrap(), vec![ids[2]]);

    assert_eq!(request_count(&t.db, "accepted").await, 2);
    assert_eq!(balance(&t.db, USER).await, units(70));
}

// A Thursday-ish instant inside a Blitz window (phase 130 s of 180 s) and one outside it.
const BLITZ_ON: i64 = 1_800_000_010_000 - 1_800_000_010_000 % 180_000 + 130_000;
const BLITZ_OFF: i64 = BLITZ_ON - 130_000 + 10_000;

async fn blitz_audit_rows(db: &Db) -> (i64, i64) {
    db.read(|conn| {
        Ok(conn.query_row(
            "SELECT count(*), coalesce(sum(amount), 0) FROM balance_audit_log \
             WHERE operation_type = 'blitz_fee'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn a_blitz_pass_debits_once_with_one_audit_row() {
    let t = TempDb::new();
    deposit(&t.db, USER, "5", "0xdep1").await;
    let first = blitz::enter(&t.db, USER, USER, USDC, BLITZ_ON)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["charged"], "1");
    assert_eq!(first["windowStartsAt"], BLITZ_ON - 10_000);
    assert_eq!(first["endsAt"], BLITZ_ON - 10_000 + 60_000);
    let again = blitz::enter(&t.db, USER, USER, USDC, BLITZ_ON + 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again["charged"], "0");
    assert_eq!(
        blitz_audit_rows(&t.db).await,
        (1, to_fixed(Decimal::ONE, MONEY_SCALE).unwrap())
    );
    let balance =
        t.db.read(|c| {
            Ok(c.query_row(
                "SELECT balance FROM user_balances WHERE user_address = ?1",
                [USER],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(balance, to_fixed(Decimal::from(4), MONEY_SCALE).unwrap());
    let status = blitz::pass_status(&t.db, USER, BLITZ_ON).await.unwrap();
    assert_eq!(status["hasPass"], true);
}

#[tokio::test]
async fn a_blitz_pass_needs_the_balance() {
    let t = TempDb::new();
    let refused = blitz::enter(&t.db, USER, USER, USDC, BLITZ_ON)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(
        (refused.0, refused.1["code"].as_str()),
        (400, Some("insufficient_balance"))
    );
    assert_eq!(blitz_audit_rows(&t.db).await.0, 0);
    let status = blitz::pass_status(&t.db, USER, BLITZ_ON).await.unwrap();
    assert_eq!(status, json!({"hasPass": false, "windowStartsAt": null}));
}

#[tokio::test]
async fn a_boost_needs_a_pass_for_the_window_that_is_active() {
    let t = TempDb::new();
    deposit(&t.db, USER, "5", "0xdep2").await;
    let boxed = json!({"mode": "box", "blitz": true});
    let classic = json!({"mode": "binomo", "blitz": true});
    let plain = json!({"mode": "box"});
    async fn boost(t: &TempDb, body: &Value, now: i64) -> ApiResult<Result<f64, (u16, Value)>> {
        blitz::boost_for(&t.db, body, USER, now).await
    }
    let code =
        |r: Result<f64, (u16, Value)>| r.unwrap_err().1["code"].as_str().unwrap().to_string();

    assert_eq!(
        code(boost(&t, &boxed, BLITZ_ON).await.unwrap()),
        "blitz_inactive"
    );
    assert_eq!(boost(&t, &classic, BLITZ_ON).await.unwrap().unwrap(), 1.0);

    // A pass bought before the window opens is for that window, and only then.
    blitz::enter(&t.db, USER, USER, USDC, BLITZ_OFF)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        code(boost(&t, &boxed, BLITZ_OFF).await.unwrap()),
        "blitz_inactive"
    );
    assert_eq!(boost(&t, &boxed, BLITZ_ON).await.unwrap().unwrap(), 2.0);
    assert_eq!(boost(&t, &plain, BLITZ_ON).await.unwrap().unwrap(), 1.0);
    assert_eq!(boost(&t, &classic, BLITZ_ON).await.unwrap().unwrap(), 1.0);
    assert_eq!(
        code(boost(&t, &boxed, BLITZ_ON + 60_000).await.unwrap()),
        "blitz_inactive"
    );
}
