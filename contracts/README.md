# StrikeTreasury on Arc

House treasury settling in **USDC** (`0x3600…0000`) and **EURC** (`0x89B5…D72a`),
both 6 decimals on Arc. Deposits are plain token transfers to the treasury; the
backend credits them from the Transfer log.

`StrikeTreasury.sol` is **v2**. Arc Testnet still runs **v1** at
`0x1aE19F0dF3062e154b94b7AF43Cc5A884184De7A` (see `deployments/`) until v2 is
deployed from Arc Studio and v1's balance is moved over.

## v2

- **Two keys.** The owner (cold) sets the operator and caps, sweeps, and unpauses.
  The operator (the backend's hot key) can only pay out and commit round proofs.
- **Caps.** Every payout is checked against a per-transaction and a per-day cap
  for its token. A leaked operator key can move at most one day's cap. No cap set
  means nothing can be paid.
- **Payouts.** `payout` and `payoutBatch` pay USDC or EURC with a `ref` (bet or
  withdrawal id) in the event. A withdrawal fee is simply not sent and stays here.
- **Cross-chain.** `payoutCrossChain` pays USDC to another chain through CCTP V2
  (`TokenMessengerV2` `0x8FE6…2DAA`, Arc domain 26), with an exact approval per burn.
- **Round proofs.** `commitRounds` stores a write-once Merkle root per epoch of
  settled rounds; `verifyRound` checks a round against it (sorted-pair tree).
- **Pause.** Either key pauses at once, only the owner resumes.

Constructor: `(usdc, eurc, tokenMessenger, operator)`.

## v1 (deployed)

`withdrawTokenTo`, `withdrawBatch` (fee and net in one transaction), `pause`,
two-step ownership. One key owns and pays.
