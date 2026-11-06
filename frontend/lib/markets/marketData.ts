import { useEffect, useState } from "react";

export interface Venue {
  issuer: string;
  symbol: string;
  address: string;
  price: number | null;
  premiumBps: number | null;
  route: string[];
  error: string | null;
}

export interface Asset {
  ticker: string;
  name: string | null;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  points: number[];
  venues: Venue[];
  best: string | null;
}

export interface Markets {
  at: number;
  session: "pre" | "open" | "post" | "closed";
  quoteUsd: number;
  assets: Asset[];
}

const REFRESH_MS = 30_000;

let latest: Markets | null = null;
let dwell: ReturnType<typeof setTimeout> | undefined;

let tradeHeld = false;
/** Outlives the trade modal, so reopening it cannot start a second trade. */
export const tradeLock = {
  get: () => tradeHeld,
  set: (held: boolean) => {
    tradeHeld = held;
  },
};

export const historyUrl = (ticker: string, range: string) =>
  `/api/markets/history?symbol=${ticker}&range=${range}`;

/** Fetches the chart once a pointer rests on a stock, so the click finds it in the HTTP cache. */
export const preloadStock = (ticker: string) => {
  clearTimeout(dwell);
  dwell = setTimeout(() => void fetch(historyUrl(ticker, "1D")), 100);
};
export const cancelPreload = () => clearTimeout(dwell);

export function useMarkets() {
  const [data, setData] = useState<Markets | null>(latest);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/markets")
        .then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
        )
        .then((d: Markets) => {
          latest = d;
          if (alive) {
            setData(d);
            setFailed(false);
          }
        })
        .catch((err) => {
          console.error("[markets] load failed", err);
          if (alive) setFailed(true);
        });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return { data, failed };
}

export const usd = (n: number | null | undefined) =>
  n == null
    ? "–"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
export const pct = (n: number | null | undefined) =>
  n == null ? "–" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
export const bps = (n: number | null) =>
  n == null ? "" : `${n >= 0 ? "+" : "−"}${Math.abs(n)} bp`;
export const compact = (n: number | null | undefined) =>
  n == null
    ? "–"
    : Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n);
export const tone = (n: number | null) =>
  n == null || Math.abs(n) < 0.005
    ? "text-muted"
    : n > 0
      ? "text-up"
      : "text-down";
export const quoted = (a: Asset) => a.venues.filter((v) => v.price != null);
export const bestVenue = (a: Asset) =>
  a.venues.find((v) => v.issuer === a.best) ?? null;
export const mainnetRoute = (a: Asset) => {
  const best = bestVenue(a);
  return best ? `${best.issuer} on BNB Chain` : null;
};
export function spread(a: Asset) {
  const prices = quoted(a).map((v) => v.price as number);
  return prices.length > 1
    ? (Math.max(...prices) / Math.min(...prices) - 1) * 100
    : 0;
}
export const stockMarketEnabled = () =>
  /^0x[0-9a-fA-F]{40}$/.test(
    process.env.NEXT_PUBLIC_STOCK_MARKET_ADDRESS?.trim() ?? "",
  );
