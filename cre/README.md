# round-attestor (Chainlink CRE)

Every time the house commits an epoch root (`StrikeTreasury.RoundsCommitted`), this workflow re-settles every round of that epoch on its own and writes the verdict to `contracts/RoundAttestor.sol` on Arc testnet.

Per run:
1. Log trigger on `RoundsCommitted(uint256,bytes32,uint256)` from the treasury, finalized blocks only.
2. In node mode: `GET {apiBase}/api/proofs/epoch/{n}`, then one Binance 1s klines call per crypto asset (14 at most, the 15 call budget). Each round's strike and end must sit inside the klines of its second and the two before it. `decide()` from `settlement.rs` recomputes outcome and payout, and the leaves and root are rebuilt from the fields, never taken from the API.
3. Consensus (identical) on `{root, checked, mismatches, skipped, liabilities}` only.
4. EVM reads at the finalized block: `treasury.roundRoots(n)` and `usdc.balanceOf(treasury)`.
5. Report `(chainSelector, epoch, root, checked, mismatches, skipped, usdcBalance, liabilities)` to `RoundAttestor`, which emits `HouseMismatch` and `Undercollateralized` when they apply.

Rounds priced from Yahoo, withheld rounds and assets past the call budget count as `skipped`. They still go into the root.

## Run it

Needs the CRE CLI (v1.0.7 or newer for Arc) and Bun 1.2.21 or newer.

```powershell
irm https://app.chain.link/cre/install.ps1 | iex   # new shell after this
cre version                                        # 1.0.7 or newer
cre login                                          # browser login, needed even to simulate
cre whoami
cd cre/round-attestor; bun install; cd ..          # postinstall runs bunx cre-setup
```

`cre/.env` (gitignored), a throwaway wallet funded from the Arc testnet USDC faucet, never the treasury key:

```
CRE_ETH_PRIVATE_KEY=<64 hex, no 0x>
```

### Deploy RoundAttestor

Deploy `contracts/RoundAttestor.sol` (contract `RoundAttestor`) in Arc Studio on Arc testnet (chain id `5042002`):

| Constructor arg | Value |
|---|---|
| `forwarder` | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` (MockKeystoneForwarder, Arc testnet) |
| `treasury_` | `0xea76bc5a87114d8a6a85f4dfd6c48c5e688a9871` (`StrikeTreasury`, see `contracts/deployments/arc-5042002.json`) |

The deployer becomes the owner. Leave expected author, workflow name and workflow id unset while on the MockForwarder, it sends no metadata. Then:

1. Put the address in `round-attestor/config.staging.json` as `attestor`. The workflow refuses to start without it.
2. Set `NEXT_PUBLIC_ROUND_ATTESTOR_ADDRESS` in the root `.env.local` (and the prod backend env) so `/api/proofs/*` reads the verdicts.
3. Set `PROOFS_START_EPOCH` (epoch = unix ms / 600000) so the backend committer runs. It also needs `ARC_TREASURY_SECRET_KEY` (the treasury operator). Without either it logs that it is off.

### Simulate

The newest `commitRounds` tx is `commit_tx` in `curl http://127.0.0.1:8080/api/proofs/epochs?limit=1`.

With the backend running on `127.0.0.1:8080` and that tx on Arc, from `cre/`:

```powershell
# dry run, no tx
cre workflow simulate round-attestor --target staging-settings --non-interactive --trigger-index 0 --evm-tx-hash <commitRounds tx> --evm-event-index 0
# real tx through the MockForwarder
cre workflow simulate round-attestor --target staging-settings --non-interactive --trigger-index 0 --evm-tx-hash <commitRounds tx> --evm-event-index 0 --broadcast
```

The last log line reads `epoch N checked C mismatches M skipped S root matches solvency Rx tx 0x..`. Check it with `cast call <attestor> "attestations(uint256)" N --rpc-url https://rpc.testnet.arc.io`.

## Trust

The MockForwarder is for simulation. A verdict written through it proves the pipeline, not a DON signature. For a DON deployment, point a second `RoundAttestor` at the production KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` and call `setExpectedWorkflowId`. Liabilities come from our ledger, snapshotted when the epoch was committed.
