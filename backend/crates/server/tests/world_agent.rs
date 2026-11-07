use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use k256::ecdsa::SigningKey;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use strike_core::address::keccak256;
use strike_core::agent::{start_message, StartTerms};
use strike_core::crypto::{mint_balance_session_with, BALANCE_SESSION_COOKIE};
use strike_core::payout_rules::withdrawal_intent_message;

const SECRET: &str = "world-agent-test-secret";
const CLIENT_ID: &str = "ap-client";
const KEY_PEM: &str = include_str!("../../core/src/agentpass/test_key.pem");
const KEY_N: &str = include_str!("../../core/src/agentpass/test_key.n");
const UNIT: i64 = 10_000_000_000;

fn key(byte: u8) -> SigningKey {
    SigningKey::from_slice(&[byte; 32]).unwrap()
}

fn address_of(signer: &SigningKey) -> String {
    let point = signer.verifying_key().to_encoded_point(false);
    format!(
        "0x{}",
        hex::encode(&keccak256(&point.as_bytes()[1..])[12..])
    )
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

#[derive(Clone, Default)]
struct Idp {
    url: Arc<Mutex<String>>,
    answers: Arc<Mutex<VecDeque<(u16, Value)>>>,
}

impl Idp {
    fn approve_as(&self, sub: &str) {
        let now = chrono::Utc::now().timestamp();
        let claims = json!({
            "iss": *self.url.lock().unwrap(), "aud": CLIENT_ID, "sub": sub,
            "exp": now + 300, "iat": now, "auth_time": now,
            "acr": "https://world.org/oidc/acr/orb", "amr": ["pop"],
        });
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-1".into());
        let token = encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_pem(KEY_PEM.as_bytes()).unwrap(),
        )
        .unwrap();
        self.answer(200, json!({ "id_token": token, "token_type": "Bearer" }));
    }

    fn answer(&self, status: u16, body: Value) {
        self.answers.lock().unwrap().push_back((status, body));
    }
}

async fn idp() -> Idp {
    let idp = Idp::default();
    let app = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get(|State(idp): State<Idp>| async move {
                let url = idp.url.lock().unwrap().clone();
                Json(json!({
                    "issuer": url,
                    "device_authorization_endpoint": format!("{url}/api/v1/device_authorization"),
                    "token_endpoint": format!("{url}/api/v1/token"),
                    "jwks_uri": format!("{url}/.well-known/jwks.json"),
                }))
            }),
        )
        .route(
            "/.well-known/jwks.json",
            get(|| async {
                Json(json!({ "keys": [{
                    "kty": "RSA", "kid": "test-1", "alg": "RS256", "use": "sig",
                    "n": KEY_N.trim(), "e": "AQAB",
                }]}))
            }),
        )
        .route(
            "/api/v1/device_authorization",
            post(|| async {
                Json(json!({
                    "device_code": format!("dc-{}", uuid::Uuid::new_v4()),
                    "user_code": "WXYZ-1234",
                    "verification_uri": "https://world.example/device",
                    "verification_uri_complete": "https://world.example/device?code=WXYZ-1234",
                    "expires_in": 1200,
                    "interval": 1,
                }))
            }),
        )
        .route(
            "/api/v1/token",
            post(|State(idp): State<Idp>| async move {
                let (status, body) = idp
                    .answers
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or((400, json!({ "error": "authorization_pending" })));
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    Json(body),
                )
            }),
        )
        .with_state(idp.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    *idp.url.lock().unwrap() = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    idp
}

