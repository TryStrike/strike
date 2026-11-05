'use client';

import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight } from '@phosphor-icons/react';
import { BlurFade, Marquee } from './primitives';

type Treasury = {
  address: string;
  explorer: string;
  balance: number;
  events: { type: 'deposit' | 'payout'; amount: number; counterparty: string; txHash: string; block: number }[];
};
type Win = { id: string; trader: string; asset: string; payout: number };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Polls a JSON endpoint; keeps the last good value on failure. */
function usePoll<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (res.ok && live) setData(await res.json());
      } catch {
        // keep the last good value
      }
    };
    load();
    const id = setInterval(load, ms);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return data;
}

/** "Built on Arc" proof: live treasury balance, recent on-chain flows and recent wins. */
export function ArcProof() {
  const treasury = usePoll<Treasury>('/api/arc/treasury', 15_000);
  const wins = usePoll<{ wins: Win[] }>('/api/bets/recent', 10_000)?.wins ?? [];

  return (
    <section className="border-t border-[#0A0C10]/[0.06]">
      <div className="mx-auto max-w-[1040px] px-5 py-28 sm:px-8">
        <BlurFade className="text-center">
          <div className="font-jet text-xs uppercase tracking-[0.18em] text-[#9AA1AD]">On Arc</div>
          <h2 className="mt-4 font-serif text-[clamp(40px,5vw,60px)] font-normal leading-[1] tracking-[-0.02em]">
            Every dollar, <span className="italic text-[#2151F5]">on-chain.</span>
          </h2>
        </BlurFade>

        <div className="mt-16 grid gap-4 md:grid-cols-[1fr_1.4fr]">
          <BlurFade className="flex flex-col justify-between rounded-3xl p-7 ring-1 ring-[#0A0C10]/[0.08]">
            <div className="text-sm text-[#6B7280]">Treasury balance · live</div>
            <div className="my-8 font-jet text-[44px] font-medium leading-none tracking-[-0.04em]">
              {treasury ? treasury.balance.toFixed(2) : '—'}
              <span className="ml-2 text-base text-[#9AA1AD]">USDC</span>
            </div>
            {treasury && (
              <a
                href={`${treasury.explorer}/address/${treasury.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-jet text-xs text-[#6B7280] hover:text-[#0A0C10]"
              >
                StrikeTreasury {short(treasury.address)} <ArrowUpRight size={12} />
              </a>
            )}
          </BlurFade>

          <BlurFade delay={0.06} className="rounded-3xl p-7 ring-1 ring-[#0A0C10]/[0.08]">
            <div className="text-sm text-[#6B7280]">Latest on-chain flows</div>
            {treasury && treasury.events.length > 0 ? (
              <ul className="mt-4 divide-y divide-[#0A0C10]/[0.06]">
                {treasury.events.map((e) => (
                  <li key={e.txHash + e.type}>
                    <a
                      href={`${treasury.explorer}/tx/${e.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between py-3 text-sm hover:text-[#2151F5]"
                    >
                      <span className="flex items-center gap-3">
                        <span className={`grid h-7 w-7 place-items-center rounded-full ${e.type === 'deposit' ? 'bg-[#EEF2FF] text-[#2151F5]' : 'bg-[#F6F7F9] text-[#0A0C10]'}`}>
                          {e.type === 'deposit' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                        </span>
                        <span>{e.type === 'deposit' ? 'Deposit' : 'Payout'}</span>
                        <span className="hidden font-jet text-xs text-[#9AA1AD] sm:inline">{short(e.counterparty)}</span>
                      </span>
                      <span className="font-jet">{e.amount.toFixed(2)} USDC</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-[#9AA1AD]">{treasury ? 'No flows in the last hour.' : 'Reading Arc…'}</p>
            )}
          </BlurFade>
        </div>

        {wins.length > 0 && (
          <div className="mt-6 rounded-full py-3 font-jet text-[13px] ring-1 ring-[#0A0C10]/[0.08]">
            <Marquee seconds={35}>
              {wins.map((w) => (
                <span key={w.id} className="whitespace-nowrap text-[#4A505C]">
                  {w.trader} won <span className="text-[#2151F5]">+{w.payout.toFixed(2)}</span> on {w.asset}
                </span>
              ))}
            </Marquee>
          </div>
        )}
      </div>
    </section>
  );
}
