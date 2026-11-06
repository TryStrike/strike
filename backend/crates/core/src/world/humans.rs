//! Per-human rules, run inside the session's write: one human per YOLO wallet,
//! bans follow the human, and a paused agent resumes only for its own human.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::attempt::settle;
use super::verify::HumanGrant;
use super::{
    ACR_PREFIX, AGENT_GONE, ALREADY_USED, BANNED_HUMAN, EXPIRED, MISMATCH, ONE_PER_HUMAN, VERIFIED,
};
use crate::address::canonical;
use crate::agent::{self, refuse};
use crate::config::config;
use crate::db::Db;
use crate::error::ApiResult;
use crate::ledger::Rejection;

/// `(iss, sub)` of the human linked to a wallet.
pub(super) fn link_of(
    conn: &Connection,
    wallet: &str,
) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT iss, sub FROM world_links WHERE wallet = ?1",
        [wallet],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

pub(super) fn running(conn: &Connection, session_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE id = ?1 AND status = 'running')",
        [session_id],
        |r| r.get(0),
    )
}

fn wallets_of(conn: &Connection, iss: &str, sub: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(
        "SELECT wallet FROM world_links WHERE iss = ?1 AND sub = ?2 ORDER BY linked_at",
    )?
    .query_map([iss, sub], |r| r.get(0))?
    .collect()
}

/// `bans::is_globally_banned` over every wallet, read inside the write so it
/// can't drift from the rows it gates.
fn any_banned(conn: &Connection, wallets: &[String]) -> rusqlite::Result<bool> {
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

/// Why this human can't start this wallet's YOLO session, recorded on the
/// attempt. `None` lets the insert go ahead.
pub(crate) fn claim(
    conn: &Connection,
    grant: &HumanGrant,
    wallet: &str,
    start_nonce: &str,
    now_ms: i64,
) -> rusqlite::Result<Option<Rejection>> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT status, expires_at FROM world_attempts WHERE id = ?1 AND wallet = ?2",
            [&grant.attempt_id, wallet],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((status, expires_at)) = row else {
        return Ok(Some(refuse(404, ALREADY_USED)));
    };
    if status != "pending" {
        return Ok(Some(refuse(409, ALREADY_USED)));
    }
    let end = |status: &str, http: u16, reason: &str| {
        settle(conn, &grant.attempt_id, status, reason, now_ms)?;
        Ok(Some(refuse(http, reason)))
    };
    if expires_at <= now_ms * 1_000 {
        return end("expired", 410, EXPIRED);
    }
    if link_of(conn, wallet)?.is_some_and(|(iss, sub)| iss != grant.iss || sub != grant.sub) {
        return end("mismatch", 403, MISMATCH);
    }
    let mut wallets = wallets_of(conn, &grant.iss, &grant.sub)?;
    wallets.push(wallet.to_string());
    if any_banned(conn, &wallets)? {
        return end("denied", 403, BANNED_HUMAN);
    }
    let running: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM agent_sessions WHERE status = 'running' AND mode = 'yolo' \
           AND wallet IN (SELECT wallet FROM world_links WHERE iss = ?1 AND sub = ?2))",
        [&grant.iss, &grant.sub],
        |r| r.get(0),
    )?;
    if running {
        return end("denied", 409, ONE_PER_HUMAN);
    }
    if let Some((http, body)) = agent::start_blocked(conn, start_nonce, wallet)? {
        let reason = body["error"]
            .as_str()
            .unwrap_or("Start refused")
            .to_string();
        return end("denied", http, &reason);
    }
    Ok(None)
}

/// Links the wallet to its human and spends the attempt on the new session.
pub(crate) fn approve(
    conn: &Connection,
    grant: &HumanGrant,
    wallet: &str,
    session_id: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO world_links (wallet, iss, sub, acr, linked_at) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT (wallet) DO UPDATE SET acr = excluded.acr",
        params![wallet, grant.iss, grant.sub, grant.acr, now_ms * 1_000],
    )?;
    conn.execute(
        "UPDATE world_attempts SET status = 'approved', reason = ?2, acr = ?3, session_id = ?4, \
         done_at = ?5 WHERE id = ?1 AND status = 'pending'",
        params![
            grant.attempt_id,
            VERIFIED,
            grant.acr,
            session_id,
            now_ms * 1_000
        ],
    )?;
    Ok(())
}