struct Server {
    child: Child,
    dir: PathBuf,
    url: String,
    http: Client,
    idp: Idp,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let idp = idp().await;
    let dir = std::env::temp_dir().join(format!("strike-world-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let child = Command::new(env!("CARGO_BIN_EXE_strike-backend"))
        .current_dir(&dir)
        .env_clear()
        .envs(std::env::var("SystemRoot").map(|v| ("SystemRoot", v)))
        .env("SQLITE_PATH", dir.join("ledger.sqlite"))
        .env("BIND_ADDR", format!("127.0.0.1:{port}"))
        .env("BALANCE_INTERNAL_SECRET", SECRET)
        .env("BALANCE_SETTLEMENT_SECRET", "world-agent-settlement")
        .env("BINANCE_ENDPOINT", "http://127.0.0.1:9/ticker")
        .env("YAHOO_SPARK_ENDPOINT", "http://127.0.0.1:9/spark")
        .env("BINANCE_PERP_ENDPOINT", "http://127.0.0.1:9/perp")
        .env("KRAKEN_ENDPOINT", "http://127.0.0.1:9/kraken")
        .env("NEXT_PUBLIC_ARC_RPC_ENDPOINT", "http://127.0.0.1:9/rpc")
        .env("NEXT_PUBLIC_WORLD_APP_ID", "app_test")
        .env("WORLD_RP_ID", "rp_test")
        .env("WORLD_RP_SIGNING_KEY", hex::encode([5u8; 32]))
        .env("WORLD_ENVIRONMENT", "staging")
        .env("WORLD_AP_ISSUER", idp.url.lock().unwrap().clone())
        .env("WORLD_AP_CLIENT_ID", CLIENT_ID)
        .env("WORLD_AP_CLIENT_SECRET", "ap-secret")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let server = Server {
        child,
        dir,
        url: format!("http://127.0.0.1:{port}"),
        http: Client::new(),
        idp,
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
        let conn = rusqlite::Connection::open(self.dir.join("ledger.sqlite")).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn
    }

    fn verify(&self, human: &str, wallet: &str, tier: &str) {
        let db = self.db();
        db.execute(
            "INSERT OR IGNORE INTO humans (id, created_at) VALUES (?1, 0)",
            [human],
        )
        .unwrap();
        db.execute(
            "INSERT INTO human_wallets (wallet, human_id, linked_at) VALUES (?1, ?2, 0)",
            [wallet, human],
        )
        .unwrap();
        db.execute(
            "INSERT OR REPLACE INTO human_limits (human_id, tier) VALUES (?1, ?2)",
            [human, tier],
        )
        .unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        self.db().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    async fn post(&self, path: &str, body: &Value) -> (StatusCode, Value, Option<String>) {
        let res = self
            .http
            .post(format!("{}{path}", self.url))
            .bearer_auth(SECRET)
            .json(body)
            .send()
            .await
            .unwrap();
        let status = res.status();
        let challenge = res
            .headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap().to_string());
        (status, res.json().await.unwrap_or(Value::Null), challenge)
    }

    async fn settled(&self, id: &str) -> Value {
        for _ in 0..100 {
            let stepup: Value = self
                .http
                .get(format!("{}/api/stepups/{id}", self.url))
                .bearer_auth(SECRET)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if stepup["status"] != "pending" {
                return stepup;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("stepup {id} still pending");
    }
}

fn withdrawal(signer: &SigningKey, amount: f64) -> Value {
    let address = address_of(signer);
    let signed_at = chrono::Utc::now().timestamp_millis();
    let message = withdrawal_intent_message(&address, amount, "USDC", signed_at as f64);
    json!({
        "userAddress": address, "amount": amount, "currency": "USDC",
        "signature": sign(signer, &message), "signedAt": signed_at,
    })
}

fn step_up(status: StatusCode, body: &Value, challenge: &Option<String>) -> String {
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "step_up_required");
    let header = challenge.as_deref().unwrap_or_default();
    assert!(
        header.contains("insufficient_user_authentication")
            && header.contains("https://world.org/oidc/acr/orb"),
        "{header}"
    );
    assert_eq!(body["stepup"]["status"], "pending");
    assert_eq!(body["stepup"]["userCode"], "WXYZ-1234");
    assert!(!body.to_string().contains("\"dc-"), "device code leaked");
    body["stepup"]["id"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_big_withdrawal_queues_nothing_until_its_human_approves_once() {
    let s = start().await;
    let player = key(9);
    let wallet = address_of(&player);
    s.db()
        .execute(
            "INSERT INTO user_balances (user_address, currency, balance) VALUES (?1, 'USDC', ?2)",
            rusqlite::params![wallet, 100 * UNIT],
        )
        .unwrap();
    let queued = "SELECT count(*) FROM withdrawal_requests";

    let (status, body, _) = s
        .post("/api/balance/withdraw", &withdrawal(&player, 30.0))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("human_required"))
    );

    s.verify("h1", &wallet, "orb");
    let (status, body, _) = s
        .post("/api/balance/withdraw", &withdrawal(&player, 60.0))
        .await;
    assert_eq!(body["code"], "withdraw_cap", "{status} {body}");
    assert_eq!(s.count("SELECT count(*) FROM stepups"), 0);

    let intent = withdrawal(&player, 30.0);
    let (status, body, challenge) = s.post("/api/balance/withdraw", &intent).await;
    let denied = step_up(status, &body, &challenge);
    assert_eq!(body["stepup"]["summary"], "Withdraw 30 USDC");
    assert_eq!(s.count(queued), 0);

    s.idp.answer(400, json!({ "error": "access_denied" }));
    assert_eq!(s.settled(&denied).await["status"], "denied");
    let mut retry = intent.clone();
    retry["stepupId"] = json!(denied);
    let (status, body, _) = s.post("/api/balance/withdraw", &retry).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("stepup_denied"))
    );
    assert_eq!(s.count(queued), 0);

    let (status, body, challenge) = s.post("/api/balance/withdraw", &intent).await;
    let fresh = step_up(status, &body, &challenge);
    assert_ne!(fresh, denied);
    let mut other = withdrawal(&player, 40.0);
    other["stepupId"] = json!(fresh);
    s.idp.approve_as("sub-1");
    assert_eq!(s.settled(&fresh).await["status"], "approved");
    let (status, _, _) = s.post("/api/balance/withdraw", &other).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(s.count(queued), 0);

    let mut approved = intent.clone();
    approved["stepupId"] = json!(fresh);
    let (status, body, _) = s.post("/api/balance/withdraw", &approved).await;
    assert_ne!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_ne!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(s.count(queued), 1);
    assert_eq!(s.settled(&fresh).await["status"], "used");
    let (status, body, _) = s.post("/api/balance/withdraw", &approved).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("stepup_used"))
    );
    assert_eq!(s.count(queued), 1);

    let (status, body, _) = s
        .post("/api/balance/withdraw", &withdrawal(&player, 5.0))
        .await;
    assert_ne!(status, StatusCode::UNAUTHORIZED, "{body}");
}

