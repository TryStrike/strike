# TS vs Rust vs Rust + SQLite

A historical record. Targets A and B, and the tools that ran them (`bench.mjs`, `diff.mjs`, `seed.mjs`), were removed with the TypeScript server; `git log` has them. What runs today is `concurrency.mjs` against the one backend.

The sections below this one describe `sqlite-port` 243723c. **Release fixes** at the end says what changed on `release-fixes`.

**All load numbers are single runs. Treat small gaps as noise.** The machine was not idle: 1-minute load average was 8.8-11.4 around the runs, partly from this harness. The planned three repeats were cut short on request, so there is no spread to quote.

| Target | Code | Database |
|---|---|---|
| A | Next.js `app/api`, `next build && next start` (`app/` is identical at f367537 and 54abe41) | Postgres 17.11 |
| B | Rust at 54abe41, `cargo build --release` | Postgres 17.11 |
| C | Rust at `sqlite-port` 243723c, `cargo build --release` | SQLite 3 in WAL, `synchronous=FULL` |

Machine: Apple M5, 10 cores, 24 GB, macOS (Darwin 27.2), Node 22.22.2, cargo 1.99.1, oha 1.16.0.
Seed: 300 users, 512 load wallets, 20,000 bets, 1,975 audit rows, 60 withdrawals. A and B use `CREATE DATABASE ... TEMPLATE` clones. C comes from `db/migrate_pg_to_sqlite`, whose row counts and numeric sums all verified. `PGPOOL_MAX=20`, `SQLITE_READ_POOL=8`.

## Core load test

8 s per cell, oha `-w`. A and B are from repeat 0 of the stopped full run, which saved only req/s, p99 and error counts, so their p50/p95 are not available. C was re-run on its own.

| Route | Clients | A TS+PG req/s (p99 ms) | B Rust+PG req/s (p99 ms) | C SQLite req/s (p99 ms) |
|---|--:|--:|--:|--:|
| `GET /api/balance/{address}` | 16 | 1,876 (26.4) | 10,463 (6.5) | 35,889 (1.46) |
| | 64 | 1,962 (76.5) | 10,387 (14.6) | 30,109 (11.5) |
| `GET /api/bets/leaderboard` | 16 | 2,094 (24.5) | 7,186 (7.2) | 7,936 (4.5) |
| | 64 | 1,919 (87.9) | 6,955 (26.9) | 9,129 (9.2) |
| `GET /api/prices/latest` | 16 | 3,117 (10.4) | 40,830 (1.5) | 40,887 (1.6) |
| | 64 | 2,368 (111.2) | 40,769 (5.2) | 43,776 (4.2) |
| `POST /api/balance/bet` | 16 | 1,686 (22.6) | 3,050 (69.3) | 221 (132), `fullfsync=ON` as shipped |
| | | | | 2,683 (16.8), `fullfsync=OFF` |
| | 64 | 1,902 (78.2) | 2,578 (154.0) | 240 (279), `fullfsync=ON` as shipped |
| | | | | 2,281 (50.8), `fullfsync=OFF` |

No errors in any cell above. C p50 ms at 16/64 clients: balance 0.38/1.66, leaderboard 1.96/7.00, prices 0.31/1.33, bet ON 65.9/268, bet OFF 3.66/27.7. C RSS: 14 MB idle, 136 MB peak (`fullfsync=ON` series). In the C run, 8 s of bets at 64 clients made 1,984 debits from 1,985 responses with ON, and 18,002 from 18,318 with OFF: oha picks random bodies, so repeats become cheap replays, about 2% at OFF.

**Durability, read this before comparing writes.** Postgres here is `fsync=on`, `synchronous_commit=on`, `wal_sync_method=open_datasync`. On macOS that does not issue `F_FULLFSYNC`, so it does not force the drive cache. `fullfsync=ON` does, which makes C-ON the stronger guarantee and the slower number. **C-OFF is the closer match to these Postgres settings.** A throwaway patch adds the OFF switch; it is not a setting in 243723c. `fullfsync` has no effect on Linux, so neither macOS write figure predicts production. Postgres's own settings were left as they are, because it is the user's shared server.

