'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { BlurFade, CountdownRing, Marquee, SlidingNumber, WordRotate } from '@/components/landing/primitives';
import { explorerAddressUrl, getArcConfig } from '@/lib/arc/config';
import { BRAND } from '@/lib/brand';
import { SiteNav } from '@/components/SiteNav';
import { ArcProof } from '@/components/landing/ArcProof';
import { glassPrimary } from '@/components/ui/kit';
import { ArrowDown, ArrowUp, ArrowUpRight, Minus } from '@phosphor-icons/react';

const HERO_ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin', pair: 'BTC / USD' },
  { symbol: 'ETH', name: 'Ethereum', pair: 'ETH / USD' },
  { symbol: 'GOLD', name: 'Gold', pair: 'XAU / USD' },
  { symbol: 'NVDA', name: 'Nvidia', pair: 'NVDA / USD' },
];
const TICKER = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'GOLD', 'SILVER', 'EUR', 'GBP', 'JPY', 'AAPL', 'NVDA', 'TSLA', 'SPX', 'WTI'];

/** Same localStorage key the /trade poller (lib/utils/priceFeed) writes on
 *  every successful fetch — lets a fresh landing visit start from the last
 *  known prices instead of an empty/placeholder flash. */
const PRICE_CACHE_KEY = 'strike_last_price_cache_v1';

function fmt(v: number) {
  const dp = v >= 100 ? 2 : v >= 1 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Only finite, positive numbers may enter price state — NaN/0/strings from a
 *  bad payload can never reach the UI. */
function sanitizePrices(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[sym] = v;
    }
  }
  return out;
}

/**
 * Live rolling price for the hero + ticker.
 * - Polls /api/prices/latest once a second; a failed poll simply keeps the
 *   last known snapshot (state is only ever merged into, never cleared).
 * - Subscribes to /api/prices/stream (SSE) as an optimization; if EventSource
 *   is missing or the stream breaks, the browser reconnects and the 1s poll
 *   keeps flowing regardless.
 */
function usePrices() {
  const [state, setState] = useState<{ prices: Record<string, number>; prev: Record<string, number> }>({
    prices: {},
    prev: {},
  });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PRICE_CACHE_KEY);
      if (raw) {
        const seed = sanitizePrices(JSON.parse(raw));
        if (Object.keys(seed).length > 0) {
          setState((cur) => ({ prev: cur.prev, prices: { ...seed, ...cur.prices } }));
        }
      }
    } catch {
      // corrupt cache: the poll will fill it in
    }

    let live = true;
    const tick = async () => {
      try {
        // GET of all assets: CDN-cached and shared with the trade screen.
        const res = await fetch('/api/prices/latest');
        if (!res.ok) return; // keep the last known prices on a failed poll
        const body = (await res.json()) as { prices?: unknown };
        const next = sanitizePrices(body?.prices);
        if (!live || Object.keys(next).length === 0) return;
        setState((cur) => ({ prev: cur.prices, prices: { ...cur.prices, ...next } }));
      } catch {
        // keep the last prices on a failed poll
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return;
    const es = new EventSource('/api/prices/stream');
    es.onmessage = (event: MessageEvent) => {
      try {
        const tick = JSON.parse(String(event.data)) as { asset?: unknown; price?: unknown };
        const sym = typeof tick?.asset === 'string' ? tick.asset : '';
        const price = typeof tick?.price === 'number' ? tick.price : NaN;
        if (!sym || !Number.isFinite(price) || price <= 0) return;
        setState((cur) => ({ prev: cur.prices, prices: { ...cur.prices, [sym]: price } }));
      } catch {
        // ignore a malformed frame; the poll remains the source of truth
      }
    };
    // No onerror handler on purpose: EventSource auto-reconnects, and the 1s
    // poll keeps the hero live while the stream is down.
    return () => es.close();
  }, []);

  return state;
}

