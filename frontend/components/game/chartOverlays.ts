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

const BAR_MS = 1_000;
// Fifteen minutes: past the widest view, with room for the averages to settle.
const MAX_BARS = 900;
const RSI_PERIOD = 14;
const RSI_PANEL_HEIGHT = 100;
const RSI_PANEL_BOTTOM = 20;
export const RSI_PANEL_INSET = RSI_PANEL_HEIGHT + RSI_PANEL_BOTTOM;

interface Bar extends PricePoint {
  high: number;
  low: number;
}

/** One second a bar, so "14" means 14 seconds on every asset, however often it trades. */
function toBars(points: readonly PricePoint[], now: number): Bar[] {
  const last = points[points.length - 1];
  if (!last) return [];
  // A quiet market still has bars: its price holds up to now.
  const end = Math.max(now, last.timestamp);
  const lastSecond = Math.floor(end / BAR_MS);
  const firstSecond = Math.max(Math.floor(points[0].timestamp / BAR_MS), lastSecond - MAX_BARS + 1);

  const bars: Bar[] = [];
  let next = 0;
  let close = points[0].price;
  for (let second = firstSecond; second <= lastSecond; second++) {
    const barStart = second * BAR_MS;
    const barEnd = barStart + BAR_MS;
    let high = -Infinity;
    let low = Infinity;
    for (; next < points.length && points[next].timestamp < barEnd; next++) {
      close = points[next].price;
      if (points[next].timestamp < barStart) continue;
      high = Math.max(high, close);
      low = Math.min(low, close);
    }
    bars.push({
      timestamp: Math.min(barEnd - 1, end),
      price: close,
      high: Number.isFinite(high) ? high : close,
      low: Number.isFinite(low) ? low : close,
    });
  }
  return bars;
}

function movingAverage(bars: readonly Bar[], period: number): PricePoint[] {
  const out: PricePoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].price;
    if (i >= period) sum -= bars[i - period].price;
    if (i >= period - 1) out.push({ timestamp: bars[i].timestamp, price: sum / period });
  }
  return out;
}

function bollinger(bars: readonly Bar[], period: number): [PricePoint[], PricePoint[], PricePoint[]] {
  const top: PricePoint[] = [];
  const bottom: PricePoint[] = [];
  const middle = movingAverage(bars, period);
  middle.forEach(({ timestamp, price: avg }, index) => {
    const window = bars.slice(index, index + period);
    const deviation = Math.sqrt(window.reduce((sum, bar) => sum + (bar.price - avg) ** 2, 0) / period);
    top.push({ timestamp, price: avg + 2 * deviation });
    bottom.push({ timestamp, price: avg - 2 * deviation });
  });
  return [top, bottom, middle];
}

/** Williams' line: a smoothed average of each bar's median, drawn `shift` bars ahead. */
function alligatorLine(bars: readonly Bar[], period: number, shift: number): PricePoint[] {
  const out: PricePoint[] = [];
  let average = 0;
  for (let i = 0; i < bars.length; i++) {
    const median = (bars[i].high + bars[i].low) / 2;
    if (i < period) average += median;
    if (i === period - 1) average /= period;
    if (i >= period) average = (average * (period - 1) + median) / period;
    if (i >= period - 1) out.push({ timestamp: bars[i].timestamp + shift * BAR_MS, price: average });
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function rsi(bars: readonly Bar[]): RsiPoint[] {
  const out: RsiPoint[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].price - bars[i - 1].price;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i < RSI_PERIOD) {
      avgGain += gain;
      avgLoss += loss;
      continue;
    }
    if (i === RSI_PERIOD) {
      avgGain = (avgGain + gain) / RSI_PERIOD;
      avgLoss = (avgLoss + loss) / RSI_PERIOD;
    } else {
      avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    }
    out.push({ timestamp: bars[i].timestamp, rsi: rsiValue(avgGain, avgLoss) });
  }
  return out;
}

export function computeIndicators(points: readonly PricePoint[], active: Record<string, boolean>, now: number): Indicators {
  if (!Object.values(active).some(Boolean)) return {};
  const bars = toBars(points, now);
  return {
    ma: active.ma ? movingAverage(bars, 20) : undefined,
    bollinger: active.bollinger ? bollinger(bars, 20) : undefined,
    alligator: active.alligator
      ? [alligatorLine(bars, 13, 8), alligatorLine(bars, 8, 5), alligatorLine(bars, 5, 3)]
      : undefined,
    rsi: active.rsi ? rsi(bars) : undefined,
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
  ctx.fillText('RSI 14s', s.width - 12, top + 16);

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
) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fill();
  ctx.stroke();
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

function drawClassicBet(ctx: CanvasRenderingContext2D, s: Scales, bet: ActiveBet, price: number, palette: OverlayPalette, symbol: string, fontFamily: string, taken: number[]) {
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

  if (bet.startTime !== undefined) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x(bet.startTime), strikeY, 3.5, 0, Math.PI * 2);
    ctx.fill();
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
  // Bets at the same strike share a line; stack their labels upward instead of overprinting.
  let labelY = strikeY - 5;
  while (taken.some((y) => Math.abs(y - labelY) < 12)) labelY -= 12;
  taken.push(labelY);
  ctx.fillText(`${bet.direction} ${bet.amount} ${symbol} @ ${bet.strikePrice.toFixed(2)}`, s.tipX + 5, labelY);

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
  view: { mode: string; asset: string; price: number; intervalMs: number; symbol: string; fontFamily: string },
  palette: OverlayPalette,
) {
  const taken: number[] = [];
  for (const bet of bets) {
    if (bet.mode !== view.mode || bet.asset !== view.asset) continue;
    if (bet.mode === 'box') drawBoxBet(ctx, s, bet, view.intervalMs, palette, view.symbol, view.fontFamily);
    else drawClassicBet(ctx, s, bet, view.price, palette, view.symbol, view.fontFamily, taken);
  }
}
