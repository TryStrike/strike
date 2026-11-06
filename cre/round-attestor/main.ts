import {
  bytesToHex,
  ConsensusAggregationByFields,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  identical,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  TxStatus,
  type EVMLog,
  type NodeRuntime,
  type Runtime,
} from '@chainlink/cre-sdk'
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { z } from 'zod'
import { decide, leaf, merkleRoot, parseKlines, priceInKlines, roundSchema, type Kline, type Round } from './settle'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address')

const configSchema = z.object({
  chainSelectorName: z.string(),
  apiBase: z.string().url(),
  treasury: address,
  usdc: address,
  attestor: address,
  klineBase: z.string().url(),
  symbols: z.record(z.string(), z.string()),
  gasLimit: z.string().regex(/^\d+$/),
})
type Config = z.infer<typeof configSchema>

const epochSchema = z.object({
  epoch: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  root: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  count: z.number().int().positive(),
  liabilities_usdc: z.string().regex(/^\d+$/),
  rounds: z.array(roundSchema).min(1),
})

const ROUNDS_COMMITTED = keccak256(toBytes('RoundsCommitted(uint256,bytes32,uint256)'))
const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function roundRoots(uint256) view returns (bytes32)',
])
const REPORT_PARAMS = parseAbiParameters(
  'uint64 chainSelector, uint256 epoch, bytes32 root, uint32 checked, uint32 mismatches, uint32 skipped, uint128 usdcBalance, uint128 liabilities',
)
// 15 HTTP calls per execution: one to our API, the rest to Binance, one per asset.
const KLINE_CALL_BUDGET = 14
const KLINE_WINDOW_MS = 1_000_000

type Verdict = {
  root: string
  checked: number
  mismatches: number
  skipped: number
  liabilities: string
}

