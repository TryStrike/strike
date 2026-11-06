'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { BlurFade, CountdownRing, Marquee, SlidingNumber, WordRotate } from '@/components/landing/primitives';
import { explorerAddressUrl, getArcConfig } from '@/lib/arc/config';
import { BRAND } from '@/lib/brand';
import { SiteNav } from '@/components/SiteNav';
import { ArcProof } from '@/components/landing/ArcProof';
import { Features, ProofLadder } from '@/components/landing/MoreSections';
import { glassPrimary } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import { ArrowDown, ArrowUp, ArrowUpRight, Minus } from '@phosphor-icons/react';

const STATIC_DOTS =
  'h-full w-full [background-image:radial-gradient(var(--ink)_1px,transparent_1px)] [background-size:24px_24px] opacity-[0.08] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_35%,#000_20%,transparent_80%)]';

const HeroDither = dynamic(() => import('@/components/ui/DitherField').then((m) => m.DitherField), {
  ssr: false,
  loading: () => <div className={STATIC_DOTS} />,
});

const HERO_ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin', pair: 'BTC / USD' },
  { symbol: 'ETH', name: 'Ethereum', pair: 'ETH / USD' },
  { symbol: 'GOLD', name: 'Gold', pair: 'XAU / USD' },
  { symbol: 'NVDA', name: 'Nvidia', pair: 'NVDA / USD' },
];
const TICKER = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'GOLD', 'SILVER', 'EUR', 'GBP', 'JPY', 'AAPL', 'NVDA', 'TSLA', 'SPX', 'WTI'];

const PRICE_CACHE_KEY = 'strike_last_price_cache_v1';

function fmt(v: number) {
  const dp = v >= 100 ? 2 : v >= 1 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function sanitizePrices(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[sym] = v;
    }
  }
  return out;
}

function usePrices() {
  const live = useStore((s) => s.assetPrices);
  const [seed] = useState<Record<string, number>>(() => {
    try {
      const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(PRICE_CACHE_KEY);
      return raw ? sanitizePrices(JSON.parse(raw)) : {};
    } catch (err) {
      console.warn('[prices] ignoring unreadable price cache', err);
      return {};
    }
  });
  const prices = useMemo(() => ({ ...seed, ...sanitizePrices(live) }), [seed, live]);
  const [prev, setPrev] = useState<Record<string, number>>({});
  const last = useRef(prices);
  useEffect(() => {
    setPrev(last.current);
    last.current = prices;
  }, [prices]);
  return { prices, prev };
}

