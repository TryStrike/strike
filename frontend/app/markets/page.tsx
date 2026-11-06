"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { CaretRight, MagnifyingGlass, Storefront } from "@phosphor-icons/react";
import { SiteNav } from "@/components/SiteNav";
import { WalletConnect } from "@/components/wallet";
import { Badge, Label, cx, glassPrimary } from "@/components/ui/kit";
import { isAsset } from "@/lib/utils/priceFeed";
import { SessionPill, StockLogo } from "@/components/markets/MarketBits";
import {
  bestVenue,
  bps,
  cancelPreload,
  compact,
  mainnetRoute,
  pct,
  preloadStock,
  quoted,
  spread,
  positionsOf,
  stockMarketEnabled,
  tone,
  usd,
  useMarkets,
  useStockTrades,
  type Asset,
} from "@/lib/markets/marketData";

const StockTrade = dynamic(
  () => import("@/components/markets/StockTrade").then((m) => m.StockTrade),
  { ssr: false },
);

const FILTERS = {
  all: { label: "All", test: () => true },
  tech: {
    label: "Tech",
    test: (a: Asset) =>
      ["NVDA", "AAPL", "MSFT", "GOOGL", "META", "AMD"].includes(a.ticker),
  },
  consumer: {
    label: "Consumer",
    test: (a: Asset) => ["AMZN", "TSLA", "NFLX"].includes(a.ticker),
  },
  etf: { label: "ETF", test: (a: Asset) => a.ticker === "SPY" },
  multi: { label: "2+ venues", test: (a: Asset) => quoted(a).length > 1 },
} as const;
type FilterKey = keyof typeof FILTERS;
type SortKey = "volume" | "change" | "spread" | "name";

const tradable = isAsset;