/// Spends an approved checkpoint on its paused session: the same human, not
/// banned, before the pause runs out. `Err` is the status the attempt ended
/// with, `"used"` when it had already ended.
pub async fn resume(
    db: &Db,
    grant: HumanGrant,
    now_ms: i64,
) -> ApiResult<Result<String, &'static str>> {
    db.write(move |conn| {
        let row: Option<(String, i64, String, String)> = conn
            .query_row(
                "SELECT status, expires_at, session_id, wallet FROM world_attempts \
                 WHERE id = ?1 AND kind = 'checkpoint'",
                [&grant.attempt_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((status, expires_at, session_id, wallet)) = row else {
            return Ok(Err("used"));
        };
        if status != "pending" {
            return Ok(Err("used"));
        }
        let end = |status: &'static str, reason: &str| {
            settle(conn, &grant.attempt_id, status, reason, now_ms).map(|_| Err(status))
        };
        if expires_at <= now_ms * 1_000 {
            return Ok(end("expired", EXPIRED)?);
        }
        if !running(conn, &session_id)? {
            return Ok(end("failed", AGENT_GONE)?);
        }
        if link_of(conn, &wallet)? != Some((grant.iss.clone(), grant.sub.clone())) {
            return Ok(end("mismatch", MISMATCH)?);
        }
        if any_banned(conn, &wallets_of(conn, &grant.iss, &grant.sub)?)? {
            return Ok(end("denied", BANNED_HUMAN)?);
        }
        conn.execute(
            "UPDATE world_attempts SET status = 'approved', reason = ?2, acr = ?3, done_at = ?4 \
             WHERE id = ?1 AND status = 'pending'",
            params![grant.attempt_id, VERIFIED, grant.acr, now_ms * 1_000],
        )?;
        Ok(Ok(session_id))
    })
    .await
}

/// Whether the paused session's human approved its checkpoint. `give_up`
/// expires one still out at World in the same write, so none lands later.
pub async fn checkpoint_passed(
    db: &Db,
    session_id: &str,
    give_up: bool,
    now_ms: i64,
) -> ApiResult<bool> {
    let session_id = session_id.to_string();
    db.write(move |conn| {
        let passed: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM world_attempts \
              WHERE session_id = ?1 AND kind = 'checkpoint' AND status = 'approved')",
            [&session_id],
            |r| r.get(0),
        )?;
        if !passed && give_up {
            conn.execute(
                "UPDATE world_attempts SET status = 'expired', reason = ?2, done_at = ?3 \
                 WHERE session_id = ?1 AND kind = 'checkpoint' AND status = 'pending'",
                params![session_id, EXPIRED, now_ms * 1_000],
            )?;
        }
        Ok(passed)
    })
    .await
}