export default function Landing() {
  const { prices, prev } = usePrices();
  const reduceMotion = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
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
    <div className="min-h-full shrink-0 bg-white text-ink font-tight tabular-nums selection:bg-up selection:text-white">
      <a
        href="#landing-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
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
      <section className="relative overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 text-up">
          <HeroDither pattern="horizon" dotSize={2} intensity={0.7} className="h-full w-full" />
        </div>
        <div className="relative mx-auto flex max-w-[920px] flex-col items-center px-5 pb-20 pt-20 text-center sm:px-8 sm:pt-28">
          <BlurFade>
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium text-muted ring-1 ring-line">
              <span className="h-1.5 w-1.5 rounded-full bg-up" aria-hidden="true" />
              Live on Arc Testnet · settles in USDC
            </span>
          </BlurFade>

          <BlurFade delay={0.08}>
            <h1 className="mt-7 font-serif text-[clamp(52px,8vw,104px)] font-normal leading-[0.95] tracking-[-0.025em]">
              Higher or lower?
              <br />
              <span className="italic text-up">Five seconds</span> to find out.
            </h1>
          </BlurFade>

          <BlurFade delay={0.16}>
            <p className="mx-auto mt-7 max-w-[540px] text-[18px] leading-relaxed text-muted">
              Binary rounds on crypto, forex, stocks and metals. Deposit USDC once, then trade every round without signing a transaction.
            </p>
          </BlurFade>

          <BlurFade delay={0.24}>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link href="/trade" className={`inline-flex h-12 items-center rounded-full px-6 font-semibold ${glassPrimary}`}>
                Start trading
              </Link>
              <a href="#how" className="inline-flex h-12 items-center rounded-full bg-white px-6 font-semibold ring-1 ring-line transition-colors">
                How it works
              </a>
            </div>
          </BlurFade>

          <BlurFade delay={0.34} className="mt-16 w-full max-w-[600px]">
            <div className="rounded-[28px] bg-white p-6 text-left ring-1 ring-line shadow-2xl sm:p-8">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[15px] font-semibold">
                    <WordRotate words={HERO_ASSETS.map((a) => a.name)} index={i} />
                  </div>
                  <div className="mt-0.5 font-jet text-xs text-subtle">{hero.pair} · live</div>
                </div>
                <CountdownRing size={56} />
              </div>

              <div className="mt-6 font-jet text-[clamp(44px,9vw,76px)] font-semibold leading-none tracking-[-0.05em] tabular-nums">
                <span className="relative inline-block align-top">
                  <span aria-hidden="true" className="invisible">
                    1,111,111.11
                  </span>
                  {priceText && (
                    <span className="absolute inset-0 flex whitespace-nowrap">
                      <SlidingNumber value={whole} />
                      {frac && <span className="text-subtle">.<SlidingNumber value={frac} /></span>}
                    </span>
                  )}
                </span>
                {!priceText && <span className="sr-only">Loading live price</span>}
              </div>
              <div className={`mt-3 min-h-[1.25rem] font-jet text-sm ${dir < 0 ? 'text-down' : dir > 0 ? 'text-up' : 'text-subtle'}`}>
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
                <Link href="/trade" className="flex h-14 items-center justify-between rounded-2xl bg-up px-5 font-semibold text-white transition-transform">
                  Higher <span className="font-jet text-sm font-medium opacity-90">×1.75</span>
                </Link>
                <Link href="/trade" className="flex h-14 items-center justify-between rounded-2xl px-5 font-semibold ring-1 ring-ink transition-transform">
                  Lower <span className="font-jet text-sm font-medium text-muted">×1.75</span>
                </Link>
              </div>
            </div>
          </BlurFade>
        </div>

      </section>

      <div className="border-y border-ink/[0.06] py-3.5 font-jet text-[13px]">
        <Marquee seconds={50}>
          {TICKER.map((s) => {
            const v = prices[s];
            const d = v && prev[s] ? Math.sign(v - prev[s]) : 0;
            return (
              <span key={s} className="whitespace-nowrap text-muted">
                <span className="text-subtle">{s}</span> {v ? fmt(v) : '—'}{' '}
                <span className={`inline-block align-[-2px] ${d < 0 ? 'text-down' : d > 0 ? 'text-up' : 'text-subtle'}`}>
                  {d < 0 ? <ArrowDown size={13} weight="bold" aria-hidden="true" /> : d > 0 ? <ArrowUp size={13} weight="bold" aria-hidden="true" /> : <Minus size={13} weight="bold" aria-hidden="true" />}
                </span>
              </span>
            );
          })}
        </Marquee>
      </div>

      <section id="how" className="scroll-mt-16">
        <div className="mx-auto max-w-[1040px] px-5 py-28 sm:px-8">
          <BlurFade className="text-center">
            <div className="font-jet text-xs uppercase tracking-[0.18em] text-subtle">How it works</div>
            <h2 className="mt-4 font-serif text-[clamp(40px,5vw,60px)] font-normal leading-[1] tracking-[-0.02em]">
              Three taps. <span className="italic text-subtle">That&apos;s it.</span>
            </h2>
          </BlurFade>

          <div className="mt-16 grid gap-4 md:grid-cols-3">
            <BlurFade className="rounded-3xl p-2 ring-1 ring-ink/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-surface">
                <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 font-jet text-sm ring-1 ring-ink/[0.08]">
                  <span className="h-2 w-2 rounded-full bg-up" aria-hidden="true" /> +25.00 USDC
                </span>
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="text-[17px] font-semibold tracking-tight">Deposit</div>
                <div className="mt-1 text-[15px] text-subtle">USDC from any chain, on Arc.</div>
              </div>
            </BlurFade>

            <BlurFade delay={0.06} className="rounded-3xl p-2 ring-1 ring-ink/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-surface">
                <div className="flex gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-xl bg-up px-4 py-2.5 text-sm font-semibold text-white"><ArrowUp size={14} weight="bold" /> Higher</span>
                  <span className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold ring-1 ring-ink/[0.12]"><ArrowDown size={14} weight="bold" /> Lower</span>
                </div>
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="text-[17px] font-semibold tracking-tight">Call it</div>
                <div className="mt-1 text-[15px] text-subtle">One tap. No signature.</div>
              </div>
            </BlurFade>

            <BlurFade delay={0.12} className="rounded-3xl p-2 ring-1 ring-ink/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-surface">
                <div className="text-center">
                  <div className="font-jet text-[28px] font-medium tracking-[-0.04em] text-up">+0.75</div>
                  <div className="font-jet text-xs text-subtle">USDC · paid on-chain</div>
                </div>
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="text-[17px] font-semibold tracking-tight">Get paid</div>
                <div className="mt-1 text-[15px] text-subtle">Withdraw any time.</div>
              </div>
            </BlurFade>
          </div>

          <BlurFade className="mt-20 grid grid-cols-2 gap-y-10 md:grid-cols-4">
            {[
              ['5s', 'fastest round'],
              ['×1.95', 'top payout'],
              ['USDC', 'in and out'],
              ['0', 'signatures per bet'],
            ].map(([v, l]) => (
              <div key={l} className="text-center">
                <div className="font-jet text-[32px] font-medium tracking-[-0.04em]">{v}</div>
                <div className="mt-1 text-sm text-subtle">{l}</div>
              </div>
            ))}
          </BlurFade>
        </div>
      </section>

      <ProofLadder />

      <Features />

      <ArcProof />

      <section className="border-t border-ink/[0.06]">
        <BlurFade className="mx-auto flex max-w-[720px] flex-col items-center px-5 py-28 text-center sm:px-8">
          <h2 className="font-serif text-[clamp(44px,6vw,72px)] font-normal leading-[1] tracking-[-0.02em]">
            Make the <span className="italic text-up">call.</span>
          </h2>
          <p className="mt-5 text-[17px] text-subtle">Free test USDC at faucet.circle.com.</p>
          <Link href="/trade" className={`mt-8 inline-flex h-12 items-center rounded-full px-6 font-semibold ${glassPrimary}`}>
            Start trading
          </Link>
        </BlurFade>
      </section>

      <footer className="border-t border-ink/[0.06]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-6 text-[13px] text-subtle sm:px-8">
          <span>© {BRAND.name} · Prices via Yahoo Finance &amp; Binance · Not financial advice</span>
          <div className="flex gap-6">
            <a href={explorerAddressUrl(getArcConfig().treasuryAddress)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">Treasury contract <ArrowUpRight size={13} aria-hidden="true" /></a>
            <a href="https://github.com/TryStrike/strike" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">GitHub <ArrowUpRight size={13} aria-hidden="true" /></a>
          </div>
        </div>
      </footer>
      </div>
    </div>
  );
}
