# World ID in Strike

Your agent trades for you, never past what one human allows.

Strike runs fast up/down USDC rounds on Arc with an AI agent that can bet for you. World ID ties every wallet and every agent back to one verified human. Limits are counted per human, so a fresh wallet does not reset them. When the agent wants to do something risky, it stops and asks that human to approve on their phone. No approval, no money moves.

Two World products, two jobs:

- **IDKit answers "is this one unique human?"** You verify once, on your first money action. The IDKit nullifier becomes your human key.
- **Agent Pass answers "is that human here right now, approving this?"** A fresh approval in World App before each risky action.

Branch: `feat/world-agent-pass`. Tested locally on 2026-11-06 and 07, not deployed yet. IDKit runs against World's staging environment and simulator. Agent Pass runs against the sandbox issuer `https://sandbox.auth.world.org`, because production Agent Pass needs an Orb and there are no Orbs in India (see "Known limitations").

---

## Architecture

```
 browser (Next.js)                          strike API (Rust, axum, SQLite)                    World
 ─────────────────                          ───────────────────────────────                    ─────
 any money action ──────────────────────▶  gate: human_of_wallet(wallet)
   (bet, agent start,                         none ─▶ 403 human_required
    withdraw, approve)                        caps / cool-off ─▶ 409 human_*
        │
        │ 403 human_required
        ▼
 WorldGate verify modal ──POST /api/world/human/start──▶ pending attempt, signed rp_context
 IDKitRequestWidget ◀──────────────────────────────────── (signal = wallet + attempt id)
        │ proof                                                                   World App
        └──POST /api/world/attempts/{id}/proof──▶ check_proof (env, action,  ──▶ developer.world.org
                                                   nonce, signal, class)          /api/v4/verify/{rp_id}
                                                  finish_human: nullifier ─▶ humans,
                                                   human_ids, human_wallets, human_limits

 risky action ──────────────────────────▶  agentpass::begin
        │                                     stepups row (pending, exact action key)
        │ 401 step_up_required + stepup       device_authorization ───────────────▶ WORLD_AP_ISSUER
        ▼                                     tokio poller: token endpoint ◀──────▶ (Agent Pass)
 StepUpCard: user code + "Approve with World"     id_token ─▶ RS256/JWKS, iss, aud,        │
   polls GET /api/stepups/{id}                    auth_time, acr=orb, amr has pop,         │
        │ approved                                same sub as this human                   │
        └── re-send same request + stepupId ─▶ consume(): spend once, in the action's write
                                               the bet / start / withdrawal runs
```

Every check happens on the backend. The browser only shows state and re-sends requests.

---

## Identity model

| Table | What it holds |
|---|---|
| `humans` | one row per verified human |
| `human_ids` (`iss`, `sub`) | identities that point at a human. `PRIMARY KEY (iss, sub)`, so one identity maps to one human |
| `human_wallets` | wallet to human. A wallet belongs to exactly one human |
| `human_limits` | tier (`selfie` or `orb`, only ever goes up) and `cooloff_until` |
| `stepups` | one Agent Pass approval, bound to one human and one exact action |

Schema: `backend/crates/core/src/db.rs:145-195`, the last entry in `MIGRATIONS`.

Two kinds of identity live in `human_ids`:

1. **IDKit nullifier.** `iss = "idkit:{rp_id}:strike-human"`, `sub` = the nullifier from World's verify reply (`core/src/world/verify.rs:164-200`). One stable action, `strike-human`, so the same human always gets the same nullifier. A second wallet that proves with the same nullifier joins the existing human (`core/src/world/humans.rs:154-238`). A wallet already linked to a different human gets `human_mismatch`.
2. **Agent Pass `sub`.** `iss` = the configured issuer (`https://auth.world.org` or `https://sandbox.auth.world.org`). It is linked to the human the first time that human approves a step-up. After that, every approval must come from the same `sub`. A `sub` already owned by another human, or a second `sub` for the same human, ends the step-up as `mismatch` (`core/src/world/humans.rs:89-124`).

World does not document any link between the IDKit nullifier and the Agent Pass `sub`. We bind them by trust on first use: whoever first approves with Agent Pass for a verified human becomes that human's Agent Pass identity. In the live test the sandbox `sub` linked to the same human as the IdKit nullifier, as expected. See `docs/world-debrief.md`.

