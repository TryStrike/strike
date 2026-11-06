
import { TargetCell } from './game';

export interface BetRecord {
  id: string;
  timestamp: number;
  amount: string;
  target: TargetCell;
  startPrice: number;
  endPrice: number;
  actualChange: number;
  won: boolean;
  payout: string;
}

/** History keeps `won` true on a tie or refund, which returns only the stake. */
export const isRealWin = (bet: BetRecord) => bet.won && parseFloat(bet.payout) > parseFloat(bet.amount);
