"use client";

import { useEffect, useRef, useState } from "react";
import { traceMonotone } from "tapgrid";
import { usd } from "@/lib/markets/marketData";

export type Range = "1D" | "1W" | "1M" | "1Y" | "ALL";
export interface Point {
  t: number;
  c: number;
}

const HEIGHT = 340;
const TAG_HEIGHT = 24;
const PAD = { top: 12, right: 60, bottom: 26, left: 4 };
const TIME_FORMAT: Record<Range, Intl.DateTimeFormatOptions> = {
  "1D": { hour: "numeric", minute: "2-digit" },
  "1W": { weekday: "short", day: "numeric" },
  "1M": { month: "short", day: "numeric" },
  "1Y": { month: "short", year: "2-digit" },
  ALL: { year: "numeric" },
};

export const pointTime = (t: number, range: Range) =>
  new Date(t * 1000).toLocaleString(
    undefined,
    range === "1D" || range === "1W"
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" },
  );

function priceTicks(min: number, max: number) {
  const rough = (max - min) / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= rough) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

/** Bars sit evenly by index, so nights and weekends don't draw as flat gaps. */
export function StockChart({
  points,
  base,
  range,
  up,
  hover,
  onHover,
}: {
  points: Point[];
  base: number;
  range: Range;
  up: boolean;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !width || points.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = width * dpr;
    el.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    const css = getComputedStyle(el);
    const color = css.getPropertyValue(up ? "--up" : "--down");
    const faint = css.getPropertyValue("--faint");
    const line = css.getPropertyValue("--line");
    const showBase = range === "1D";
    const closes = points.map((p) => p.c);
    const low = Math.min(...closes, ...(showBase ? [base] : []));
    const high = Math.max(...closes, ...(showBase ? [base] : []));
    const pad = (high - low || high * 0.01) * 0.06;
    const min = low - pad;
    const max = high + pad;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * plotH;
    const x = (i: number) => PAD.left + (i / (points.length - 1)) * plotW;

    ctx.font = `11px ${css.getPropertyValue("--font-jetbrains-mono")}, monospace`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const tick of priceTicks(min, max)) {
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y(tick));
      ctx.lineTo(PAD.left + plotW, y(tick));
      ctx.stroke();
      ctx.fillStyle = faint;
      ctx.textAlign = "left";
      ctx.fillText(
        tick.toLocaleString(undefined, {
          maximumFractionDigits: tick < 10 ? 2 : 0,
        }),
        PAD.left + plotW + 8,
        y(tick),
      );
    }
    const labels = width < 480 ? 3 : 5;
    for (let n = 0; n < labels; n++) {
      const i = Math.round((n / (labels - 1)) * (points.length - 1));
      ctx.textAlign = n === 0 ? "left" : n === labels - 1 ? "right" : "center";
      ctx.fillStyle = faint;
      ctx.fillText(
        new Date(points[i].t * 1000).toLocaleString(
          undefined,
          TIME_FORMAT[range],
        ),
        x(i),
        HEIGHT - 10,
      );
    }
    if (showBase) {
      ctx.strokeStyle = faint;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y(base));
      ctx.lineTo(PAD.left + plotW, y(base));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const xs = points.map((_, i) => x(i));
    const ys = closes.map(y);
    ctx.beginPath();
    traceMonotone(ctx, xs, ys, xs.length);
    ctx.lineTo(x(points.length - 1), PAD.top + plotH);
    ctx.lineTo(x(0), PAD.top + plotH);
    ctx.closePath();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    traceMonotone(ctx, xs, ys, xs.length);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    if (hover != null && points[hover]) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = faint;
      ctx.beginPath();
      ctx.moveTo(x(hover), PAD.top);
      ctx.lineTo(x(hover), PAD.top + plotH);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x(hover), y(points[hover].c), 4, 0, Math.PI * 2);
      ctx.fill();

      const label = usd(points[hover].c);
      ctx.font = `600 12px ${css.getPropertyValue("--font-jetbrains-mono")}, monospace`;
      const tagW = ctx.measureText(label).width + 16;
      const tagX = Math.min(
        PAD.left + plotW - tagW,
        Math.max(PAD.left, x(hover) - tagW / 2),
      );
      const above = y(points[hover].c) - TAG_HEIGHT - 10;
      const tagY = above < 0 ? y(points[hover].c) + 10 : above;
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, TAG_HEIGHT, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(label, tagX + tagW / 2, tagY + TAG_HEIGHT / 2);
    }
  }, [points, base, range, up, hover, width, plotW, plotH]);

  const pick = (clientX: number, left: number) => {
    if (points.length < 2 || plotW <= 0) return;
    const i = Math.round(
      ((clientX - left - PAD.left) / plotW) * (points.length - 1),
    );
    onHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  return (
    <div className="relative w-full" style={{ height: HEIGHT }}>
      <canvas
        ref={canvas}
        role="img"
        aria-label="Price chart"
        style={{ width: "100%", height: HEIGHT, touchAction: "pan-y" }}
        onPointerMove={(e) =>
          pick(e.clientX, e.currentTarget.getBoundingClientRect().left)
        }
        onPointerLeave={() => onHover(null)}
      />
    </div>
  );
}
