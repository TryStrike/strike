use rusqlite::types::Value as Param;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use rust_decimal::Decimal;
use serde_json::{json, Value};

use super::attempt::settle;
use super::verify::HumanGrant;
use super::{tier_of, BANNED_HUMAN, EXPIRED, MISMATCH, NOT_CONFIGURED, VERIFIED};
use crate::address::canonical;
use crate::config::config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::money::{from_fixed, MONEY_SCALE};

const DEV: &str = "dev:";
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Human {
    pub id: String,
    pub tier: String,
    pub ap_sub: Option<String>,
    pub cooloff_until: Option<i64>,
}

pub fn dev_bypass() -> bool {
    config().dev_no_world
}

pub fn gate_ready() -> Result<(), &'static str> {
    if config().world_idkit.is_some() || dev_bypass() {
        Ok(())
    } else {
        Err("world_unconfigured")
    }
}

pub(crate) fn human_of_wallet(conn: &Connection, wallet: &str) -> rusqlite::Result<Option<Human>> {
    lookup(conn, wallet, dev_bypass())
}

fn lookup(conn: &Connection, wallet: &str, dev: bool) -> rusqlite::Result<Option<Human>> {
    let wallet = canonical(wallet);
    let id = if dev {
        Some(format!("{DEV}{wallet}"))
    } else {
        conn.query_row(
            "SELECT human_id FROM human_wallets WHERE wallet = ?1",
            [&wallet],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    };
    let Some(id) = id else {
        return Ok(None);
    };
    let limits: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT tier, cooloff_until FROM human_limits WHERE human_id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (tier, until) = limits.unwrap_or_else(|| ("selfie".into(), None));
    let ap_sub = conn
        .query_row(
            "SELECT sub FROM human_ids WHERE human_id = ?1 AND iss NOT LIKE 'idkit:%'",
            [&id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Some(Human {
        tier: if dev { "orb".into() } else { tier },
        id,
        ap_sub,
        cooloff_until: until.map(|us| us / 1_000),
    }))
}

pub(crate) fn wallets_of_human(conn: &Connection, human_id: &str) -> rusqlite::Result<Vec<String>> {
    if let Some(wallet) = human_id.strip_prefix(DEV) {
        return Ok(vec![wallet.to_string()]);
    }
    conn.prepare_cached("SELECT wallet FROM human_wallets WHERE human_id = ?1 ORDER BY linked_at")?
        .query_map([human_id], |r| r.get(0))?
        .collect()
}

pub(crate) fn link_agent_pass(
    conn: &Connection,
    human_id: &str,
    iss: &str,
    sub: &str,
    acr: &str,
    env: &str,
    now_ms: i64,
) -> rusqlite::Result<Result<(), &'static str>> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT human_id FROM human_ids WHERE iss = ?1 AND sub = ?2",
            [iss, sub],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == human_id => return Ok(Ok(())),
        Some(_) => return Ok(Err("human_mismatch")),
        None => {}
    }
    let other: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM human_ids WHERE human_id = ?1 AND iss NOT LIKE 'idkit:%')",
        [human_id],
        |r| r.get(0),
    )?;
    if other {
        return Ok(Err("human_mismatch"));
    }
    conn.execute(
        "INSERT INTO human_ids (iss, sub, human_id, acr, env, linked_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![iss, sub, human_id, acr, env, now_ms * 1_000],
    )?;
    Ok(Ok(()))
}

