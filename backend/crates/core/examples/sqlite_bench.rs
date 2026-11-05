//! Throughput of the real ledger path on a real file:
//!   SQLITE_FULLFSYNC=OFF cargo run --release -p strike-core --example sqlite_bench -- /path
//!
//! Writes are `place_bet_locked` through the group-committing writer. Reads are a
//! primary-key balance lookup through the read pool.

use std::sync::Arc;
use std::time::Instant;

use strike_core::db::Db;
use serde_json::Value;

const WRITES: usize = 5_000;
const READS: usize = 100_000;
const TASKS: usize = 64;

fn s(text: &str) -> Value {
    Value::String(text.to_string())
}

async fn run(dir: &std::path::Path) {
    let path = dir.join(format!("bench-{}.sqlite", uuid::Uuid::new_v4()));
    let db = Arc::new(Db::open(&path, 8, 8_000).unwrap());
    db.call_rpc(
        "update_balance_for_deposit",
        &[
            ("p_user_address", &s("0xbench")),
            ("p_deposit_amount", &s("900000000")),
            ("p_currency", &s("USDC")),
        ],
    )
    .await
    .unwrap();

    let started = Instant::now();
    let mut tasks = Vec::new();
    for task in 0..TASKS {
        let db = db.clone();
        tasks.push(tokio::spawn(async move {
            for i in 0..WRITES / TASKS {
                let key = format!("{task}-{i}");
                let result = db
                    .call_rpc(
                        "place_bet_locked",
                        &[
                            ("p_user_address", &s("0xbench")),
                            ("p_bet_amount", &s("0.1")),
                            ("p_currency", &s("USDC")),
                            ("p_idempotency_key", &s(&key)),
                            ("p_bet_id", &s(&key)),
                            ("p_max_payout", &s("0.19")),
                            ("p_settlement_token", &s("t")),
                        ],
                    )
                    .await
                    .unwrap();
                assert_eq!(result["success"], Value::Bool(true));
            }
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let done = WRITES / TASKS * TASKS;
    let write_rate = done as f64 / started.elapsed().as_secs_f64();

    let started = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..TASKS {
        let db = db.clone();
        tasks.push(tokio::spawn(async move {
            let user = s("0xbench");
            let currency = s("USDC");
            for _ in 0..READS / TASKS {
                let rows = db
                    .fetch(
                        "SELECT balance FROM user_balances \
                         WHERE user_address = CAST($1 AS text) AND currency = CAST($2 AS text)",
                        &[("text", &user), ("text", &currency)],
                    )
                    .await
                    .unwrap();
                assert_eq!(rows.len(), 1);
            }
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let read_rate = (READS / TASKS * TASKS) as f64 / started.elapsed().as_secs_f64();

    let (batches, jobs) = db.writer_stats();
    println!(
        "writes/s={write_rate:>9.0} reads/s={read_rate:>9.0} avg batch={:.1}",
        jobs as f64 / batches.max(1) as f64
    );
    drop(db);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[tokio::main]
async fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    run(&dir).await;
}