/// The human behind a wallet for the admin view: proof class, when it was
/// linked, and every wallet that human has used. No `sub`.
pub async fn human_of(db: &Db, wallet: &str) -> ApiResult<Option<Value>> {
    let wallet = canonical(wallet);
    db.read(move |conn| {
        let link: Option<(String, String, Option<String>, i64)> = conn
            .query_row(
                "SELECT iss, sub, acr, linked_at FROM world_links WHERE wallet = ?1",
                [&wallet],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((iss, sub, acr, linked_at)) = link else {
            return Ok(None);
        };
        Ok(Some(json!({
            "acr": acr.as_deref().map(|a| a.strip_prefix(ACR_PREFIX).unwrap_or(a)),
            "linkedAt": linked_at / 1_000,
            "wallets": wallets_of(conn, &iss, &sub)?,
        })))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::StartTerms;
    use rust_decimal::Decimal;

    const NOW_MS: i64 = 1_800_000_000_000;

    fn start_terms(wallet: &str, nonce: &str) -> StartTerms {
        StartTerms {
            wallet: wallet.into(),
            chain_id: 5042002,
            asset: "BTC".into(),
            mode: "yolo".into(),
            budget: Decimal::from(20),
            max_per_trade: Decimal::from(5),
            stop_loss: Decimal::from(10),
            minutes: 10,
            expires_ms: NOW_MS + 600_000,
            nonce: nonce.into(),
        }
    }

    async fn pending(db: &Db, id: &str, wallet: &str) {
        let (id, wallet) = (id.to_string(), wallet.to_string());
        db.write(move |conn| {
            conn.execute(
                "INSERT INTO world_attempts (id, wallet, message, nonce, browser, \
                 acr_allowed, status, expires_at, created_at) \
                 VALUES (?1, ?2, ?1, 'n', 'b', 'x', 'pending', ?3, ?4)",
                params![id, wallet, (NOW_MS + 60_000) * 1_000, NOW_MS * 1_000],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    fn grant(attempt: &str, sub: &str) -> HumanGrant {
        HumanGrant {
            attempt_id: attempt.into(),
            iss: "https://sandbox.auth.world.org".into(),
            sub: sub.into(),
            acr: format!("{ACR_PREFIX}orb"),
        }
    }

    async fn outcome(db: &Db, id: &str) -> (String, Option<String>) {
        let id = id.to_string();
        db.read(move |conn| {
            Ok(conn.query_row(
                "SELECT status, reason FROM world_attempts WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn one_human_one_yolo_wallet_stays_with_its_human_bans_follow() {
        let path = std::env::temp_dir().join(format!("world-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Db::open(&path, 1, 5_000).unwrap();
        let (a, b, c) = (
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "0xcccccccccccccccccccccccccccccccccccccccc",
        );

        pending(&db, "a1", a).await;
        let session = agent::create_session(
            &db,
            start_terms(a, "nonceaaa1"),
            NOW_MS,
            Some(grant("a1", "h1")),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            outcome(&db, "a1").await,
            ("approved".into(), Some(VERIFIED.into()))
        );

        // Spent attempt: a replayed callback creates nothing.
        let replay = agent::create_session(
            &db,
            start_terms(a, "nonceaaa2"),
            NOW_MS,
            Some(grant("a1", "h1")),
        )
        .await
        .unwrap();
        assert_eq!(replay.unwrap_err().0, 409);

        // Same human, second wallet, while A runs.
        pending(&db, "b1", b).await;
        let second = agent::create_session(
            &db,
            start_terms(b, "noncebbb1"),
            NOW_MS,
            Some(grant("b1", "h1")),
        )
        .await
        .unwrap();
        assert_eq!(second.unwrap_err().0, 409);
        assert_eq!(
            outcome(&db, "b1").await,
            ("denied".into(), Some(ONE_PER_HUMAN.into()))
        );

        // Another human on A's wallet.
        agent::stop_session(&db, &session.id, agent::USER_STOPPED)
            .await
            .unwrap();
        pending(&db, "a2", a).await;
        let stolen = agent::create_session(
            &db,
            start_terms(a, "nonceaaa3"),
            NOW_MS,
            Some(grant("a2", "h2")),
        )
        .await
        .unwrap();
        assert_eq!(stolen.unwrap_err().0, 403);
        assert_eq!(
            outcome(&db, "a2").await,
            ("mismatch".into(), Some(MISMATCH.into()))
        );

        // Ban A: the human's fresh wallet C is refused too.
        db.write(move |conn| {
            conn.execute(
                "INSERT INTO banned_wallets (wallet_address) VALUES (?1)",
                [a],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        pending(&db, "c1", c).await;
        let banned = agent::create_session(
            &db,
            start_terms(c, "nonceccc1"),
            NOW_MS,
            Some(grant("c1", "h1")),
        )
        .await
        .unwrap();
        assert_eq!(banned.unwrap_err().0, 403);
        assert_eq!(
            outcome(&db, "c1").await,
            ("denied".into(), Some(BANNED_HUMAN.into()))
        );

        // Expired attempt.
        pending(&db, "c2", c).await;
        let late = agent::create_session(
            &db,
            start_terms(c, "nonceccc2"),
            NOW_MS + 120_000,
            Some(grant("c2", "h3")),
        )
        .await
        .unwrap();
        assert_eq!(late.unwrap_err().0, 410);
        assert_eq!(outcome(&db, "c2").await.0, "expired");

        let human = human_of(&db, a).await.unwrap().unwrap();
        assert_eq!(human["wallets"], json!([a]));
        assert_eq!(human["acr"], "orb");

        let sessions: i64 = db
            .read(|conn| {
                Ok(conn.query_row("SELECT count(*) FROM agent_sessions", [], |r| r.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(sessions, 1);
        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