pub(crate) fn any_banned(conn: &Connection, wallets: &[String]) -> rusqlite::Result<bool> {
    let env = &config().banned_wallet_addresses;
    for wallet in wallets {
        let key = canonical(wallet);
        if env.iter().any(|banned| canonical(banned) == key) {
            return Ok(true);
        }
        let listed: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM banned_wallets WHERE wallet_address = ?1)",
            [&key],
            |r| r.get(0),
        )?;
        if listed {
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn finish_human(
    db: &Db,
    grant: HumanGrant,
    now_ms: i64,
) -> ApiResult<Result<String, (&'static str, &'static str)>> {
    db.write(move |conn| Ok(link_idkit(conn, &grant, now_ms)?))
        .await
}

fn link_idkit(
    conn: &Connection,
    grant: &HumanGrant,
    now_ms: i64,
) -> rusqlite::Result<Result<String, (&'static str, &'static str)>> {
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT status, wallet, expires_at FROM world_attempts WHERE id = ?1",
            [&grant.attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((status, wallet, expires_at)) = row else {
        return Ok(Err(("expired", EXPIRED)));
    };
    if status != "pending" {
        return Ok(Err(("expired", EXPIRED)));
    }
    let end = |status: &'static str, reason: &'static str| {
        settle(conn, &grant.attempt_id, status, reason, now_ms).map(|_| Err((status, reason)))
    };
    if expires_at <= now_ms * 1_000 {
        return end("expired", EXPIRED);
    }
    let known: Option<String> = conn
        .query_row(
            "SELECT human_id FROM human_ids WHERE iss = ?1 AND sub = ?2",
            [&grant.iss, &grant.sub],
            |r| r.get(0),
        )
        .optional()?;
    let linked: Option<String> = conn
        .query_row(
            "SELECT human_id FROM human_wallets WHERE wallet = ?1",
            [&wallet],
            |r| r.get(0),
        )
        .optional()?;
    if linked.is_some() && linked != known {
        return end("mismatch", MISMATCH);
    }
    let mut wallets = match &known {
        Some(human) => wallets_of_human(conn, human)?,
        None => vec![],
    };
    wallets.push(wallet.clone());
    if any_banned(conn, &wallets)? {
        return end("denied", BANNED_HUMAN);
    }
    let at = now_ms * 1_000;
    let human = match known {
        Some(human) => human,
        None => {
            let human = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO humans (id, created_at) VALUES (?1, ?2)",
                params![human, at],
            )?;
            conn.execute(
                "INSERT INTO human_ids (iss, sub, human_id, acr, env, linked_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![grant.iss, grant.sub, human, grant.acr, grant.env, at],
            )?;
            human
        }
    };
    if linked.is_none() {
        conn.execute(
            "INSERT INTO human_wallets (wallet, human_id, linked_at) VALUES (?1, ?2, ?3)",
            params![wallet, human, at],
        )?;
    }
    conn.execute(
        "INSERT INTO human_limits (human_id, tier) VALUES (?1, ?2) \
         ON CONFLICT (human_id) DO UPDATE SET \
           tier = CASE WHEN excluded.tier = 'orb' THEN 'orb' ELSE tier END",
        params![human, tier_of(&grant.acr)],
    )?;
    conn.execute(
        "UPDATE world_attempts SET status = 'approved', reason = ?2, acr = ?3, done_at = ?4 \
         WHERE id = ?1 AND status = 'pending'",
        params![grant.attempt_id, VERIFIED, grant.acr, at],
    )?;
    Ok(Ok(human))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub until: Option<i64>,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>, until: Option<i64>) -> Self {
        Self {
            code,
            message: message.into(),
            until,
        }
    }

    pub fn into_error(self) -> ApiError {
        let err = ApiError::coded(self.code, self.message);
        match self.until {
            Some(until) => err.with("until", json!(until)),
            None => err,
        }
    }
}

fn sum_over(
    conn: &Connection,
    sql: &str,
    first: Option<i64>,
    wallets: &[String],
) -> rusqlite::Result<Decimal> {
    let from = 1 + usize::from(first.is_some());
    let list = (from..from + wallets.len())
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = sql.replace("{wallets}", if list.is_empty() { "NULL" } else { &list });
    let params = first
        .map(Param::Integer)
        .into_iter()
        .chain(wallets.iter().map(|w| Param::Text(w.clone())));
    let fixed: i64 = conn
        .prepare_cached(&sql)?
        .query_row(params_from_iter(params), |r| r.get(0))?;
    Ok(from_fixed(fixed, MONEY_SCALE))
}

fn open_stake(conn: &Connection, wallets: &[String]) -> rusqlite::Result<Decimal> {
    sum_over(
        conn,
        "SELECT coalesce(sum(stake), 0) FROM bet_rounds \
         WHERE outcome IS NULL AND user_address IN ({wallets})",
        None,
        wallets,
    )
}

fn lost_today(conn: &Connection, wallets: &[String], now_ms: i64) -> rusqlite::Result<Decimal> {
    let midnight_us = (now_ms - now_ms.rem_euclid(DAY_MS)) * 1_000;
    let net = sum_over(
        conn,
        "SELECT coalesce(sum(stake - payout), 0) FROM bet_rounds \
         WHERE outcome IS NOT NULL AND settled_at >= ?1 AND user_address IN ({wallets})",
        Some(midnight_us),
        wallets,
    )?;
    Ok(net.max(Decimal::ZERO))
}

