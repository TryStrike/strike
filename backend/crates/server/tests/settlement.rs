//! The payout path over real HTTP: the real binary, a throwaway database, and a
//! Binance-shaped feed in this process, so a test decides what the market did.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode as AxumStatus;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use strike_core::address::keccak256;
use strike_core::agent::{start_message, StartTerms};
use k256::ecdsa::SigningKey;
use reqwest::{Client, StatusCode};
use rust_decimal::Decimal;
use serde_json::{json, Value};

const SECRET: &str = "http-test-secret";
const SETTLEMENT_SECRET: &str = "http-test-settlement-secret";
const WALLET: &str = "0x1111111111111111111111111111111111111111";
const UNIT: i64 = 10_000_000_000;
const PRICE_UNIT: i64 = 100_000_000;

/// `{ "BTCUSDT": 100.0 }`; `down` answers 503 to everything.
#[derive(Default)]
struct Market {
    prices: HashMap<String, f64>,
    down: bool,
}

type Feed = Arc<Mutex<Market>>;

async fn binance(
    State(feed): State<Feed>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let market = feed.lock().unwrap();
    if market.down {
        return AxumStatus::SERVICE_UNAVAILABLE.into_response();
    }
    let wanted: Vec<String> =
        serde_json::from_str(query.get("symbols").map_or("[]", String::as_str)).unwrap();
    let rows: Vec<Value> = wanted
        .iter()
        .filter_map(|symbol| {
            let price = market.prices.get(symbol)?;
            Some(json!({ "symbol": symbol, "price": price.to_string() }))
        })
        .collect();
    Json(rows).into_response()
}