Bans are checked across every wallet of the human, on every bet, withdrawal and agent reservation.

---

## What is gated

| Action | Not verified | Verified human | Where |
|---|---|---|---|
| Browse, prices, history, Arkiv proofs, copilot reads | open | open | — |
| Deposit | allowed, with a "verify to trade" nudge | allowed | `frontend/components/balance/DepositModal.tsx` |
| Manual bet (classic and box) | 403 `human_required` | allowed within the human's caps | `core/src/rpc.rs:707-718`, in the debit's own transaction |
| Normal agent start | 403 `human_required` | allowed | `server/src/routes/agent.rs:95-98` |
| YOLO agent start | 403 `human_required` | selfie: 403 `human_tier_too_low`. Orb: Agent Pass approval | `server/src/routes/agent.rs:100-130` |
| Agent bet inside the loop | — | caps re-checked on every bet; refused while paused | `core/src/agent.rs:928-1025` |
| YOLO agent loses 50%, then 75%, of its stop-loss | — | pauses for Agent Pass | `core/src/agent.rs:279-291` |
| YOLO agent stakes more than it just lost, within 60 s of the loss | — | pauses for Agent Pass | `core/src/agent.rs:295-297`, `server/src/agent.rs:276-283` |
| Normal-mode proposal approve | — | stake 5 or less: one click. Above 5: Agent Pass | `server/src/routes/agent.rs:323-394`, `core/src/agent.rs:986-996` |
| Withdrawal | 403 `human_required` | 25 or less: allowed. Above 25: Agent Pass. Max 50 per request, 200 per human per day | `server/src/routes/balance_mutations.rs:630-674`, `core/src/withdrawals.rs:89-130`, `:144-220` |

All amounts are USDC and come from env (see "Configuration"). The UI reads them from `GET /api/world/config` (`server/src/routes/world.rs:31-54`), nothing is hardcoded.

### Per-human caps

Inside `place_bet_locked`, in the same SQLite write as the debit (`core/src/world/humans.rs:309-372`):

```
human  = human_wallets[wallet]                       else 403 human_required
banned on any wallet of human                        else 403 banned
now >= cooloff_until                                 else 409 human_cooloff {until}
lost today (UTC) over every wallet < daily loss cap  else 409 human_daily_loss, cool-off 30 min
open stake over every wallet + stake <= open cap     else 409 human_exposure_cap
```

---

## Credential tiers, and why each is the minimum that is enough

| Tier | Credential | Unlocks | Why this and not less | Why not more |
|---|---|---|---|---|
| Selfie | IDKit Selfie Check | 5 USDC open, 25 USDC daily loss | Small stakes only need to make multi-accounting expensive. A selfie stops a farm of wallets from multiplying a tiny cap. | Asking for an Orb to place a 2 USDC bet loses most users, especially in India where there are no Orbs. |
| Orb | IDKit Proof of Human (Orb) | 50 USDC open, 200 USDC daily loss, YOLO agent | Real money and an agent that bets without a tap need a guaranteed unique human, or the caps can be dodged with a second identity. | The Orb is already the strongest uniqueness proof World has. |
| Step-up | Agent Pass, fresh, `acr = orb`, `amr` contains `pop` | one risky action, once | Uniqueness from a past proof does not show the human is present now. A stolen session or a runaway agent could otherwise act. `auth_time` must fall inside this approval, so the proof is fresh. | It covers one action and expires in 5 minutes. Nothing broader is needed. |

On `amr`: World's docs list a passkey on an Orb-level account as `pop user mfa`, and in the live test the approval came back as exactly that. We accept it, because `acr = orb` already says the account belongs to an Orb-verified human and the passkey is a fresh, user-verified presence check on that human's device. We require `pop` and reject anything without it.

