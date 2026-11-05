//! The treasury path against a JSON-RPC stub that answers like a node: full
//! 32-byte ABI words and one transaction per sender nonce.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{extract::State, routing::post, Json, Router};
use strike_core::error::ApiError;
use strike_core::eth::{PayError, Rpc, Sent, Transfer, Treasury};
use k256::ecdsa::SigningKey;
use serde_json::{json, Value};

const USDC: &str = "0x3600000000000000000000000000000000000000";
const CONTRACT: &str = "0x00000000000000000000000000000000000000c0";
const PLAYER: &str = "0x00000000000000000000000000000000000000aa";
const CHAIN_ID: u64 = 5042;

/// What the node does with the next `eth_sendRawTransaction`.
#[derive(Default, Clone, Copy, PartialEq)]
enum SendMode {
    #[default]
    Normal,
    /// Takes the transaction, then the response is lost.
    TakenButNoAnswer,
    /// The request dies before reaching the node.
    NeverArrived,
    /// A JSON-RPC refusal for a transaction it did not take.
    Refuse,
}

#[derive(Default)]
struct Chain {
    /// Next nonce the node accepts, which is also its pending count.
    nonce: u64,
    /// Nonces of accepted transactions, in order.
    landed: Vec<u64>,
    broadcasts: usize,
    /// Methods that answer with a JSON-RPC error.
    failing: HashSet<String>,
    send_mode: SendMode,
    send_delay_ms: u64,
    reverts: bool,
    owner_word: String,
    balance_word: String,
}

type Shared = Arc<Mutex<Chain>>;

/// Reads the nonce out of a raw EIP-1559 transaction: `0x02`, the list header,
/// the chain id, then the nonce.
fn nonce_of(raw: &str) -> u64 {
    let bytes = hex::decode(raw.trim_start_matches("0x")).unwrap();
    let mut at = 1;
    at += match bytes[at] {
        0xc0..=0xf7 => 1,
        long => 1 + (long - 0xf7) as usize,
    };
    let item = |at: usize| -> (u64, usize) {
        match bytes[at] {
            b @ 0..=0x7f => (b as u64, 1),
            h => {
                let len = (h - 0x80) as usize;
                let value = bytes[at + 1..at + 1 + len]
                    .iter()
                    .fold(0u64, |v, b| (v << 8) | *b as u64);
                (value, 1 + len)
            }
        }
    };
    let (_, chain_len) = item(at);
    item(at + chain_len).0
}

fn rpc_ok(value: Value) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": 1, "result": value })).into_response()
}

fn rpc_err(message: &str) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": message } }))
        .into_response()
}

async fn rpc(State(chain): State<Shared>, Json(req): Json<Value>) -> Response {
    let method = req["method"].as_str().unwrap_or_default().to_string();

    if method == "eth_sendRawTransaction" {
        let delay = chain.lock().unwrap().send_delay_ms;
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }

    let mut c = chain.lock().unwrap();
    if c.failing.contains(&method) {
        return rpc_err("node refused");
    }
    match method.as_str() {
        "eth_call" => {
            // `owner()` is a bare selector, `balanceOf(address)` has an argument.
            let data = req["params"][0]["data"].as_str().unwrap_or_default();
            rpc_ok(json!(if data.len() == 10 {
                c.owner_word.clone()
            } else {
                c.balance_word.clone()
            }))
        }
        "eth_getTransactionCount" => rpc_ok(json!(format!("0x{:x}", c.nonce))),
        "eth_gasPrice" => rpc_ok(json!("0x3b9aca00")),
        "eth_estimateGas" => rpc_ok(json!("0x186a0")),
        "eth_blockNumber" => rpc_ok(json!("0xf4240")),
        "eth_getTransactionReceipt" => {
            let status = if c.reverts { "0x0" } else { "0x1" };
            rpc_ok(json!({ "status": status, "blockNumber": "0xf423a", "logs": [] }))
        }
        "eth_sendRawTransaction" => {
            c.broadcasts += 1;
            let raw = req["params"][0].as_str().unwrap_or_default();
            let nonce = nonce_of(raw);
            match std::mem::take(&mut c.send_mode) {
                SendMode::NeverArrived => return StatusCode::BAD_GATEWAY.into_response(),
                SendMode::Refuse => return rpc_err("nonce too low"),
                SendMode::TakenButNoAnswer | SendMode::Normal if nonce != c.nonce => {
                    return rpc_err("nonce mismatch")
                }
                mode => {
                    c.nonce += 1;
                    c.landed.push(nonce);
                    if mode == SendMode::TakenButNoAnswer {
                        return StatusCode::BAD_GATEWAY.into_response();
                    }
                }
            }
            rpc_ok(json!(format!("0x{nonce:064x}")))
        }
        _ => rpc_err("unsupported"),
    }
}

async fn node() -> (Shared, String) {
    let chain: Shared = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/", post(rpc))
        .with_state(chain.clone());
    tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    (chain, url)
}