Other caveats:
- Prices are served from a roughly 1 s in-process cache on all targets, so that row mostly measures HTTP and JSON.
- `oha` and Postgres share the machine with the server. RSS excludes Postgres.
- Bets use 512 wallets. A single hot wallet would behave differently.
- `/api/stats/public` is left out, and would mislead anyway: Rust serves a 300 s in-process cache while TS rescans on each request (3-9 req/s), because `revalidate = 300` has no effect there.
- Partial log of the stopped run, including c=1, c=256 and other routes: `results/bench-full-partial.log`. Ignore A's c=256 cells: oha logged many errors that were not investigated.

## Concurrency

32 parallel clients unless noted, 5 rounds, fresh wallets, ledger reconciled against `balance_audit_log` after every round.

| Invariant | A TS | B Rust+PG | C SQLite |
|---|---|---|---|
| idempotent_bet | pass | pass | pass |
| overspend_bets | pass | pass | pass |
| parallel_settlement | pass | pass | pass |
| repeat_deposit | pass | pass | pass |
| double_accept | pass | pass | pass |
| parallel_withdrawals_accept | **FAIL 5/5** | **FAIL 5/5** | pass |
| parallel_withdrawals_cap | **FAIL 5/5** | **FAIL 5/5** | pass |
| same_intent_replay | **FAIL 5/5** | **FAIL 5/5** | pass |
| accept_success_parallel (every transfer lands) | pass | pass | pass |
| accept_strict_nonce (real node nonces) | pass | pass | **FAIL 5/5** |

Stub modes matter here:
- Treasury calls go through a local stub with a throwaway key, so nothing is on-chain. External CONNECT attempts: 0.
- **`rustWords`:** Rust cannot parse real `uint256` responses (bug 1), so the rows above give Rust a non-spec short word to reach the code behind that bug. TS always gets real ABI words.
- **`lenient` nonces** (`parallel_withdrawals_accept`, `accept_success_parallel`) give every send a unique nonce, as a working nonce manager would, so all transfers land.
- **`strict` nonces** act like a node: one transaction per nonce.

## Money and auth bugs

Repro setup: `backend/bench/servers.sh setup && servers.sh build-sqlite`, then `start ts|rs|sq`.

1. **Rust bug, B and C, blocks release.** `parse_quantity` (`eth.rs`) rejects more than 32 hex digits, but every `uint256` from `eth_call` is 64. Every admin accept fails with 502 and is parked. `GET /api/arc/treasury` returns 502, and treasury balances are empty. **On C the debit stands with nothing paid: every withdrawal takes the player's balance.** Observed with spec-compliant words: A 200, balance 90, 1 payout; B 502, balance 100, 0 payouts; C 502, balance 90, 0 payouts. Repro: `node backend/bench/concurrency.mjs --rounds=1`, see the "Single accept" line in `results/concurrency.md`.
2. **Shared bug, A and B: overpayment on parallel accepts.** The balance check holds no lock and the debit runs after the transfer. 8 requests of 40 on a balance of 100: 288 USDC net paid, 2 debits. This needs the transfers to land, so it requires distinct nonces; simultaneous accepts with strict nonces collide and it does not appear. C fixes it by debiting before the transfer.
3. **Shared bug, A and B: withdrawal requests race.** Parallel requests pass the 1.08x cap together: 160 (A) and 320 (B) USDC queued against a cap of 108. One signed intent POSTed 32 times queued 15 rows on A and 32 on B. C fixes both.
4. **C design consequence.** Parallel accepts share the treasury nonce. With strict nonces, 3 of 4 returned 502 and were parked with the debit kept: 1 payout, 4 debits, 60 USDC held. No money is lost, but the player is short until an operator acts. Accepts need a nonce manager or serialising.
5. **TS bug, Rust changes the money.** Deposit and withdraw run `select('tier')` (`deposit/route.ts:112`, `withdraw/route.ts:256`), but the column is `user_tier`, so TS always charges 10%. Rust charges 9% and 8%. A standard-tier deposit of 10 gives TS fee 1, net 9; Rust fee 0.89999999, net 9.10000001 (float residue). A vip withdrawal of 5 gives fee 0.5 vs 0.4. Going live with Rust cuts fees: decide if that is intended. `node backend/bench/diff.mjs --only=divergent`.
6. **Rust bug, auth, B and C: wrong status, fails closed.** `GET /api/withdrawals` and `POST /api/validate-access-code` return 500, not 401, with no or bad credentials. No data leaked. `curl -i 127.0.0.1:4200/api/withdrawals?wallet=0x...`
7. **Rust bug, B and C: junk bet row.** `POST /api/bets/save` with `{"id":"x","walletAddress":42}` is 500 on TS but stores wallet `"42"` on Rust, and it then appears in admin lists, totals and leaderboards.
8. **Rust bug, B and C: admin money view.** `GET /api/admin/player-ledger` ignores every parameter: all 812 players returned, invalid input gets 200, and `total`, `limit`, `offset` and `_has_explicit_fee` are missing.
9. **Minor, B and C.** With the RPC down, a deposit reports `tx_not_found` instead of `rpc_error` (`transaction()` swallows the error). Both are retryable. Session cookies lack `Expires` but carry the same `Max-Age`: harmless.
10. **Safety hazard, all Rust targets.** `dotenvy::from_filename` walks up parent directories, so a server started from a worktree loads the parent checkout's live `.env.local` for any unset variable. The harness runs outside the repo and refuses to start otherwise.