const getJson = (runtime: NodeRuntime<Config>, url: string): unknown => {
  const resp = new cre.capabilities.HTTPClient().sendRequest(runtime, { url, method: 'GET' }).result()
  const text = new TextDecoder().decode(resp.body)
  if (resp.statusCode !== 200) throw new Error(`GET ${url} returned HTTP ${resp.statusCode}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

/// Runs on every node. Re-settles each round from Binance 1s klines and rebuilds the root.
/// Only this small verdict reaches consensus, never the raw klines.
const checkEpoch = (runtime: NodeRuntime<Config>, epoch: string, eventRoot: string, eventCount: string): Verdict => {
  const { apiBase, klineBase, symbols } = runtime.config
  const body = epochSchema.parse(getJson(runtime, `${apiBase}/api/proofs/epoch/${epoch}`))
  if (String(body.epoch) !== epoch) throw new Error(`API answered epoch ${body.epoch} for ${epoch}`)

  let mismatches = 0
  if (body.root.toLowerCase() !== eventRoot) {
    runtime.log(`API root ${body.root} differs from the committed root ${eventRoot}`)
    mismatches++
  }
  if (String(body.rounds.length) !== eventCount || body.count !== body.rounds.length) {
    runtime.log(`round count: committed ${eventCount}, API count ${body.count}, rows ${body.rounds.length}`)
    mismatches++
  }

  const rounds = [...body.rounds].sort((a, b) => (a.bet_id < b.bet_id ? -1 : a.bet_id > b.bet_id ? 1 : 0))
  const verifiable = (r: Round) => r.strike_source === 'binance' && r.outcome !== 'withheld' && r.asset in symbols
  const assets = [...new Set(rounds.filter(verifiable).map((r) => r.asset))].sort().slice(0, KLINE_CALL_BUDGET)

  const windowStart = body.end_ms - KLINE_WINDOW_MS
  const klines = new Map<string, Map<number, Kline>>()
  for (const asset of assets) {
    const url = `${klineBase}?symbol=${symbols[asset]}&interval=1s&startTime=${windowStart}&limit=1000`
    klines.set(asset, parseKlines(getJson(runtime, url)))
  }

  let checked = 0
  let skipped = 0
  let strikeUnchecked = 0
  for (const r of rounds) {
    const k = klines.get(r.asset)
    if (!k || !verifiable(r)) {
      skipped++
      continue
    }
    // A non-binance end refunds whatever its price, so only a binance end needs the kline check.
    let endOk = true
    if (r.end_price !== null && r.end_price_at !== null && r.end_source === 'binance') {
      const inWindow = r.end_price_at / 1_000 >= windowStart && r.end_price_at / 1_000 <= body.end_ms
      const inRange = inWindow ? priceInKlines(k, r.end_price_at, r.end_price) : false
      if (inRange === null) {
        skipped++
        continue
      }
      endOk = inRange
    }
    const strikeOk = r.strike_at / 1_000 >= windowStart ? priceInKlines(k, r.strike_at, r.strike) : null
    if (strikeOk === null) strikeUnchecked++

    const want = decide(r)
    const decided = want.outcome === r.outcome && want.payout === r.payout
    checked++
    if (!endOk || strikeOk === false || !decided) {
      runtime.log(
        `mismatch ${r.bet_id}: end in klines ${endOk}, strike in klines ${strikeOk}, ` +
          `stored ${r.outcome}/${r.payout}, recomputed ${want.outcome}/${want.payout}`,
      )
      mismatches++
    }
  }
  if (strikeUnchecked > 0) runtime.log(`${strikeUnchecked} strikes older than the kline window, end checked only`)

  return {
    root: merkleRoot(rounds.map(leaf)),
    checked,
    mismatches,
    skipped,
    liabilities: body.liabilities_usdc,
  }
}

const read = (runtime: Runtime<Config>, evm: InstanceType<typeof cre.capabilities.EVMClient>, to: Address, data: Hex) =>
  bytesToHex(
    evm
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result().data,
  )

const onRoundsCommitted = (runtime: Runtime<Config>, log: EVMLog): string => {
  const { chainSelectorName, treasury, usdc, attestor, gasLimit } = runtime.config
  const epoch = BigInt(bytesToHex(log.topics[1]))
  const [eventRoot, eventCount] = decodeAbiParameters(parseAbiParameters('bytes32, uint256'), bytesToHex(log.data))
  runtime.log(`RoundsCommitted epoch ${epoch} root ${eventRoot} rounds ${eventCount}`)

  const verdict = runtime
    .runInNodeMode(
      checkEpoch,
      ConsensusAggregationByFields<Verdict>({
        root: identical,
        checked: identical,
        mismatches: identical,
        skipped: identical,
        liabilities: identical,
      }),
    )(epoch.toString(), eventRoot.toLowerCase(), eventCount.toString())
    .result()

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName })
  if (!network) throw new Error(`unknown chain ${chainSelectorName}`)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)

  const houseRoot = decodeFunctionResult({
    abi: ABI,
    functionName: 'roundRoots',
    data: read(runtime, evm, treasury as Address, encodeFunctionData({ abi: ABI, functionName: 'roundRoots', args: [epoch] })),
  })
  if (BigInt(houseRoot) === 0n) {
    runtime.log(`epoch ${epoch} has no root at the finalized block, not attesting`)
    return 'not_committed'
  }
  const balance = decodeFunctionResult({
    abi: ABI,
    functionName: 'balanceOf',
    data: read(runtime, evm, usdc as Address, encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [treasury as Address] })),
  })
  const liabilities = BigInt(verdict.liabilities)

  const report = runtime
    .report(
      prepareReportRequest(
        encodeAbiParameters(REPORT_PARAMS, [
          network.chainSelector.selector,
          epoch,
          verdict.root as Hex,
          verdict.checked,
          verdict.mismatches,
          verdict.skipped,
          balance,
          liabilities,
        ]),
      ),
    )
    .result()
  const resp = evm.writeReport(runtime, { receiver: attestor, report, gasConfig: { gasLimit } }).result()
  if (resp.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`attestation for epoch ${epoch} failed: ${resp.errorMessage ?? resp.txStatus}`)
  }

  const tx = bytesToHex(resp.txHash ?? new Uint8Array(32))
  const solvency = liabilities === 0n ? 'no liabilities' : `${Number((balance * 100n) / liabilities) / 100}x`
  runtime.log(
    `epoch ${epoch} checked ${verdict.checked} mismatches ${verdict.mismatches} skipped ${verdict.skipped} ` +
      `root ${verdict.root === houseRoot.toLowerCase() ? 'matches' : 'DIFFERS'} solvency ${solvency} tx ${tx}`,
  )
  return tx
}

const initWorkflow = (config: Config) => {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName })
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
  return [
    cre.handler(
      evm.logTrigger({
        addresses: [hexToBase64(config.treasury)],
        topics: [{ values: [hexToBase64(ROUNDS_COMMITTED)] }],
        confidence: 'CONFIDENCE_LEVEL_FINALIZED',
      }),
      onRoundsCommitted,
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}

main()
