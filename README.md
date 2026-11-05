# Strike on Arc

> Binary options on **Arc** — USDC settlement, live-price settlement, no per-bet wallet signature.

| | |
|---|---|
| **Live (Arc Testnet)** | https://ethglobalmumbai.vercel.app/ |
| **Trade** | https://ethglobalmumbai.vercel.app/trade |
| **Arc Studio** | https://studio.arc.io/app/3466b6f3-8cdb-436f-a47b-2eb0d379c4dd |
| **Treasury (testnet)** | [`0x1aE19F0dF3062e154b94b7AF43Cc5A884184De7A`](https://explorer.testnet.arc.io/address/0x1aE19F0dF3062e154b94b7AF43Cc5A884184De7A) |
| **Deck** | [Google Slides](https://docs.google.com/presentation/d/1gPwWqA6F5mqtdAjCApLNCzE-zLr99AYG1fzq4zLuQyY/edit?usp=sharing) |
| **GitHub** | https://example.com/strike |

This repo settles on **Arc only**. Players deposit **USDC**, trade binary rounds against a house balance, and withdraw on-chain. Other networks are not supported.

---

## ETHGlobal Mumbai — Arc track

**Arc Studio project:** https://studio.arc.io/app/3466b6f3-8cdb-436f-a47b-2eb0d379c4dd

### Before the hackathon

Strike was a working binary options dapp that had been ported across several chains, most recently BOT Chain (native BOT + USDT). The codebase still carried integrations for about ten networks, a staking product, and a treasury contract designed for a separate native coin and ERC-20.

### During the hackathon

- **Pruned to Arc only** — removed every other chain, staking, dead code and unused packages (~26.8k lines), driven by knip and `tsc --noUnusedLocals`.
- **USDC-only `StrikeTreasury`** — rewritten for Arc, where native USDC and the ERC-20 interface share one balance: no payable paths, `depositToken`, `withdrawTokenTo`, batched payouts, pause and two-step ownership.
- **Treasury contract is now the money path** — deposits land in the contract, payouts go through `withdrawTokenTo` signed by the owner key (previously an EOA).
- **Decimals fix** — the app treated USDC as native with 6 decimals; native USDC on Arc has 18. Everything now goes through the 6-decimal ERC-20 interface.
- **Testnet end to end** — Arc Testnet config, Neon Postgres, deploy + e2e scripts driven by env.

---

## Table of Contents

1. [Overview](#overview)
2. [Arc](#arc)
3. [How it works](#how-it-works)
4. [Game modes](#game-modes)
5. [Treasury contract](#treasury-contract)
7. [Fees](#fees)
8. [Tech stack](#tech-stack)
9. [Architecture](#architecture)
10. [Schema](#schema)
11. [API](#api)
12. [Admin dashboard](#admin-dashboard)
13. [Directory structure](#directory-structure)
14. [Environment variables](#environment-variables)
15. [Local development](#local-development)
16. [Contracts](#contracts)
17. [Deployment](#deployment)
18. [Security](#security)

---

## Overview

Strike is a fast binary options dapp that lives entirely on Arc.

- Deposit USDC to the `StrikeTreasury` contract.
- Trade 5s / 10s / 15s / 30s / 1m rounds without signing a transaction per bet.
- Outcomes resolve from **live price feeds (Yahoo/Binance)** price feeds.
- Wins and losses update an in-house balance; withdrawals go back on-chain.

Playable asset: **USDC** (6 decimals). Markets cover crypto, forex, stocks, metals, and commodities via live price feeds.

---

## Arc

| | Mainnet | Testnet |
|---|---|---|
| **Chain ID** | `5042` | `5042002` |
| **RPC** | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| **Explorer** | https://explorer.arc.io | https://explorer.testnet.arc.io |
| **USDC (ERC-20 interface, 6 dp)** | `0x3600000000000000000000000000000000000000` | `0x3600000000000000000000000000000000000000` |
| **Faucet** | — | https://faucet.circle.com |
| **Treasury** | `NEXT_PUBLIC_TREASURY_ADDRESS` (StrikeTreasury) | `NEXT_PUBLIC_TREASURY_ADDRESS` (StrikeTreasury) |

Mainnet is the default; set the `NEXT_PUBLIC_ARC_*` variables to run on testnet.

On Arc, native USDC (the gas token, 18 decimals) and the USDC ERC-20 interface (6 decimals) are **the same balance**. Strike only moves USDC through the ERC-20 interface so amounts are never mis-scaled.

**Wallets:** MetaMask, Trust Wallet, WalletConnect (wagmi + ConnectKit), and Privy social login (embedded EVM wallet). The app switches the connected wallet onto Arc on connect.

Config lives in `lib/arc/config.ts` for compatibility with existing internal imports. Arc values use `NEXT_PUBLIC_ARC_*` variables.

---

## How it works

```
1. Connect a wallet on Arc
2. Deposit USDC to StrikeTreasury
3. House balance is credited (off-chain, in the SQLite ledger)
4. Place bets — no wallet signature per round
5. Live price at expiry settles the outcome
6. Withdraw back to the same Arc address
```

Deposits and withdrawals are on-chain. Bets, wins, and losses are atomic house-balance RPCs so rounds can settle in milliseconds.

```mermaid
flowchart LR
  subgraph Browser["Browser — Next.js 16 + wagmi/ConnectKit/Privy"]
    UI[Trade UI · Zustand store]
  end
  subgraph Server["Rust backend, behind Next's /api proxy"]
    BAL["/api/balance/* — deposit · bet · win · withdraw"]
    ADM["/api/admin/* — review + payout"]
    PX["/api/prices/latest — Yahoo / Binance"]
  end
  DB[("SQLite ledger, one writer<br/>user_balances · bet_history<br/>withdrawal_requests · audit log")]
  subgraph Arc["Arc (USDC gas)"]
    USDC["USDC ERC-20 interface<br/>0x3600…0000"]
    T["StrikeTreasury<br/>depositToken · withdrawTokenTo<br/>pause · 2-step owner"]
  end
  UI -- "1. USDC transfer to treasury" --> USDC --> T
  UI -- "2. tx hash" --> BAL
  BAL -- "verify Transfer log on-chain" --> Arc
  BAL <--> DB
  UI -- "bets, no signature" --> BAL
  UI --> PX
  UI -- "3. signed withdrawal intent" --> BAL
  ADM -- "4. owner key: withdrawTokenTo" --> T
  ADM <--> DB
```

---

## Game modes

### Classic

Pick UP or DOWN, a multiplier tile, and an expiry. Win if the live price at `endTime` is above (UP) or below (DOWN) the strike at bet placement.

### Box

The live chart shows a grid of price-band tiles. Win if the price line tip is inside the selected band when it reaches the tile’s start time. Tighter bands pay higher multipliers.

### Draw

Draw a rectangle on the chart. Win if price stays inside that band for the full window. Smaller, farther, shorter boxes pay more.

### Blitz

Pay a one-time entry fee to the fee collector during the active window. All multipliers are boosted **2×** while Blitz is live (1 min on, 2 min cooldown).

| Asset | Entry fee |
|-------|-----------|
| USDC | 1 USDC |

### Demo

Full simulation of every mode with a local balance. No wallet required. Demo bet IDs are prefixed `demo-*` and never written to `bet_history`.

---

## Treasury contract

`contracts/arc/StrikeTreasury.sol` is the house vault. It holds the playable asset (USDC). Players deposit; the operator pays withdrawals and winnings after off-chain settlement.

Why a contract instead of an EOA:

- **`pause()`** stops deposits and payouts immediately if a key is compromised.
- **Two-step ownership** — the nominee must call `acceptOwnership()`, so a mistyped address cannot lock the treasury.

Events (`Deposited`, `Withdrawn`) are the on-chain audit trail used to reconcile the house ledger.

See [`contracts/arc/README.md`](contracts/arc/README.md) for deploy addresses, e2e coverage, and owner.

---

## Fees

Tiered on every deposit and withdrawal. The fee is sent from the treasury to `NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC`.

| Tier | Fee |
|------|-----|
| free | 10% |
| standard | 9% |
| vip | 8% |

Net amount is what is credited on deposit or sent on withdrawal. Blitz entry fees are a separate flat transfer to the same collector.

---

## Tech stack

| Layer | Stack |
|-------|--------|
| Frontend | Next.js 16 App Router, React 19, TypeScript, Tailwind v4, Zustand, TanStack Query |
| Arc | wagmi 3 + viem 2 + ConnectKit, ethers 6, Privy |
| Backend | Rust (axum) service in `backend/`, SQLite in WAL mode |
| Oracle | live price feeds (Yahoo/Binance) |
| Contracts | Solidity (`StrikeTreasury`) |
| Tooling | cargo test, ESLint, PostHog |

---

## Architecture

### State (Zustand — `lib/store/`)

| Slice | Responsibility |
|-------|----------------|
| `walletSlice` | Address, USDC currency, real vs demo |
| `gameSlice` | Mode, active/settled bets, price feed, Blitz |
| `balanceSlice` | House balance, deposit/withdraw, demo balance |
| `historySlice` | Local bet history |
| `referralSlice` | Referral code |
| `profileSlice` | Username / profile |

Combined as `useStore` in `lib/store/index.ts`.

### Arc modules (`lib/arc/`)

| File | Role |
|------|------|
| `config.ts` | Arc chain ID, RPC, explorer, USDC address, treasury, and assets |
| `wagmi.ts` | Single-chain wagmi config (`arc`) |
| `client.ts` | Browser deposits and balance reads (USDC) |

### Bet lifecycle

```mermaid
flowchart TD
  A[User picks target + amount in USDC] --> B[Zustand creates active bet]
  B --> C[POST /api/balance/bet]
  C --> D[Server freezes strike, end and multiplier with the debit]
  D --> E[Server sampler prices the asset until endTime]
  E --> F{Server: outcome from its own end price}
  F -- Win --> G[Payout from the frozen stake and multiplier]
  F -- Loss --> H[No payout]
  F -- Tie or no price --> I[Stake refunded]
  G & H & I --> J[Client reads the result from POST /api/balance/win]
```

### Withdrawal flow

```mermaid
flowchart TD
  U[User signs withdrawal intent in wallet] --> W[POST /api/balance/withdraw]
  W --> S{Signature, balance, cap, ban, frequency checks}
  S -- fail --> Y[Reject]
  S -- pass --> P[withdrawal_requests: pending]
  P --> A[Admin dashboard: accept / reject]
  A -- accept --> Z[Claim the row and debit in one commit]
  Z --> T["StrikeTreasury.withdrawTokenTo (owner key)"]
  T --> R[Record the tx hash, or park the row for an operator]
```

---

## Schema

### Tables

| Table | Purpose |
|-------|---------|
| `user_balances` | PK `(user_address, currency)` — USDC house balance, tier, status |
| `balance_audit_log` | deposit, withdrawal, bet_placed, bet_won, bet_lost, platform_fee, refund, … |
| `bet_history` | Settled real-mode bets |
| `user_profiles` / `user_referrals` | Username and referrals |
| `access_codes` / `waitlist` / `user_sessions` | Onboarding and dwell time |
| `withdrawal_requests` | Manual approval queue |

Arc defaults `user_balances.currency` to `'USDC'`. See `db/arc.sql`.

The schema is `db/schema.sqlite.sql`, and `PRAGMA user_version` tracks changes after it (`MIGRATIONS` in `backend/crates/core/src/db.rs`). Only the backend writes the file. `supabase/` and `db/arc.sql` are the old Postgres schema: only `db/migrate_pg_to_sqlite`'s test still uses them.

---

## API

### Balance

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/balance/[address]` | Balances for a Arc address |
| `POST` | `/api/balance/deposit` | Verify on-chain tx, credit net house balance |
| `POST` | `/api/balance/withdraw` | Signed intent → treasury payout |
| `POST` | `/api/balance/bet` | Deduct stake |
| `POST` | `/api/balance/win` | Credit win (dedup on `betId`) |
| `POST` | `/api/balance/session` | HttpOnly cookie for balance mutations |

Deposits are verified against the Arc RPC (`verify_deposit` in `backend/crates/core/src/eth.rs`).

### Bets / public

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/bets/save` | Upsert settled bet |
| `GET` | `/api/bets/history` | User history |
| `GET` | `/api/bets/leaderboard` | Aggregated leaderboard |
| `GET` | `/api/stats/public` | Platform stats (`chainsActive: 1`) |

Admin routes live under `/api/admin/*` (auth, stats, ledger, treasury balances, withdrawal queue, access codes).

---

## Admin dashboard

`/dashboard` — every `/api/admin/*` route requires the admin session cookie.

Wallet Intel, Ledger, Player P&L, Gameplay, Financials (including withdrawal Accept/Reject), Inventory, Referrals, Access Codes, Danger Zone. Treasury snapshots read USDC on Arc.

---

## Directory structure

```
├── app/                        # Next.js App Router
│   ├── trade/                  # Game UI
│   ├── dashboard/              # Admin
│   └── providers.tsx           # wagmi + Privy (Arc only)
│
├── components/
│   ├── game/                   # GameBoard, LiveChart, BetControls
│   ├── wallet/                 # ConnectKit + Privy
│   └── balance/                # Deposit / withdraw (USDC)
│
├── lib/
│   ├── arc/               # config, wagmi, client
│   ├── store/                  # Zustand slices
│   ├── balance/                # Client balance helpers
│   └── supabase/               # Query client for the /api/db gateway
│
├── backend/                    # Rust API, token parity and concurrency harnesses
├── contracts/arc/         # StrikeTreasury.sol, deploy, e2e
├── db/                         # schema.sqlite.sql, migrate_pg_to_sqlite, check-arc.mjs
├── scripts/deploy/             # oracle.sh, systemd units, backup and restore
├── supabase/                   # Old Postgres schema, used by the migration tool's test
└── docs/                       # ENVIRONMENT.md, CONTRIBUTING.md, SECURITY_REPORTING.md
```

---

## Environment variables

Copy `.env.example` to `.env` / `.env.local`. Arc values that this app actually reads:

### App

```env
NEXT_PUBLIC_APP_NAME=Strike
NEXT_PUBLIC_ROUND_DURATION=30
NEXT_PUBLIC_PRICE_UPDATE_INTERVAL=1000
NEXT_PUBLIC_CHART_TIME_WINDOW=300000
```

### Arc

```env
NEXT_PUBLIC_ARC_CHAIN_ID=5042            # optional override
NEXT_PUBLIC_ARC_RPC_ENDPOINT=https://rpc.mainnet.arc.io
NEXT_PUBLIC_ARC_EXPLORER=https://explorer.arc.io
NEXT_PUBLIC_ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000

NEXT_PUBLIC_TREASURY_ADDRESS=0x53A4228A2a50438e815E6c7CfD4f29DcA88e92CF
ARC_TREASURY_SECRET_KEY=                 # owner key — server only

NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC=

NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
```

`ARC_TREASURY_SECRET_KEY` must match `NEXT_PUBLIC_TREASURY_ADDRESS`. Contract deploy/e2e also honor `ARC_RPC_URL`.

### Backend, Privy, admin, settlement

```env
BACKEND_URL=http://127.0.0.1:8080        # required by next build
SQLITE_PATH=./strike.sqlite

NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=

DASHBOARD_PASSWORD=

BALANCE_SETTLEMENT_SECRET=
BALANCE_INTERNAL_SECRET=
```

### Analytics / oracle

```env
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=
```

Do not commit secrets. See `docs/ENVIRONMENT.md`.

---

## Local development

```bash
npm install
cp .env.example .env
# Fill the Arc values and SQLITE_PATH
npm run api:dev            # the Rust API on 127.0.0.1:8080
npm run dev                # in another shell
```

App: http://localhost:3000. Next proxies `/api/*` to the Rust service, so both must run. `next dev` assumes port 8080; `next build` requires `BACKEND_URL`.

```bash
BACKEND_URL=http://127.0.0.1:8080 npm run build
npm run api:test
npm run api:check          # fmt, clippy, build
npm run api:parity         # tokens against the frozen JS algorithms
npm run arc:check          # RPC + USDC sanity
```

Running it in production: `docs/OPERATIONS.md`.

`docs/CONTRIBUTING.md` covers PR expectations.

---

## Contracts

```bash
ARC_TREASURY_SECRET_KEY=... ARC_USDC_ADDRESS=0x... node contracts/arc/deploy.mjs
ARC_TREASURY_SECRET_KEY=... ARC_USDC_ADDRESS=0x... node contracts/arc/e2e.mjs
```

`e2e.mjs` covers deposit (call + plain transfer), payout, batch payout, over-balance refusal, non-owner refusal, pause/unpause, and the ownership handshake at 0.00001 per step.

---

## Deployment

Vercel (Next.js App Router) — production: https://ethglobalmumbai.vercel.app/

Set the Arc env vars in the project. `next.config.ts` applies CSP, `X-Frame-Options`, COOP, and CORS. Type errors block the build.

---

## Security

- Signed withdrawal intents on Arc (replay protection)
- Duplicate payout guard: `betId` checked in `balance_audit_log`
- Treasury `pause()` and two-step ownership
- The browser has no database credentials: `/api/db` serves only an allow-list, and the backend is the only writer
- Admin routes behind `requireAdminAuth`
- Balance mutation routes gated by session cookie / `BALANCE_INTERNAL_SECRET`

Report issues via `docs/SECURITY_REPORTING.md`.
