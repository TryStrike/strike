# StrikeTreasury on Arc

House treasury settling in **USDC** (`0x3600…0000`) and **EURC** (`0x89B5…D72a`),
both 6 decimals on Arc. Built, tested (52 Foundry tests) and deployed in
[Arc Studio](https://studio.arc.io/app/3466b6f3-8cdb-436f-a47b-2eb0d379c4dd).

Arc Testnet: `0xea76bc5a87114d8a6a85f4dfd6c48c5e688a9871` (see `deployments/`).

- **Deposits** are plain token transfers to the treasury. The backend credits them
  from the Transfer log, so there is no deposit function and no approval step.
- **Two roles.** The owner sets the operator and caps, sweeps, and unpauses. The
  operator (the backend key) can only pay out and commit round proofs. Today both
  are `0xc036…fD28`; `transferOwnership` moves the owner to a cold wallet.
- **Caps.** Every payout is checked against a per-transaction and a per-day cap per
  token (1,000 and 10,000 for USDC and EURC). No cap set means nothing can be paid.
- **Payouts.** `payout` and `payoutBatch` carry a `ref` (bet or withdrawal id) in
  the event. Fees are never sent anywhere: they stay in the treasury.
- **Cross-chain.** `payoutCrossChain` pays USDC to another chain through CCTP V2
  (`TokenMessengerV2` `0x8FE6…2DAA`, Arc domain 26), with an exact approval per burn.
- **Round proofs.** `commitRounds` stores a write-once Merkle root per epoch of
  settled rounds; `verifyRound` checks a round against it (sorted-pair tree).
- **Pause.** Either role pauses at once, only the owner resumes.

Constructor: `(usdc, eurc, tokenMessenger, owner, operator)`. The owner is an
argument, never the deployer, so a shared deploy wallet cannot end up owning it.
