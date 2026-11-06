use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get as http_get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::token::tests::{jwks, sign, KEY_PEM};
use super::*;

const AUD: &str = "client-1";
const WALLET: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Clone, Default)]
struct Fake {
    url: Arc<Mutex<String>>,
    answers: Arc<Mutex<VecDeque<(u16, Value)>>>,
    polls: Arc<Mutex<Vec<Instant>>>,
}

async fn discovery(State(f): State<Fake>) -> Json<Value> {
    let url = f.url.lock().unwrap().clone();
    Json(json!({
        "issuer": url,
        "device_authorization_endpoint": format!("{url}/api/v1/device_authorization"),
        "token_endpoint": format!("{url}/api/v1/token"),
        "jwks_uri": format!("{url}/.well-known/jwks.json"),
    }))
}

async fn device() -> Json<Value> {
    Json(json!({
        "device_code": "secret-device-code",
        "user_code": "ABCD-EFGH",
        "verification_uri": "https://world.example/device",
        "verification_uri_complete": "https://world.example/device?code=ABCD-EFGH",
        "expires_in": 1200,
        "interval": 1,
    }))
}

async fn token(State(f): State<Fake>) -> (StatusCode, Json<Value>) {
    f.polls.lock().unwrap().push(Instant::now());
    let (status, body) = f
        .answers
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or((400, json!({ "error": "authorization_pending" })));
    (StatusCode::from_u16(status).unwrap(), Json(body))
}

struct World {
    fake: Fake,
    cfg: &'static ApConfig,
    db: &'static Db,
}

async fn world() -> World {
    let fake = Fake::default();
    let app = Router::new()
        .route("/.well-known/openid-configuration", http_get(discovery))
        .route(
            "/.well-known/jwks.json",
            http_get(|| async { Json(serde_json::to_value(jwks()).unwrap()) }),
        )
        .route("/api/v1/device_authorization", post(device))
        .route("/api/v1/token", post(token))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    *fake.url.lock().unwrap() = url.clone();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let path = std::env::temp_dir().join(format!("agentpass-{}.sqlite", uuid::Uuid::new_v4()));
    let db = Box::leak(Box::new(Db::open(&path, 1, 5_000).unwrap()));
    let cfg = Box::leak(Box::new(ApConfig::new(&url, AUD, "secret")));
    World { fake, cfg, db }
}

fn human(id: &str) -> Human {
    Human {
        id: id.into(),
        tier: "orb".into(),
        ap_sub: None,
        cooloff_until: None,
    }
}

fn claims(w: &World, sub: &str) -> Value {
    let now = chrono::Utc::now().timestamp();
    json!({
        "iss": w.cfg.issuer, "aud": AUD, "sub": sub,
        "exp": now + 300, "iat": now, "auth_time": now,
        "acr": ORB, "amr": ["pop"],
    })
}

fn id_token(w: &World, sub: &str) -> Value {
    json!({ "id_token": sign(KEY_PEM, &claims(w, sub)) })
}

impl World {
    fn answer(&self, status: u16, body: Value) {
        self.fake.answers.lock().unwrap().push_back((status, body));
    }

    async fn start(&self, who: &str, key: &str) -> Stepup {
        let action = Action {
            kind: "withdraw",
            key: key.into(),
            summary: "Withdraw 30 USDC".into(),
            session_id: None,
        };
        let now = crate::bets::now_ms();
        begin_with(self.db, Some(self.cfg), &human(who), WALLET, action, now)
            .await
            .unwrap()
            .unwrap()
    }

