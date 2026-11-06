import { concat, keccak256, padHex, stringToHex, toHex, type Hex } from 'viem';

/** A settled round exactly as `GET /api/proofs/bet/{id}` returns it. Integers are decimal strings. */
export interface RoundFields {
  betId: string;
  user: string;
  asset: string;
  mode: string;
  direction: string;
  stake: string;
  multiplier: string;
  strike: string;
  top: string;
  bottom: string;
  strikeAt: string;
  endPriceAt: string;
  endPrice: string;
  outcome: string;
  payout: string;
  strikeSource: string;
  endSource: string | null;
}

const MODES = ['binomo', 'box', 'draw'];
const DIRECTIONS = ['UP', 'DOWN'];
const OUTCOMES = ['win', 'loss', 'tie', 'refund_no_price', 'withheld'];

const word = (v: bigint): Hex => toHex(BigInt.asUintN(256, v), { size: 32 });
const text = (s: string): Hex => keccak256(stringToHex(s));
const code = (value: string, codes: string[], field: string): Hex => {
  const i = codes.indexOf(value);
  if (i < 0) throw new Error(`unknown ${field} ${value}`);
  return word(BigInt(i));
};

/**
 * keccak256 of the 17 words `StrikeTreasury` commits, in the same order as the Rust
 * `proofs::leaf`. Built here so the browser never has to take our leaf on trust.
 */
export function roundLeaf(r: RoundFields): Hex {
  return keccak256(
    concat([
      text(r.betId),
      padHex(r.user.toLowerCase() as Hex, { size: 32 }),
      text(r.asset),
      code(r.mode, MODES, 'mode'),
      code(r.direction, DIRECTIONS, 'direction'),
      word(BigInt(r.stake)),
      word(BigInt(r.multiplier)),
      word(BigInt(r.strike)),
      word(BigInt(r.top)),
      word(BigInt(r.bottom)),
      word(BigInt(r.strikeAt)),
      word(BigInt(r.endPriceAt)),
      word(BigInt(r.endPrice)),
      code(r.outcome, OUTCOMES, 'outcome'),
      word(BigInt(r.payout)),
      text(r.strikeSource),
      r.endSource ? text(r.endSource) : word(BigInt(0)),
    ]),
  );
}
