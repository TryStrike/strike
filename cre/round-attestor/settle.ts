import { concat, encodeAbiParameters, keccak256, parseAbiParameters, toBytes, type Hex } from 'viem'
import { z } from 'zod'

// Mirrors backend/crates/core/src/settlement.rs and proofs.rs. Money is MONEY_SCALE 10,
// multipliers MULTIPLIER_SCALE 4, prices PRICE_SCALE 8, times in microseconds, all as stored.

const int = z.string().regex(/^-?\d+$/, 'expected an integer string').transform(BigInt)
const uint = z.string().regex(/^\d+$/, 'expected an unsigned integer string').transform(BigInt)

const OUTCOMES = ['win', 'loss', 'tie', 'refund_no_price', 'withheld'] as const
const MODES = ['binomo', 'box', 'draw'] as const
const DIRECTIONS = ['UP', 'DOWN'] as const

export const roundSchema = z.object({
  bet_id: z.string().min(1),
  user: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  asset: z.string().min(1),
  mode: z.enum(MODES),
  direction: z.enum(DIRECTIONS),
  stake: uint,
  multiplier: uint,
  strike: int,
  strike_at: z.number().int().nonnegative(),
  strike_source: z.string(),
  top: int.nullable(),
  bottom: int.nullable(),
  end_time: z.number().int().nonnegative(),
  end_price: int.nullable(),
  end_price_at: z.number().int().nonnegative().nullable(),
  end_source: z.string().nullable(),
  outcome: z.enum(OUTCOMES),
  payout: uint,
})
export type Round = z.infer<typeof roundSchema>
export type Outcome = (typeof OUTCOMES)[number]

const LEAF_PARAMS = parseAbiParameters(
  'bytes32, address, bytes32, uint8, uint8, uint256, uint256, int256, int256, int256, uint64, uint64, int256, uint8, uint256',
)

export function leaf(r: Round): Hex {
  return keccak256(
    encodeAbiParameters(LEAF_PARAMS, [
      keccak256(toBytes(r.bet_id)),
      r.user as Hex,
      keccak256(toBytes(r.asset)),
      MODES.indexOf(r.mode),
      DIRECTIONS.indexOf(r.direction),
      r.stake,
      r.multiplier,
      r.strike,
      r.top ?? 0n,
      r.bottom ?? 0n,
      BigInt(r.strike_at),
      BigInt(r.end_price_at ?? 0),
      r.end_price ?? 0n,
      OUTCOMES.indexOf(r.outcome),
      r.payout,
    ]),
  )
}

/// Sorted-pair tree, odd node promoted unchanged. Same as StrikeTreasury.verifyRound.
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error('merkleRoot: no leaves')
  let level = leaves.map((l) => l.toLowerCase() as Hex)
  while (level.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]
      const b = level[i + 1]
      next.push(b === undefined ? a : keccak256(a < b ? concat([a, b]) : concat([b, a])))
    }
    level = next
  }
  return level[0]
}

/// `exact_payout`: stake * multiplier floored to 8 decimals, kept in MONEY_SCALE units.
export function exactPayout(stake: bigint, multiplier: bigint): bigint {
  return ((stake * multiplier) / 1_000_000n) * 100n
}

/// Port of `settlement::decide` over the stored terms and the stored end tick.
export function decide(r: Round): { outcome: Outcome; payout: bigint } {
  if (r.end_price === null || r.end_source !== r.strike_source) {
    return { outcome: 'refund_no_price', payout: r.stake }
  }
  const end = r.end_price
  let won: boolean
  if (r.top !== null && r.bottom !== null) {
    won = end >= r.bottom && end <= r.top
  } else if (end === r.strike) {
    return { outcome: 'tie', payout: r.stake }
  } else {
    won = r.direction === 'UP' ? end > r.strike : end < r.strike
  }
  return won ? { outcome: 'win', payout: exactPayout(r.stake, r.multiplier) } : { outcome: 'loss', payout: 0n }
}

/// Binance price string ("67890.12000000") to PRICE_SCALE 8 fixed point.
export function parsePrice(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new Error(`bad kline price ${s}`)
  const frac = (m[2] ?? '').padEnd(8, '0')
  if (/[^0]/.test(frac.slice(8))) throw new Error(`kline price has more than 8 decimals: ${s}`)
  return BigInt(m[1] + frac.slice(0, 8))
}

export type Kline = { low: bigint; high: bigint }

/// Klines by open time in ms, from a Binance `/api/v3/klines` body.
export function parseKlines(body: unknown): Map<number, Kline> {
  if (!Array.isArray(body)) throw new Error('klines body is not an array')
  const out = new Map<number, Kline>()
  for (const row of body) {
    if (!Array.isArray(row) || typeof row[0] !== 'number') throw new Error('bad kline row')
    out.set(row[0], { high: parsePrice(row[2]), low: parsePrice(row[3]) })
  }
  return out
}

// A sampled tick is our receive time, so its trade can sit in the second before or the one before that.
const TICK_LAG_MS = 2_000

/// Whether `price` sits inside the 1s klines covering `[atUs - 2s, atUs]`. Null when no kline exists there.
export function priceInKlines(klines: Map<number, Kline>, atUs: number, price: bigint): boolean | null {
  const atSecond = Math.floor(atUs / 1_000_000) * 1_000
  let low: bigint | null = null
  let high: bigint | null = null
  for (let t = atSecond - TICK_LAG_MS; t <= atSecond; t += 1_000) {
    const k = klines.get(t)
    if (!k) continue
    low = low === null || k.low < low ? k.low : low
    high = high === null || k.high > high ? k.high : high
  }
  if (low === null || high === null) return null
  return price >= low && price <= high
}