async fn start(balance: u128) -> (Shared, Treasury) {
    let signer = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let (chain, url) = node().await;
    let treasury = Treasury::new(
        Rpc::new(url, CHAIN_ID),
        signer,
        CONTRACT.to_string(),
        USDC.to_string(),
    );
    {
        let mut c = chain.lock().unwrap();
        let owner = treasury.signer_address().trim_start_matches("0x");
        c.owner_word = format!("0x{:0>64}", owner.to_lowercase());
        c.balance_word = format!("0x{balance:064x}");
    }
    (chain, treasury)
}

fn pay_to(amount: u128) -> Vec<Transfer> {
    vec![Transfer {
        to: PLAYER.to_string(),
        amount,
    }]
}

/// Pays with a commit step that counts its calls, like the debit does.
async fn pay(
    treasury: &Treasury,
    transfers: Vec<Transfer>,
    commits: &Arc<AtomicUsize>,
) -> Result<((), Vec<Sent>), PayError<()>> {
    let commits = commits.clone();
    treasury
        .pay(transfers, move || async move {
            commits.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
}

#[tokio::test]
async fn a_real_uint256_response_is_read() {
    let (chain, treasury) = start(10u128.pow(15)).await;
    assert_eq!(chain.lock().unwrap().balance_word.len(), 66);
    assert_eq!(
        treasury.treasury_token_balance().await.unwrap(),
        10u128.pow(15)
    );
    let commits = Arc::default();
    assert!(pay(&treasury, pay_to(10u128.pow(15)), &commits)
        .await
        .is_ok());
}

#[tokio::test]
async fn every_failed_read_stops_before_the_commit() {
    for method in [
        "eth_call",
        "eth_getTransactionCount",
        "eth_gasPrice",
        "eth_estimateGas",
    ] {
        let (chain, treasury) = start(1_000).await;
        chain.lock().unwrap().failing.insert(method.to_string());
        let commits = Arc::default();
        let result = pay(&treasury, pay_to(10), &commits).await;
        assert!(matches!(result, Err(PayError::Preflight(_))), "{method}");
        assert_eq!(commits.load(Ordering::SeqCst), 0, "{method}");
        assert_eq!(chain.lock().unwrap().broadcasts, 0, "{method}");
    }
}

#[tokio::test]
async fn bad_answers_stop_before_the_commit_too() {
    // No contract at the token address, the short non-ABI form, a poor treasury,
    // and a key that does not own the contract.
    let (chain, treasury) = start(1_000).await;
    let commits = Arc::default();
    for word in ["0x", "0x3e8", &format!("0x{:064x}", 5)] {
        chain.lock().unwrap().balance_word = word.to_string();
        let result = pay(&treasury, pay_to(10), &commits).await;
        assert!(matches!(result, Err(PayError::Preflight(_))), "{word}");
    }
    let (chain, treasury) = start(1_000).await;
    chain.lock().unwrap().owner_word = format!("0x{:064x}", 1);
    let result = pay(&treasury, pay_to(10), &commits).await;
    assert!(matches!(result, Err(PayError::Preflight(_))));
    assert_eq!(commits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_refused_commit_sends_nothing() {
    let (chain, treasury) = start(1_000).await;
    let result: Result<((), Vec<Sent>), _> = treasury
        .pay(pay_to(10), || async { Err("insufficient") })
        .await;
    assert!(matches!(result, Err(PayError::Refused("insufficient"))));
    assert_eq!(chain.lock().unwrap().broadcasts, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_payouts_each_land_once_on_their_own_nonce() {
    let (chain, treasury) = start(10_000).await;
    chain.lock().unwrap().nonce = 41;
    chain.lock().unwrap().send_delay_ms = 2;
    let commits: Arc<AtomicUsize> = Arc::default();

    let tasks: Vec<_> = (0..16)
        .map(|_| {
            let (treasury, commits) = (treasury.clone(), commits.clone());
            tokio::spawn(async move {
                let (_, sent) = pay(&treasury, pay_to(10), &commits).await.unwrap();
                treasury.confirm(&sent[0]).await.unwrap();
            })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }

    let c = chain.lock().unwrap();
    let expected: Vec<u64> = (41..57).collect();
    assert_eq!(c.landed, expected);
    assert_eq!(c.broadcasts, 16);
    assert_eq!(commits.load(Ordering::SeqCst), 16);
}

#[tokio::test]
async fn a_fee_and_a_net_transfer_take_consecutive_nonces() {
    let (chain, treasury) = start(1_000).await;
    let commits = Arc::default();
    let (_, sent) = pay(&treasury, [pay_to(1), pay_to(9)].concat(), &commits)
        .await
        .unwrap();
    assert_eq!(sent.len(), 2);
    assert_eq!(chain.lock().unwrap().landed, vec![0, 1]);
    assert_eq!(commits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_unanswered_send_is_not_retried_and_its_nonce_is_not_reused() {
    let (chain, treasury) = start(1_000).await;
    chain.lock().unwrap().send_mode = SendMode::TakenButNoAnswer;
    let commits = Arc::default();

    let Err(PayError::Send { sent, .. }) = pay(&treasury, pay_to(10), &commits).await else {
        panic!("an unknown outcome is a send failure");
    };
    // Its hash is known even though the node never answered.
    assert_eq!(sent.len(), 1);
    assert!(sent[0].hash.starts_with("0x") && sent[0].hash.len() == 66);
    assert_eq!(chain.lock().unwrap().broadcasts, 1, "sent exactly once");

    pay(&treasury, pay_to(10), &commits).await.unwrap();
    let c = chain.lock().unwrap();
    assert_eq!(c.landed, vec![0, 1]);
    assert_eq!(c.broadcasts, 2);
}

#[tokio::test]
async fn a_lost_send_blocks_later_payouts_before_they_debit() {
    let (chain, treasury) = start(1_000).await;
    chain.lock().unwrap().send_mode = SendMode::NeverArrived;
    let commits: Arc<AtomicUsize> = Arc::default();
    assert!(matches!(
        pay(&treasury, pay_to(10), &commits).await,
        Err(PayError::Send { .. })
    ));
    assert_eq!(commits.load(Ordering::SeqCst), 1);

    // The node is behind the nonce we may have used. Going on would strand
    // every later payout with its debit already taken.
    assert!(matches!(
        pay(&treasury, pay_to(10), &commits).await,
        Err(PayError::Preflight(_))
    ));
    assert_eq!(commits.load(Ordering::SeqCst), 1);
    assert!(chain.lock().unwrap().landed.is_empty());

    // Once the node shows the nonce was used, payouts carry on.
    chain.lock().unwrap().nonce = 1;
    pay(&treasury, pay_to(10), &commits).await.unwrap();
    assert_eq!(chain.lock().unwrap().landed, vec![1]);
}

#[tokio::test]
async fn a_refused_send_leaves_its_nonce_free_and_is_not_retried() {
    let (chain, treasury) = start(1_000).await;
    chain.lock().unwrap().send_mode = SendMode::Refuse;
    let commits = Arc::default();
    let Err(PayError::Send { sent, .. }) = pay(&treasury, pay_to(10), &commits).await else {
        panic!("a refused send is a send failure");
    };
    assert!(sent.is_empty());
    assert_eq!(chain.lock().unwrap().broadcasts, 1);

    pay(&treasury, pay_to(10), &commits).await.unwrap();
    assert_eq!(chain.lock().unwrap().landed, vec![0]);
}

#[tokio::test]
async fn unconfirmed_payouts_count_against_the_treasury_balance() {
    let (chain, treasury) = start(100).await;
    let commits: Arc<AtomicUsize> = Arc::default();
    let (_, sent) = pay(&treasury, pay_to(60), &commits).await.unwrap();

    // The chain's balance still says 100, but 60 of it is already on the way.
    let second = pay(&treasury, pay_to(60), &commits).await;
    assert!(matches!(second, Err(PayError::Preflight(_))));
    assert_eq!(commits.load(Ordering::SeqCst), 1);

    treasury.confirm(&sent[0]).await.unwrap();
    pay(&treasury, pay_to(60), &commits).await.unwrap();
    assert_eq!(chain.lock().unwrap().landed, vec![0, 1]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dropping_the_request_cannot_stop_a_send_halfway() {
    let (chain, treasury) = start(1_000).await;
    chain.lock().unwrap().send_delay_ms = 100;
    let commits: Arc<AtomicUsize> = Arc::default();

    let dropped = {
        let (treasury, commits) = (treasury.clone(), commits.clone());
        tokio::spawn(async move { pay(&treasury, pay_to(10), &commits).await.map(|_| ()) })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    dropped.abort();

    // The turn finishes regardless, so the next payout takes the next nonce.
    let (_, sent) = pay(&treasury, pay_to(10), &commits).await.unwrap();
    treasury.confirm(&sent[0]).await.unwrap();
    let c = chain.lock().unwrap();
    assert_eq!(c.landed, vec![0, 1]);
    assert_eq!(commits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_reverted_payout_is_a_failure() {
    let (chain, treasury) = start(1_000).await;
    assert!(treasury.withdraw_token_to(PLAYER, 10).await.is_ok());
    chain.lock().unwrap().reverts = true;
    let err: ApiError = treasury.withdraw_token_to(PLAYER, 10).await.unwrap_err();
    assert!(err.to_string().contains("reverted"));
}

#[tokio::test]
async fn a_failed_read_is_not_a_missing_transaction() {
    let (chain, url) = node().await;
    let rpc = Rpc::new(url, CHAIN_ID);
    for method in ["eth_getTransactionByHash", "eth_getTransactionReceipt"] {
        chain.lock().unwrap().failing.insert(method.to_string());
    }
    assert!(rpc.transaction("0x1").await.is_err());
    assert!(rpc.receipt("0x1").await.is_err());
}

#[tokio::test]
async fn a_read_failure_while_confirming_does_not_fail_the_payout() {
    let (chain, treasury) = start(1_000).await;
    let commits = Arc::default();
    let (_, sent) = pay(&treasury, pay_to(10), &commits).await.unwrap();

    let receipt = "eth_getTransactionReceipt".to_string();
    chain.lock().unwrap().failing.insert(receipt.clone());
    let healed = chain.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        healed.lock().unwrap().failing.remove(&receipt);
    });
    treasury.confirm(&sent[0]).await.unwrap();
}