fn yolo(wallet: &str) -> StartTerms {
    StartTerms {
        wallet: wallet.into(),
        chain_id: 5042002,
        asset: "BTC".into(),
        mode: "yolo".into(),
        budget: 10.into(),
        max_per_trade: 2.into(),
        stop_loss: 6.into(),
        minutes: 5,
        expires_ms: chrono::Utc::now().timestamp_millis() + 120_000,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_yolo_start_needs_an_orb_human_and_one_fresh_approval_from_the_same_world_id() {
    let s = start().await;
    let (alice, bob) = (key(11), key(12));
    let start = |signer: &SigningKey, terms: &StartTerms, stepup: Option<&str>| {
        let message = start_message(terms);
        let mut body = json!({ "message": message, "signature": sign(signer, &message) });
        if let Some(id) = stepup {
            body["stepupId"] = json!(id);
        }
        body
    };
    let alice_terms = yolo(&address_of(&alice));

    let (status, body, _) = s
        .post("/api/agent/start", &start(&alice, &alice_terms, None))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("human_required"))
    );

    s.verify("selfie-human", &address_of(&alice), "selfie");
    let (status, body, _) = s
        .post("/api/agent/start", &start(&alice, &alice_terms, None))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("human_tier_too_low"))
    );

    s.verify("orb-human", &address_of(&bob), "orb");
    let terms = yolo(&address_of(&bob));
    let (status, body, challenge) = s.post("/api/agent/start", &start(&bob, &terms, None)).await;
    let first = step_up(status, &body, &challenge);
    assert_eq!(
        body["stepup"]["summary"],
        "Start YOLO agent: 10 USDC, BTC, 5 min"
    );
    let (status, body, _) = s
        .post("/api/agent/start", &start(&bob, &terms, Some(&first)))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("stepup_pending"))
    );
    assert_eq!(s.count("SELECT count(*) FROM agent_sessions"), 0);

    s.idp.answer(400, json!({ "error": "invalid_grant" }));
    assert_eq!(s.settled(&first).await["status"], "failed");
    let (status, body, _) = s
        .post("/api/agent/start", &start(&bob, &terms, Some(&first)))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::GONE, Some("stepup_expired"))
    );

    let (status, body, challenge) = s.post("/api/agent/start", &start(&bob, &terms, None)).await;
    let second = step_up(status, &body, &challenge);
    s.idp.approve_as("bob-world-id");
    assert_eq!(s.settled(&second).await["status"], "approved");
    let mut bigger = terms.clone();
    bigger.minutes = 4;
    let (status, _, _) = s
        .post("/api/agent/start", &start(&bob, &bigger, Some(&second)))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body, _) = s
        .post("/api/agent/start", &start(&bob, &terms, Some(&second)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["session"]["status"], "running");
    assert_eq!(s.settled(&second).await["status"], "used");

    let carol = key(13);
    s.verify("carol", &address_of(&carol), "orb");
    let carol_terms = yolo(&address_of(&carol));
    let (status, body, challenge) = s
        .post("/api/agent/start", &start(&carol, &carol_terms, None))
        .await;
    let stolen = step_up(status, &body, &challenge);
    s.idp.approve_as("bob-world-id");
    assert_eq!(s.settled(&stolen).await["status"], "mismatch");
    let (status, body, _) = s
        .post(
            "/api/agent/start",
            &start(&carol, &carol_terms, Some(&stolen)),
        )
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("human_mismatch"))
    );
}

