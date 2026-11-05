'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BlurFade, CountdownRing, Marquee, SlidingNumber, WordRotate } from '@/components/landing/primitives';
import { explorerAddressUrl, getArcConfig } from '@/lib/arc/config';

const HERO_ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin', pair: 'BTC / USD' },
  { symbol: 'ETH', name: 'Ethereum', pair: 'ETH / USD' },
  { symbol: 'GOLD', name: 'Gold', pair: 'XAU / USD' },
  { symbol: 'NVDA', name: 'Nvidia', pair: 'NVDA / USD' },
];
const TICKER = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'GOLD', 'SILVER', 'EUR', 'GBP', 'JPY', 'AAPL', 'NVDA', 'TSLA', 'SPX', 'WTI'];
const ASSETS = Array.from(new Set([...HERO_ASSETS.map((a) => a.symbol), ...TICKER]));

function fmt(v: number) {
  const dp = v >= 100 ? 2 : v >= 1 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Polls the app's price route; keeps the previous tick so we can show direction. */
function usePrices(ms = 1500) {
  const [state, setState] = useState<{ prices: Record<string, number>; prev: Record<string, number> }>({
    prices: {},
    prev: {},
  });
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch('/api/prices/latest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assets: ASSETS }),
        });
        const { prices: next } = await res.json();
        if (!live || !next) return;
        setState((cur) => ({ prev: cur.prices, prices: { ...cur.prices, ...next } }));
      } catch {
        // keep the last prices on a failed poll
      }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [ms]);
  return state;
}