### Row-count differences (final tables, TS / other)

| Table | A / B | A / C | Cause | Verdict |
|---|---|---|---|---|
| `bet_history` | 20003 / 20004 | 20003 / 20004 | The `walletAddress: 42` row (7) | Rust bug |
| `balance_audit_log` | 2017 / 2016 | 2017 / 2018 | B: the real-ABI accept never debited (1). C: its RPC-down accept kept the debit (design, 4) | Follows from 1 and 4 |
| `access_codes` | 559 / 560 | 559 / 560 | Admin POST with body `null`: TS 500, Rust mints a code as if `{}` | Harmless, admin only |

## Diffs

803 cases over all 42 route files and every handler, compared on status, JSON and selected headers, then on final table contents. Repeat runs gave identical results, apart from one elapsed-time field (`averageSessionSeconds`) in an earlier A vs B run.

| Pair | Matching | Differing | Status mismatches |
|---|--:|--:|--:|
| A vs B | 732 | 71 | 38 |
| A vs C | 704 | 99 | 38 |

The 72 first reported for A vs B was one case higher only because of that timing field. The extra 28 on C were not itemised; the ones checked trace to the kept debit (4), which shifts admin users, transactions, export and wallet-insights, plus tie ordering in the referral leaderboard.

**Triaged:** items above, which are all that could affect money or auth, plus `accept` on an unknown id (TS bug: 500 where Rust gives a correct 404, harmless).

**Untriaged, per the reduced scope:**
- `POST /api/session/ping` lacks `ttl_seconds`, `refresh_after_seconds`, `expires_at` and `server_time` on Rust. The client schedules refreshes from these, so look at this one first.
- Bad-body handling on ping, banned-wallets and referral: 400 vs 500 either way. Rust's banned-wallets 500 echoes the parser's message.
- Over-long `walletAddress` is accepted on the banned-wallets POST and DELETE.
- `cache-control` differences on stats and treasury.
- Treasury number formatting and error text, and audit tie order in wallet-insights.

The referral suffix difference is deliberate (TS appends `undefined`) and not counted.

## Commands

```sh
backend/bench/servers.sh setup && backend/bench/servers.sh build-sqlite
backend/bench/servers.sh reset && for s in ts rs sq; do backend/bench/servers.sh start $s; done
node backend/bench/diff.mjs --tag=diff
node backend/bench/diff.mjs --b=sq --tag=diff-ac
node backend/bench/concurrency.mjs --rounds=5 --n=32
backend/bench/servers.sh stop ts; backend/bench/servers.sh stop rs; backend/bench/servers.sh stop sq
node backend/bench/bench.mjs --tag=bench-core-c --targets=C,D --repeats=1 --seconds=8 --startups=0 --conc=16,64 '--routes=balance/{address},leaderboard,prices/latest,balance/bet'
backend/bench/servers.sh stop-all
```