impl Server {
    async fn post_cookie(
        &self,
        path: &str,
        cookie: &str,
        body: &Value,
    ) -> (StatusCode, Value, Option<String>) {
        let res = self
            .http
            .post(format!("{}{path}", self.url))
            .header("cookie", cookie)
            .json(body)
            .send()
            .await
            .unwrap();
        let status = res.status();
        let challenge = res
            .headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap().to_string());
        let set = res
            .headers()
            .get("set-cookie")
            .map(|v| v.to_str().unwrap().to_string());
        let body = res.json().await.unwrap_or(Value::Null);
        let carried = challenge.or(set);
        (status, body, carried)
    }

    /// Starts a normal session and returns the cookie that follows it.
    async fn start_normal(&self, signer: &SigningKey) -> String {
        let mut terms = yolo(&address_of(signer));
        terms.mode = "normal".into();
        let message = start_message(&terms);
        let body = json!({ "message": message, "signature": sign(signer, &message) });
        let (status, body, cookie) = self.post_cookie("/api/agent/start", "", &body).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        cookie.unwrap().split(';').next().unwrap().to_string()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_agent_switches_to_yolo_only_with_a_fresh_orb_approval() {
    let s = start().await;
    let (selfie, orb) = (key(21), key(22));
    s.verify("selfie-human", &address_of(&selfie), "selfie");
    s.verify("orb-human", &address_of(&orb), "orb");
    let to = |mode: &str| json!({ "mode": mode });
    let yolo_with = |id: &str| json!({ "mode": "yolo", "stepupId": id });

    let low = s.start_normal(&selfie).await;
    let (status, body, _) = s.post_cookie("/api/agent/mode", &low, &to("yolo")).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("human_tier_too_low"))
    );

    let cookie = s.start_normal(&orb).await;
    let (status, _, _) = s
        .post_cookie("/api/agent/mode", &cookie, &to("turbo"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = s.post_cookie("/api/agent/mode", "", &to("yolo")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body, challenge) = s.post_cookie("/api/agent/mode", &cookie, &to("yolo")).await;
    let first = step_up(status, &body, &challenge);
    let (status, body, _) = s
        .post_cookie("/api/agent/mode", &cookie, &yolo_with(&first))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("stepup_pending"))
    );
    assert_eq!(
        s.count("SELECT count(*) FROM agent_sessions WHERE mode = 'yolo'"),
        0
    );

    s.idp.approve_as("orb-world-id");
    assert_eq!(s.settled(&first).await["status"], "approved");
    let (status, body, _) = s
        .post_cookie("/api/agent/mode", &cookie, &yolo_with(&first))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["session"]["mode"], "yolo");
    assert_eq!(s.settled(&first).await["status"], "used");

    let (status, body, _) = s.post_cookie("/api/agent/mode", &cookie, &to("yolo")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["session"]["mode"], "yolo");

    let (status, body, _) = s
        .post_cookie("/api/agent/mode", &cookie, &to("normal"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["session"]["mode"], "normal");

    let (status, body, _) = s
        .post_cookie("/api/agent/mode", &cookie, &yolo_with(&first))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("stepup_used"))
    );

    let (status, _, _) = s.post_cookie("/api/agent/stop", &cookie, &json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body, _) = s
        .post_cookie("/api/agent/mode", &cookie, &to("normal"))
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("not_running"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wallet_reconnects_to_its_running_agent_from_a_new_browser() {
    let s = start().await;
    let (alice, bob) = (key(31), key(32));
    s.verify("alice", &address_of(&alice), "selfie");
    let wallet = address_of(&alice);
    let original = s.start_normal(&alice).await;
    let signed_in = |who: &str| {
        let token = mint_balance_session_with(Some(SECRET), who).unwrap();
        format!("{BALANCE_SESSION_COOKIE}={token}")
    };
    let body = json!({ "wallet": wallet });

    let (status, reply, _) = s.post_cookie("/api/agent/resume", "", &body).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{reply}");
    let other = signed_in(&address_of(&bob));
    let (status, reply, _) = s.post_cookie("/api/agent/resume", &other, &body).await;
    assert_eq!(
        (status, reply["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("session_required"))
    );
    let bob_body = json!({ "wallet": address_of(&bob) });
    let (status, _, _) = s.post_cookie("/api/agent/resume", &other, &bob_body).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = s
        .post_cookie("/api/agent/resume", &other, &json!({ "wallet": "nope" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let mine = signed_in(&wallet);
    let (status, reply, cookie) = s.post_cookie("/api/agent/resume", &mine, &body).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["session"]["status"], "running");
    let cookie = cookie.unwrap();
    let cookie = cookie.split(';').next().unwrap();

    let (status, reply, _) = s.post_cookie("/api/agent/stop", cookie, &json!({})).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["session"]["stoppedReason"], "You stopped the agent");
    let (status, _, _) = s.post_cookie("/api/agent/resume", &mine, &body).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, reply, _) = s
        .post_cookie("/api/agent/stop", &original, &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
}
