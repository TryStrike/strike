import { cellState, ease, panCenter, priceOfRow, stepChange, stepFor, traceMonotone, visibleRange } from './grid';
import type { Cell, CellLabel, Point, Scales, TapGrid, TapGridOptions } from './types';

const AXIS_GUTTER_PX = 80;

const TIP_EASE_MS = 90;
const PAN_EASE_MS = 180;
const DEAD_ZONE = 0.4;
const STEP_CHECK_MS = 500;
const LABEL_REFRESH_MS = 250;
const MIN_LABEL_PX = 28;
const MIN_TIME_LABEL_PX = 70;
const PILL_WIDTH = 80;
const PILL_HEIGHT = 22;
const STALE_ALPHA = 0.35;

export function createTapGrid(canvas: HTMLCanvasElement, initial: TapGridOptions): TapGrid {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('tapgrid needs a 2d canvas context');
  const ctx = context;

  let options = initial;
  let points: readonly Point[] = [];
  let price = 0;
  let priceText = '';
  let width = 0;
  let height = 0;
  let dpr = 1;

  let seriesKey: string | null = null;
  let step = 0;
  let center = 0;
  let tip = 0;
  let lastColumn = 0;
  let lastStepCheck = 0;
  let targetStep = 0;
  let current: Scales | null = null;

  let labels = new Map<string, CellLabel | null>();
  let labelsAt = 0;
  const timeTexts = new Map<number, string>();

  let frameId = 0;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let lastFrame = 0;
  let visible = true;

  const snap = (value: number) => Math.round(value * dpr) / dpr;
  const hairline = (value: number) => snap(value) + 0.5 / dpr;
  const rowPx = () => Math.max(1, Math.round(height / options.rows));

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    render(performance.now());
  };

  const buildScales = (now: number): Scales => {
    const { pxPerSecond, tipRatio } = options;
    const tipX = width * tipRatio;
    const row = rowPx();
    const halfSpan = ((height / 2) * step) / row;
    return {
      now,
      width,
      height,
      tipX,
      step,
      minPrice: center - halfSpan,
      maxPrice: center + halfSpan,
      x: (time) => tipX + ((time - now) / 1000) * pxPerSecond,
      y: (value) => height / 2 - ((value - center) / step) * row,
      timeAt: (x) => now + ((x - tipX) / pxPerSecond) * 1000,
      priceAt: (y) => center + ((height / 2 - y) / row) * step,
    };
  };

  const cellOf = (column: number, row: number, now: number): Cell => {
    const time = column * options.intervalMs;
    return {
      key: `${time}:${row}:${step}`,
      time,
      top: priceOfRow(row + 1, step),
      bottom: priceOfRow(row, step),
      state: cellState(time, now, options.intervalMs, options.lockMs),
    };
  };

  const updateView = (now: number, dt: number) => {
    const { seriesKey: key, intervalMs, pxPerSecond, tipRatio, minRange, viewSpan, maxStep, rows, reducedMotion } = options;
    const since = now - ((width * tipRatio) / pxPerSecond) * 1000;
    const column = Math.floor(now / intervalMs);

    if (key !== seriesKey) {
      seriesKey = key;
      step = stepFor(visibleRange(points, since, price), minRange, viewSpan, rows, maxStep);
      center = price;
      tip = price;
      lastColumn = column;
      labelsAt = 0;
      targetStep = step;
      lastStepCheck = now;
    }

    if (now - lastStepCheck >= STEP_CHECK_MS) {
      lastStepCheck = now;
      targetStep = stepFor(visibleRange(points, since, price), minRange, viewSpan, rows, maxStep);
    }
    if (targetStep > 0 && !(options.holdStep && step <= options.maxStep)) {
      const change = stepChange(step, targetStep);
      const overLimit = options.maxStep > 0 && step > options.maxStep;
      const atBoundary = options.mode === 'line' || column !== lastColumn;
      if (overLimit || change === 'now' || (change === 'boundary' && atBoundary)) {
        step = targetStep;
        labelsAt = 0;
      }
    }
    lastColumn = column;

    const span = (height / rowPx()) * step;
    const panned = panCenter(center, price, span, DEAD_ZONE);
    center = reducedMotion ? panned : ease(center, panned, dt, PAN_EASE_MS);
    tip = reducedMotion || !tip ? price : ease(tip, price, dt, TIP_EASE_MS);
  };

  const drawGrid = (s: Scales) => {
    const { intervalMs, pxPerSecond, mode, colors, fontFamily } = options;
    const columnPx = (intervalMs / 1000) * pxPerSecond;
    const firstColumn = Math.floor(s.timeAt(0) / intervalMs);
    const lastColumnIndex = Math.ceil(s.timeAt(width) / intervalMs);
    const topRow = Math.ceil(s.maxPrice / step);
    const bottomRow = Math.floor(s.minPrice / step);

    if (mode === 'grid') {
      const crossing = Math.floor(s.now / intervalMs) * intervalMs;
      const left = snap(s.x(crossing));
      ctx.fillStyle = colors.crossing;
      ctx.fillRect(left, 0, snap(s.x(crossing + intervalMs)) - left, height);
    }

    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    for (let row = bottomRow; row <= topRow; row++) {
      const y = hairline(s.y(priceOfRow(row, step)));
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    for (let column = firstColumn; column <= lastColumnIndex; column++) {
      const x = hairline(s.x(column * intervalMs));
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();

    ctx.font = `10px ${fontFamily}`;
    if (mode === 'grid' && options.cellLabel) {
      if (s.now - labelsAt >= LABEL_REFRESH_MS) {
        labels = new Map();
        labelsAt = s.now;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const row = rowPx();
      for (let column = firstColumn; column <= lastColumnIndex; column++) {
        for (let r = bottomRow; r < topRow; r++) {
          const cell = cellOf(column, r, s.now);
          if (cell.state === 'past' || cell.state === 'crossing') continue;
          let label = labels.get(cell.key);
          if (label === undefined) {
            label = options.cellLabel(cell, s);
            labels.set(cell.key, label);
          }
          if (!label) continue;
          ctx.fillStyle = label.accent ? colors.accentText : colors.cellText;
          ctx.globalAlpha = label.cold ? 0.2 : cell.state === 'locked' ? 0.4 : 1;
          const labelX = s.x(cell.time) + columnPx / 2;
          // The price axis owns the right edge; a multiplier there would print over it.
          if (labelX > width - AXIS_GUTTER_PX) continue;
          ctx.fillText(label.text, labelX, s.y(cell.top) + row / 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = colors.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    const rowEvery = rowPx() < MIN_LABEL_PX ? 2 : 1;
    for (let row = bottomRow; row <= topRow; row++) {
      if (row % rowEvery !== 0) continue;
      const value = priceOfRow(row, step);
      ctx.fillText(formatPrice(value, options.decimals), width - 8, hairline(s.y(value)) - 4);
    }

    ctx.textAlign = 'left';
    const timeEvery = Math.max(1, Math.ceil(MIN_TIME_LABEL_PX / columnPx));
    for (let column = firstColumn; column <= lastColumnIndex; column++) {
      if (column % timeEvery !== 0) continue;
      const time = column * intervalMs;
      ctx.fillText(timeText(time), hairline(s.x(time)) + 5, height - 10);
    }
  };

  const timeText = (time: number) => {
    let text = timeTexts.get(time);
    if (!text) {
      if (timeTexts.size > 256) timeTexts.clear();
      text = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      timeTexts.set(time, text);
    }
    return text;
  };

  const drawLine = (s: Scales) => {
    const { colors, stale, pxPerSecond } = options;
    const earliest = s.now - ((s.tipX + 100) / pxPerSecond) * 1000;
    const xs: number[] = [];
    const ys: number[] = [];
    let last = NaN;
    let before = NaN;
    for (let i = 0; i < points.length; i++) {
      const { timestamp, price: value } = points[i];
      if (timestamp <= earliest) before = value;
      if (timestamp <= earliest || timestamp > s.now) continue;
      if (value === last && points[i + 1]?.price === value) continue;
      last = value;
      xs.push(s.x(timestamp));
      ys.push(s.y(value));
    }
    if (!Number.isNaN(before)) {
      xs.unshift(s.x(earliest));
      ys.unshift(s.y(before));
    }

    const tipY = s.y(tip);
    ctx.globalAlpha = stale ? STALE_ALPHA : 1;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceMonotone(ctx, xs, ys, xs.length);
    if (xs.length > 0) {
      if (xs.length === 1) ctx.moveTo(xs[0], ys[0]);
      ctx.lineTo(s.tipX, tipY);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    return tipY;
  };

  const drawTip = (s: Scales, tipY: number) => {
    const { colors, fontFamily } = options;
    const pillX = width - PILL_WIDTH - 4;
    ctx.strokeStyle = colors.line;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(s.tipX, tipY);
    ctx.lineTo(pillX, tipY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.fillStyle = colors.line;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(s.tipX, tipY, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = colors.background;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.tipX, tipY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(pillX, tipY - PILL_HEIGHT / 2, PILL_WIDTH, PILL_HEIGHT, 6);
    ctx.moveTo(pillX + 1, tipY - 5);
    ctx.lineTo(pillX - 6, tipY);
    ctx.lineTo(pillX + 1, tipY + 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colors.tipText;
    ctx.font = `11px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(priceText, pillX + PILL_WIDTH / 2, tipY);
  };

  function render(time: number) {
    const dt = lastFrame ? time - lastFrame : 0;
    lastFrame = time;
    if (width === 0 || height === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = options.colors.background;
    ctx.fillRect(0, 0, width, height);
    if (price <= 0) return;

    const now = Date.now();
    updateView(now, dt);
    const s = buildScales(now);
    current = s;

    drawGrid(s);
    options.underlay?.(ctx, s);
    const tipY = drawLine(s);
    options.overlay?.(ctx, s);
    drawTip(s, tipY);
  }

  const loop = (time: number) => {
    render(time);
    frameId = requestAnimationFrame(loop);
  };

  const stop = () => {
    cancelAnimationFrame(frameId);
    if (timerId !== null) clearInterval(timerId);
    timerId = null;
  };

  const start = () => {
    stop();
    lastFrame = 0;
    if (!visible) return;
    if (options.reducedMotion) timerId = setInterval(() => !document.hidden && render(performance.now()), 1000);
    else frameId = requestAnimationFrame(loop);
  };

  const cellAt = (x: number, y: number): Cell | null => {
    if (!current || options.mode !== 'grid' || y > height - options.tapInsetBottom) return null;
    const s = buildScales(Date.now());
    const column = Math.floor(s.timeAt(x) / options.intervalMs);
    return cellOf(column, Math.floor(s.priceAt(y) / step), s.now);
  };

  const onClick = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x > width - AXIS_GUTTER_PX) return;
    const cell = cellAt(x, event.clientY - rect.top);
    // Locked cells go through too, so the app can say why the tap did nothing.
    if (cell?.state === 'open' || cell?.state === 'locked') options.onCellTap?.(cell, labels.get(cell.key) ?? null);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    start();
  });
  visibility.observe(canvas);
  canvas.addEventListener('click', onClick);
  resize();
  start();

  return {
    setOptions(next) {
      const motionChanged = next.reducedMotion !== undefined && next.reducedMotion !== options.reducedMotion;
      const seriesChanged = next.seriesKey !== undefined && next.seriesKey !== options.seriesKey;
      options = { ...options, ...next };
      if (seriesChanged) {
        current = null;
        labels = new Map();
      }
      if (motionChanged) start();
      else if (seriesChanged && options.reducedMotion) render(performance.now());
    },
    setData(nextPoints, nextPrice) {
      points = nextPoints;
      if (nextPrice === price) return;
      price = nextPrice;
      priceText = formatPrice(nextPrice, options.decimals);
      if (options.reducedMotion) render(performance.now());
    },
    scales: () => current,
    cellAt,
    destroy() {
      stop();
      observer.disconnect();
      visibility.disconnect();
      canvas.removeEventListener('click', onClick);
    },
  };
}

const priceFormats = new Map<number, Intl.NumberFormat>();

function formatPrice(value: number, decimals: number): string {
  let format = priceFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    priceFormats.set(decimals, format);
  }
  return format.format(value);
}