    async fn outcome(&self, id: &str) -> Stepup {
        for _ in 0..200 {
            let stepup = get(self.db, id, crate::bets::now_ms())
                .await
                .unwrap()
                .unwrap();
            if stepup.status != "pending" {
                return stepup;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("stepup {id} still pending");
    }

    async fn spend(&self, id: &str, who: &str, key: &str) -> Result<(), Rejection> {
        consume_now(self.db, id, who, "withdraw", key, crate::bets::now_ms())
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn an_approval_is_verified_linked_and_spent_once() {
    let w = world().await;
    let stepup = w.start("h1", "w:1").await;
    assert_eq!(stepup.status, "pending");
    let shown = stepup.to_json();
    assert_eq!(shown["userCode"], "ABCD-EFGH");
    assert_eq!(shown["summary"], "Withdraw 30 USDC");
    assert!(!shown.to_string().contains("secret-device-code"));
    assert_eq!(w.start("h1", "w:1").await.id, stepup.id);

    w.answer(200, id_token(&w, "sub-1"));
    let done = w.outcome(&stepup.id).await;
    assert_eq!(done.status, "approved", "{:?}", done.reason);

    assert_eq!(w.spend(&stepup.id, "h1", "w:2").await.unwrap_err().0, 403);
    assert_eq!(w.spend(&stepup.id, "h2", "w:1").await.unwrap_err().0, 403);
    w.spend(&stepup.id, "h1", "w:1").await.unwrap();
    let again = w.spend(&stepup.id, "h1", "w:1").await.unwrap_err();
    assert_eq!(
        (again.0, again.1["code"].as_str()),
        (409, Some("stepup_used"))
    );

    let other = w.start("h2", "w:3").await;
    w.answer(200, id_token(&w, "sub-1"));
    assert_eq!(w.outcome(&other.id).await.status, "mismatch");
    let refused = w.spend(&other.id, "h2", "w:3").await.unwrap_err();
    assert_eq!(refused.1["code"], "human_mismatch");
    let swapped = w.start("h1", "w:4").await;
    w.answer(200, id_token(&w, "sub-2"));
    assert_eq!(w.outcome(&swapped.id).await.status, "mismatch");
}

#[tokio::test]
async fn every_world_error_ends_the_stepup_unapproved() {
    let w = world().await;
    for (status, body, expect) in [
        (400, json!({ "error": "access_denied" }), "denied"),
        (400, json!({ "error": "expired_token" }), "expired"),
        (400, json!({ "error": "invalid_grant" }), "failed"),
        (503, json!({}), "failed"),
        (429, json!({}), "failed"),
    ] {
        let key = format!("k:{expect}:{status}:{body}");
        let stepup = w.start("h1", &key).await;
        w.answer(400, json!({ "error": "authorization_pending" }));
        w.answer(status, body.clone());
        let done = w.outcome(&stepup.id).await;
        assert_eq!(done.status, expect, "{body}");
        let refused = w.spend(&stepup.id, "h1", &key).await.unwrap_err();
        assert!(matches!(refused.0, 403 | 410), "{refused:?}");
    }
    let forged = w.start("h1", "k:forged").await;
    w.answer(
        200,
        json!({ "id_token": sign(include_str!("test_key_other.pem"), &claims(&w, "s")) }),
    );
    let done = w.outcome(&forged.id).await;
    assert_eq!(done.status, "failed");
}

#[tokio::test]
async fn slow_down_adds_five_seconds_to_every_later_poll() {
    let w = world().await;
    let stepup = w.start("h1", "k:slow").await;
    w.answer(400, json!({ "error": "slow_down" }));
    w.answer(400, json!({ "error": "authorization_pending" }));
    w.answer(400, json!({ "error": "access_denied" }));
    for _ in 0..300 {
        if w.fake.polls.lock().unwrap().len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let polls = w.fake.polls.lock().unwrap().clone();
    assert_eq!(polls.len(), 3);
    for gap in [polls[1] - polls[0], polls[2] - polls[1]] {
        assert!(gap >= Duration::from_millis(5_900), "{gap:?}");
    }
    assert_eq!(w.outcome(&stepup.id).await.status, "denied");
}

#[tokio::test]
async fn a_cancelled_stepup_cannot_be_approved_or_spent() {
    let w = world().await;
    let stepup = w.start("h1", "k:cancel").await;
    cancel(w.db, &stepup.id, "You cancelled").await.unwrap();
    w.answer(200, id_token(&w, "sub-9"));
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let now = get(w.db, &stepup.id, crate::bets::now_ms())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(now.status, "cancelled");
    assert_eq!(
        w.spend(&stepup.id, "h1", "k:cancel").await.unwrap_err().0,
        403
    );
}