pub(crate) fn bet_refusal(
    conn: &Connection,
    wallet: &str,
    stake: Decimal,
    now_ms: i64,
) -> rusqlite::Result<Option<Refusal>> {
    if let Err(code) = gate_ready() {
        return Ok(Some(Refusal::new(code, NOT_CONFIGURED, None)));
    }
    check_bet(conn, wallet, stake, now_ms, dev_bypass())
}

fn check_bet(
    conn: &Connection,
    wallet: &str,
    stake: Decimal,
    now_ms: i64,
    dev: bool,
) -> rusqlite::Result<Option<Refusal>> {
    let Some(human) = lookup(conn, wallet, dev)? else {
        return Ok(Some(Refusal::new(
            "human_required",
            "Verify with World ID before placing a bet",
            None,
        )));
    };
    let wallets = wallets_of_human(conn, &human.id)?;
    if any_banned(conn, &wallets)? {
        return Ok(Some(Refusal::new("banned", BANNED_HUMAN, None)));
    }
    if let Some(until) = human.cooloff_until.filter(|until| *until > now_ms) {
        return Ok(Some(Refusal::new(
            "human_cooloff",
            "Cooling off after today's losses",
            Some(until),
        )));
    }
    let limits = &config().world_limits;
    let caps = limits.caps(&human.tier);
    if lost_today(conn, &wallets, now_ms)? >= caps.daily_loss {
        let until = now_ms + limits.cooloff_min * 60_000;
        conn.execute(
            "INSERT INTO human_limits (human_id, tier, cooloff_until) VALUES (?1, ?2, ?3) \
             ON CONFLICT (human_id) DO UPDATE SET cooloff_until = excluded.cooloff_until",
            params![human.id, human.tier, until * 1_000],
        )?;
        return Ok(Some(Refusal::new(
            "human_daily_loss",
            format!("Daily loss limit of {} USDC reached", caps.daily_loss),
            Some(until),
        )));
    }
    if open_stake(conn, &wallets)? + stake > caps.open_cap {
        return Ok(Some(Refusal::new(
            "human_exposure_cap",
            format!(
                "Open bets are limited to {} USDC per human at the {} tier",
                caps.open_cap, human.tier
            ),
            None,
        )));
    }
    Ok(None)
}

