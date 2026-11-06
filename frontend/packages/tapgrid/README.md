# tapgrid

A real-time price line and a tappable time by price grid, drawn on Canvas 2D. No dependencies. React is optional.

Columns are time and rows are price bands. The line, grid lines, cells, price labels and time labels all come from one geometry, so they can't drift apart.

```tsx
import { TapGridChart } from 'tapgrid/react';

<TapGridChart
  mode="grid"
  seriesKey="BTC"
  intervalMs={15_000}
  pxPerSecond={16}
  tipRatio={0.5}
  rows={10}
  decimals={2}
  lockMs={2_000}
  minRange={25}
  maxStep={0}
  colors={colors}
  fontFamily="monospace"
  reducedMotion={false}
  stale={false}
  tapInsetBottom={0}
  cellLabel={(cell) => ({ text: '2.10x' })}
  onCellTap={(cell, label) => placeBet(cell, label)}
  onReady={(chart) => chart?.setData(points, price)}
/>
```

Without React, call `createTapGrid(canvas, options)` and feed it with `setData(points, price)`.

## How it behaves

- Row height is fixed in pixels, so a cell never resizes under a finger.
- The price step only changes at a column boundary after about a 2x move in range, or at once after 4x.
- The view holds still while the price stays in the middle 40% of the height, then pans.
- `maxStep` caps the price step, for a backend that limits band width. 0 means no cap.
- `lockMs` shows closing cells as locked, and they ignore taps.
- `underlay` and `overlay` hand you the canvas context and scales for strikes, bands and indicators.

## Measured in Strike

Next.js dev build, 1034 by 777 canvas at 2x, Chrome on an Apple laptop, 20 open bets:

| Metric | Result |
|---|---|
| Frame rate | 60 fps |
| Frame time p99 | 17.6 ms |
| Long tasks | 0 |

Source is 572 lines, about 5 KB gzipped before minifying. Other setups will differ.
