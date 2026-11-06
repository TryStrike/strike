'use client';

import Link from 'next/link';
import { ArrowRight, ArrowsLeftRight, ChartLineUp, Fingerprint, Robot } from '@phosphor-icons/react';
import { BlurFade } from '@/components/landing/primitives';

const STEPS = [
  { n: '1', title: 'Your bet, saved publicly', text: 'Your browser signs it onto Arkiv before the round ends. Nobody can change it after.' },
  { n: '2', title: 'Settled at the live price', text: 'The price at the end decides it. A win lands in your balance in seconds.' },
  { n: '3', title: 'A fingerprint on Arc', text: 'Every 10 minutes all rounds roll into one fingerprint, kept on Arc for good.' },
  { n: '4', title: 'The proof file on Swarm', text: 'Every round and its proof in one file. Arkiv links to it.' },
  { n: '5', title: 'Anyone can check', text: 'Read Arkiv, open the file, ask Arc. No Strike server needed.' },
];

/** The proof staircase, as a ladder of steps that climbs to the right. */
export function ProofLadder() {
  return (
    <section className="border-t border-ink/[0.06] bg-surface/60">
      <div className="mx-auto grid max-w-[1040px] gap-14 px-5 py-28 sm:px-8 lg:grid-cols-[1fr_1.25fr] lg:items-center">
        <BlurFade>
          <div className="font-jet text-xs uppercase tracking-[0.18em] text-subtle">Provably fair</div>
          <h2 className="mt-4 font-serif text-[clamp(40px,5vw,60px)] font-normal leading-[1] tracking-[-0.02em]">
            Every round, <span className="italic text-up">checkable.</span>
          </h2>
          <p className="mt-5 max-w-[420px] text-[17px] leading-relaxed text-subtle">
            Fast games usually ask you to trust the house. Strike leaves a public trail for every round, so you
            never have to.
          </p>
          <Link
            href="/arkiv"
            className="mt-8 inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[15px] font-semibold ring-1 ring-line"
          >
            See how it works <ArrowRight size={16} weight="bold" aria-hidden="true" />
          </Link>
        </BlurFade>

        <ol className="space-y-3">
          {STEPS.map((s, i) => (
            <BlurFade key={s.n} delay={i * 0.06}>
              <li
                className="flex gap-4 rounded-2xl bg-white p-4 ring-1 ring-ink/[0.08]"
                style={{ marginLeft: `${i * 6}%` }}
              >
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full font-jet text-sm font-semibold ${
                    i === STEPS.length - 1 ? 'bg-up text-white' : 'bg-surface text-ink'
                  }`}
                >
                  {s.n}
                </span>
                <div>
                  <div className="text-[16px] font-semibold tracking-tight">{s.title}</div>
                  <div className="mt-0.5 text-[14px] leading-relaxed text-subtle">{s.text}</div>
                </div>
              </li>
            </BlurFade>
          ))}
        </ol>
      </div>
    </section>
  );
}

const Chip = ({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'up' }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-jet text-[12px] ${
      tone === 'up' ? 'bg-up text-white' : 'bg-white text-ink ring-1 ring-ink/[0.08]'
    }`}
  >
    {children}
  </span>
);

const FEATURES = [
  {
    icon: Robot,
    title: 'An agent that asks first',
    text: 'Set a budget and a stop-loss, and the AI agent trades for you. Before anything risky, it waits for your approval in World App.',
    visual: (
      <div className="flex flex-col items-center gap-2">
        <Chip>budget 20 USDC · stop 10</Chip>
        <Chip tone="up">approve in World App?</Chip>
      </div>
    ),
  },
  {
    icon: Fingerprint,
    title: 'One human, every wallet',
    text: 'World ID checks once, on your first real move. Limits follow the person, so a new wallet resets nothing.',
    visual: (
      <div className="flex flex-wrap justify-center gap-2">
        <Chip>wallet 1</Chip>
        <Chip>wallet 2</Chip>
        <Chip tone="up">1 verified human</Chip>
      </div>
    ),
  },
  {
    icon: ChartLineUp,
    title: 'Real stocks, test shares',
    text: 'Buy and sell test shares of NVDA, AAPL, TSLA and more at the live price, in USDC or EURC, settled on Arc.',
    visual: (
      <div className="flex flex-wrap justify-center gap-2">
        <Chip>NVDA</Chip>
        <Chip>AAPL</Chip>
        <Chip>TSLA</Chip>
        <Chip tone="up">buy $1 in EURC</Chip>
      </div>
    ),
  },
  {
    icon: ArrowsLeftRight,
    title: 'Money from any chain',
    text: 'Bring USDC from Base, Arbitrum or Ethereum in seconds with Circle Gateway and CCTP, and send it back the same way.',
    visual: (
      <div className="flex items-center gap-2">
        <Chip>Base</Chip>
        <ArrowRight size={14} weight="bold" className="text-subtle" aria-hidden="true" />
        <Chip tone="up">Arc</Chip>
        <ArrowRight size={14} weight="bold" className="text-subtle" aria-hidden="true" />
        <Chip>Arbitrum</Chip>
      </div>
    ),
  },
];

export function Features() {
  return (
    <section className="border-t border-ink/[0.06]">
      <div className="mx-auto max-w-[1040px] px-5 py-28 sm:px-8">
        <BlurFade className="text-center">
          <div className="font-jet text-xs uppercase tracking-[0.18em] text-subtle">Beyond the round</div>
          <h2 className="mt-4 font-serif text-[clamp(40px,5vw,60px)] font-normal leading-[1] tracking-[-0.02em]">
            More than a <span className="italic text-subtle">coin flip.</span>
          </h2>
        </BlurFade>

        <div className="mt-16 grid gap-4 md:grid-cols-2">
          {FEATURES.map((f, i) => (
            <BlurFade key={f.title} delay={i * 0.06} className="rounded-3xl p-2 ring-1 ring-ink/[0.08]">
              <div className="grid h-36 place-items-center rounded-[18px] bg-surface px-4">{f.visual}</div>
              <div className="px-4 pb-4 pt-5">
                <div className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
                  <f.icon size={18} weight="bold" className="text-up" aria-hidden="true" />
                  {f.title}
                </div>
                <div className="mt-1 text-[15px] leading-relaxed text-subtle">{f.text}</div>
              </div>
            </BlurFade>
          ))}
        </div>
      </div>
    </section>
  );
}
