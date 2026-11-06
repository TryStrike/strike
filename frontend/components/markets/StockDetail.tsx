"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react";
import { SiteNav } from "@/components/SiteNav";
import { WalletConnect } from "@/components/wallet";
import { Button, Segmented, cx } from "@/components/ui/kit";
import { isAsset } from "@/lib/utils/priceFeed";
import {
  SessionPill,
  StockLogo,
  VenueTable,
} from "@/components/markets/MarketBits";
import {
  StockChart,
  pointTime,
  type Point,
  type Range,
} from "@/components/markets/StockChart";
import {
  compact,
  historyUrl,
  mainnetRoute,
  pct,
  stockMarketEnabled,
  tone,
  usd,
  useMarkets,
} from "@/lib/markets/marketData";

const StockTrade = dynamic(
  () => import("@/components/markets/StockTrade").then((m) => m.StockTrade),
  { ssr: false },
);

interface History {
  ticker: string;
  range: Range;
  price: number;
  base: number;
  changePct: number;
  dayHigh: number | null;
  dayLow: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  volume: number | null;
  points: Point[];
}

interface Stats {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  averageVolume: number | null;
  dividendYield: string | null;
  exDividendDate: string | null;
  expenseRatio: string | null;
}

const RANGES: { value: Range; label: string }[] = [
  { value: "1D", label: "Day" },
  { value: "1W", label: "Week" },
  { value: "1M", label: "Month" },
  { value: "1Y", label: "Year" },
  { value: "ALL", label: "All" },
];

const UNAVAILABLE = {
  dayLow: null,
  dayHigh: null,
  yearLow: null,
  yearHigh: null,
  volume: null,
};

const load = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(body?.error ?? "Market data is unreachable right now");
  return body as T;
};

