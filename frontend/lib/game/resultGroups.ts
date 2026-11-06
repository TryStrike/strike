export interface SettledResult {
  betId: string;
  cellId?: string;
  asset: string;
  mode: string;
  endTime?: number;
  priceTop?: number;
  priceBottom?: number;
  won: boolean;
  refunded: boolean;
  amount: number;
  payout: number;
  currency: string;
  timestamp: number;
}

export interface GroupSummary {
  won: boolean;
  refunded: boolean;
  amount: number;
  payout: number;
  count: number;
  wins: number;
  refunds: number;
  betIds: string[];
  betId: string;
  sound: "win" | "lose" | null;
}

/** Bets in the same chart column settle as one group. */
export const groupKey = (b: {
  asset: string;
  mode: string;
  endTime?: number;
}) => `${b.asset}|${b.mode}|${b.endTime ?? ""}`;

/** Fold the per-bet results of one column into a single banner result. */
export function summarizeGroup(results: SettledResult[]): GroupSummary | null {
  if (results.length === 0) return null;
  const count = results.length;
  const amount = results.reduce((s, r) => s + r.amount, 0);
  const payout = results.reduce((s, r) => s + r.payout, 0);
  const refunds = results.filter((r) => r.refunded).length;
  const wins = results.filter((r) => r.won && !r.refunded).length;
  const betIds = results.map((r) => r.betId);
  const first = results[0];
  const base = { amount, payout, count, wins, refunds, betIds };
  if (count === 1) {
    return {
      ...base,
      won: first.won,
      refunded: first.refunded,
      betId: first.betId,
      sound: first.refunded ? null : first.won ? "win" : "lose",
    };
  }
  const refunded = refunds === count;
  const won = payout > amount;
  return {
    ...base,
    won,
    refunded,
    betId: (results.find((r) => r.won && !r.refunded) ?? first).betId,
    sound: refunded ? null : wins > 0 && won ? "win" : "lose",
  };
}