export default function Landing() {
  const { prices, prev } = usePrices();
  const reduceMotion = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    // Under reduced motion the hero stays on one asset — nothing auto-advances.
    if (reduceMotion) return;
    const id = setInterval(() => setI((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [reduceMotion]);

  const hero = HERO_ASSETS[reduceMotion ? 0 : i % HERO_ASSETS.length];
  const price = prices[hero.symbol];
  const prevPrice = prev[hero.symbol];
  const priceText = typeof price === 'number' && Number.isFinite(price) && price > 0 ? fmt(price) : null;
  const [whole, frac] = priceText ? priceText.split('.') : ['', ''];
  const dir = typeof price === 'number' && typeof prevPrice === 'number' ? Math.sign(price - prevPrice) : 0;

  return (
    <div className="min-h-full shrink-0 bg-white text-[#0A0C10] font-[family-name:var(--font-inter-tight)] tabular-nums selection:bg-[#2151F5] selection:text-white">
      <a
        href="#landing-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[#0A0C10] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <SiteNav
        sticky
        right={
          <Link href="/trade" className={`rounded-full px-4 py-2 text-sm font-semibold ${glassPrimary}`}>
            Launch app
          </Link>
        }
      />

      <div id="landing-content" tabIndex={-1} className="focus:outline-none">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(#0A0C10_1px,transparent_1px)] [background-size:24px_24px] opacity-[0.08] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_35%,#000_20%,transparent_80%)]"
        />
        <div className="relative mx-auto flex max-w-[920px] flex-col items-center px-5 pb-20 pt-20 text-center sm:px-8 sm:pt-28">
          <BlurFade>
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium text-[#4A505C] ring-1 ring-[#E3E6EB]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2151F5]" aria-hidden="true" />
              Live on Arc Testnet · settles in USDC
            </span>
          </BlurFade>

          <BlurFade delay={0.08}>
            <h1 className="mt-7 font-[family-name:var(--font-instrument-serif)] text-[clamp(52px,8vw,104px)] font-normal leading-[0.95] tracking-[-0.025em]">
              Higher or lower?
              <br />
              <span className="italic text-[#2151F5]">Five seconds</span> to find out.
            </h1>
          </BlurFade>

          <BlurFade delay={0.16}>
            <p className="mx-auto mt-7 max-w-[540px] text-[18px] leading-relaxed text-[#4A505C]">
              Binary rounds on crypto, forex, stocks and metals. Deposit USDC once, then trade every round without signing a transaction.
            </p>
          </BlurFade>

          <BlurFade delay={0.24}>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link href="/trade" className={`inline-flex h-12 items-center rounded-full px-6 font-semibold ${glassPrimary}`}>
                Start trading
              </Link>
              <a href="#how" className="inline-flex h-12 items-center rounded-full bg-white px-6 font-semibold ring-1 ring-[#E3E6EB] transition-colors hover:ring-[#0A0C10]">
                How it works
              </a>
            </div>
          </BlurFade>

          {/* Live round card */}
          <BlurFade delay={0.34} className="mt-16 w-full max-w-[600px]">
            <div className="rounded-[28px] bg-white p-6 text-left ring-1 ring-line shadow-2xl sm:p-8">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[15px] font-semibold">
                    <WordRotate words={HERO_ASSETS.map((a) => a.name)} index={i} />
                  </div>
                  <div className="mt-0.5 font-[family-name:var(--font-jetbrains-mono)] text-xs text-[#6B7280]">{hero.pair} · live</div>
                </div>
                <CountdownRing size={56} />
              </div>

              <div className="mt-6 font-[family-name:var(--font-jetbrains-mono)] text-[clamp(44px,9vw,76px)] font-semibold leading-none tracking-[-0.05em] tabular-nums">
                {/* An invisible widest-case sizer pins the row width so digit-count
                    changes never shift the layout; the live value overlays it.
                    Before the first tick: reserved whitespace, never "—"/NaN/0. */}
                <span className="relative inline-block align-top">
                  <span aria-hidden="true" className="invisible">
                    1,111,111.11
                  </span>
                  {priceText && (
                    <span className="absolute inset-0 flex whitespace-nowrap">
                      <SlidingNumber value={whole} />
                      {frac && <span className="text-[#6B7280]">.<SlidingNumber value={frac} /></span>}
                    </span>
                  )}
                </span>
                {!priceText && <span className="sr-only">Loading live price</span>}
              </div>
              {/* Three-state direction: never claim "moving up" on dir=0 / no data. */}
              <div className={`mt-3 min-h-[1.25rem] font-[family-name:var(--font-jetbrains-mono)] text-sm ${dir < 0 ? 'text-[#C2410C]' : dir > 0 ? 'text-[#2151F5]' : 'text-[#6B7280]'}`}>
                {priceText ? (
                  typeof prevPrice === 'number' ? (
                    <span className="inline-flex items-center gap-1.5">
                      {dir < 0 ? <ArrowDown size={14} weight="bold" aria-hidden="true" /> : dir > 0 ? <ArrowUp size={14} weight="bold" aria-hidden="true" /> : <Minus size={14} weight="bold" aria-hidden="true" />}
                      moving {dir < 0 ? 'down' : dir > 0 ? 'up' : 'sideways'}
                    </span>
                  ) : (
                    'waiting for next tick…'
                  )
                ) : (
                  'connecting to live feed…'
                )}
              </div>

              <div className="mt-7 grid grid-cols-2 gap-3">
                <Link href="/trade" className="flex h-14 items-center justify-between rounded-2xl bg-[#2151F5] px-5 font-semibold text-white transition-transform hover:-translate-y-0.5">
                  Higher <span className="font-[family-name:var(--font-jetbrains-mono)] text-sm font-medium opacity-90">×1.75</span>
                </Link>
                <Link href="/trade" className="flex h-14 items-center justify-between rounded-2xl px-5 font-semibold ring-1 ring-[#0A0C10] transition-transform hover:-translate-y-0.5">
                  Lower <span className="font-[family-name:var(--font-jetbrains-mono)] text-sm font-medium text-[#4A505C]">×1.75</span>
                </Link>
              </div>
            </div>
          </BlurFade>
        </div>

        {/* Ticker */}
        <div className="border-y border-[#0A0C10]/[0.06] py-3.5 font-[family-name:var(--font-jetbrains-mono)] text-[13px]">
          <Marquee seconds={50}>
            {TICKER.map((s) => {
              const v = prices[s];
              const d = v && prev[s] ? Math.sign(v - prev[s]) : 0;
              return (
                <span key={s} className="whitespace-nowrap text-[#4A505C]">
                  <span className="text-[#6B7280]">{s}</span> {v ? fmt(v) : '—'}{' '}
                  <span className={`inline-block align-[-2px] ${d < 0 ? 'text-[#C2410C]' : d > 0 ? 'text-[#2151F5]' : 'text-[#6B7280]'}`}>
                    {d < 0 ? <ArrowDown size={13} weight="bold" aria-hidden="true" /> : d > 0 ? <ArrowUp size={13} weight="bold" aria-hidden="true" /> : <Minus size={13} weight="bold" aria-hidden="true" />}
                  </span>
                </span>
              );
            })}
          </Marquee>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-16">
        <div className="mx-auto max-w-[1040px] px-5 py-28 sm:px-8">
          <BlurFade className="text-center">
            <div className="font-[family-name:var(--font-jetbrains-mono)] text-xs uppercase tracking-[0.18em] text-[#6B7280]">How it works</div>
            <h2 className="mt-4 font-[family-name:var(--font-instrument-serif)] text-[clamp(40px,5vw,60px)] font-normal leading-[1] tracking-[-0.02em]">
              Three taps. <span className="italic text-[#6B7280]">That&apos;s it.</span>
            </h2>
          </BlurFade>

          <div className="mt-16 grid gap-4 md:grid-cols-3">
            <BlurFade className="rounded-3xl p-2 ring-1 ring-[#0A0C10]/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-[#F6F7F9]">
                <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 font-[family-name:var(--font-jetbrains-mono)] text-sm ring-1 ring-[#0A0C10]/[0.08]">
                  <span className="h-2 w-2 rounded-full bg-[#2151F5]" aria-hidden="true" /> +25.00 USDC
                </span>
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="text-[17px] font-semibold tracking-tight">Deposit</div>
                <div className="mt-1 text-[15px] text-[#6B7280]">USDC in, on Arc.</div>
              </div>
            </BlurFade>

            <BlurFade delay={0.06} className="rounded-3xl p-2 ring-1 ring-[#0A0C10]/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-[#F6F7F9]">
                <div className="flex gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-xl bg-[#2151F5] px-4 py-2.5 text-sm font-semibold text-white"><ArrowUp size={14} weight="bold" /> Higher</span>
                  <span className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold ring-1 ring-[#0A0C10]/[0.12]"><ArrowDown size={14} weight="bold" /> Lower</span>
                </div>
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="text-[17px] font-semibold tracking-tight">Call it</div>
                <div className="mt-1 text-[15px] text-[#6B7280]">One tap. No signature.</div>
              </div>
            </BlurFade>

            <BlurFade delay={0.12} className="rounded-3xl p-2 ring-1 ring-[#0A0C10]/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-[#F6F7F9]">
                <div className="text-center">
                  <div className="font-[family-name:var(--font-jetbrains-mono)] text-[28px] font-medium tracking-[-0.04em] text-[#2151F5]">+0.75</div>
                  <div className="font-[family-name:var(--font-jetbrains-mono)] text-xs text-[#6B7280]">USDC · paid on-chain</div>
                </div>
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="text-[17px] font-semibold tracking-tight">Get paid</div>
                <div className="mt-1 text-[15px] text-[#6B7280]">Withdraw any time.</div>
              </div>
            </BlurFade>
          </div>

          {/* Numbers */}
          <BlurFade className="mt-20 grid grid-cols-2 gap-y-10 md:grid-cols-4">
            {[
              ['5s', 'fastest round'],
              ['×1.95', 'top payout'],
              ['USDC', 'in and out'],
              ['0', 'signatures per bet'],
            ].map(([v, l]) => (
              <div key={l} className="text-center">
                <div className="font-[family-name:var(--font-jetbrains-mono)] text-[32px] font-medium tracking-[-0.04em]">{v}</div>
                <div className="mt-1 text-sm text-[#6B7280]">{l}</div>
              </div>
            ))}
          </BlurFade>
        </div>
      </section>

      <ArcProof />

      {/* Closing */}
      <section className="border-t border-[#0A0C10]/[0.06]">
        <BlurFade className="mx-auto flex max-w-[720px] flex-col items-center px-5 py-28 text-center sm:px-8">
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-[clamp(44px,6vw,72px)] font-normal leading-[1] tracking-[-0.02em]">
            Make the <span className="italic text-[#2151F5]">call.</span>
          </h2>
          <p className="mt-5 text-[17px] text-[#6B7280]">Free test USDC at faucet.circle.com.</p>
          <Link href="/trade" className={`mt-8 inline-flex h-12 items-center rounded-full px-6 font-semibold ${glassPrimary}`}>
            Start trading
          </Link>
        </BlurFade>
      </section>

      <footer className="border-t border-[#0A0C10]/[0.06]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-6 text-[13px] text-[#6B7280] sm:px-8">
          <span>© {BRAND.name} · Prices via Yahoo Finance &amp; Binance · Not financial advice</span>
          <div className="flex gap-6">
            <a href={explorerAddressUrl(getArcConfig().treasuryAddress)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-[#0A0C10]">Treasury contract <ArrowUpRight size={13} aria-hidden="true" /></a>
            {BRAND.social.x && <a href={BRAND.social.x} target="_blank" rel="noopener noreferrer" className="hover:text-[#0A0C10]">X</a>}
            {BRAND.social.telegram && <a href={BRAND.social.telegram} target="_blank" rel="noopener noreferrer" className="hover:text-[#0A0C10]">Telegram</a>}
          </div>
        </div>
      </footer>
      </div>
    </div>
  );
}