export function StockDetail({ ticker }: { ticker: string }) {
  const { data: markets, failed: marketsFailed } = useMarkets();
  const [range, setRange] = useState<Range>("1D");
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [trading, setTrading] = useState(false);

  useEffect(() => {
    let alive = true;
    load<History>(historyUrl(ticker, range))
      .then((h) => {
        if (!alive) return;
        setHistory(h);
        setHistoryError(null);
        setHover(null);
      })
      .catch((err: Error) => alive && setHistoryError(err.message));
    return () => {
      alive = false;
    };
  }, [ticker, range, attempt]);

  useEffect(() => {
    let alive = true;
    load<Stats>(`/api/markets/stats?symbol=${ticker}`)
      .then((s) => alive && setStats(s))
      .catch((err: Error) => alive && setStatsError(err.message));
    return () => {
      alive = false;
    };
  }, [ticker]);

  const asset = markets?.assets.find((a) => a.ticker === ticker) ?? null;
  const unknown = !!markets && !asset;
  const loading = !!history && history.range !== range && !historyError;
  const point = hover != null ? history?.points[hover] : undefined;
  const price = point?.c ?? asset?.price ?? history?.price ?? null;
  const change =
    history && price != null ? (price / history.base - 1) * 100 : null;

  const quote = history ?? (historyError ? UNAVAILABLE : null);

  if (unknown) {
    return (
      <div className="min-h-full w-full bg-white font-tight text-ink">
        <SiteNav wide right={<WalletConnect />} />
        <main className="mx-auto max-w-[1200px] px-5 pt-16 text-center sm:px-8">
          <p className="text-sm text-muted">We don&apos;t list {ticker}.</p>
          <Link href="/markets" className="mt-3 inline-block text-sm underline">
            Back to markets
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <SiteNav wide right={<WalletConnect />} />

      <main className="mx-auto max-w-[1200px] px-5 pb-16 pt-6 sm:px-8">
        <Link
          href="/markets"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Markets
        </Link>

        <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <StockLogo ticker={ticker} />
              <h1 className="text-[20px] font-semibold tracking-tight">
                {ticker}
              </h1>
              <span className="text-sm text-subtle">{asset?.name}</span>
            </div>
            <div className="mt-3 font-jet text-[34px] font-semibold leading-none tabular-nums sm:text-[40px]">
              {usd(price)}
            </div>
            <div
              className={cx(
                "mt-2 h-5 font-jet text-[13px] tabular-nums",
                tone(change),
              )}
            >
              {pct(change)}
              <span className="ml-2 text-subtle">
                {point
                  ? pointTime(point.t, range)
                  : RANGES.find((r) => r.value === range)?.label}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {markets && <SessionPill session={markets.session} />}
            {asset && stockMarketEnabled() && (
              <Button onClick={() => setTrading(true)}>Buy or sell</Button>
            )}
            {isAsset(ticker) && (
              <Link
                href={`/trade?asset=${ticker}`}
                className="rounded-full bg-ink/[0.05] px-4 py-2 text-sm font-semibold text-ink"
              >
                Predict
              </Link>
            )}
          </div>
        </header>

        <section className="mt-5">
          <Segmented
            options={RANGES}
            value={range}
            onChange={(r) => {
              setHistoryError(null);
              setRange(r);
            }}
            className="max-w-sm"
          />
          <div
            className={cx("mt-3 transition-opacity", loading && "opacity-50")}
          >
            {historyError ? (
              <div
                role="alert"
                className="flex h-[340px] flex-col items-center justify-center gap-3 rounded-3xl bg-down-soft text-sm"
              >
                {historyError}
                <Button onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              </div>
            ) : history && history.points.length < 2 ? (
              <div className="flex h-[340px] items-center justify-center rounded-3xl bg-surface text-sm text-muted">
                No trades yet this session.
              </div>
            ) : history ? (
              <StockChart
                points={history.points}
                base={history.base}
                range={history.range}
                up={history.changePct >= 0}
                hover={hover}
                onHover={setHover}
              />
            ) : (
              <div className="h-[340px] animate-pulse rounded-3xl bg-ink/[0.04]" />
            )}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-[15px] font-semibold">Stats</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <Stat
              label="Day range"
              value={quote && range2(quote.dayLow, quote.dayHigh)}
            />
            <Stat
              label="52-week range"
              value={quote && range2(quote.yearLow, quote.yearHigh)}
            />
            <Stat label="Volume" value={quote && compact(quote.volume)} />
            {statsError ? (
              <p className="col-span-2 self-center text-[13px] text-muted md:col-span-1">
                {statsError}
              </p>
            ) : (
              <>
                <Stat
                  label="Market cap"
                  value={stats && `$${compact(stats.marketCap)}`}
                />
                <Stat
                  label="Average volume"
                  value={stats && compact(stats.averageVolume)}
                />
                {stats?.expenseRatio ? (
                  <Stat label="Expense ratio" value={stats.expenseRatio} />
                ) : (
                  <>
                    <Stat
                      label="Dividend yield"
                      value={stats && (stats.dividendYield ?? "None")}
                    />
                    <Stat
                      label="Ex-dividend date"
                      value={stats && (stats.exDividendDate ?? "None")}
                    />
                    <Stat
                      label="Sector"
                      value={stats && (stats.sector ?? "–")}
                    />
                  </>
                )}
              </>
            )}
          </dl>
        </section>

        <section className="mt-8">
          <h2 className="text-[15px] font-semibold">Where it trades</h2>
          <p className="mt-1 text-[13px] text-muted">
            Live quotes for a ${markets?.quoteUsd ?? 100} buy, slippage
            included.
          </p>
          <div className="mt-3">
            {asset ? (
              <VenueTable asset={asset} />
            ) : marketsFailed ? (
              <p role="alert" className="text-sm text-down">
                Could not reach the markets feed. It retries every 30 seconds.
              </p>
            ) : (
              <div className="h-32 animate-pulse rounded-3xl bg-ink/[0.04]" />
            )}
          </div>
        </section>

        <p className="mt-6 font-jet text-[11px] text-faint">
          Prices from Yahoo Finance. Company stats from Nasdaq. Wrapper quotes
          from the KyberSwap aggregator on BNB Chain.
        </p>
      </main>

      {trading && asset && (
        <StockTrade
          ticker={ticker}
          name={asset.name}
          price={asset.price}
          mainnetRoute={mainnetRoute(asset)}
          onClose={() => setTrading(false)}
        />
      )}
    </div>
  );
}

const range2 = (low: number | null, high: number | null) =>
  low == null || high == null ? "–" : `${usd(low)} – ${usd(high)}`;

function Stat({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-1 font-jet text-[14px] tabular-nums">
        {value ?? (
          <span className="inline-block h-4 w-20 animate-pulse rounded bg-ink/[0.05]" />
        )}
      </dd>
    </div>
  );
}
