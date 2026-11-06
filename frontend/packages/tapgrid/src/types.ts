export interface Point {
  timestamp: number;
  price: number;
}

export type CellState = 'past' | 'crossing' | 'locked' | 'open';

export interface Cell {
  key: string;
  time: number;
  top: number;
  bottom: number;
  state: CellState;
}

export interface CellLabel<V = unknown> {
  text: string;
  accent?: boolean;
  value?: V;
}

export interface Scales {
  now: number;
  width: number;
  height: number;
  tipX: number;
  step: number;
  minPrice: number;
  maxPrice: number;
  x(time: number): number;
  y(price: number): number;
  timeAt(x: number): number;
  priceAt(y: number): number;
}

export interface Colors {
  background: string;
  grid: string;
  text: string;
  cellText: string;
  accentText: string;
  crossing: string;
  line: string;
  tipText: string;
}

export type Overlay = (ctx: CanvasRenderingContext2D, scales: Scales) => void;

export interface TapGridOptions {
  mode: 'line' | 'grid';
  seriesKey: string;
  intervalMs: number;
  pxPerSecond: number;
  tipRatio: number;
  rows: number;
  decimals: number;
  lockMs: number;
  viewSpan: number;
  minRange: number;
  maxStep: number;
  colors: Colors;
  fontFamily: string;
  reducedMotion: boolean;
  stale: boolean;
  tapInsetBottom: number;
  cellLabel?: (cell: Cell, scales: Scales) => CellLabel | null;
  onCellTap?: (cell: Cell, label: CellLabel | null) => void;
  underlay?: Overlay;
  overlay?: Overlay;
}

export interface TapGrid {
  setOptions(options: Partial<TapGridOptions>): void;
  setData(points: readonly Point[], price: number): void;
  scales(): Scales | null;
  cellAt(x: number, y: number): Cell | null;
  destroy(): void;
}
