# Strike on Arc

**bounty: Best DeFi / Onchain Finance App Built End to End in Arc Studio**

**Arc Studio project:** [studio.arc.io/app/3466b6f3-8cdb-436f-a47b-2eb0d379c4dd](https://studio.arc.io/app/3466b6f3-8cdb-436f-a47b-2eb0d379c4dd) · **live:** [strike.fastship.studio](https://strike.fastship.studio)

Strike is a trading app on Arc. you call higher or lower on crypto, forex, stocks and metals in rounds of 5 seconds to 1 minute, settled in USDC or EURC. you can also buy and sell test shares of real stocks at the live price. money comes in from any chain through Circle, the vault on Arc pays wins in seconds, and every result is checkable by anyone

## architecture

![how strike fits together](../arkiv/assets/architecture.png)

| part | what it is | code |
|---|---|---|
| web app | Next.js 16, wagmi and viem. trade, markets, stock pages, history, the AI agent | [`frontend/`](../frontend) |
| Strike server | Rust (axum) over a single writer SQLite ledger. settles every round from live prices, pays out inside caps, signs stock quotes, commits round fingerprints to Arc | [`backend/`](../backend) |
| Strike vault | `StrikeTreasury` on Arc: holds USDC and EURC, pays out with caps, keeps the round fingerprints | [`contracts/StrikeTreasury.sol`](../contracts/StrikeTreasury.sol) |
| test stocks | `TestStockMarket` on Arc: buy and sell test shares at a quote the server signs | [`contracts/TestStockMarket.sol`](../contracts/TestStockMarket.sol) |

## contracts on Arc testnet

| contract | address |
|---|---|
| `StrikeTreasury` | [`0x8726144B6a122862B9F1184752d8ebA0AcD662B6`](https://explorer.testnet.arc.io/address/0x8726144B6a122862B9F1184752d8ebA0AcD662B6) |
| `TestStockMarket` | [`0xd9f98f3b268e788f3ccf6e7ced2d592a84a6f80f`](https://explorer.testnet.arc.io/address/0xd9f98f3b268e788f3ccf6e7ced2d592a84a6f80f) |
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| CCTP `TokenMessengerV2` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` (Arc domain 26) |

both contracts are tested with Foundry ([`contracts/test`](../contracts/test), `forge test` from the root). addresses, ABIs and caps live in [`contracts/deployments/`](../contracts/deployments)

## money in, money out

![money in, money out](../arkiv/assets/money-flow.png)

| Circle product | how Strike uses it | code |
|---|---|---|
| **USDC** | the game's currency and Arc's gas, so a player only ever holds dollars | everywhere |
| **EURC** | play and buy stocks in euros, priced at the live EUR/USD rate | [`backend/crates/core/src/markets.rs`](../backend/crates/core/src/markets.rs) |
| **Gateway** | one USDC balance across chains. a stock buy pulls from it and mints on Arc in seconds | [`frontend/lib/gateway/`](../frontend/lib/gateway) |
| **CCTP via Bridge Kit** | brings USDC in from Base, Arbitrum or Ethereum Sepolia, and sends it back out. Circle's Forwarder pays the gas on the other side | [`frontend/lib/bridge/cctp.ts`](../frontend/lib/bridge/cctp.ts) |
| **CCTP from the vault** | the vault can pay a winner straight onto another chain (`payoutCrossChain`) | [`contracts/StrikeTreasury.sol`](../contracts/StrikeTreasury.sol) |
| **Modular Wallets** | sign in with a passkey, no extension: a Circle smart account on Arc | [`frontend/lib/wallet/passkey.ts`](../frontend/lib/wallet/passkey.ts) |

a stock buy finds your USDC wherever it is: your Arc wallet first, then your Gateway balance, then a bridge from another chain ([`frontend/lib/gateway/usdcSources.ts`](../frontend/lib/gateway/usdcSources.ts))

## how the money stays safe

- **two roles in the vault.** the owner sets the caps and can sweep. the operator (the server's key) can only pay out and commit fingerprints
- **caps on every payout.** 1,000 per transaction and 10,000 per day, per token. no cap set means nothing can be paid
- **deposits are checked on Arc.** the server credits a deposit only after reading the token transfer into the vault from Arc itself
- **withdrawals pay out on their own,** inside the caps, and every payout carries the bet or withdrawal id onchain
- **stock quotes can't be replayed.** each quote is signed for one token, one symbol and one price, and expires in 60 seconds. a tampered price, a wrong symbol, an expired quote, selling more than you hold and paying in the wrong token are all refused onchain
- **either role can pause,** only the owner resumes

## every round is checkable

![how a round proves itself](../arkiv/assets/proof-staircase.png)

every 10 minutes the server rolls that batch's settled rounds into one fingerprint (a Merkle root) and stores it in the vault with `commitRounds`. it's write once. anyone can then check a single round with `verifyRound(epoch, leaf, proof)`. the results themselves are public on Arkiv, and the full proof file is on Swarm, see [arkiv/](../arkiv)

## built in Arc Studio

the Strike project lives in Arc Studio: the contracts, their tests and the app. the vault was deployed from Studio

## run it

```bash
cp .env.example .env.local
(cd frontend && npm install)
cargo run --manifest-path backend/Cargo.toml -p server    # API on 127.0.0.1:8080
cd frontend && npm run dev                                # app on http://localhost:3000
```

free test USDC at [faucet.circle.com](https://faucet.circle.com)