export default function MarketsPage() {
  const router = useRouter();
  const { data, failed } = useMarkets();
  const { address } = useAccount();
  const { trades } = useStockTrades(address);
  const holdings = useMemo(() => positionsOf(trades ?? []), [trades]);
  const owned = useMemo(
    () => new Set(holdings.map((p) => p.symbol)),
    [holdings],
  );
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("volume");
  const [query, setQuery] = useState("");
  const [trading, setTrading] = useState<Asset | null>(null);

  const assets = useMemo(() => data?.assets ?? [], [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = assets.filter(
      (a) =>
        FILTERS[filter].test(a) &&
        (!q ||
          a.ticker.toLowerCase().includes(q) ||
          a.name?.toLowerCase().includes(q)),
    );
    const by: Record<SortKey, (a: Asset, b: Asset) => number> = {
      volume: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
      change: (a, b) => (b.changePct ?? 0) - (a.changePct ?? 0),
      spread: (a, b) => spread(b) - spread(a),
      name: (a, b) => a.ticker.localeCompare(b.ticker),
    };
    return [...list]
      .sort(by[sort])
      .sort(
        (a, b) => Number(owned.has(b.ticker)) - Number(owned.has(a.ticker)),
      );
  }, [assets, filter, sort, query, owned]);

  const byChange = useMemo(
    () => [...assets].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)),
    [assets],
  );
  const bySpread = useMemo(
    () => [...assets].sort((a, b) => spread(b) - spread(a)),
    [assets],
  );
  const hero = bySpread[0] && spread(bySpread[0]) > 0 ? bySpread[0] : null;
  const venueCount = assets.reduce((n, a) => n + quoted(a).length, 0);

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <SiteNav wide right={<WalletConnect />} />

      <main className="mx-auto max-w-[1200px] px-5 pb-16 pt-8 sm:px-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 font-jet text-[11px] uppercase tracking-[0.14em] text-faint">
              <Storefront size={14} />
              Markets
            </div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
              One stock, every wrapper, best price
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
              Live quotes for a ${data?.quoteUsd ?? 100} buy of each tokenized
              stock on BNB Chain, slippage included. Read-only: nothing here
              moves money.
            </p>
          </div>
          {data && <SessionPill session={data.session} />}
        </header>

        {failed && !data ? (
          <div
            role="alert"
            className="rounded-3xl bg-down-soft px-5 py-4 text-sm text-ink ring-1 ring-down/20"
          >
            Could not reach the markets feed. It retries every 30 seconds.
          </div>
        ) : !data ? (
          <div className="space-y-3">
            <div className="h-40 animate-pulse rounded-3xl bg-ink/[0.04]" />
            <div className="h-96 animate-pulse rounded-3xl bg-ink/[0.04]" />
          </div>
        ) : (
          <div className="space-y-4">
            {holdings.length > 0 && (
              <section className="rounded-3xl bg-white/70 p-5 ring-1 ring-ink/[0.06]">
                <Label>Your holdings</Label>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {holdings.map((p) => {
                    const price = assets.find(
                      (a) => a.ticker === p.symbol,
                    )?.price;
                    const value = price == null ? null : p.shares * price;
                    const gain =
                      value == null || p.cost == null ? null : value - p.cost;
                    return (
                      <Link
                        key={p.symbol}
                        href={`/markets/${p.symbol}`}
                        className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3"
                      >
                        <StockLogo ticker={p.symbol} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">
                            {p.symbol}
                          </span>
                          <span className="block font-jet text-xs text-subtle">
                            {p.shares} shares
                          </span>
                        </span>
                        <span className="text-right font-jet tabular-nums">
                          <span className="block text-sm">{usd(value)}</span>
                          <span className={cx("block text-xs", tone(gain))}>
                            {gain == null
                              ? "–"
                              : `${gain >= 0 ? "+" : "−"}${usd(Math.abs(gain))}`}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="rounded-3xl p-2 ring-1 ring-ink/[0.08]">
              <div className="grid gap-5 rounded-[18px] bg-surface px-6 py-6 md:grid-cols-[1.4fr_1fr] md:items-center sm:px-8">
                <div>
                  <h2 className="text-[26px] font-semibold leading-[1.1] tracking-tight sm:text-[30px]">
                    Same share.
                    <br />
                    Different price.
                  </h2>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
                    {hero
                      ? `${hero.ticker} costs ${spread(hero).toFixed(2)}% less on ${hero.best} than on its dearest wrapper right now.`
                      : "Each stock trades as several wrapper tokens. We quote all of them and show the cheapest."}{" "}
                    {venueCount} live quotes across {assets.length} stocks.
                  </p>
                </div>
                {hero && (
                  <div className="grid auto-cols-fr grid-flow-col gap-2">
                    {hero.venues.map((v) => (
                      <div
                        key={v.symbol}
                        className={cx(
                          "min-w-0 rounded-2xl bg-white px-3 py-3 ring-1",
                          v.issuer === hero.best ? "ring-up/40" : "ring-line",
                        )}
                      >
                        <div className="truncate text-[13px] font-semibold">
                          {v.symbol}
                        </div>
                        <div className="mt-1 font-jet text-sm tabular-nums">
                          {v.price == null ? "no quote" : usd(v.price)}
                        </div>
                        <div
                          className={cx(
                            "mt-0.5 text-[11px]",
                            v.issuer === hero.best
                              ? "font-semibold text-up"
                              : "text-subtle",
                          )}
                        >
                          {v.issuer === hero.best ? "Best price" : v.issuer}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <div className="grid gap-3 lg:grid-cols-3">
              <MiniList
                title="Best today"
                rows={byChange.slice(0, 3)}
                value={(a) => pct(a.changePct)}
              />
              <MiniList
                title="Worst today"
                rows={byChange.slice(-3).reverse()}
                value={(a) => pct(a.changePct)}
              />
              <MiniList
                title="Widest venue gap"
                rows={bySpread.slice(0, 3)}
                value={(a) =>
                  spread(a) ? `${spread(a).toFixed(2)}%` : "one venue"
                }
                neutral
              />
            </div>

            <section className="rounded-3xl bg-white/70 p-5 ring-1 ring-ink/[0.06]">
              <div className="flex flex-wrap items-center gap-2">
                <Label>Stocks &amp; ETFs</Label>
                <div className="ml-2 flex flex-wrap gap-1">
                  {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setFilter(k)}
                      aria-pressed={filter === k}
                      className={cx(
                        "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                        filter === k
                          ? "bg-surface text-ink ring-1 ring-line"
                          : "text-muted hover:bg-surface",
                      )}
                    >
                      {FILTERS[k].label}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <label className="flex h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-xs text-muted focus-within:ring-1 focus-within:ring-ink/40">
                    <MagnifyingGlass size={13} aria-hidden="true" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search"
                      aria-label="Search stocks"
                      className="w-24 bg-transparent text-ink outline-none placeholder:text-faint"
                    />
                  </label>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    aria-label="Sort by"
                    className="h-8 rounded-full bg-surface px-3 text-xs font-medium text-ink outline-none"
                  >
                    <option value="volume">Volume</option>
                    <option value="change">Top gainers</option>
                    <option value="spread">Venue gap</option>
                    <option value="name">Name A–Z</option>
                  </select>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line font-jet text-[11px] uppercase tracking-[0.08em] text-faint">
                      <th className="pb-3 pr-3 font-medium">Asset</th>
                      <th className="pb-3 pr-3 text-right font-medium">
                        Price
                      </th>
                      <th className="pb-3 pr-3 text-right font-medium">
                        Today
                      </th>
                      <th className="pb-3 pr-3 text-right font-medium">
                        Volume
                      </th>
                      <th className="pb-3 pr-3 font-medium">
                        Today&apos;s chart
                      </th>
                      <th className="pb-3 pr-3 font-medium">Best venue</th>
                      <th className="pb-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const best = bestVenue(a);
                      return (
                        <tr
                          key={a.ticker}
                          onClick={() => router.push(`/markets/${a.ticker}`)}
                          onPointerEnter={() => preloadStock(a.ticker)}
                          onPointerLeave={cancelPreload}
                          className="cursor-pointer border-b border-line/70 transition-colors hover:bg-surface/70"
                        >
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2.5">
                              <StockLogo ticker={a.ticker} />
                              <div className="min-w-0">
                                <Link
                                  href={`/markets/${a.ticker}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="flex items-center gap-1.5 font-semibold"
                                >
                                  {a.ticker}
                                  {owned.has(a.ticker) && (
                                    <Badge tone="up">Owned</Badge>
                                  )}
                                </Link>
                                <div className="truncate text-xs text-subtle">
                                  {a.name ?? "–"}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 pr-3 text-right font-jet font-medium tabular-nums">
                            {usd(a.price)}
                          </td>
                          <td
                            className={cx(
                              "py-3 pr-3 text-right font-jet tabular-nums",
                              tone(a.changePct),
                            )}
                          >
                            {pct(a.changePct)}
                          </td>
                          <td className="py-3 pr-3 text-right font-jet tabular-nums text-muted">
                            {compact(a.volume)}
                          </td>
                          <td className="py-3 pr-3">
                            <Sparkline
                              points={a.points}
                              up={(a.changePct ?? 0) >= 0}
                            />
                          </td>
                          <td className="py-3 pr-3">
                            {best ? (
                              <div>
                                <div className="font-medium">
                                  {best.issuer}{" "}
                                  <span className="font-jet tabular-nums">
                                    {usd(best.price)}
                                  </span>
                                </div>
                                <div className="text-xs text-subtle">
                                  {a.venues.length === 1
                                    ? "Only venue"
                                    : `${quoted(a).length} of ${a.venues.length} venues quoting`}
                                  {best.premiumBps != null &&
                                    ` · ${bps(best.premiumBps)} vs stock`}
                                </div>
                              </div>
                            ) : (
                              <span className="text-xs text-subtle">
                                No venue quoting
                              </span>
                            )}
                          </td>
                          <td className="py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {stockMarketEnabled() && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTrading(a);
                                  }}
                                  className={cx(
                                    "rounded-full px-3.5 py-1.5 text-xs font-semibold",
                                    glassPrimary,
                                  )}
                                >
                                  Buy
                                </button>
                              )}
                              {tradable(a.ticker) && (
                                <Link
                                  href={`/trade?asset=${a.ticker}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded-full bg-ink/[0.05] px-3.5 py-1.5 text-xs font-semibold text-ink hover:bg-ink/[0.08]"
                                >
                                  Predict
                                </Link>
                              )}
                              <CaretRight
                                size={14}
                                aria-hidden="true"
                                className="text-faint"
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          className="py-10 text-center text-sm text-subtle"
                        >
                          No stocks match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 font-jet text-[11px] text-faint">
                Stock prices from Yahoo Finance. Wrapper quotes from the
                KyberSwap aggregator on BNB Chain. Updated{" "}
                {new Date(data.at).toLocaleTimeString()}.
              </p>
            </section>
          </div>
        )}
      </main>
      {trading && (
        <StockTrade
          ticker={trading.ticker}
          name={trading.name}
          price={trading.price}
          mainnetRoute={mainnetRoute(trading)}
          onClose={() => setTrading(null)}
        />
      )}
    </div>
  );
}

function MiniList({
  title,
  rows,
  value,
  neutral,
}: {
  title: string;
  rows: Asset[];
  value: (a: Asset) => string;
  neutral?: boolean;
}) {
  return (
    <div className="rounded-3xl bg-white/70 px-4 py-3.5 ring-1 ring-ink/[0.06]">
      <div className="font-jet text-[11px] uppercase tracking-[0.12em] text-faint">
        {title}
      </div>
      <ul className="mt-2">
        {rows.map((a) => (
          <li key={a.ticker}>
            <Link
              href={`/markets/${a.ticker}`}
              onPointerEnter={() => preloadStock(a.ticker)}
              onPointerLeave={cancelPreload}
              className="flex w-full items-center gap-2.5 rounded-xl px-1 py-1.5 text-left transition-colors hover:bg-surface"
            >
              <StockLogo ticker={a.ticker} small />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-tight">
                  {a.ticker}
                </span>
                <span className="block truncate text-[11px] text-subtle">
                  {a.name}
                </span>
              </span>
              <span className="text-right">
                <span className="block font-jet text-[13px] tabular-nums">
                  {usd(a.price)}
                </span>
                <span
                  className={cx(
                    "block font-jet text-xs tabular-nums",
                    neutral ? "text-muted" : tone(a.changePct),
                  )}
                >
                  {value(a)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <span className="text-xs text-faint">–</span>;
  const min = Math.min(...points);
  const range = Math.max(...points) - min || 1;
  const d = points
    .map(
      (p, i) =>
        `${(i / (points.length - 1)) * 100},${28 - ((p - min) / range) * 26}`,
    )
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="h-7 w-24"
      aria-hidden="true"
    >
      <polyline
        points={d}
        fill="none"
        stroke={up ? "var(--up)" : "var(--down)"}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
