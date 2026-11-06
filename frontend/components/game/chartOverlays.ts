import { traceMonotone } from 'tapgrid';
import type { Colors, Scales } from 'tapgrid';
import type { ActiveBet } from '@/lib/store/gameSlice';
import type { PricePoint } from '@/lib/types/game';

interface RsiPoint {
  timestamp: number;
  rsi: number;
}

export interface Indicators {
  ma?: PricePoint[];
  bollinger?: [PricePoint[], PricePoint[], PricePoint[]];
  alligator?: [PricePoint[], PricePoint[], PricePoint[]];
  rsi?: RsiPoint[];
}

export interface OverlayPalette extends Colors {
  up: string;
  upSoft: string;
  down: string;
  ink: string;
  subtle: string;
  faint: string;
  muted: string;
  border: string;
}

export interface PendingBand {
  startTime: number;
  endTime: number;
  priceTop: number;
  priceBottom: number;
}

const RSI_PERIOD = 14;
const RSI_PANEL_HEIGHT = 100;
const RSI_PANEL_BOTTOM = 20;
export const RSI_PANEL_INSET = RSI_PANEL_HEIGHT + RSI_PANEL_BOTTOM;

function movingAverage(points: readonly PricePoint[], period: number): PricePoint[] {
  const out: PricePoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const slice = points.slice(Math.max(0, i + 1 - Math.min(i + 1, period)), i + 1);
    out.push({ timestamp: points[i].timestamp, price: slice.reduce((sum, p) => sum + p.price, 0) / slice.length });
  }
  return out;
}

function bollinger(points: readonly PricePoint[], period: number): [PricePoint[], PricePoint[], PricePoint[]] {
  const top: PricePoint[] = [];
  const bottom: PricePoint[] = [];
  const middle = movingAverage(points, period);
  middle.forEach(({ timestamp, price: avg }, index) => {
    const i = index + 1;
    const slice = points.slice(Math.max(0, i + 1 - Math.min(i + 1, period)), i + 1).map((p) => p.price);
    const deviation = Math.sqrt(slice.reduce((sum, value) => sum + (value - avg) ** 2, 0) / slice.length);
    top.push({ timestamp, price: avg + 2 * deviation });
    bottom.push({ timestamp, price: avg - 2 * deviation });
  });
  return [top, bottom, middle];
}

function rsi(points: readonly PricePoint[]): RsiPoint[] {
  const out: RsiPoint[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < points.length; i++) {
    const change = points[i].price - points[i - 1].price;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i < RSI_PERIOD) {
      avgGain += gain;
      avgLoss += loss;
      out.push({ timestamp: points[i].timestamp, rsi: 50 });
      continue;
    }
    if (i === RSI_PERIOD) {
      avgGain = (avgGain + gain) / RSI_PERIOD;
      avgLoss = (avgLoss + loss) / RSI_PERIOD;
    } else {
      avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    }
    out.push({ timestamp: points[i].timestamp, rsi: 100 - 100 / (1 + avgGain / (avgLoss || 0.00001)) });
  }
  return out;
}

export function computeIndicators(points: readonly PricePoint[], active: Record<string, boolean>): Indicators {
  if (points.length < 2) return {};
  return {
    ma: active.ma ? movingAverage(points, 20) : undefined,
    bollinger: active.bollinger ? bollinger(points, 20) : undefined,
    alligator: active.alligator
      ? [movingAverage(points, 13), movingAverage(points, 8), movingAverage(points, 5)]
      : undefined,
    rsi: active.rsi ? rsi(points) : undefined,
  };
}