Both Rust binaries are built from copies with only the two price URLs pointed at the stub; C also has the `BENCH_FULLFSYNC` switch. `backend/crates` is untouched. TS reaches the same stub through `preload.cjs`. Secrets are random and local (`.env.bench`, gitignored), and `.env.local` was never read.

## Release fixes

Target C rebuilt from `release-fixes`. `backend/bench/stub.mjs` now always answers real 32-byte words, and SQLite's race invariants run with strict nonces: one transaction per nonce, as a node does.

### Group commit, `POST /api/balance/bet`

Three repeats of 8 s per cell, median run, spread in brackets. Before is 424503d, after is this branch, run back to back under `caffeinate` with nothing else of ours running (load average 3-6). An earlier run was thrown away because the Mac slept during it. No errors in any cell. Batch is jobs per commit, from `GET /api/admin/ops-health`; before, every commit is one job.

| fullfsync | Clients | Before req/s | Before p99 ms | After req/s | After p99 ms | Avg batch |
|---|--:|--:|--:|--:|--:|--:|
| ON | 16 | 397 (237-409) | 57.6 | 1,448 (1,423-1,967) | 28.6 | 8.0 |
| ON | 64 | 377 (284-382) | 205 | 3,689 (3,607-3,738) | 30.5 | 32.0 |
| OFF | 16 | 4,630 (4,581-4,674) | 9.9 | 5,853 (5,555-5,896) | 12.1 | 8.0 |
| OFF | 64 | 4,078 (4,073-4,112) | 21.6 | 5,868 (5,695-5,890) | 19.2 | 32.0 |

`fullfsync` does nothing on Linux, so the macOS ON row does not predict production. Repeated random bodies make about 1-4% of requests cheap duplicate replays, on both sides. Full tables: `results/gc-before.md`, `results/gc-after.md`.

### A vs C after the fixes

803 cases: 750 match, 53 differ (was 704 and 99). `bet_history` now matches row for row. A multiset comparison of `balance_audit_log`, ignoring ids and order, leaves two causes only: the two seeded-tier wallets' fee rows, and one extra 4 USDC withdrawal, the accept that ran with the RPC down and, being left pending instead of parked, paid when tried again.

Deliberate, because a failed read now leaves a request pending: `accept` with the RPC down (502 either way, different text) and the follow-up accept (200, TS 400). That one payout then shifts admin users, stats, transactions, export, player-ledger (the withdrawer's row only) and wallet-insights..

Left as they are, none touching money or auth:

| Difference | Why it stays |
|---|---|
| Fee tiers: deposit and withdraw values, `deposit_locks.amount` | Not decided here, see RESULTS item 5 |
| `bets/save` numeric wallet and `null` body, `validate-access-code` bad bodies, `referral` and `banned-wallets` `null` body: 400 vs TS 500 | Rust is more correct and the client never sends these |
| `accept` on an unknown id: 404 vs TS 500 | TS bug |
| Admin `access-codes` POST with `null` body mints one code; TS 500 | Admin only, and equal to posting `{}` |
| `user_sessions.network`: numeric body stored as `5` on TS, `ARC` on Rust | Rust ignores a non-string |
| `set-cookie` has no `Expires` | Same `Max-Age` |
| `cache-control` on `stats/public` and on `arc/treasury` when the RPC is down | Rust is stricter or shorter |
| `stats/public` totals | A cached 20,000 from before the test's writes; both are caches |
| Treasury `formatted`: `1e9` vs `1.0000e+9`, and the RPC-down error text | Admin display only |
| Referral leaderboard tie order, key order on prices and leaderboard | No defined order |

### Open: payouts past 6 decimals cannot be sent

USDC has 6 decimals, but fees and nets are kept to 8. When either one has more than 6, `parse_units` refuses it, as `ethers.parseUnits` does on TS. Of the 10,000 cent amounts up to 100: 354 fail at 10%, 2,735 at 9%, 691 at 8%. Of the whole amounts up to 100: 0, 20 and 2. For example 0.57 at 10% gives fee 0.05699999. TS parks these rows; Rust debited and parked them; now the accept answers 400, the row stays pending and nothing is debited, and an operator can only reject it. Rounding changes what a player receives, so it was left for a decision. Deposits skip the fee transfer for the same reason, and the player is still credited the net.