pub async fn human_status(db: &Db, wallet: &str, now_ms: i64) -> ApiResult<Value> {
    let wallet = wallet.to_string();
    db.read(move |conn| {
        let Some(human) = human_of_wallet(conn, &wallet)? else {
            return Ok(json!({
                "verified": false,
                "tier": null,
                "wallets": [],
                "open": 0,
                "lostToday": 0,
                "cooloffUntil": null,
                "caps": null,
                "agentPassLinked": false,
            }));
        };
        let wallets = wallets_of_human(conn, &human.id)?;
        let caps = config().world_limits.caps(&human.tier);
        Ok(json!({
            "verified": true,
            "tier": human.tier,
            "wallets": wallets,
            "open": open_stake(conn, &wallets)?,
            "lostToday": lost_today(conn, &wallets, now_ms)?,
            "cooloffUntil": human.cooloff_until.filter(|until| *until > now_ms),
            "caps": { "openCap": caps.open_cap, "dailyLoss": caps.daily_loss },
            "agentPassLinked": human.ap_sub.is_some(),
        }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ACR_PREFIX;

    const NOW_MS: i64 = 1_800_000_000_000;
    const A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "0xcccccccccccccccccccccccccccccccccccccccc";

    struct Temp(std::path::PathBuf, Option<Db>);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("humans-{}.sqlite", uuid::Uuid::new_v4()));
            let db = Db::open(&path, 1, 5_000).unwrap();
            Self(path, Some(db))
        }

        async fn run<T: Send + 'static>(
            &self,
            job: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
        ) -> T {
            self.1
                .as_ref()
                .unwrap()
                .write(move |conn| Ok(job(conn)?))
                .await
                .unwrap()
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            drop(self.1.take());
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
            }
        }
    }

    fn pending(conn: &Connection, id: &str, wallet: &str) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO world_attempts (id, wallet, message, nonce, browser, acr_allowed, \
             status, expires_at, created_at) VALUES (?1, ?2, ?1, 'n', 'b', 'x', 'pending', ?3, ?4)",
            params![id, wallet, (NOW_MS + 60_000) * 1_000, NOW_MS * 1_000],
        )?;
        Ok(())
    }

    fn grant(attempt: &str, nullifier: &str, class: &str) -> HumanGrant {
        HumanGrant {
            attempt_id: attempt.into(),
            iss: "idkit:rp_test:strike-human".into(),
            sub: nullifier.into(),
            acr: format!("{ACR_PREFIX}{class}"),
            env: "staging".into(),
        }
    }

    fn verify(
        conn: &Connection,
        attempt: &str,
        wallet: &str,
        nullifier: &str,
        class: &str,
    ) -> rusqlite::Result<Result<String, (&'static str, &'static str)>> {
        pending(conn, attempt, wallet)?;
        link_idkit(conn, &grant(attempt, nullifier, class), NOW_MS)
    }

    fn usdc(n: i64) -> i64 {
        n * 10i64.pow(MONEY_SCALE)
    }

    fn round(conn: &Connection, id: &str, wallet: &str, stake: i64, payout: Option<i64>) {
        let settled = payout.map(|_| NOW_MS * 1_000);
        conn.execute(
            "INSERT INTO bet_rounds (bet_id, user_address, currency, asset, mode, direction, \
             stake, multiplier, strike_price, strike_at, strike_source, end_time, created_at, \
             end_price, end_price_at, end_source, outcome, payout, settled_by, settled_at) \
             VALUES (?1, ?2, 'USDC', 'BTC', 'binomo', 'UP', ?3, 19000, 1, 1, 'binance', 2, 1, \
                     ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                wallet,
                usdc(stake),
                payout.map(|_| 1),
                payout.map(|_| 2),
                payout.map(|_| "binance"),
                payout.map(|p| if p > 0 { "win" } else { "loss" }),
                payout.map(usdc),
                payout.map(|_| "claim"),
                settled
            ],
        )
        .unwrap();
    }

    fn code(refusal: Option<Refusal>) -> Option<&'static str> {
        refusal.map(|r| r.code)
    }

    #[tokio::test]
    async fn nullifiers_make_humans_and_wallets_join_them() {
        let t = Temp::new();
        t.run(|conn| {
            let h1 = verify(conn, "a1", A, "n1", "selfie")?.unwrap();
            assert_eq!(lookup(conn, A, false)?.unwrap().tier, "selfie");
            assert_eq!(verify(conn, "b1", B, "n1", "selfie")?, Ok(h1.clone()));
            assert_eq!(wallets_of_human(conn, &h1)?, vec![A, B]);
            assert_eq!(
                verify(conn, "a2", A, "n2", "orb")?,
                Err(("mismatch", MISMATCH))
            );
            assert!(lookup(conn, C, false)?.is_none());
            assert_eq!(verify(conn, "b2", B, "n1", "orb-face")?, Ok(h1.clone()));
            assert_eq!(lookup(conn, A, false)?.unwrap().tier, "orb");
            assert_eq!(verify(conn, "a3", A, "n1", "selfie")?, Ok(h1.clone()));
            assert_eq!(lookup(conn, B, false)?.unwrap().tier, "orb");
            let status: String = conn.query_row(
                "SELECT status FROM world_attempts WHERE id = 'a3'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(status, "approved");
            conn.execute(
                "INSERT INTO banned_wallets (wallet_address) VALUES (?1)",
                [A],
            )?;
            assert_eq!(
                verify(conn, "c1", C, "n1", "orb")?,
                Err(("denied", BANNED_HUMAN))
            );
            Ok(())
        })
        .await;
    }

    #[tokio::test]
    async fn agent_pass_links_once_per_human() {
        let t = Temp::new();
        t.run(|conn| {
            let h1 = verify(conn, "a1", A, "n1", "orb")?.unwrap();
            let h2 = verify(conn, "b1", B, "n2", "orb")?.unwrap();
            let ap = "https://auth.world.org";
            assert_eq!(
                link_agent_pass(conn, &h1, ap, "s1", "orb", "production", NOW_MS)?,
                Ok(())
            );
            assert_eq!(
                link_agent_pass(conn, &h1, ap, "s1", "orb", "production", NOW_MS)?,
                Ok(())
            );
            assert_eq!(
                lookup(conn, A, false)?.unwrap().ap_sub.as_deref(),
                Some("s1")
            );
            assert_eq!(
                link_agent_pass(conn, &h2, ap, "s1", "orb", "production", NOW_MS)?,
                Err("human_mismatch")
            );
            assert_eq!(
                link_agent_pass(conn, &h1, ap, "s2", "orb", "production", NOW_MS)?,
                Err("human_mismatch")
            );
            Ok(())
        })
        .await;
    }

    #[tokio::test]
    async fn caps_count_across_every_wallet_of_a_human() {
        let t = Temp::new();
        t.run(|conn| {
            let ten = Decimal::from(10);
            assert_eq!(
                code(check_bet(conn, C, ten, NOW_MS, false)?),
                Some("human_required")
            );
            let human = verify(conn, "a1", A, "n1", "orb")?.unwrap();
            verify(conn, "b1", B, "n1", "orb")?.unwrap();
            assert_eq!(code(check_bet(conn, A, ten, NOW_MS, false)?), None);
            round(conn, "r1", A, 30, None);
            round(conn, "r2", B, 15, None);
            assert_eq!(
                code(check_bet(conn, B, Decimal::from(5), NOW_MS, false)?),
                None
            );
            assert_eq!(
                code(check_bet(conn, A, Decimal::from(6), NOW_MS, false)?),
                Some("human_exposure_cap")
            );
            round(conn, "r3", A, 150, Some(0));
            round(conn, "r4", B, 60, Some(10));
            let hit = check_bet(conn, B, Decimal::ONE, NOW_MS, false)?.unwrap();
            assert_eq!(hit.code, "human_daily_loss");
            assert_eq!(hit.until, Some(NOW_MS + 30 * 60_000));
            let later = NOW_MS + 60_000;
            let cooling = check_bet(conn, A, Decimal::ONE, later, false)?.unwrap();
            assert_eq!((cooling.code, cooling.until), ("human_cooloff", hit.until));
            let tomorrow = NOW_MS + DAY_MS;
            assert_eq!(
                code(check_bet(conn, A, Decimal::from(5), tomorrow, false)?),
                None
            );
            assert_eq!(lookup(conn, A, false)?.unwrap().id, human);
            Ok(())
        })
        .await;
    }

    #[tokio::test]
    async fn dev_bypass_is_one_orb_human_per_wallet_with_caps() {
        let t = Temp::new();
        t.run(|conn| {
            let human = lookup(conn, A, true)?.unwrap();
            assert_eq!(
                human,
                Human {
                    id: format!("dev:{A}"),
                    tier: "orb".into(),
                    ap_sub: None,
                    cooloff_until: None
                }
            );
            assert_eq!(wallets_of_human(conn, &human.id)?, vec![A]);
            round(conn, "r1", A, 50, None);
            assert_eq!(
                code(check_bet(conn, A, Decimal::ONE, NOW_MS, true)?),
                Some("human_exposure_cap")
            );
            assert_eq!(code(check_bet(conn, B, Decimal::ONE, NOW_MS, true)?), None);
            round(conn, "r2", B, 200, Some(0));
            assert_eq!(
                code(check_bet(conn, B, Decimal::ONE, NOW_MS, true)?),
                Some("human_daily_loss")
            );
            assert_eq!(
                lookup(conn, B, true)?.unwrap().cooloff_until,
                Some(NOW_MS + 30 * 60_000)
            );
            Ok(())
        })
        .await;
    }

    #[test]
    fn refusals_carry_their_code_and_status() {
        let refusal = Refusal::new("human_cooloff", "wait", Some(5));
        let response = axum::response::IntoResponse::into_response(refusal.into_error());
        assert_eq!(response.status(), 409);
        let required = Refusal::new("human_required", "verify", None).into_error();
        assert_eq!(
            axum::response::IntoResponse::into_response(required).status(),
            403
        );
        match Refusal::new("world_unconfigured", "off", None).into_error() {
            ApiError::Json { status, extra, .. } => {
                assert_eq!(status, 503);
                let extra = extra.unwrap();
                assert_eq!(extra["code"], "world_unconfigured");
                assert_eq!(extra["retryable"], true);
            }
            other => panic!("{other:?}"),
        }
    }
}