async fn spawn_feed(btc: f64) -> (Feed, String) {
    let feed: Feed = Arc::default();
    set_price(&feed, btc);
    let spark = || async { Json(json!({ "spark": { "result": [] } })) };
    let app = Router::new()
        .route("/ticker", get(binance))
        .route("/spark", get(spark))
        .with_state(feed.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (feed, url)
}

fn set_price(feed: &Feed, btc: f64) {
    let mut market = feed.lock().unwrap();
    market.prices.insert("BTCUSDT".to_string(), btc);
}

struct Server {
    child: Child,
    dir: PathBuf,
    url: String,
    http: Client,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spawn_server(dir: &Path, feed_url: &str, port: u16) -> Child {
    Command::new(env!("CARGO_BIN_EXE_strike-backend"))
        .current_dir(dir)
        .env_clear()
        .env("SQLITE_PATH", dir.join("ledger.sqlite"))
        .env("BIND_ADDR", format!("127.0.0.1:{port}"))
        .env("BALANCE_INTERNAL_SECRET", SECRET)
        .env("BALANCE_SETTLEMENT_SECRET", SETTLEMENT_SECRET)
        .env("BINANCE_ENDPOINT", format!("{feed_url}/ticker"))
        .env("YAHOO_SPARK_ENDPOINT", format!("{feed_url}/spark"))
        // One missed sample is an outage here, so a test needs no 5 s wait.
        .env("SETTLE_TICK_TOLERANCE_MS", "1500")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

impl Server {
    /// A server, a funded wallet, and time for the first price sample to land.
    async fn start(btc: f64) -> (Self, Feed, String) {
        let (feed, feed_url) = spawn_feed(btc).await;
        let dir = std::env::temp_dir().join(format!("strike-settle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let port = free_port();
        let child = spawn_server(&dir, &feed_url, port);
        let server = Server {
            child,
            dir,
            url: format!("http://127.0.0.1:{port}"),
            http: Client::new(),
        };
        server.wait_up().await;
        server.fund(WALLET, 100);
        tokio::time::sleep(Duration::from_millis(1300)).await;
        (server, feed, feed_url)
    }

    /// A hard stop: nothing is flushed, which is what a crash does.
    fn kill(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }

    /// Same database, empty rings.
    async fn restart(&mut self, feed_url: &str) {
        let port = free_port();
        self.child = spawn_server(&self.dir, feed_url, port);
        self.url = format!("http://127.0.0.1:{port}");
        self.wait_up().await;
    }

    /// `(outcome, settled_by, end_source)`, the permanent record.
    fn round(&self, bet: &Value) -> (Option<String>, Option<String>, Option<String>) {
        self.sqlite()
            .query_row(
                "SELECT outcome, settled_by, end_source FROM bet_rounds WHERE bet_id = ?1",
                [bet["betId"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    }

    async fn wait_up(&self) {
        for _ in 0..500 {
            let up = self.http.get(format!("{}/api/health", self.url)).send();
            if up.await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("server did not start");
    }

    fn sqlite(&self) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(self.dir.join("ledger.sqlite")).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn
    }

    fn fund(&self, wallet: &str, whole: i64) {
        self.sqlite()
            .execute(
                "INSERT INTO user_balances (user_address, currency, balance) \
                 VALUES (?1, 'USDC', ?2)",
                rusqlite::params![wallet, whole * UNIT],
            )
            .unwrap();
    }

    /// In units of 1e-10, so nothing here compares a float.
    fn balance(&self) -> i64 {
        self.sqlite()
            .query_row(
                "SELECT balance FROM user_balances WHERE user_address = ?1",
                [WALLET],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn audit_rows(&self, operation: &str) -> i64 {
        self.sqlite()
            .query_row(
                "SELECT count(*) FROM balance_audit_log WHERE operation_type = ?1",
                [operation],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn history(&self, bet: &Value) -> Option<(i64, Option<i64>, i64, bool)> {
        use rusqlite::OptionalExtension;
        self.sqlite()
            .query_row(
                "SELECT strike_price, end_price, payout, won FROM bet_history WHERE id = ?1",
                [bet["betId"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .unwrap()
    }

    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        let res = self
            .http
            .post(format!("{}{path}", self.url))
            .bearer_auth(SECRET)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = res.status();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    async fn bet(&self, body: Value) -> Value {
        let (status, reply) = self.post("/api/balance/bet", body).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        reply
    }

    async fn claim(&self, bet: &Value, win_amount: f64) -> (StatusCode, Value) {
        let body = json!({
            "userAddress": WALLET, "winAmount": win_amount, "currency": "USDC",
            "betId": bet["betId"], "settlementToken": bet["settlementToken"],
        });
        self.post("/api/balance/win", body).await
    }

    /// Nothing here claims: only the server can write this row.
    async fn wait_settled(&self, bet: &Value) {
        for _ in 0..200 {
            if self.history(bet).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("round {bet} never settled");
    }
}

fn request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The up/down round the classic game places: 10 USDC at the 5 s tier.
fn classic(direction: &str, strike: f64) -> Value {
    json!({
        "userAddress": WALLET, "betAmount": 10, "currency": "USDC", "asset": "BTC",
        "mode": "binomo", "roundId": 1, "targetPrice": strike, "strikePrice": strike,
        "isOver": direction == "UP", "multiplier": 1.75, "betRequestId": request_id(),
        "targetCell": { "id": 9, "priceChange": 10, "direction": direction, "timeframe": 5 },
    })
}

async fn after_the_next_sample() {
    tokio::time::sleep(Duration::from_millis(1300)).await;
}

/// Past a 5 s round whose price moved at the first sample.
async fn round_over() {
    tokio::time::sleep(Duration::from_millis(4000)).await;
}

// -- the exploit -------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bet_followed_by_an_immediate_claim_is_not_paid() {
    let (s, _feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    assert_eq!(s.balance(), 90 * UNIT);

    let (status, reply) = s.claim(&bet, 17.5).await;

    assert_eq!(s.balance(), 90 * UNIT, "paid at once: {reply}");
    assert_ne!(status, StatusCode::OK, "{reply}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claim_on_a_losing_round_pays_nothing() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 90.0);
    round_over().await;

    let (_, reply) = s.claim(&bet, 17.5).await;

    assert_eq!(s.balance(), 90 * UNIT, "paid a losing round: {reply}");
    assert_eq!(s.audit_rows("payout"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claim_needs_the_token_it_was_issued() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    let other = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 110.0);

    let without = json!({ "userAddress": WALLET, "winAmount": 17.5, "betId": bet["betId"] });
    let (status, reply) = s.post("/api/balance/win", without.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");

    let tokens = [
        json!(""),
        json!(null),
        json!("abc.def"),
        other["settlementToken"].clone(),
    ];
    for token in tokens {
        let mut forged = without.clone();
        forged["settlementToken"] = token;
        let (status, reply) = s.post("/api/balance/win", forged).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED,
            "{status} {reply}"
        );
    }
    assert_eq!(s.audit_rows("payout"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_inflated_win_amount_changes_nothing() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 110.0);
    round_over().await;

    let (status, reply) = s.claim(&bet, 9_999.0).await;

    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(s.balance(), 90 * UNIT + 175 * UNIT / 10, "{reply}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_prices_never_reach_the_outcome() {
    let (s, feed, _) = Server::start(100.0).await;

    // A strike the feed never printed is refused before any money moves.
    let (status, reply) = s.post("/api/balance/bet", classic("UP", 50.0)).await;
    assert_ne!(status, StatusCode::OK, "{reply}");
    assert_eq!(s.balance(), 100 * UNIT);

    let bet = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 90.0);
    round_over().await;

    // The loser claims with prices that would make it a winner.
    let lying = json!({
        "userAddress": WALLET, "winAmount": 17.5, "currency": "USDC",
        "betId": bet["betId"], "settlementToken": bet["settlementToken"],
        "strikePrice": 1, "endPrice": 1_000_000, "won": true,
    });
    let _ = s.post("/api/balance/win", lying).await;
    s.wait_settled(&bet).await;

    assert_eq!(s.balance(), 90 * UNIT);
    let row = s.history(&bet).unwrap();
    assert_eq!(
        row,
        (100 * PRICE_UNIT, Some(90 * PRICE_UNIT), 0, false),
        "the stored row must be the server's"
    );
}

// -- settlement without a client ---------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sweep_pays_a_winner_nobody_claimed() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 110.0);

    s.wait_settled(&bet).await;

    assert_eq!(s.balance(), 90 * UNIT + 175 * UNIT / 10);
    assert_eq!(s.audit_rows("payout"), 1);
    let (outcome, settled_by, source) = s.round(&bet);
    assert_eq!(outcome.as_deref(), Some("win"));
    assert_eq!(settled_by.as_deref(), Some("sweep"));
    assert_eq!(source.as_deref(), Some("binance"));

    // A claim afterwards is told the result and moves nothing.
    let (status, reply) = s.claim(&bet, 17.5).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["duplicate"], json!(true));
    assert_eq!(reply["payout"], json!(17.5));
    assert_eq!(s.balance(), 90 * UNIT + 175 * UNIT / 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sweep_settles_a_loser_and_a_tie() {
    let (s, feed, _) = Server::start(100.0).await;
    let tie = s.bet(classic("UP", 100.0)).await;
    s.wait_settled(&tie).await;
    assert_eq!(s.round(&tie).0.as_deref(), Some("tie"));
    assert_eq!(s.balance(), 100 * UNIT, "a tie returns the stake");
    assert_eq!(s.audit_rows("refund"), 1);

    let lost = s.bet(classic("DOWN", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 110.0);
    s.wait_settled(&lost).await;
    assert_eq!(s.round(&lost).0.as_deref(), Some("loss"));
    assert_eq!(s.balance(), 90 * UNIT);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_claims_and_the_sweep_pay_once() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 110.0);
    round_over().await;

    let claims: Vec<_> = (0..16).map(|_| s.claim(&bet, 17.5)).collect();
    let replies = futures::future::join_all(claims).await;

    for (status, reply) in &replies {
        assert_eq!(*status, StatusCode::OK, "{reply}");
        assert_eq!(reply["payout"], json!(17.5), "{reply}");
    }
    assert_eq!(s.audit_rows("payout"), 1);
    assert_eq!(s.audit_rows("payout_lock"), 1);
    assert_eq!(s.balance(), 90 * UNIT + 175 * UNIT / 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_proof_carries_the_server_record() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    after_the_next_sample().await;
    set_price(&feed, 110.0);
    s.wait_settled(&bet).await;

    let id = bet["betId"].as_str().unwrap();
    let res = s
        .http
        .get(format!("{}/api/bets/{id}?wallet={WALLET}", s.url))
        .bearer_auth(SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let proof: Value = res.json().await.unwrap();
    let record = &proof["bet"]["server_settlement"];
    assert_eq!(record["outcome"], "win", "{proof}");
    assert_eq!(record["strike_source"], "binance");
    assert_eq!(record["end_source"], "binance");
    assert_eq!(proof["bet"]["strike_price"], json!(100));
    assert_eq!(proof["bet"]["recorded_end_price"], json!(110));
}

// -- the refund rule ---------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outage_across_the_end_refunds_the_stake() {
    let (s, feed, _) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    feed.lock().unwrap().down = true;

    s.wait_settled(&bet).await;

    assert_eq!(s.round(&bet).0.as_deref(), Some("refund_no_price"));
    assert_eq!(s.balance(), 100 * UNIT);
    let (_, end_price, payout, _) = s.history(&bet).unwrap();
    assert_eq!(
        (end_price, payout),
        (None, 10 * UNIT),
        "never a guessed price"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_round_that_ended_while_the_server_was_down_refunds() {
    let (mut s, _feed, feed_url) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    s.kill();
    tokio::time::sleep(Duration::from_millis(5200)).await;

    s.restart(&feed_url).await;
    s.wait_settled(&bet).await;

    assert_eq!(s.round(&bet).0.as_deref(), Some("refund_no_price"));
    assert_eq!(s.balance(), 100 * UNIT);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_round_still_open_across_a_restart_settles_on_its_price() {
    let (mut s, feed, feed_url) = Server::start(100.0).await;
    let bet = s.bet(classic("UP", 100.0)).await;
    s.kill();
    set_price(&feed, 110.0);

    s.restart(&feed_url).await;
    s.wait_settled(&bet).await;

    assert_eq!(s.round(&bet).0.as_deref(), Some("win"));
    assert_eq!(s.balance(), 90 * UNIT + 175 * UNIT / 10);
}

// -- what a bet is refused for -----------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bet_on_a_stale_feed_is_refused_before_money_moves() {
    let (s, feed, _) = Server::start(100.0).await;
    feed.lock().unwrap().down = true;
    tokio::time::sleep(Duration::from_millis(3300)).await;

    let (status, reply) = s.post("/api/balance/bet", classic("UP", 100.0)).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{reply}");
    assert_eq!(reply["code"], "price_unavailable");
    assert_eq!(s.balance(), 100 * UNIT);
    assert_eq!(s.audit_rows("bet_lock"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forged_multiplier_is_refused() {
    let (s, _feed, _) = Server::start(100.0).await;
    let mut forged = classic("UP", 100.0);
    forged["multiplier"] = json!(20);

    let (status, reply) = s.post("/api/balance/bet", forged).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");
    assert_eq!(reply["code"], "multiplier_not_offered");
    assert_eq!(s.balance(), 100 * UNIT);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_cannot_put_a_price_in_the_feed() {
    let (s, _feed, _) = Server::start(100.0).await;
    let forged = json!({ "assets": ["BTC"], "prices": { "BTC": 1 }, "price": 1, "BTC": 1 });
    let (status, _) = s.post("/api/prices/latest", forged).await;
    assert_eq!(status, StatusCode::OK);
    let query = format!("{}/api/prices/latest?asset=BTC&price=1", s.url);
    s.http.get(query).send().await.unwrap();

    // The feed still says 100, so a strike of 1 is refused and 100 is taken.
    let (status, reply) = s.post("/api/balance/bet", classic("UP", 1.0)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{reply}");
    assert_eq!(reply["code"], "price_moved");
    let bet = s.bet(classic("UP", 100.0)).await;
    assert_eq!(bet["strikePrice"], json!(100.0));
}

// -- bands -------------------------------------------------------------------

/// A 3 s box round on `[bottom, top]`.
fn band(top: f64, bottom: f64, multiplier: f64, ahead_ms: i64) -> Value {
    json!({
        "userAddress": WALLET, "betAmount": 10, "currency": "USDC", "asset": "BTC",
        "mode": "box", "roundId": 1, "targetPrice": 100, "strikePrice": 100,
        "isOver": true, "multiplier": multiplier, "betRequestId": request_id(),
        "priceTop": top, "priceBottom": bottom,
        "endTime": chrono::Utc::now().timestamp_millis() + ahead_ms,
        "targetCell": { "id": 9, "priceChange": 10, "direction": "UP", "timeframe": 5 },
    })
}

/// Leaves a 2-wide range in the last 30 s, with the price back at 100.
async fn make_the_market_move(feed: &Feed) {
    set_price(feed, 102.0);
    after_the_next_sample().await;
    set_price(feed, 100.0);
    after_the_next_sample().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_band_round_pays_on_the_servers_price() {
    let (s, feed, _) = Server::start(100.0).await;
    make_the_market_move(&feed).await;

    let won = s.bet(band(100.4, 100.2, 1.5, 3_000)).await;
    assert!(won["endTime"].is_i64(), "{won}");
    let lost = s.bet(band(99.8, 99.6, 1.5, 3_000)).await;
    set_price(&feed, 100.3);

    s.wait_settled(&won).await;
    s.wait_settled(&lost).await;

    assert_eq!(s.round(&won).0.as_deref(), Some("win"));
    assert_eq!(s.round(&lost).0.as_deref(), Some("loss"));
    assert_eq!(s.balance(), 80 * UNIT + 15 * UNIT);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forged_or_late_band_is_refused() {
    let (s, feed, _) = Server::start(100.0).await;
    make_the_market_move(&feed).await;

    let refused = [
        (band(200.0, 100.01, 20.0, 5_000), "band_too_wide"),
        (band(100.4, 100.01, 20.0, 5_000), "multiplier_not_offered"),
        (band(100.2, 99.8, 2.0, 5_000), "multiplier_not_offered"),
        (band(100.4, 100.2, 1.5, 1_000), "betting_closed"),
        (band(100.2, 100.4, 1.5, 5_000), "invalid_band"),
    ];
    for (body, code) in refused {
        let (status, reply) = s.post("/api/balance/bet", body).await;
        assert_ne!(status, StatusCode::OK, "{code}: {reply}");
        assert_eq!(reply["code"], code, "{reply}");
    }
    assert_eq!(s.balance(), 100 * UNIT);
}

// -- agent -------------------------------------------------------------------

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

fn usdc(whole: i64) -> Decimal {
    Decimal::from(whole)
}

/// Yolo on BTC, 5 USDC a trade out of 5, valid for a minute from now.
fn yolo(signer: &SigningKey) -> StartTerms {
    StartTerms {
        wallet: address_of(signer),
        chain_id: 5042002,
        asset: "BTC".into(),
        mode: "yolo".into(),
        budget: usdc(5),
        max_per_trade: usdc(5),
        stop_loss: usdc(5),
        minutes: 5,
        expires_ms: chrono::Utc::now().timestamp_millis() + 60_000,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
    }
}

/// `(event, data)` frames off an SSE body.
struct SseFeed {
    res: reqwest::Response,
    buffer: String,
}

impl SseFeed {
    async fn next(&mut self) -> Option<(String, Value)> {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let frame: String = self.buffer.drain(..end + 2).collect();
                let mut event = String::new();
                let mut data = String::new();
                for line in frame.lines() {
                    if let Some(rest) = line.strip_prefix("event: ") {
                        event = rest.to_string();
                    } else if let Some(rest) = line.strip_prefix("data: ") {
                        data.push_str(rest);
                    }
                }
                if data.is_empty() {
                    continue;
                }
                return Some((event, serde_json::from_str(&data).unwrap()));
            }
            let chunk = self.res.chunk().await.ok()??;
            self.buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }

    /// The first frame of `event` that `wanted` accepts, within `secs`.
    async fn until(&mut self, event: &str, secs: u64, wanted: impl Fn(&Value) -> bool) -> Value {
        let found = tokio::time::timeout(Duration::from_secs(secs), async {
            while let Some((name, data)) = self.next().await {
                if name == event && wanted(&data) {
                    return data;
                }
            }
            panic!("feed ended before a matching {event}");
        });
        found
            .await
            .unwrap_or_else(|_| panic!("no matching {event} in {secs}s"))
    }
}

impl Server {
    /// `(status, body, agent cookie)`.
    async fn start_agent(
        &self,
        signer: &SigningKey,
        terms: &StartTerms,
    ) -> (StatusCode, Value, Option<String>) {
        let message = start_message(terms);
        let res = self
            .http
            .post(format!("{}/api/agent/start", self.url))
            .json(&json!({ "message": message, "signature": sign(signer, &message) }))
            .send()
            .await
            .unwrap();
        let status = res.status();
        let cookie = res
            .headers()
            .get("set-cookie")
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
        (status, res.json().await.unwrap_or(Value::Null), cookie)
    }

    async fn agent_post(&self, path: &str, cookie: Option<&str>) -> (StatusCode, Value) {
        let mut req = self.http.post(format!("{}{path}", self.url));
        if let Some(cookie) = cookie {
            req = req.header("cookie", cookie);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    async fn feed(&self, cookie: &str) -> SseFeed {
        let res = self
            .http
            .get(format!("{}/api/agent/decisions", self.url))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        SseFeed {
            res,
            buffer: String::new(),
        }
    }

    fn balance_of(&self, wallet: &str) -> i64 {
        self.sqlite()
            .query_row(
                "SELECT balance FROM user_balances WHERE user_address = ?1",
                [wallet],
                |r| r.get(0),
            )
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_price_move_makes_a_yolo_agent_place_a_bet_on_the_feed() {
    let (s, feed, _) = Server::start(100.0).await;
    let trader = key(7);
    let wallet = address_of(&trader);
    s.fund(&wallet, 100);

    let (status, body, cookie) = s.start_agent(&trader, &yolo(&trader)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cookie = cookie.expect("agent cookie");
    let mut decisions = s.feed(&cookie).await;
    let session = decisions.until("session", 5, |_| true).await;
    assert_eq!(session["status"], "running", "{session}");

    // Fifteen seconds of a flat 100, then a jump the 2 minute range can't hide.
    tokio::time::sleep(Duration::from_millis(16_000)).await;
    set_price(&feed, 101.0);

    let placed = decisions
        .until("decision", 15, |d| d["verdict"] == "placed")
        .await;
    assert_eq!(placed["direction"], "UP", "{placed}");
    assert_eq!(placed["stake"], json!(5.0), "{placed}");
    assert!(placed["confidence"].is_null(), "{placed}");
    assert!(placed["betId"].is_string(), "{placed}");
    assert_eq!(s.balance_of(&wallet), 95 * UNIT);

    let stopped = decisions
        .until("session", 10, |d| d["status"] == "stopped")
        .await;
    assert_eq!(stopped["stoppedReason"], "limit reached", "{stopped}");
    assert_eq!(stopped["spent"], json!(5.0), "{stopped}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_wallets_token_cannot_stop_or_read_a_session() {
    let (s, _feed, _) = Server::start(100.0).await;
    let (alice, bob) = (key(8), key(9));
    let (_, a, alice_cookie) = s.start_agent(&alice, &yolo(&alice)).await;
    let (_, b, bob_cookie) = s.start_agent(&bob, &yolo(&bob)).await;
    let (alice_cookie, bob_cookie) = (alice_cookie.unwrap(), bob_cookie.unwrap());

    // Alice's claims with a signature that isn't the server's.
    let (claims, sig) = alice_cookie.rsplit_once('.').unwrap();
    let flipped = if sig.ends_with('A') { "B" } else { "A" };
    let forged = format!("{claims}.{}{flipped}", &sig[..sig.len() - 1]);
    for cookie in [None, Some(forged.as_str()), Some("strike_agent=abc.def")] {
        let (status, reply) = s.agent_post("/api/agent/stop", cookie).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{reply}");
    }
    let res = s
        .http
        .get(format!("{}/api/agent/decisions", s.url))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let (status, reply) = s.agent_post("/api/agent/stop", Some(&bob_cookie)).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["session"]["id"], b["session"]["id"]);
    assert_eq!(reply["session"]["stoppedReason"], "You stopped the agent");

    let mut bobs = s.feed(&bob_cookie).await;
    let seen = bobs.until("session", 5, |_| true).await;
    assert_eq!(seen["id"], b["session"]["id"], "{seen}");
    let mut alices = s.feed(&alice_cookie).await;
    let seen = alices.until("session", 5, |_| true).await;
    assert_eq!(seen["id"], a["session"]["id"], "{seen}");
    assert_eq!(
        seen["status"], "running",
        "bob's stop reached alice: {seen}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_is_refused_with_the_reason() {
    let (s, _feed, _) = Server::start(100.0).await;
    let trader = key(10);
    let now = chrono::Utc::now().timestamp_millis();
    let refused: Vec<(StartTerms, StatusCode, &str)> = vec![
        (
            StartTerms {
                expires_ms: now - 1,
                ..yolo(&trader)
            },
            StatusCode::BAD_REQUEST,
            "Start message expired",
        ),
        (
            StartTerms {
                budget: usdc(101),
                ..yolo(&trader)
            },
            StatusCode::BAD_REQUEST,
            "Budget is above the 100 USDC ceiling",
        ),
        (
            StartTerms {
                max_per_trade: usdc(11),
                budget: usdc(20),
                ..yolo(&trader)
            },
            StatusCode::BAD_REQUEST,
            "Max per trade is above the 10 USDC ceiling",
        ),
        (
            StartTerms {
                minutes: 31,
                ..yolo(&trader)
            },
            StatusCode::BAD_REQUEST,
            "Session length is above the 30 minute ceiling",
        ),
        (
            StartTerms {
                asset: "AAPL".into(),
                ..yolo(&trader)
            },
            StatusCode::BAD_REQUEST,
            "The agent trades crypto assets only",
        ),
    ];
    for (terms, status, error) in refused {
        let (got, reply, cookie) = s.start_agent(&trader, &terms).await;
        assert_eq!(
            (got, reply["error"].as_str()),
            (status, Some(error)),
            "{reply}"
        );
        assert!(cookie.is_none());
    }

    // Signed by someone else.
    let (status, reply, _) = s.start_agent(&key(11), &yolo(&trader)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{reply}");

    let terms = yolo(&trader);
    let (status, _, cookie) = s.start_agent(&trader, &terms).await;
    assert_eq!(status, StatusCode::OK);
    let (status, reply, _) = s.start_agent(&trader, &yolo(&trader)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{reply}");
    assert_eq!(
        reply["error"],
        "This wallet already has an active agent session"
    );

    s.agent_post("/api/agent/stop", cookie.as_deref()).await;
    let (status, reply, _) = s.start_agent(&trader, &terms).await;
    assert_eq!(status, StatusCode::CONFLICT, "{reply}");
    assert_eq!(reply["error"], "Start message already used");
}