function strokeSeries(
  ctx: CanvasRenderingContext2D,
  s: Scales,
  points: readonly PricePoint[],
  color: string,
  width: number,
  alpha: number,
  dash: number[] = [],
) {
  const xs = points.map((p) => s.x(p.timestamp));
  const ys = points.map((p) => s.y(p.price));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.setLineDash(dash);
  ctx.beginPath();
  traceMonotone(ctx, xs, ys, xs.length);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function drawIndicators(ctx: CanvasRenderingContext2D, s: Scales, indicators: Indicators, palette: OverlayPalette) {
  if (indicators.ma) strokeSeries(ctx, s, indicators.ma, palette.down, 1.5, 0.7, [4, 2]);
  if (indicators.bollinger) {
    const [top, bottom, middle] = indicators.bollinger;
    strokeSeries(ctx, s, top, palette.subtle, 1.5, 0.5);
    strokeSeries(ctx, s, bottom, palette.subtle, 1.5, 0.5);
    strokeSeries(ctx, s, middle, palette.subtle, 1, 0.3, [2, 2]);
  }
  if (indicators.alligator) {
    const [jaw, teeth, lips] = indicators.alligator;
    strokeSeries(ctx, s, jaw, palette.ink, 1.5, 0.5);
    strokeSeries(ctx, s, teeth, palette.subtle, 1.5, 0.5);
    strokeSeries(ctx, s, lips, palette.faint, 1.5, 0.6);
  }
}

export function drawRsiPanel(ctx: CanvasRenderingContext2D, s: Scales, points: readonly RsiPoint[], palette: OverlayPalette, fontFamily: string) {
  const top = s.height - RSI_PANEL_INSET;
  const yOf = (value: number) => top + RSI_PANEL_HEIGHT - (value / 100) * RSI_PANEL_HEIGHT;

  ctx.fillStyle = palette.background;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(0, top, s.width, RSI_PANEL_HEIGHT);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(s.width, top);
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (const level of [70, 30]) {
    ctx.moveTo(0, yOf(level));
    ctx.lineTo(s.width, yOf(level));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `10px ${fontFamily}`;
  ctx.fillStyle = palette.faint;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('70', 10, yOf(70) - 4);
  ctx.fillText('30', 10, yOf(30) - 4);
  ctx.fillStyle = palette.subtle;
  ctx.textAlign = 'right';
  ctx.fillText('RSI 14', s.width - 12, top + 16);

  ctx.strokeStyle = palette.ink;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  traceMonotone(ctx, points.map((p) => s.x(p.timestamp)), points.map((p) => yOf(p.rsi)), points.length);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
  dash: number[] = [],
) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBoxBet(ctx: CanvasRenderingContext2D, s: Scales, bet: ActiveBet, intervalMs: number, palette: OverlayPalette, symbol: string, fontFamily: string) {
  if (bet.endTime === undefined || bet.priceTop === undefined || bet.priceBottom === undefined) return;
  const x = s.x(bet.endTime);
  const y = s.y(bet.priceTop);
  const width = s.x(bet.endTime + intervalMs) - x;
  const height = s.y(bet.priceBottom) - y;
  drawBand(ctx, x, y, width, height, palette.upSoft, palette.up);

  ctx.fillStyle = palette.up;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `13px ${fontFamily}`;
  ctx.fillText(`${(bet.amount * bet.multiplier).toFixed(2)} ${symbol}`, x + width / 2, y + height / 2 - 6);
  ctx.font = `9px ${fontFamily}`;
  ctx.fillText(`${bet.multiplier}x`, x + width / 2, y + height / 2 + 9);
}

function drawDrawBet(ctx: CanvasRenderingContext2D, s: Scales, bet: ActiveBet, price: number, palette: OverlayPalette, fontFamily: string) {
  if (bet.startTime === undefined || bet.endTime === undefined || bet.priceTop === undefined || bet.priceBottom === undefined) return;
  const left = Math.max(s.tipX, s.x(bet.startTime));
  const width = s.x(bet.endTime) - left;
  const y = s.y(bet.priceTop);
  const height = s.y(bet.priceBottom) - y;
  if (width <= 0 || height <= 0) return;

  const inside = price <= bet.priceTop && price >= bet.priceBottom;
  drawBand(ctx, left, y, width, height, inside ? palette.upSoft : palette.background, inside ? palette.up : palette.faint);
  ctx.fillStyle = inside ? palette.up : palette.muted;
  ctx.font = `10px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`x${Number(bet.multiplier).toFixed(2)}`, left + 6, y + 16);
}

function drawClassicBet(ctx: CanvasRenderingContext2D, s: Scales, bet: ActiveBet, price: number, palette: OverlayPalette, symbol: string, fontFamily: string) {
  if (bet.strikePrice === undefined || bet.endTime === undefined) return;
  const strikeY = s.y(bet.strikePrice);
  const priceY = s.y(price);
  const endX = s.x(bet.endTime);
  const color = bet.direction === 'UP' ? palette.up : palette.down;

  if (endX > s.tipX) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.05;
    ctx.fillRect(s.tipX, Math.min(strikeY, priceY), endX - s.tipX, Math.abs(strikeY - priceY));
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(endX, 0);
    ctx.lineTo(endX, s.height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(s.tipX, strikeY);
  ctx.lineTo(Math.max(s.tipX, endX), strikeY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = color;
  ctx.font = `10px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${bet.direction} ${bet.amount} ${symbol} @ $${bet.strikePrice.toFixed(2)}`, s.tipX + 5, strikeY - 5);

  const seconds = Math.ceil((bet.endTime - s.now) / 1000);
  if (seconds > 0) {
    ctx.font = `13px ${fontFamily}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${seconds}s`, Math.max(s.tipX, endX) - 6, strikeY + 16);
  }
}

export function drawBets(
  ctx: CanvasRenderingContext2D,
  s: Scales,
  bets: readonly ActiveBet[],
  view: { mode: string; asset: string; price: number; intervalMs: number; symbol: string; fontFamily: string; pending: PendingBand | null },
  palette: OverlayPalette,
) {
  for (const bet of bets) {
    if (bet.mode !== view.mode || bet.asset !== view.asset) continue;
    if (bet.mode === 'box') drawBoxBet(ctx, s, bet, view.intervalMs, palette, view.symbol, view.fontFamily);
    else if (bet.mode === 'draw') drawDrawBet(ctx, s, bet, view.price, palette, view.fontFamily);
    else drawClassicBet(ctx, s, bet, view.price, palette, view.symbol, view.fontFamily);
  }

  if (view.pending) {
    const x = s.x(view.pending.startTime);
    const y = s.y(view.pending.priceTop);
    drawBand(ctx, x, y, s.x(view.pending.endTime) - x, s.y(view.pending.priceBottom) - y, palette.upSoft, palette.up, [4, 4]);
  }
}
