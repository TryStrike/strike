import type { CellState, Point } from './types';

const RANGE_SHARE = 0.8;
const STEP_CHANGE = 2;
const STEP_JUMP = 4;

export function snapStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const unit = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return unit * magnitude;
}

function snapDown(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  return (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
}

export function stepFor(range: number, minRange: number, rows: number, maxStep: number): number {
  const step = snapStep(Math.max(range, minRange) / (rows * RANGE_SHARE));
  return maxStep > 0 && step > maxStep ? snapDown(maxStep) : step;
}

export function stepChange(current: number, target: number): 'keep' | 'boundary' | 'now' {
  const ratio = Math.max(target / current, current / target);
  if (ratio >= STEP_JUMP) return 'now';
  return ratio >= STEP_CHANGE ? 'boundary' : 'keep';
}

export function priceOfRow(row: number, step: number): number {
  return Number((row * step).toPrecision(12));
}

export function cellState(time: number, now: number, intervalMs: number, lockMs: number): CellState {
  if (time + intervalMs <= now) return 'past';
  if (time <= now) return 'crossing';
  return time - now < lockMs ? 'locked' : 'open';
}

export function visibleRange(points: readonly Point[], since: number, price: number): number {
  let low = price;
  let high = price;
  for (let i = points.length - 1; i >= 0 && points[i].timestamp >= since; i--) {
    if (points[i].price < low) low = points[i].price;
    if (points[i].price > high) high = points[i].price;
  }
  return high - low;
}

export function ease(current: number, target: number, dtMs: number, tauMs: number): number {
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

export function panCenter(center: number, price: number, span: number, deadZone: number): number {
  const reach = (span * deadZone) / 2;
  if (price > center + reach) return price - reach;
  if (price < center - reach) return price + reach;
  return center;
}

/** Fritsch-Carlson monotone cubic through points, so the line never overshoots a price. */
export function traceMonotone(
  ctx: CanvasRenderingContext2D,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  count: number,
): void {
  if (count < 2) return;
  ctx.moveTo(xs[0], ys[0]);
  if (count === 2) {
    ctx.lineTo(xs[1], ys[1]);
    return;
  }

  const slope = (i: number) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1);
  const tangent = (i: number) => {
    if (i === 0) return slope(0);
    if (i === count - 1) return slope(count - 2);
    const before = slope(i - 1);
    const after = slope(i);
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  };

  let out = tangent(0);
  for (let i = 0; i < count - 1; i++) {
    const into = tangent(i + 1);
    const third = (xs[i + 1] - xs[i]) / 3;
    ctx.bezierCurveTo(xs[i] + third, ys[i] + third * out, xs[i + 1] - third, ys[i + 1] - third * into, xs[i + 1], ys[i + 1]);
    out = into;
  }
}
