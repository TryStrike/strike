
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
  asset?: string;
  endTime?: number | null;
  strikePrice?: number | null;
}
