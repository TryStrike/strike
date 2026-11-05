
export type Direction = 'UP' | 'DOWN';

export interface TargetCell {
  id: string;
  label: string;
  multiplier: number;
  priceChange: number;
  direction: Direction;
  timeframe?: number;
}

export interface PricePoint {
  timestamp: number;
  price: number;
}
