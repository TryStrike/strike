import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

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

export interface StockTrade {
  txHash: string;
  block: number;
  tradedAt: number;
  side: "buy" | "sell";
  symbol: string;
  currency: string;
  total: number;
  shares: number;
  price: number;
}

export interface Position {
  symbol: string;
  shares: number;
  /** What the shares held now cost, in USD. Null when any trade was in EURC. */
  cost: number | null;
}

const UNITS = 1e6;

/** Average cost: a sale takes its share of the cost and leaves the average alone. */
export function positionsOf(trades: StockTrade[]): Position[] {
  const open = new Map<
    string,
    { shares: number; cost: number; mixed: boolean }
  >();
  for (const t of [...trades].reverse()) {
    const p = open.get(t.symbol) ?? { shares: 0, cost: 0, mixed: false };
    if (t.currency !== "USDC") p.mixed = true;
    if (t.side === "buy") {
      p.shares += t.shares;
      p.cost += t.total / UNITS;
    } else {
      p.cost -= p.shares > 0 ? (p.cost * t.shares) / p.shares : 0;
      p.shares -= t.shares;
    }
    open.set(t.symbol, p);
  }
  return [...open]
    .filter(([, p]) => p.shares > 0)
    .map(([symbol, p]) => ({
      symbol,
      shares: p.shares / UNITS,
      cost: p.mixed ? null : p.cost,
    }));
}

/** Confirmed on chain but not indexed yet, so every page shows a trade the moment it lands. */
let unindexed: (StockTrade & { wallet: string })[] = [];
const watchers = new Set<() => void>();
const INDEX_CHECK_MS = 2_500;

export function recordTrade(
  wallet: string,
  trade: Omit<StockTrade, "tradedAt">,
) {
  unindexed = [
    {
      ...trade,
      tradedAt: Math.floor(Date.now() / 1000),
      wallet: wallet.toLowerCase(),
    },
    ...unindexed,
  ];
  watchers.forEach((notify) => notify());
}

const watchUnindexed = (notify: () => void) => {
  watchers.add(notify);
  return () => {
    watchers.delete(notify);
  };
};

/** Survives page changes, so a stock page opens with the position already known. */
const knownTrades = new Map<string, StockTrade[]>();
const TRADES_RETRY_MS = 2_000;

export function useStockTrades(wallet: string | null | undefined) {
  const [fetched, setTrades] = useState<StockTrade[] | null>(null);
  const waiting = useSyncExternalStore(
    watchUnindexed,
    () => unindexed,
    () => unindexed,
  );
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    if (!wallet) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    fetch(`/api/markets/trades?wallet=${wallet}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok)
          throw new Error(body?.error ?? "Could not load stock trades");
        return body as StockTrade[];
      })
      .then((rows) => {
        if (!alive) return;
        knownTrades.set(wallet.toLowerCase(), rows);
        setTrades(rows);
        setError(null);
        const indexed = new Set(rows.map((t) => t.txHash));
        const left = unindexed.filter((t) => !indexed.has(t.txHash));
        if (left.length !== unindexed.length) {
          unindexed = left;
          watchers.forEach((notify) => notify());
        }
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(err.message);
        retry = setTimeout(reload, TRADES_RETRY_MS);
      });
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [wallet, reads, reload]);

  const trades =
    fetched ?? knownTrades.get(wallet?.toLowerCase() ?? "") ?? null;
  const mine = waiting.filter((t) => t.wallet === wallet?.toLowerCase());
  useEffect(() => {
    if (mine.length === 0) return;
    const id = setTimeout(reload, INDEX_CHECK_MS);
    return () => clearTimeout(id);
  }, [mine, reload, trades]);

  if (!wallet) return { trades: null, error: null, reload };
  return {
    trades: trades || mine.length ? [...mine, ...(trades ?? [])] : null,
    error,
    reload,
  };
}

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
