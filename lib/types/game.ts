/**
 * Game-related type definitions for Strike
 */

export type Direction = 'UP' | 'DOWN';

export interface TargetCell {
  id: string;
  label: string;          // e.g., "+$10 in 30s"
  multiplier: number;     // e.g., 2.0 for x2
  priceChange: number;    // e.g., 10.0
  direction: Direction;
  timeframe?: number;
}

export interface PricePoint {
  timestamp: number;
  price: number;
}
