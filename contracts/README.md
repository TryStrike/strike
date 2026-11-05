# StrikeTreasury on Arc

House treasury holding **USDC** through Arc's ERC-20 interface
(`0x3600000000000000000000000000000000000000`, 6 decimals). Players deposit
here; the owner key pays winnings and withdrawals out with `withdrawTokenTo`
after settling off-chain.

On Arc the native gas token and the ERC-20 are the same USDC balance (18 vs 6
decimals), so the contract has no payable entry points and refuses native
value.

## Why a contract rather than an EOA

A plain wallet means one leaked key drains everything. This contract adds:

- **pause()** halts deposits and payouts immediately, without an upgrade.
- **Two-step ownership transfer** - the nominee must call `acceptOwnership()`,
  so a mistyped address cannot lock the treasury out of reach.
- **Events** (`Deposited`, `Withdrawn`) to reconcile the off-chain ledger.

## Commands

Both scripts read `.env.local` then `.env` (`ARC_TREASURY_SECRET_KEY`,
`NEXT_PUBLIC_ARC_CHAIN_ID`, `NEXT_PUBLIC_ARC_RPC_ENDPOINT`, `NEXT_PUBLIC_ARC_EXPLORER`). `NEXT_PUBLIC_ARC_CHAIN_ID`
is required — there is no implicit default, so a script can never quietly act on
mainnet (`5042`) when the testnet (`5042002`) was meant.

`deploy.mjs` refuses to overwrite an existing `deployments/arc-<chainId>.json`
unless `--force` is given: redeploying orphans the previous treasury and the
funds tracked against it.

```bash
node contracts/deploy.mjs   # writes deployments/arc-<chainId>.json + ABI
```


## Configuration

```bash
NEXT_PUBLIC_TREASURY_ADDRESS=<deployed StrikeTreasury>
ARC_TREASURY_SECRET_KEY=<owner key>
```
