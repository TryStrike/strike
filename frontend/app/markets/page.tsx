'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, CaretDown, MagnifyingGlass, Storefront } from '@phosphor-icons/react';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';
import { Label, cx } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import { PRICE_FEED_IDS, type AssetType } from '@/lib/utils/priceFeed';

interface Venue {
  issuer: string;
  symbol: string;
  address: string;
  price: number | null;
  premiumBps: number | null;
  route: string[];
  error: string | null;
}

interface Asset {
  ticker: string;
  name: string | null;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  points: number[];
  venues: Venue[];
  best: string | null;
}

interface Markets {
  at: number;
  session: 'pre' | 'open' | 'post' | 'closed';
  quoteUsd: number;
  assets: Asset[];
}

const REFRESH_MS = 30_000;
const SESSION_LABEL = { pre: 'Pre-market', open: 'Market open', post: 'After hours', closed: 'Market closed' } as const;
const FILTERS = {
  all: { label: 'All', test: () => true },
  tech: { label: 'Tech', test: (a: Asset) => ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMD'].includes(a.ticker) },
  consumer: { label: 'Consumer', test: (a: Asset) => ['AMZN', 'TSLA', 'NFLX'].includes(a.ticker) },
  etf: { label: 'ETF', test: (a: Asset) => a.ticker === 'SPY' },
  multi: { label: '2+ venues', test: (a: Asset) => quoted(a).length > 1 },
} as const;
type FilterKey = keyof typeof FILTERS;
type SortKey = 'volume' | 'change' | 'spread' | 'name';

const usd = (n: number | null | undefined) =>
  n == null ? '–' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null | undefined) => (n == null ? '–' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`);
const bps = (n: number | null) => (n == null ? '' : `${n >= 0 ? '+' : '−'}${Math.abs(n)} bp`);
const compact = (n: number | null) =>
  n == null ? '–' : Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const quoted = (a: Asset) => a.venues.filter((v) => v.price != null);
const bestVenue = (a: Asset) => a.venues.find((v) => v.issuer === a.best) ?? null;
/** Percent saved buying at the cheapest wrapper instead of the dearest. */
function spread(a: Asset) {
  const prices = quoted(a).map((v) => v.price as number);
  return prices.length > 1 ? (Math.max(...prices) / Math.min(...prices) - 1) * 100 : 0;
}
const tradable = (t: string): t is AssetType => t in PRICE_FEED_IDS;

export default function MarketsPage() {
  const [data, setData] = useState<Markets | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('volume');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const router = useRouter();
  const setSelectedAsset = useStore((s) => s.setSelectedAsset);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/markets')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: Markets) => alive && (setData(d), setFailed(false)))
        .catch((err) => {
          console.error('[markets] load failed', err);
          if (alive) setFailed(true);
        });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const assets = useMemo(() => data?.assets ?? [], [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = assets.filter(
      (a) => FILTERS[filter].test(a) && (!q || a.ticker.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q))
    );
    const by: Record<SortKey, (a: Asset, b: Asset) => number> = {
      volume: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
      change: (a, b) => (b.changePct ?? 0) - (a.changePct ?? 0),
      spread: (a, b) => spread(b) - spread(a),
      name: (a, b) => a.ticker.localeCompare(b.ticker),
    };
    return [...list].sort(by[sort]);
  }, [assets, filter, sort, query]);

  const byChange = useMemo(() => [...assets].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)), [assets]);
  const bySpread = useMemo(() => [...assets].sort((a, b) => spread(b) - spread(a)), [assets]);
  const hero = bySpread[0] && spread(bySpread[0]) > 0 ? bySpread[0] : null;
  const venueCount = assets.reduce((n, a) => n + quoted(a).length, 0);

  const reveal = (ticker: string) => {
    setOpen(ticker);
    setFilter('all');
    setQuery('');
    requestAnimationFrame(() => document.getElementById(`market-${ticker}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const predict = (ticker: string) => {
    if (!tradable(ticker)) return;
    setSelectedAsset(ticker);
    router.push('/trade');
  };

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
              Live quotes for a ${data?.quoteUsd ?? 100} buy of each tokenized stock on BNB Chain, slippage included.
              Read-only: nothing here moves money.
            </p>
          </div>
          {data && <SessionPill session={data.session} />}
        </header>

        {failed && !data ? (
          <div role="alert" className="rounded-3xl bg-down-soft px-5 py-4 text-sm text-ink ring-1 ring-down/20">
            Could not reach the markets feed. It retries every 30 seconds.
          </div>
        ) : !data ? (
          <div className="space-y-3">
            <div className="h-40 animate-pulse rounded-3xl bg-ink/[0.04]" />
            <div className="h-96 animate-pulse rounded-3xl bg-ink/[0.04]" />
          </div>
        ) : (
          <div className="space-y-4">
            <section className="grid gap-4 overflow-hidden rounded-3xl bg-ink px-6 py-6 text-white md:grid-cols-[1.4fr_1fr] md:items-center sm:px-8">
              <div>
                <h2 className="text-[26px] font-semibold leading-[1.1] tracking-tight sm:text-[30px]">
                  Same share.
                  <br />
                  Different price.
                </h2>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-white/65">
                  {hero
                    ? `${hero.ticker} costs ${spread(hero).toFixed(2)}% less on ${hero.best} than on its dearest wrapper right now.`
                    : 'Each stock trades as several wrapper tokens. We quote all of them and show the cheapest.'}{' '}
                  {venueCount} live quotes across {assets.length} stocks.
                </p>
              </div>
              {hero && (
                <div className="grid grid-cols-3 gap-2">
                  {hero.venues.map((v) => (
                    <div
                      key={v.symbol}
                      className={cx(
                        'min-w-0 rounded-2xl px-3 py-3 ring-1',
                        v.issuer === hero.best ? 'bg-white/15 ring-white/30' : 'bg-white/5 ring-white/10'
                      )}
                    >
                      <div className="truncate text-[13px] font-semibold">{v.symbol}</div>
                      <div className="mt-1 font-jet text-sm tabular-nums">{v.price == null ? 'no quote' : usd(v.price)}</div>
                      <div className="mt-0.5 text-[11px] text-white/55">
                        {v.issuer === hero.best ? 'Best price' : v.issuer}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <div className="grid gap-3 lg:grid-cols-3">
              <MiniList title="Best today" rows={byChange.slice(0, 3)} value={(a) => pct(a.changePct)} onPick={reveal} />
              <MiniList title="Worst today" rows={byChange.slice(-3).reverse()} value={(a) => pct(a.changePct)} onPick={reveal} />
              <MiniList
                title="Widest venue gap"
                rows={bySpread.slice(0, 3)}
                value={(a) => (spread(a) ? `${spread(a).toFixed(2)}%` : 'one venue')}
                onPick={reveal}
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
                        'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                        filter === k ? 'bg-surface text-ink ring-1 ring-line' : 'text-muted hover:bg-surface'
                      )}
                    >
                      {FILTERS[k].label}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <label className="flex h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-xs text-muted">
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
                      <th className="pb-3 pr-3 text-right font-medium">Price</th>
                      <th className="pb-3 pr-3 text-right font-medium">Today</th>
                      <th className="pb-3 pr-3 text-right font-medium">Volume</th>
                      <th className="pb-3 pr-3 font-medium">Today&apos;s chart</th>
                      <th className="pb-3 pr-3 font-medium">Best venue</th>
                      <th className="pb-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const best = bestVenue(a);
                      const expanded = open === a.ticker;
                      return (
                        <Fragment key={a.ticker}>
                          <tr
                            id={`market-${a.ticker}`}
                            onClick={() => setOpen(expanded ? null : a.ticker)}
                            className="cursor-pointer border-b border-line/70 transition-colors hover:bg-surface/70"
                          >
                            <td className="py-3 pr-3">
                              <div className="flex items-center gap-2.5">
                                <StockLogo ticker={a.ticker} />
                                <div className="min-w-0">
                                  <div className="font-semibold">{a.ticker}</div>
                                  <div className="truncate text-xs text-subtle">{a.name ?? '–'}</div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 pr-3 text-right font-jet font-medium tabular-nums">{usd(a.price)}</td>
                            <td className={cx('py-3 pr-3 text-right font-jet tabular-nums', tone(a.changePct))}>{pct(a.changePct)}</td>
                            <td className="py-3 pr-3 text-right font-jet tabular-nums text-muted">{compact(a.volume)}</td>
                            <td className="py-3 pr-3">
                              <Sparkline points={a.points} up={(a.changePct ?? 0) >= 0} />
                            </td>
                            <td className="py-3 pr-3">
                              {best ? (
                                <div>
                                  <div className="font-medium">
                                    {best.issuer} <span className="font-jet tabular-nums">{usd(best.price)}</span>
                                  </div>
                                  <div className="text-xs text-subtle">
                                    {a.venues.length === 1
                                      ? 'Only venue'
                                      : `${quoted(a).length} of ${a.venues.length} venues quoting`}
                                    {best.premiumBps != null && ` · ${bps(best.premiumBps)} vs stock`}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-xs text-subtle">No venue quoting</span>
                              )}
                            </td>
                            <td className="py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                {tradable(a.ticker) && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      predict(a.ticker);
                                    }}
                                    className="rounded-full bg-up-soft px-3 py-1.5 text-xs font-semibold text-up transition-colors hover:bg-up hover:text-white"
                                  >
                                    Predict
                                  </button>
                                )}
                                <CaretDown
                                  size={14}
                                  aria-hidden="true"
                                  className={cx('text-faint transition-transform', expanded && 'rotate-180')}
                                />
                              </div>
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="border-b border-line/70 bg-surface/50">
                              <td colSpan={7} className="px-3 py-3">
                                <VenueTable asset={a} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-10 text-center text-sm text-subtle">
                          No stocks match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 font-jet text-[11px] text-faint">
                Stock prices from Yahoo Finance. Wrapper quotes from the KyberSwap aggregator on BNB Chain. Updated{' '}
                {new Date(data.at).toLocaleTimeString()}.
              </p>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

const tone = (n: number | null) => (n == null || Math.abs(n) < 0.005 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');

function SessionPill({ session }: { session: Markets['session'] }) {
  const live = session === 'open';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium',
        live ? 'bg-up-soft text-up' : 'bg-surface text-muted ring-1 ring-line'
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', live ? 'bg-up' : 'bg-faint')} />
      {SESSION_LABEL[session]}
      {!live && <span className="text-faint">· wrappers still trade</span>}
    </span>
  );
}

function VenueTable({ asset }: { asset: Asset }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {asset.venues.map((v) => (
        <div
          key={v.symbol}
          className={cx('rounded-2xl bg-white px-4 py-3 ring-1', v.issuer === asset.best ? 'ring-up/40' : 'ring-line')}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">{v.symbol}</span>
            {v.issuer === asset.best && (
              <span className="rounded-full bg-up-soft px-2 py-0.5 text-[10px] font-semibold text-up">Best</span>
            )}
          </div>
          <div className="text-xs text-subtle">{v.issuer} · BNB Chain</div>
          {v.price != null ? (
            <>
              <div className="mt-2 font-jet text-[15px] font-medium tabular-nums">{usd(v.price)}</div>
              <div className="text-xs text-subtle">
                {bps(v.premiumBps)} vs stock{v.route.length > 0 && ` · via ${v.route.join(', ')}`}
              </div>
            </>
          ) : (
            <div className="mt-2 text-xs text-down">{v.error ?? 'No quote'}</div>
          )}
          <a
            href={`https://bscscan.com/token/${v.address}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-ink"
          >
            Token contract <ArrowUpRight size={11} aria-hidden="true" />
          </a>
        </div>
      ))}
    </div>
  );
}

function MiniList({
  title,
  rows,
  value,
  onPick,
  neutral,
}: {
  title: string;
  rows: Asset[];
  value: (a: Asset) => string;
  onPick: (ticker: string) => void;
  neutral?: boolean;
}) {
  return (
    <div className="rounded-3xl bg-white/70 px-4 py-3.5 ring-1 ring-ink/[0.06]">
      <div className="font-jet text-[11px] uppercase tracking-[0.12em] text-faint">{title}</div>
      <ul className="mt-2">
        {rows.map((a) => (
          <li key={a.ticker}>
            <button
              type="button"
              onClick={() => onPick(a.ticker)}
              className="flex w-full items-center gap-2.5 rounded-xl px-1 py-1.5 text-left transition-colors hover:bg-surface"
            >
              <StockLogo ticker={a.ticker} small />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-tight">{a.ticker}</span>
                <span className="block truncate text-[11px] text-subtle">{a.name}</span>
              </span>
              <span className="text-right">
                <span className="block font-jet text-[13px] tabular-nums">{usd(a.price)}</span>
                <span className={cx('block font-jet text-xs tabular-nums', neutral ? 'text-muted' : tone(a.changePct))}>
                  {value(a)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StockLogo({ ticker, small }: { ticker: string; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const size = small ? 'h-7 w-7' : 'h-8 w-8';
  if (broken) {
    return (
      <span className={cx(size, 'flex shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-muted')}>
        {ticker[0]}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/logos/stock-${ticker}-logo.png`}
      alt=""
      onError={() => setBroken(true)}
      className={cx(size, 'shrink-0 rounded-full bg-surface object-cover')}
    />
  );
}

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <span className="text-xs text-faint">–</span>;
  const min = Math.min(...points);
  const range = Math.max(...points) - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${28 - ((p - min) / range) * 26}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-24" aria-hidden="true">
      <polyline points={d} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
