'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowSquareOut, CheckCircle, Circle, CircleNotch, Clock, MinusCircle, ShieldCheck, XCircle } from '@phosphor-icons/react';
import { verifyBet, type Report, type StepStatus } from '@/lib/verify/verifyRound';

const ICON: Record<StepStatus, React.ReactNode> = {
  pending: <CircleNotch size={18} className="animate-spin text-faint" />,
  pass: <CheckCircle size={18} weight="fill" className="text-up" />,
  fail: <XCircle size={18} weight="fill" className="text-down" />,
  skip: <MinusCircle size={18} className="text-faint" />,
  wait: <Clock size={18} className="text-muted" />,
};

function Verify() {
  const params = useSearchParams();
  const [input, setInput] = useState(params.get('bet') ?? '');
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);

  const check = (id: string) => {
    const mine = ++run.current;
    const betId = id.trim();
    if (!betId) return;
    window.history.replaceState(null, '', `/verify?bet=${encodeURIComponent(betId)}`);
    setBusy(true);
    void verifyBet(betId, (r) => {
      if (run.current === mine) setReport(r);
    }).finally(() => {
      if (run.current === mine) setBusy(false);
    });
  };

  useEffect(() => {
    const id = params.get('bet');
    if (id) queueMicrotask(() => check(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const r = report?.round;
  const tone = report?.verdict.kind === 'ok' ? 'bg-up/[0.08] text-up' : report?.verdict.kind === 'fail' ? 'bg-down-soft text-down' : 'bg-surface text-ink';
  const canRetry = report?.verdict.kind === 'retry' && !busy;

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <main className="mx-auto max-w-[1200px] px-5 pb-16 pt-8 sm:px-8">
        <header className="mb-8">
          <div className="mb-2 flex items-center gap-2 font-jet text-[11px] uppercase tracking-[0.14em] text-faint">
            <ShieldCheck size={14} />
            Check a round
          </div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
            Check any round yourself
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            Paste a bet id. Your browser reads Arkiv, Swarm and Arc directly and rebuilds the proof. No Strike server is
            asked.
          </p>
          <form
            className="mt-5 flex max-w-xl flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              check(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="bet_1793957410432_4d7014a2300f"
              aria-label="Bet id"
              spellCheck={false}
              className="h-11 min-w-0 flex-1 rounded-full bg-surface px-4 font-jet text-sm text-ink outline-none ring-1 ring-ink/[0.08] focus:ring-ink/25"
            />
            <button
              type="submit"
              className="inline-flex h-11 items-center rounded-full bg-up px-5 text-sm font-semibold text-white transition-all hover:brightness-110 active:scale-[0.98]"
            >
              Check
            </button>
          </form>
        </header>

        {report && (
          <div className="space-y-6">
            <div role="status" className={`rounded-2xl px-5 py-4 text-[15px] font-semibold ${tone}`}>
              {report.verdict.text}
              {canRetry && (
                <button
                  type="button"
                  onClick={() => check(input)}
                  className="ml-3 inline-flex h-8 items-center rounded-full bg-ink px-4 text-xs font-semibold text-white"
                >
                  Retry
                </button>
              )}
            </div>

            {r && (
              <section className="rounded-2xl bg-surface px-5 py-5">
                <h2 className="text-lg font-semibold tracking-tight">The round</h2>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  {[
                    ['Asset', r.asset],
                    ['Direction', r.direction],
                    ['Stake', `${r.stake} ${r.currency ?? ''}`],
                    ['Outcome', r.outcome],
                    ['Strike price', r.strike],
                    ['End price', r.endPrice],
                    ['Payout', `${r.payout} ${r.currency ?? ''}`],
                    ['Settled', new Date(r.settledAt).toLocaleString()],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">{k}</dt>
                      <dd className="mt-0.5 font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <ol className="divide-y divide-line rounded-2xl ring-1 ring-line">
              {report.steps.map((s) => (
                <li key={s.id} className="flex gap-3 px-5 py-4">
                  <span className="mt-0.5 shrink-0">{ICON[s.status] ?? <Circle size={18} />}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{s.title}</div>
                    {s.detail && <p className="mt-0.5 break-words text-sm text-muted">{s.detail}</p>}
                    {s.links && (
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        {s.links.map((l) => (
                          <a
                            key={l.href}
                            href={l.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink underline-offset-4 hover:underline"
                          >
                            {l.label}
                            <ArrowSquareOut size={14} className="text-faint" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </main>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="min-h-full bg-white" />}>
      <Verify />
    </Suspense>
  );
}