Where the tier is decided: `core/src/world/mod.rs:42-59` (`classes`, `tier_of`), `core/src/world/verify.rs:46-53` (class from World's answer, never from the browser), `core/src/agentpass/token.rs:8-33` (which `acr` to ask for and accept) and `:50-102` (token checks).

---

## IDKit flow

IDKit 4 (`@worldcoin/idkit` 4.6.0).

1. A gated action answers 403 `human_required`. `sendGuarded` opens the verify modal (`frontend/lib/world/gate.ts:43-79`).
2. `POST /api/world/human/start` saves a pending attempt for 5 minutes and returns an IDKit request with an `rp_context` signed with `WORLD_RP_SIGNING_KEY` (`core/src/world/request.rs:85-156`). The signal binds the proof to this wallet and this attempt.
3. `IDKitRequestWidget` runs in the browser, `allow_legacy_proofs={false}` (`frontend/components/agent/WorldCheck.tsx:26-47`). Orb preset, or Selfie or Orb.
4. The result goes to `POST /api/world/attempts/{id}/proof` (`server/src/routes/world.rs:199-225`). The server checks protocol 4.0, environment, action, signed nonce, signal hash and credential class (`core/src/world/verify.rs:83-126`), then forwards it to `developer.world.org/api/v4/verify/{rp_id}` (`verify.rs:128-162`).
5. `finish_human` links the nullifier, wallet and tier in one write (`core/src/world/humans.rs:145-238`).
6. The route answers with the attempt's real status, not always 200 (`server/src/routes/world.rs:163-198`). The original request is re-sent.

## Agent Pass device flow

RFC 8628 device grant. No redirect, no PKCE, works on localhost and on a server.

```
risky action ─▶ stepups row: pending, subject = {key, summary}, expires in 5 min
   (a pending step-up for the same human and action is reused, not duplicated)
   POST device_authorization_endpoint  (client_secret_basic)
        scope=openid  claims={"id_token":{"acr":{"essential":true,"values":["https://world.org/oidc/acr/orb"]}}}
        (claims depend on WORLD_AP_ACR, see "Configuration")
   ◀─ device_code, user_code, verification_uri(_complete), interval
API answers 401 step_up_required + WWW-Authenticate: Bearer error="insufficient_user_authentication"
StepUpCard shows the summary, the user code and "Approve with World"
poller every interval:
   authorization_pending ─▶ wait
   slow_down             ─▶ interval += 5 s
   access_denied         ─▶ denied
   expired_token         ─▶ expired
   other error / 5xx / timeout ─▶ failed (never approved)
   any ending error is logged with World's error code and error_description (max 200 chars)
   200 id_token ─▶ RS256 against JWKS by kid, iss, aud = client_id, exp,
                   auth_time in [started - 30 s, now + 30 s], acr = orb, amr has pop,
                   (iss, sub) is this human's linked Agent Pass identity (linked on first use)
              ─▶ approved
client re-sends the same request + stepupId ─▶ consume(): same human, same kind, same action key,
   approved less than 5 min ago ─▶ status used, inside the action's own write
```

Code:

- Discovery, start, poll, JWKS: `core/src/agentpass/client.rs:69-187`
- `acr` request and acceptance policy, token checks: `core/src/agentpass/token.rs:8-102`
- Config from env: `core/src/agentpass/mod.rs:45-57`
- Step-up row, poller, approval and Agent Pass link: `core/src/agentpass/mod.rs:165-429`
- Spend once: `core/src/agentpass/mod.rs:459-535`
- Challenge header and `Retry-After`: `server/src/routes/stepup.rs:24-40`
- `GET /api/stepups/{id}` and `POST /api/stepups/{id}/cancel`, owner only, 404 otherwise: `server/src/routes/stepup.rs:18-76`
- Pending step-ups are failed at boot, since their poller died with the process: `core/src/agentpass/mod.rs:558-566`, called from `server/src/main.rs:36`

The approval is bound to the exact action. A withdrawal approval is keyed on wallet, amount and currency (`balance_mutations.rs:647-652`). A YOLO start is keyed on the hash of the signed start message (`core/src/agent.rs:583-585`, `core/src/agentpass/mod.rs:568-570`). Re-sending the same signed bytes with `stepupId` is the only way to use it, so the wallet does not sign twice.

### Agent pause and resume

- A YOLO agent pauses at 50% and 75% of its stop-loss, and when it wants to stake more than it just lost within 60 s of that loss (`server/src/agent.rs:259-283`).
- The pause is stored in the database (`agent_sessions.paused_until`, `pause_stepup_id`). `reserve()` refuses every bet while it is set (`core/src/agent.rs:958-960`), so the loop cannot slip one through.
- The feed sends `event: stepup` so the card appears straight away (`server/src/agent.rs:78-80`, `:400-402`).
- Only the step-up created for this pause can resume it, and it is spent on resume (`core/src/agent.rs:789-827`).
- Denied, cancelled or another human: the session stops with "human check denied". Expired or failed: the user can ask again (`POST /api/agent/checkpoint`, `server/src/routes/agent.rs:193-259`) until `HUMAN_WAIT_MS` (2 min) runs out, then it stops with "human check expired" (`server/src/agent.rs:366-487`).

---

## Failure paths and what the user sees

Every non-approved step-up message ends with "Nothing happened, no money moved." A network error is never shown as approved.

| What happens | Server result | User sees |
|---|---|---|
| Not verified, tries to bet or withdraw | 403 `human_required` | verify modal opens |
| Selfie human starts a YOLO agent | 403 `human_tier_too_low` | verify modal asks for Orb |
| IDKit cancelled or closed | attempt `denied` | "You cancelled in World App" |
| IDKit proof for another human on a linked wallet | attempt `mismatch`, 403 `human_mismatch` | "This wallet is already linked to a different human" |
| IDKit attempt older than 5 min | 410 `attempt_expired` | expired, try again |
| World verify API down | 503 `world_unavailable`, `retryable` | "World is unavailable right now. Nothing happened, try again." |
| Over the exposure cap | 409 `human_exposure_cap` | cap message, no charge |
| Daily loss cap hit | 409 `human_daily_loss`, then `human_cooloff {until}` | countdown to the end of the cool-off |
| Agent Pass approval denied in World App (also what World returns when it refuses the account) | step-up `denied`, re-send gets 403 `stepup_denied` | "Denied in World App. Nothing happened, no money moved." |
| Approval not given in 5 min | step-up `expired`, 410 `stepup_expired` | "The approval expired. Nothing happened, no money moved." |
| User presses Cancel on the card | step-up `cancelled` | "Cancelled. Nothing happened, no money moved." |
| A different World ID approved | step-up `mismatch`, 403 `human_mismatch` | "A different World ID approved this than the one linked to you..." |
| Bad token, low `acr`, no `pop`, World down mid-poll | step-up `failed` | "World could not finish the approval..." |
| Approval re-used | 409 `stepup_used` | "That approval was already used. Request a new one." |
| World rate-limits the device grant | 429 `rate_limited` + `Retry-After` | countdown |
| Agent Pass not configured | 503 `world_unconfigured` | "try again" |
| Backend stops while the card is open | poll fails | "Lost the connection", never approved |
| Paused agent, approval denied | session stops | "human check denied" |
| Paused agent, approval expired | card offers "Request new approval"; after `HUMAN_WAIT_MS` the session stops | "human check expired" |
| Normal-mode proposal expired while approving | 409 `proposal_expired` | "This proposal expired. Nothing was placed." |

UI copy: `frontend/components/world/StepUpCard.tsx:11-28`, `frontend/lib/api/errors.ts:77-121`.

## Status codes

| Status | Codes | Frontend |
|---|---|---|
| 400 | `withdraw_cap` | message |
| 401 | `session_required` (or no code) | re-sign the wallet once, re-send |
| 401 + `WWW-Authenticate` | `step_up_required` with `stepup` | approval card, re-send with `stepupId` |
| 403 | `human_required`, `human_tier_too_low`, `banned`, `human_mismatch`, `stepup_denied`, `attempt_denied`, `attempt_failed` | verify modal for the first two, message otherwise |
| 404 | `not_found` (someone else's step-up) | message |
| 409 | `human_exposure_cap`, `human_daily_loss`, `human_cooloff` (`until`), `agent_running`, `duplicate`, `stepup_pending`, `stepup_used`, `not_paused`, `proposal_expired`, `attempt_pending`, `dev_bypass` | message, countdown when `until` is set |
| 410 | `stepup_expired`, `attempt_expired` | "expired, try again" |
| 422 | `invalid_body` with `field` | inline field error |
| 429 | `daily_cap` (`retryAfter`), `rate_limited` + `Retry-After` | countdown |
| 503 | `world_unconfigured`, `world_unavailable` with `retryable` | "try again", never shown as success |

All times in API bodies (`until`, `expiresAt`, `pausedUntil`) are milliseconds. Database columns are microseconds.

---

## Verified live

Local testing on 2026-11-06 and 07, real World services, no mocks.

IDKit 4 on staging with simulator.worldcoin.org:

- Unverified bet refused with 403 `human_required`.
- Closing the widget recorded the attempt as cancelled: "You cancelled in World App".
- Simulator proof verified through `developer.world.org` v4 verify; the wallet linked to an Orb-tier human; the bet was retried and placed.
- A 51 USDC bet at Orb tier (50 cap) was refused with `human_exposure_cap`. No money moved.

Agent Pass on `https://sandbox.auth.world.org`:

- YOLO start approved: `acr = orb`, `amr = pop user mfa` (passkey on an Orb-level sandbox account). The step-up was approved, then spent once by the re-sent start. The sandbox `sub` linked to the same human as the IDKit nullifier.
- Expired: "The approval expired. Nothing happened, no money moved."
- Denied: many times, while the sandbox app's "simulated human" was being refused by World (see the debrief).

Still to check in the browser: cancel on the card, withdrawal over 25 (step-up), proposal over 5 (step-up), pause at 50% of the stop-loss.

---

## Prize requirements

### World ID Agent Pass

| Requirement | How it is met | Where |
|---|---|---|
| Uses the official Agent Pass | OIDC device grant against World's issuer, endpoints from discovery, confidential client | `core/src/agentpass/client.rs:69-171`, `core/src/agentpass/mod.rs:45-61` |
| Full journey: request, user completes, backend validates, protected action runs | 401 `step_up_required` with a step-up; user approves in World App; poller verifies the id_token; the re-sent request spends the approval inside the action's own write. Run live on the sandbox issuer for a YOLO start | `core/src/agentpass/mod.rs:165-429`, `:459-535`; `server/src/routes/agent.rs:100-136`; `server/src/routes/balance_mutations.rs:630-674` |
| Denied, expired or cancelled path that blocks the action | each ends the step-up unapproved; `consume` refuses anything but `approved`; a paused agent stops. Denied and expired seen live | `core/src/agentpass/mod.rs:489-521`, `client.rs:164-170`, `server/src/agent.rs:366-447` |
| Validated on the backend | RS256 against JWKS, `iss`, `aud`, `exp`, `auth_time`, `acr`, `amr`, same `sub` per human | `core/src/agentpass/token.rs:50-102`, `core/src/agentpass/mod.rs:363-429` |
| Integration debrief | written | `docs/world-debrief.md` |

The agent itself asks for the approval: the trading loop pauses, persists the pause, and waits for its human (`server/src/agent.rs:366-487`).

### Best Use of IDKit

| Requirement | How it is met | Where |
|---|---|---|
| IDKit in a working app | IDKit 4 widget on every first money action, via `WorldGate` mounted once | `frontend/components/agent/WorldCheck.tsx:26-47`, `frontend/app/providers.tsx:107` |
| Verified on the backend | local checks, then `developer.world.org/api/v4/verify/{rp_id}`; tier read from World's answer | `core/src/world/verify.rs:83-200` |
| The moment that needs trust, and why the credential is the minimum that is enough | the first bet: without one human per key, a new wallet resets every loss cap. Selfie for small caps, Orb for real money and YOLO | "Credential tiers" above; `core/src/config.rs:213-231`, `core/src/world/humans.rs:309-372` |
| Success plus at least one other outcome | approved, cancelled, expired, mismatch, banned, unavailable, each with its own status and copy. Approved, cancelled and exposure cap seen live | `server/src/routes/world.rs:163-198`, `core/src/world/humans.rs:154-238` |
| Integration debrief | written | `docs/world-debrief.md` |

---

## Tests

- `cargo test --manifest-path backend/Cargo.toml -p strike-core --lib -- world:: agentpass::` covers human linking, shared caps, cool-off, Agent Pass linking (`core/src/world/humans.rs:406-672`) and the device grant against a fake World server: approval verified, linked and spent once; every World error ends unapproved; `slow_down` adds 5 s; a cancelled step-up cannot be approved (`core/src/agentpass/tests.rs:145-244`). Token checks, including passkey `amr` accepted and missing `pop` refused: `core/src/agentpass/token.rs:104-211`.
- `backend/crates/server/tests/world_agent.rs` drives a big withdrawal and a YOLO start through a fake IdP. It compiles but has **not run yet**; it needs Linux.
- Not covered by any server test yet: the full pause/resume loop and the restart path.

---

## Configuration

Set in the repo-root `.env.local` (see `.env.example`). The backend reads it from the directory it starts in.

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY` | IDKit app from developer.world.org. The signing key is backend only, 32-byte hex secp256k1 |
| `WORLD_ENVIRONMENT` | `production` (default, real World App) or `staging` (simulator.worldcoin.org) |
| `WORLD_ACTION` | default `strike-human`. Must exist as an action on the app |
| `WORLD_VERIFY_URL` | default `https://developer.world.org`. Only for tests against a fake server |
| `WORLD_AP_CLIENT_ID`, `WORLD_AP_CLIENT_SECRET` | Agent Pass client from the portal of the issuer below. A sandbox client only works with the sandbox issuer |
| `WORLD_AP_ISSUER` | default `https://auth.world.org` (production, real Orb accounts only). `https://sandbox.auth.world.org` for the sandbox World App |
| `WORLD_AP_ACR` | which `acr` to ask for and accept. `orb` (default). A list such as `selfie,orb` asks for and accepts those classes, but World has Selfie Check off, so it collapses to Orb. `client` sends no `claims`, so the portal's default applies, and accepts selfie or orb. `any` is a sandbox-only test mode: sends `claims` with `acr: null` and skips the `acr` and `amr` checks (signature, issuer, audience, expiry, `auth_time` and the same-`sub` rule still apply). `any` is ignored unless the issuer starts with `https://sandbox.` |
| `WORLD_SELFIE_OPEN_CAP`, `WORLD_SELFIE_DAILY_LOSS` | Selfie tier caps in USDC, defaults 5 and 25 |
| `WORLD_ORB_OPEN_CAP`, `WORLD_ORB_DAILY_LOSS` | Orb tier caps in USDC, defaults 50 and 200 |
| `WORLD_COOLOFF_MIN` | cool-off after the daily loss cap, default 30 minutes |
| `STEPUP_WITHDRAW_OVER` | withdrawals above this need Agent Pass, default 25 USDC |
| `STEPUP_PROPOSAL_OVER` | normal-mode proposals above this need Agent Pass, default 5 USDC |
| `HUMAN_WAIT_MS` | how long a paused agent waits for its human, default 120000 |
| `STRIKE_DEV_NO_WORLD=1` | local development only, never in production: every wallet is its own Orb human and step-ups approve themselves. The server refuses to boot with it when `NODE_ENV=production` |

Without the IDKit vars, bets, agents and withdrawals answer 503 `world_unconfigured`. Without the Agent Pass vars, YOLO starts, big withdrawals and big proposals do.

Settings used for the live test and the demo: `WORLD_ENVIRONMENT=staging`, `WORLD_AP_ISSUER=https://sandbox.auth.world.org` with a sandbox client, `WORLD_AP_ACR=orb`.

## Local run

```
cd strike
cargo run --manifest-path backend/Cargo.toml -p server      # API on 127.0.0.1:8080
cd frontend && npm run dev         # second shell, http://localhost:3000
# no World at all: STRIKE_DEV_NO_WORLD=1 cargo run --manifest-path backend/Cargo.toml -p server
```

Without `ARC_TREASURY_SECRET_KEY`, withdrawals queue but do not pay out.

Speed-ups for a demo: `WORLD_SELFIE_DAILY_LOSS=2` makes the cool-off easy to hit; a small stop-loss on the agent reaches the 50% pause in a few rounds.

### Getting a sandbox approval to work

What worked for us, after the sandbox app's "simulated human" was refused every time:

1. Install the sandbox World App and, in it, run the Orb communication test with your ID.
2. Reset the app settings to default.
3. Create the account and link it with a passkey.
4. Approve with the passkey. The token comes back with `acr = orb`, `amr = pop user mfa`.

If an approval ends `denied` with no clear reason, the backend log line `[agentpass] token poll ended: access_denied (...)` carries World's `error_description`. The detail World shows on its own error page is often only a generic "Something went wrong" with a reference.

## 3-minute demo script

There are no Orbs in India, so IDKit runs against staging and the simulator (https://simulator.worldcoin.org), and Agent Pass runs against the sandbox issuer with a sandbox World App account (Orb level, passkey).

| Time | Do | Say |
|---|---|---|
| 0:00 | Open `/trade`, connect wallet A, place a 2 USDC bet. Verify modal opens. | "Strike is fast USDC markets on Arc with an AI agent. Your first bet asks one question: are you a unique human?" |
| 0:20 | Verify with the simulator (Orb). Bet goes through. Point at the status line: tier, caps, open stake. | "That nullifier is now your human key. Every limit counts against it, not against the wallet." |
| 0:45 | Open `/agent`, start a YOLO agent with "Sign and approve in World App". The approval card shows the code. Open the link, approve with the passkey in the sandbox World App. Agent starts without a second wallet signature. | "A YOLO agent bets without asking. So before it starts, the human approves in World App, through Agent Pass." |
| 1:15 | Let the agent lose half its stop-loss. Panel shows "paused" and a new card. Approve. Agent resumes. | "The agent hit 50% of its stop-loss. It stopped itself and asked its human. Nothing is placed while it waits." |
| 1:45 | At 75% it pauses again. Press Cancel. Session stops: "human check denied". Balance unchanged. | "Cancel, deny or expire, and the action never happens. No money moved." |
| 2:10 | Switch to wallet B, verify with the same simulator identity, bet 51 USDC. 409 `human_exposure_cap`. | "New wallet, same human, same limits. That is what breaks without World ID." |
| 2:35 | Withdraw 30 USDC. Approval card. Approve. Queued without signing again. | "Moving money out above 25 needs the human too. One approval, one action, used once." |
| 2:55 | Close. | "Your agent trades for you, never past what one human allows." |

Say on stage that Agent Pass is on the sandbox issuer and why. Fallback if World is unreachable: run with `STRIKE_DEV_NO_WORLD=1` and say so. Step-ups then approve themselves.

## Known limitations

1. **Production Agent Pass needs an Orb.** On both production and sandbox, Selfie Check is off (`GET /api/v1/features` returns `selfieCheck: false`, discovery lists only `orb` and `orb-face` in `acr_values_supported`). Asking for selfie or orb silently becomes orb. With no Orbs in India we could not get a production approval, so the demo uses the sandbox issuer.
2. **Sandbox "simulated human" is refused.** Approvals from the sandbox app's simulated human in Developer Settings always ended `access_denied`. Only a sandbox account set up as described in "Getting a sandbox approval to work" was accepted.
3. **IDKit Selfie tier is coded but not tested live.** The live IDKit run used the Orb preset in the simulator.
4. **Passkeys are accepted** on Orb-level accounts (`amr = pop user mfa`). That proves a user-verified device of the Orb-verified account holder, not a fresh face scan.
5. Server integration tests (settlement, world_agent, shutdown, http) pass on Linux. The full pause and resume loop was verified live in the browser, not by an automated server test.
6. A signed agent start is valid for 9 minutes and a signed withdrawal for 10, longer than the 5 minute approval, so a slow approval no longer expires the re-sent request.
7. A 401 with no code from the agent routes makes the frontend re-sign the wallet once for nothing. Harmless.
8. Not seen live yet: `slow_down` from the token endpoint. We assume it comes as HTTP 400 like the other RFC 8628 errors.
9. After the daily loss cap, each new bet attempt pushes the cool-off another 30 minutes, until UTC midnight resets the loss total.
10. The device code is never stored (only its hash), logged or returned; the poller keeps it in memory.
11. The approval card shows a code and a link, no QR code.
12. One poller per process. Approval polling breaks if the API runs as more than one process.
13. The nullifier, `sub`, device code and tokens are never logged. Logs carry the step-up id, status, HTTP status, World's OAuth error code and World's `error_description` (cut to 200 characters).
14. Agent Pass identity is bound to the human by trust on first use, since World gives no link between the IDKit nullifier and the Agent Pass `sub`.
15. If the market signal has gone by the time a proposal is approved, the trade is not placed and the reason reads "The market moved while you were approving, so nothing was placed and no money moved".
16. A withdrawal over the 50 USDC per-request or 200 USDC daily cap is refused before any World approval is requested.
