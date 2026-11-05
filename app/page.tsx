'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BlurFade, CountdownRing, Marquee, SlidingNumber, WordRotate } from '@/components/landing/primitives';
import { explorerAddressUrl, getArcConfig } from '@/lib/arc/config';
import { BRAND } from '@/lib/brand';
import { SiteNav } from '@/components/SiteNav';
import { ArrowDown, ArrowUp, ArrowUpRight } from '@phosphor-icons/react';

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
  useEffect(() => {
    const id = setInterval(() => setI((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const hero = HERO_ASSETS[i % HERO_ASSETS.length];
  const price = prices[hero.symbol];
  const [whole, frac] = price ? fmt(price).split('.') : ['—', ''];
  const dir = price && prev[hero.symbol] ? Math.sign(price - prev[hero.symbol]) : 0;

  return (
    <div className="min-h-full shrink-0 bg-white text-[#0A0C10] font-[family-name:var(--font-inter-tight)] selection:bg-[#2151F5] selection:text-white">
      <SiteNav
        sticky
        right={
          <Link href="/trade" className="rounded-full bg-[#0A0C10] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2151F5]">
            Launch app
          </Link>
        }
      />

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
              <Link href="/trade" className="inline-flex h-12 items-center rounded-full bg-[#0A0C10] px-6 font-semibold text-white transition-colors hover:bg-[#2151F5]">
                Start trading
              </Link>
              <a href="#how" className="inline-flex h-12 items-center rounded-full bg-white px-6 font-semibold ring-1 ring-[#E3E6EB] transition-colors hover:ring-[#0A0C10]">
                How it works
              </a>
            </div>
          </BlurFade>

          {/* Live round card */}
          <BlurFade delay={0.34} className="mt-16 w-full max-w-[600px]">
            <div className="rounded-[28px] bg-white p-6 text-left ring-1 ring-[#E3E6EB] shadow-[0_40px_80px_-40px_rgba(10,12,16,0.28)] sm:p-8">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[15px] font-semibold">
                    <WordRotate words={HERO_ASSETS.map((a) => a.name)} index={i} />
                  </div>
                  <div className="mt-0.5 font-[family-name:var(--font-jetbrains-mono)] text-xs text-[#6B7280]">{hero.pair} · live</div>
                </div>
                <CountdownRing size={56} />
              </div>

              <div className="mt-6 font-[family-name:var(--font-jetbrains-mono)] text-[clamp(44px,9vw,76px)] font-semibold leading-none tracking-[-0.05em]">
                <SlidingNumber value={whole} />
                {frac && <span className="text-[#B7BDC7]">.<SlidingNumber value={frac} /></span>}
              </div>
              <div className={`mt-3 font-[family-name:var(--font-jetbrains-mono)] text-sm ${dir < 0 ? 'text-[#C2410C]' : 'text-[#2151F5]'}`}>
                <span className="inline-flex items-center gap-1.5">{dir < 0 ? <ArrowDown size={14} weight="bold" /> : <ArrowUp size={14} weight="bold" />} moving {dir < 0 ? 'down' : 'up'}</span>
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
                  <span className="text-[#9AA1AD]">{s}</span> {v ? fmt(v) : '—'}{' '}
                  <span className={`inline-block align-[-2px] ${d < 0 ? 'text-[#C2410C]' : 'text-[#2151F5]'}`}>{d < 0 ? <ArrowDown size={13} weight="bold" /> : <ArrowUp size={13} weight="bold" />}</span>
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
            <div className="font-[family-name:var(--font-jetbrains-mono)] text-xs uppercase tracking-[0.18em] text-[#9AA1AD]">How it works</div>
            <h2 className="mt-4 font-[family-name:var(--font-instrument-serif)] text-[clamp(40px,5vw,60px)] font-normal leading-[1] tracking-[-0.02em]">
              Three taps. <span className="italic text-[#9AA1AD]">That&apos;s it.</span>
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
                  <div className="font-[family-name:var(--font-jetbrains-mono)] text-xs text-[#9AA1AD]">USDC · paid on-chain</div>
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

      {/* Closing */}
      <section className="border-t border-[#0A0C10]/[0.06]">
        <BlurFade className="mx-auto flex max-w-[720px] flex-col items-center px-5 py-28 text-center sm:px-8">
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-[clamp(44px,6vw,72px)] font-normal leading-[1] tracking-[-0.02em]">
            Make the <span className="italic text-[#2151F5]">call.</span>
          </h2>
          <p className="mt-5 text-[17px] text-[#6B7280]">Free test USDC at faucet.circle.com.</p>
          <Link href="/trade" className="mt-8 inline-flex h-12 items-center rounded-full bg-[#0A0C10] px-6 font-semibold text-white transition-colors hover:bg-[#2151F5]">
            Start trading
          </Link>
        </BlurFade>
      </section>

      <footer className="border-t border-[#0A0C10]/[0.06]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-6 text-[13px] text-[#6B7280] sm:px-8">
          <span>© {BRAND.name} · Prices via Yahoo Finance &amp; Binance · Not financial advice</span>
          <div className="flex gap-6">
            <a href={explorerAddressUrl(getArcConfig().treasuryAddress)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-[#0A0C10]">Treasury contract <ArrowUpRight size={13} /></a>
            {BRAND.social.x && <a href={BRAND.social.x} target="_blank" rel="noopener noreferrer" className="hover:text-[#0A0C10]">X</a>}
            {BRAND.social.telegram && <a href={BRAND.social.telegram} target="_blank" rel="noopener noreferrer" className="hover:text-[#0A0C10]">Telegram</a>}
          </div>
        </div>
      </footer>
    </div>
  );
}
