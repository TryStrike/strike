use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use k256::ecdsa::SigningKey;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use strike_core::address::keccak256;
use strike_core::payout_rules::withdrawal_intent_message;

const SECRET: &str = "shutdown-test-secret";
const TREASURY: &str = "0x00000000000000000000000000000000000000c0";
const USDC: &str = "0x3600000000000000000000000000000000000000";
const DEPOSIT_TX: &str = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const UNIT: i64 = 10_000_000_000;

fn key(byte: u8) -> SigningKey {
    SigningKey::from_slice(&[byte; 32]).unwrap()
}

fn address_of(signer: &SigningKey) -> String {
    let point = signer.verifying_key().to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

fn sign(signer: &SigningKey, message: &str) -> String {
    let mut framed = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    framed.extend_from_slice(message.as_bytes());
    let (signature, recovery) = signer
        .sign_prehash_recoverable(&keccak256(&framed))
        .unwrap();
    format!(
        "0x{}{:02x}",
        hex::encode(signature.to_bytes()),
        27 + recovery.to_byte()
    )
}

fn word(address: &str) -> String {
    format!("0x{:0>64}", address.trim_start_matches("0x"))
}

#[derive(Clone)]
struct Node {
    pending: Arc<AtomicBool>,
    reverts: Arc<AtomicBool>,
    owner: String,
    player: String,
    nonce: Arc<std::sync::atomic::AtomicU64>,
}

async fn rpc(State(node): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let result = match req["method"].as_str().unwrap_or_default() {
        "eth_call" => {
            let data = req["params"][0]["data"].as_str().unwrap_or_default();
            if data.len() == 10 {
                json!(word(&node.owner))
            } else {
                json!(format!("0x{:064x}", 1_000_000_000_000u128))
            }
        }
        "eth_getTransactionCount" => {
            json!(format!("0x{:x}", node.nonce.load(Ordering::SeqCst)))
        }
        "eth_gasPrice" => json!("0x3b9aca00"),
        "eth_estimateGas" => json!("0x186a0"),
        "eth_blockNumber" => json!("0xf4240"),
        "eth_getTransactionByHash" => json!({ "from": node.player }),
        "eth_sendRawTransaction" => {
            let nonce = node.nonce.fetch_add(1, Ordering::SeqCst);
            json!(format!("0x{nonce:064x}"))
        }
        "eth_getTransactionReceipt" if req["params"][0] == DEPOSIT_TX => json!({
            "status": "0x1", "blockNumber": "0xf423a",
            "logs": [{
                "address": USDC,
                "topics": [
                    strike_core::eth::transfer_topic_hex(),
                    word(&node.player),
                    word(TREASURY),
                ],
                "data": format!("0x{:064x}", 10_000_000u64),
            }],
        }),
        "eth_getTransactionReceipt" if node.pending.load(Ordering::SeqCst) => Value::Null,
        "eth_getTransactionReceipt" => {
            let status = if node.reverts.load(Ordering::SeqCst) {
                "0x0"
            } else {
                "0x1"
            };
            json!({ "status": status, "blockNumber": "0xf423a", "logs": [] })
        }
        _ => Value::Null,
    };
    Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
}

struct Server {
    child: Child,
    dir: PathBuf,
    url: String,
    http: Client,
    node: Node,
    player: SigningKey,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let treasury_key = key(7);
    let player = key(9);
    let node = Node {
        pending: Arc::new(AtomicBool::new(true)),
        reverts: Arc::default(),
        owner: address_of(&treasury_key),
        player: address_of(&player),
        nonce: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc_url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/", post(rpc)).with_state(node.clone());
    tokio::spawn(async { axum::serve(listener, app).await.unwrap() });

    let dir = std::env::temp_dir().join(format!("strike-stop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let child = Command::new(env!("CARGO_BIN_EXE_strike-backend"))
        .current_dir(&dir)
        .env_clear()
        .env("SQLITE_PATH", dir.join("ledger.sqlite"))
        .env("BIND_ADDR", format!("127.0.0.1:{port}"))
        .env("BALANCE_INTERNAL_SECRET", SECRET)
        .env("STRIKE_DEV_NO_WORLD", "1")
        .env("STEPUP_WITHDRAW_OVER", "100")
        .env("BINANCE_ENDPOINT", "http://127.0.0.1:9/ticker")
        .env("YAHOO_SPARK_ENDPOINT", "http://127.0.0.1:9/spark")
        .env("BINANCE_PERP_ENDPOINT", "http://127.0.0.1:9/perp")
        .env("KRAKEN_ENDPOINT", "http://127.0.0.1:9/kraken")
        .env("NEXT_PUBLIC_ARC_RPC_ENDPOINT", rpc_url)
        .env("NEXT_PUBLIC_TREASURY_ADDRESS", TREASURY)
        .env("NEXT_PUBLIC_ARC_USDC_ADDRESS", USDC)
        .env(
            "ARC_TREASURY_SECRET_KEY",
            format!("0x{}", hex::encode([7u8; 32])),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let server = Server {
        child,
        dir,
        url: format!("http://127.0.0.1:{port}"),
        http: Client::new(),
        node,
        player,
    };
    for _ in 0..3000 {
        let health = format!("{}/api/health", server.url);
        if server.http.get(health).send().await.is_ok() {
            return server;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("server did not start within 30s");
}

impl Server {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.join("ledger.sqlite")).unwrap()
    }

    async fn withdraw_then_hang_up(&self) -> i64 {
        let address = address_of(&self.player);
        self.db()
            .execute(
                "INSERT INTO user_balances (user_address, currency, balance) VALUES (?1, 'USDC', ?2)",
                rusqlite::params![address, 100 * UNIT],
            )
            .unwrap();
        let signed_at = chrono::Utc::now().timestamp_millis();
        let message = withdrawal_intent_message(&address, 50.0, "USDC", signed_at as f64);
        let hung_up = self
            .http
            .post(format!("{}/api/balance/withdraw", self.url))
            .bearer_auth(SECRET)
            .json(&json!({
                "userAddress": address, "amount": 50, "currency": "USDC",
                "signature": sign(&self.player, &message), "signedAt": signed_at,
            }))
            .timeout(Duration::from_millis(500))
            .send()
            .await;
        assert!(hung_up.unwrap_err().is_timeout());
        let mut id = None;
        eventually("the request is queued", || {
            id = self
                .db()
                .query_row("SELECT max(id) FROM withdrawal_requests", [], |r| r.get(0))
                .unwrap();
            id.is_some()
        })
        .await;
        id.unwrap()
    }

    fn notes(&self, id: i64) -> String {
        self.db()
            .query_row(
                "SELECT notes FROM withdrawal_requests WHERE id = ?1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap()
            .unwrap_or_default()
    }

    fn row(&self, id: i64) -> (String, Option<String>) {
        self.db()
            .query_row(
                "SELECT status, tx_hash FROM withdrawal_requests WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    fn terminate(&self) {
        let sent = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(sent.success());
    }

    async fn exit_within(&mut self, limit: Duration) -> ExitStatus {
        let started = Instant::now();
        while started.elapsed() < limit {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("still running after {limit:?}");
    }
}

async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(10), "{what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_closes_price_streams_and_exits_at_once() {
    let mut s = start().await;
    let mut stream = s
        .http
        .get(format!("{}/api/prices/stream?assets=BTC", s.url))
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), StatusCode::OK);
    assert_eq!(stream.headers()["x-content-type-options"], "nosniff");

    s.terminate();
    let ended = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(_frame) = stream.chunk().await.unwrap() {}
    });
    ended.await.expect("the stream stayed open");
    assert!(s.exit_within(Duration::from_secs(3)).await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hung_up_withdrawal_pays_detached_and_records_each_state() {
    let s = start().await;
    let id = s.withdraw_then_hang_up().await;
    eventually("the debit commits", || s.row(id).0 == "accepted").await;
    assert_eq!(s.row(id).1, None, "the transfer has not confirmed");

    s.node.pending.store(false, Ordering::SeqCst);
    eventually("the hash is recorded", || s.row(id).1.is_some()).await;
    assert_eq!(s.row(id).0, "accepted");

    let (balance, audit): (i64, String) = s
        .db()
        .query_row(
            "SELECT b.balance, a.transaction_hash FROM user_balances b \
             JOIN balance_audit_log a ON a.user_address = b.user_address \
             WHERE a.operation_type = 'withdrawal'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(balance, 50 * UNIT, "debited exactly once");
    assert!(audit.starts_with("0x"), "{audit}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hung_up_withdrawal_whose_transfer_reverts_is_parked() {
    let s = start().await;
    let id = s.withdraw_then_hang_up().await;
    eventually("the debit commits", || s.row(id).0 == "accepted").await;

    s.node.reverts.store(true, Ordering::SeqCst);
    s.node.pending.store(false, Ordering::SeqCst);
    eventually("the row is parked", || {
        s.row(id).0 == "paid_needs_reconciliation"
    })
    .await;
    let notes = s.notes(id);
    assert!(notes.contains("reverted"), "{notes}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_waits_for_a_payout_nobody_is_listening_to() {
    let mut s = start().await;
    let id = s.withdraw_then_hang_up().await;
    eventually("the debit commits", || s.row(id).0 == "accepted").await;

    s.terminate();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        s.child.try_wait().unwrap().is_none(),
        "exited with a transfer unconfirmed"
    );
    let refused = s.http.get(format!("{}/api/health", s.url)).send().await;
    assert!(refused.is_err(), "the listener is closed");

    s.node.pending.store(false, Ordering::SeqCst);
    assert!(s.exit_within(Duration::from_secs(10)).await.success());
    assert!(s.row(id).1.is_some(), "the hash was written before exit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deposit_credits_without_waiting_on_any_treasury_transfer() {
    let s = start().await;
    let res = s
        .http
        .post(format!("{}/api/balance/deposit", s.url))
        .bearer_auth(SECRET)
        .timeout(Duration::from_secs(5))
        .json(&json!({
            "userAddress": s.node.player, "amount": 10, "currency": "USDC", "txHash": DEPOSIT_TX,
        }))
        .send()
        .await
        .expect("a deposit must not wait on the chain");
    assert!(res.status().is_success(), "{}", res.status());
    let credited: i64 = s
        .db()
        .query_row(
            "SELECT count(*) FROM user_balances WHERE balance > 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(credited, 1);
}
