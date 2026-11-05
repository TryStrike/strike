//! The real binary over real HTTP, on a throwaway database, from a directory with
//! no env file, for what only shows at the route: status codes and body shapes.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

const SECRET: &str = "http-test-secret";
const PASSWORD: &str = "http-test-password";
const WALLET: &str = "0x1111111111111111111111111111111111111111";

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

async fn start() -> Server {
    start_with(&[]).await
}

async fn start_with(env: &[(&str, &str)]) -> Server {
    let dir = std::env::temp_dir().join(format!("strike-http-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_strike-backend"))
        .current_dir(&dir)
        .env_clear()
        .env("SQLITE_PATH", dir.join("ledger.sqlite"))
        .env("BIND_ADDR", format!("127.0.0.1:{port}"))
        .env("BALANCE_INTERNAL_SECRET", SECRET)
        .env("DASHBOARD_PASSWORD", PASSWORD)
        // The sampler starts with the server: nothing here may reach the market.
        .env("BINANCE_ENDPOINT", "http://127.0.0.1:9/ticker")
        .env("YAHOO_SPARK_ENDPOINT", "http://127.0.0.1:9/spark")
        .envs(env.iter().copied())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let server = Server {
        child,
        dir,
        url: format!("http://127.0.0.1:{port}"),
        http: Client::new(),
    };
    for _ in 0..500 {
        if server
            .http
            .get(format!("{}/api/health", server.url))
            .send()
            .await
            .is_ok()
        {
            return server;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("server did not start");
}

impl Server {
    async fn admin_cookie(&self) -> String {
        let res = self
            .http
            .post(format!("{}/api/admin/auth", self.url))
            .json(&json!({ "password": PASSWORD }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie = res.headers()["set-cookie"].to_str().unwrap();
        cookie.split(';').next().unwrap().to_string()
    }

    async fn get_admin(&self, path: &str, cookie: &str) -> (StatusCode, Value) {
        let res = self
            .http
            .get(format!("{}{path}", self.url))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap();
        (res.status(), res.json().await.unwrap())
    }

    async fn post_bearer(&self, path: &str, body: Value) -> (StatusCode, Value) {
        let res = self
            .http
            .post(format!("{}{path}", self.url))
            .bearer_auth(SECRET)
            .json(&body)
            .send()
            .await
            .unwrap();
        (res.status(), res.json().await.unwrap())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_failures_are_401_not_500() {
    let s = start().await;
    let list = s
        .http
        .get(format!("{}/api/withdrawals", s.url))
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::UNAUTHORIZED);
    let code = s
        .http
        .post(format!("{}/api/validate-access-code", s.url))
        .json(&json!({ "code": "X", "walletAddress": WALLET }))
        .send()
        .await
        .unwrap();
    assert_eq!(code.status(), StatusCode::UNAUTHORIZED);
    let forged = s
        .http
        .get(format!("{}/api/withdrawals", s.url))
        .bearer_auth("wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bet_save_needs_a_real_wallet() {
    let s = start().await;
    for wallet in [json!(42), json!(true), json!(["x"]), json!("not-a-wallet")] {
        let body = json!({ "id": "bet-1", "walletAddress": wallet });
        let (status, reply) = s.post_bearer("/api/bets/save", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");
    }
    let body = json!({ "id": "bet-1", "walletAddress": WALLET });
    let (status, reply) = s.post_bearer("/api/bets/save", body).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_accepted_ping_carries_the_timing_fields() {
    let s = start().await;
    let ping = |session: Value| {
        let body = json!({ "wallet_address": WALLET, "session_id": session });
        let (s, body) = (&s, body);
        async move { s.post_bearer("/api/session/ping", body).await.1 }
    };
    let created = ping(Value::Null).await;
    assert_eq!(created["status"], "created");
    let updated = ping(created["session_id"].clone()).await;
    assert_eq!(updated["status"], "updated");
    let resumed = ping(json!("not-a-uuid")).await;
    assert_eq!(resumed["status"], "updated");

    for reply in [created, updated, resumed] {
        assert_eq!(reply["ttl_seconds"], 90, "{reply}");
        assert_eq!(reply["refresh_after_seconds"], 45, "{reply}");
        let at = |key: &str| {
            chrono::DateTime::parse_from_rfc3339(reply[key].as_str().unwrap())
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(at("expires_at") - at("server_time"), 90_000, "{reply}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_player_ledger_honours_its_parameters() {
    let s = start().await;
    let cookie = s.admin_cookie().await;
    for n in 1..=3 {
        let address = format!("0xa{n:039x}");
        // A real bet's history row is only ever written by settlement.
        rusqlite::Connection::open(s.dir.join("ledger.sqlite"))
            .unwrap()
            .execute(
                "INSERT INTO bet_history (id, wallet_address, amount) VALUES (?1, ?2, ?3)",
                rusqlite::params![format!("b{n}"), address, i64::from(n) * 10_000_000_000],
            )
            .unwrap();
    }

    let (status, all) = s.get_admin("/api/admin/player-ledger", &cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (&all["total"], &all["limit"], &all["offset"]),
        (&json!(3), &json!(50), &json!(0))
    );
    assert_eq!(all["players"][0]["_has_explicit_fee"], false);

    let (_, page) = s
        .get_admin("/api/admin/player-ledger?limit=1&offset=1", &cookie)
        .await;
    assert_eq!(page["players"].as_array().unwrap().len(), 1);
    assert_eq!(
        (&page["total"], &page["limit"], &page["offset"]),
        (&json!(3), &json!(1), &json!(1))
    );
    assert_eq!(page["players"][0], all["players"][1]);

    let (_, searched) = s
        .get_admin("/api/admin/player-ledger?q=0000002", &cookie)
        .await;
    assert_eq!(searched["total"], 1);

    let (status, _) = s
        .get_admin("/api/admin/player-ledger?limit=abc", &cookie)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lockout_follows_the_forwarded_client_not_the_header_text() {
    let s = start().await;
    let login = |forwarded: &'static str, password: &'static str| {
        let request = s
            .http
            .post(format!("{}/api/admin/auth", s.url))
            .header("x-forwarded-for", forwarded)
            .json(&json!({ "password": password }))
            .send();
        async move { request.await.unwrap().status() }
    };

    for _ in 0..4 {
        assert_eq!(
            login("6.6.6.6, 203.0.113.1", "wrong").await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        login("7.7.7.7, 203.0.113.1", "wrong").await,
        StatusCode::TOO_MANY_REQUESTS,
        "changing the spoofable left side does not reset the count"
    );
    assert_eq!(
        login("203.0.113.1", PASSWORD).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login("203.0.113.2", PASSWORD).await,
        StatusCode::OK,
        "another client is not locked out"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_response_carries_the_security_headers() {
    let s = start().await;
    for path in ["/api/health", "/api/no-such-route"] {
        let res = s.http.get(format!("{}{path}", s.url)).send().await.unwrap();
        let headers = res.headers();
        assert_eq!(headers["x-content-type-options"], "nosniff", "{path}");
        assert_eq!(headers["x-frame-options"], "DENY", "{path}");
        assert_eq!(
            headers["referrer-policy"], "strict-origin-when-cross-origin",
            "{path}"
        );
        assert!(
            headers["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'"),
            "{path}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cors_answers_the_configured_origin_only() {
    let s = start_with(&[("NEXT_PUBLIC_APP_URL", "https://app.example/")]).await;
    let origin = |from: &'static str| {
        let request = s
            .http
            .get(format!("{}/api/health", s.url))
            .header("origin", from)
            .send();
        async move {
            let res = request.await.unwrap();
            res.headers()
                .get("access-control-allow-origin")
                .map(|v| v.to_str().unwrap().to_string())
        }
    };
    assert_eq!(
        origin("https://app.example").await.as_deref(),
        Some("https://app.example")
    );
    // Fixed, never echoed: the browser refuses it for any other caller.
    assert_eq!(
        origin("https://evil.example").await.as_deref(),
        Some("https://app.example")
    );

    let preflight = s
        .http
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/balance/bet", s.url),
        )
        .header("origin", "https://app.example")
        .header("access-control-request-method", "POST")
        .send()
        .await
        .unwrap();
    assert!(preflight.status().is_success());
    let vary = preflight.headers()["vary"].to_str().unwrap();
    assert!(vary.to_lowercase().contains("origin"), "{vary}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ops_health_is_admin_only_and_reports_the_writer() {
    let s = start().await;
    let denied = s
        .http
        .get(format!("{}/api/admin/ops-health", s.url))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let cookie = s.admin_cookie().await;
    let (status, health) = s.get_admin("/api/admin/ops-health", &cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["stuckWithdrawals"]["count"], 0);
    assert_eq!(health["stuckWithdrawals"]["timeoutSeconds"], 600);
    assert!(health["writer"]["averageBatch"].is_number());
}