export default function Landing() {
  const { prices, prev } = usePrices();
  const [i, setI] = useState(0);
  const [up, setUp] = useState(0);
  useEffect(() => {
    const a = setInterval(() => setI((n) => n + 1), 5000);
    const b = setInterval(() => setUp((n) => n + 1), 2500);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  const hero = HERO_ASSETS[i % HERO_ASSETS.length];
  const price = prices[hero.symbol];
  const [whole, frac] = price ? fmt(price).split('.') : ['—', ''];
  const dir = price && prev[hero.symbol] ? Math.sign(price - prev[hero.symbol]) : 0;

  return (
    <div className="min-h-full bg-white text-[#0A0C10] font-[family-name:var(--font-inter-tight)] selection:bg-[#2151F5] selection:text-white">
      {/* Nav */}
      <nav className="sticky top-0 z-20 border-b border-[#0A0C10]/10 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1312px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link href="/" className="text-lg font-bold tracking-tight">strike<span className="text-[#2151F5]">.</span></Link>
          <div className="hidden items-center gap-8 font-[family-name:var(--font-jetbrains-mono)] text-[12px] tracking-wider text-[#4A505C] md:flex">
            <span>5S – 1M ROUNDS</span>
            <span>SETTLES IN USDC</span>
            <span>ARC TESTNET</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/leaderboard" className="hidden text-sm font-medium text-[#4A505C] hover:text-[#0A0C10] sm:block">Leaderboard</Link>
            <Link href="/trade" className="rounded-full bg-[#0A0C10] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2151F5] transition-colors">Launch app</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(#0A0C10_1px,transparent_1px)] [background-size:22px_22px] opacity-[0.09] [mask-image:radial-gradient(ellipse_at_center,#000_30%,transparent_75%)]"
        />
        <div className="relative mx-auto flex max-w-[1312px] flex-col px-5 pb-12 pt-14 sm:px-8 sm:pt-20">
          <BlurFade>
            <h1 className="font-[family-name:var(--font-instrument-serif)] text-[clamp(40px,6vw,76px)] font-normal leading-[1.02] tracking-[-0.01em]">
              Will <WordRotate words={HERO_ASSETS.map((a) => a.name)} index={i} /> be{' '}
              <WordRotate
                words={['higher', 'lower']}
                index={up}
                className={`italic ${up % 2 ? 'text-[#C2410C]' : 'text-[#2151F5]'}`}
              />{' '}
              in five seconds?
            </h1>
          </BlurFade>

          <BlurFade delay={0.12}>
            <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-0">
                <div className="font-[family-name:var(--font-jetbrains-mono)] text-[clamp(64px,15vw,228px)] font-semibold leading-none tracking-[-0.06em]">
                  <SlidingNumber value={whole} />
                  {frac && <span className="text-[#B7BDC7]">.<SlidingNumber value={frac} /></span>}
                </div>
                <div className="mt-4 flex items-center gap-3 font-[family-name:var(--font-jetbrains-mono)] text-[15px] text-[#3A404B]">
                  <span className={dir < 0 ? 'text-[#C2410C]' : 'text-[#2151F5]'}>{dir < 0 ? '▼' : '▲'} live</span>
                  <span>·</span>
                  <span>{hero.pair}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-2xl border border-[#E3E6EB] bg-white px-4 py-3">
                <CountdownRing />
                <div className="text-sm leading-tight">
                  <div className="font-semibold">Next round</div>
                  <div className="text-[#4A505C]">pays up to ×1.95</div>
                </div>
              </div>
            </div>
          </BlurFade>

          <BlurFade delay={0.24}>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              <Link href="/trade" className="group flex items-center justify-between rounded-[18px] bg-[#2151F5] px-7 py-6 text-white transition-transform hover:-translate-y-0.5">
                <span className="text-[clamp(22px,2.4vw,30px)] font-bold tracking-tight">Higher</span>
                <span className="font-[family-name:var(--font-jetbrains-mono)] text-lg">pays ×1.75 →</span>
              </Link>
              <Link href="/trade" className="group flex items-center justify-between rounded-[18px] border-2 border-[#0A0C10] px-7 py-6 transition-transform hover:-translate-y-0.5">
                <span className="text-[clamp(22px,2.4vw,30px)] font-bold tracking-tight">Lower</span>
                <span className="font-[family-name:var(--font-jetbrains-mono)] text-lg">pays ×1.75 →</span>
              </Link>
            </div>
          </BlurFade>
        </div>

        {/* Ticker */}
        <div className="border-y border-[#0A0C10]/10 bg-[#F4F5F7] py-4 font-[family-name:var(--font-jetbrains-mono)] text-sm">
          <Marquee seconds={45}>
            {TICKER.map((s) => {
              const v = prices[s];
              const d = v && prev[s] ? Math.sign(v - prev[s]) : 0;
              return (
                <span key={s} className="whitespace-nowrap">
                  <span className="text-[#6B7280]">{s}</span>{' '}
                  {v ? fmt(v) : '—'}{' '}
                  <span className={d < 0 ? 'text-[#C2410C]' : 'text-[#2151F5]'}>{d < 0 ? '▼' : '▲'}</span>
                </span>
              );
            })}
          </Marquee>
        </div>
      </section>

      {/* Bento */}
      <section className="bg-[#F4F5F7]">
        <div className="mx-auto max-w-[1312px] px-5 py-20 sm:px-8">
          <BlurFade>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <h2 className="max-w-[720px] text-[clamp(36px,5vw,64px)] font-bold leading-none tracking-[-0.045em]">
                The fastest bet in crypto, settled in dollars.
              </h2>
              <p className="max-w-[380px] text-lg leading-relaxed text-[#4A505C]">
                Binary rounds on crypto, forex, stocks and metals. USDC in, USDC out, on Arc.
              </p>
            </div>
          </BlurFade>

          <div className="mt-12 grid auto-rows-[minmax(200px,auto)] gap-4 md:grid-cols-4">
            <BlurFade className="flex flex-col justify-between rounded-[22px] bg-[#2151F5] p-6 text-white md:col-span-2">
              <span className="text-sm font-semibold opacity-85">Fastest expiry</span>
              <span className="font-[family-name:var(--font-jetbrains-mono)] text-[96px] font-semibold leading-none tracking-[-0.05em]">5s</span>
              <span className="text-[15px] opacity-85">Or 10s, 15s, 30s and 1m.</span>
            </BlurFade>
            <BlurFade delay={0.06} className="flex flex-col justify-between rounded-[22px] bg-[#0A0C10] p-6 text-white md:col-span-2">
              <span className="text-sm font-semibold text-[#B7BDC7]">Payout up to</span>
              <span className="font-[family-name:var(--font-jetbrains-mono)] text-[96px] font-semibold leading-none tracking-[-0.05em]">×1.95</span>
              <span className="text-[15px] text-[#B7BDC7]">Longer rounds pay more: ×1.75 at 5s, ×1.95 at 1m.</span>
            </BlurFade>
            {[
              ['No signature per bet', 'Deposit once. Every round after that is one click — no wallet pop-ups.'],
              ['USDC on Arc', 'Gas is USDC too. Withdraw back to your wallet on-chain whenever you like.'],
              ['Treasury contract', 'Funds sit in StrikeTreasury: pausable, two-step ownership, every payout an on-chain event.'],
              ['Signed withdrawals', 'Your wallet signs each withdrawal request; forged or stale signatures are refused.'],
            ].map(([t, d], k) => (
              <BlurFade key={t} delay={0.04 * k} className="flex flex-col gap-2 rounded-[22px] border border-[#E3E6EB] bg-white p-6">
                <span className="mb-auto pb-8 font-[family-name:var(--font-jetbrains-mono)] text-xs text-[#6B7280]">0{k + 1}</span>
                <span className="text-[22px] font-bold tracking-tight">{t}</span>
                <span className="text-[15px] leading-relaxed text-[#4A505C]">{d}</span>
              </BlurFade>
            ))}
          </div>

          <BlurFade>
            <div className="mt-16 flex flex-wrap items-center justify-between gap-6 rounded-[22px] bg-white p-8 ring-1 ring-[#E3E6EB]">
              <div>
                <div className="text-2xl font-bold tracking-tight">Ready to call it?</div>
                <div className="mt-1 text-[#4A505C]">Free test USDC from faucet.circle.com, then trade on Arc Testnet.</div>
              </div>
              <Link href="/trade" className="rounded-full bg-[#0A0C10] px-6 py-3.5 font-semibold text-white hover:bg-[#2151F5] transition-colors">Launch app</Link>
            </div>
          </BlurFade>
        </div>
      </section>

      <footer className="border-t border-[#0A0C10]/10 bg-white">
        <div className="mx-auto flex max-w-[1312px] flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-[#4A505C] sm:px-8">
          <span>© Strike · Prices from Yahoo Finance and Binance · Not financial advice</span>
          <div className="flex gap-6">
            <a href={explorerAddressUrl(getArcConfig().treasuryAddress)} target="_blank" rel="noopener noreferrer" className="hover:text-[#0A0C10]">Treasury contract</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
