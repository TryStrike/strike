# StrikeTreasury on Arc

House treasury on Arc (chain 5042) holding **USDC**. Players deposit here; the
operator pays winnings and withdrawals out after settling off-chain.

Arc explorer: https://explorer.arc.io

## Why a contract rather than an EOA

A plain wallet means one leaked key drains everything. This contract adds:

- **pause()** halts deposits and payouts immediately, without an upgrade.
- **Two-step ownership transfer** - the nominee must call `acceptOwnership()`,
  so a mistyped address cannot lock the treasury out of reach.

## Commands

```bash
ARC_TREASURY_SECRET_KEY=... ARC_USDC_ADDRESS=0x... node contracts/arc/deploy.mjs
ARC_TREASURY_SECRET_KEY=... ARC_USDC_ADDRESS=0x... node contracts/arc/e2e.mjs
```

`e2e.mjs` covers deposit, payout, batch payout, over-balance refusal, non-owner
refusal, pause/unpause and the ownership handshake.

## Configuration

```bash
NEXT_PUBLIC_TREASURY_ADDRESS=<deployed StrikeTreasury>
ARC_TREASURY_SECRET_KEY=<owner key>
ARC_USDC_ADDRESS=<USDC on Arc>
```
