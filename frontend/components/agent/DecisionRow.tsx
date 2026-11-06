'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { CaretDown, CaretRight, CheckCircle, HandPalm } from '@phosphor-icons/react';
import { Badge, Button, cx } from '@/components/ui/kit';
import { WAITING_FOR_HUMAN, type AgentSession, type Decision } from '@/lib/agent/agentFeed';

const SettlementProof = dynamic(() => import('@/components/game/SettlementProof'), { ssr: false });

const VERDICT: Record<Decision['verdict'], { label: string; tone: 'up' | 'down' | 'neutral' }> = {
  placed: { label: 'placed', tone: 'up' },
  awaiting: { label: 'needs you', tone: 'neutral' },
  skipped: { label: 'skipped', tone: 'neutral' },
  blocked: { label: 'blocked', tone: 'down' },
  rejected: { label: 'rejected', tone: 'down' },
};

const RESULT: Record<string, string> = {
  win: 'won',
  loss: 'lost',
  tie: 'tie, stake back',
  refund_no_price: 'refunded, no price',
  withheld: 'withheld',
};

function stepsOf(d: Decision) {
  const steps: { name: string; text: string; bad?: boolean }[] = [];
  const { trace } = d;
  if (trace) {
    steps.push({ name: 'Signal', text: trace.signal });
    if (trace.jevNeeded !== null && d.confidence !== null) {
      const [score, needed] = [Math.round(d.confidence * 100), Math.round(trace.jevNeeded * 100)];
      steps.push({ name: 'jev', text: `confidence ${score}, needed ${needed}`, bad: score < needed });
    }
    if (d.verdict !== 'blocked' && d.stake !== null) {
      steps.push({
        name: 'Limits',
        text: `stake ${d.stake.toFixed(2)}, budget left ${trace.budgetLeft.toFixed(2)}, stop-loss room ${trace.stopLossRoom.toFixed(2)}`,
      });
    }
  }
  const placed = d.verdict === 'placed';
  steps.push({ name: 'Verdict', text: placed ? `placed ${d.direction}` : d.reason, bad: d.verdict === 'blocked' || d.verdict === 'rejected' });
  if (d.result) {
    const pnl = d.pnl === null ? '' : ` ${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`;
    steps.push({ name: 'Result', text: `${RESULT[d.result] ?? d.result}${pnl}`, bad: d.result === 'loss' });
  }
  return steps;
}

export function DecisionRow({
  d,
  session,
  newest,
  later,
  canWhy,
  onWhy,
  onAnswer,
}: {
  d: Decision;
  session: AgentSession;
  newest: boolean;
  /** A later decision exists, so whatever this one waited for is over. */
  later: boolean;
  canWhy: boolean;
  onWhy: (d: Decision) => void;
  /** Only `/agent` can answer. Everywhere else links there. */
  onAnswer?: (id: string, action: 'approve' | 'reject') => void;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? newest;

  if (d.verdict === 'skipped' && !d.trace) {
    return (
      <p className="flex justify-between gap-2 px-1 text-xs text-faint">
        {d.reason}
        {d.skipCount > 1 && <span className="font-jet">×{d.skipCount}</span>}
      </p>
    );
  }
  if (d.reason === WAITING_FOR_HUMAN) {
    if (later) {
      return (
        <p className="flex items-center gap-1.5 px-1 text-xs text-subtle">
          <CheckCircle size={13} weight="fill" className="text-up" /> Confirmed
        </p>
      );
    }
    return (
      <p className="flex items-center gap-2 rounded-2xl bg-down-soft px-3 py-2 text-xs text-down">
        <HandPalm size={14} weight="fill" />
        {session.status === 'running' ? 'Waiting for you.' : 'The human check was not answered.'}
        {!onAnswer && session.status === 'running' && (
          <Link href="/agent" className="font-semibold underline">
            Open /agent
          </Link>
        )}
      </p>
    );
  }

  const v = VERDICT[d.verdict];
  return (
    <div className="rounded-2xl px-3 py-2 ring-1 ring-ink/[0.06]">
      <button type="button" aria-expanded={open} onClick={() => setToggled(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-1 font-jet text-sm font-semibold">
          {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
          {d.direction ? `${d.direction === 'UP' ? '↑' : '↓'} ` : ''}
          {session.asset}
          {d.stake !== null && ` · ${d.stake.toFixed(2)}`}
        </span>
        <span className="flex items-center gap-1.5">
          {d.skipCount > 1 && <Badge>{`×${d.skipCount}`}</Badge>}
          <Badge tone={v.tone}>{v.label}</Badge>
          {d.pnl !== null && <Badge tone={d.pnl >= 0 ? 'up' : 'down'}>{`${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`}</Badge>}
        </span>
      </button>
      {open && (
        <>
          <ol className="mt-2 space-y-1.5">
            {stepsOf(d).map((s) => (
              <li key={s.name} className="flex gap-2 text-xs">
                <span className={cx('mt-1 size-1.5 shrink-0 rounded-full', s.bad ? 'bg-down' : 'bg-up')} />
                <span className="w-12 shrink-0 font-jet text-faint">{s.name}</span>
                <span className="text-muted">{s.text}</span>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex items-center gap-3">
            {canWhy && (
              <button type="button" onClick={() => onWhy(d)} className="text-xs font-semibold text-up">
                Why?
              </button>
            )}
            {d.betId && (
              <SettlementProof
                variant="chip"
                wallet={session.wallet}
                bet={{ betId: d.betId, asset: session.asset, mode: 'binomo', direction: d.direction, stake: d.stake }}
              />
            )}
          </div>
        </>
      )}
      {d.verdict === 'awaiting' &&
        (onAnswer ? (
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => onAnswer(d.id, 'approve')}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAnswer(d.id, 'reject')}>
              Reject
            </Button>
          </div>
        ) : (
          <Link href="/agent" className="mt-2 block text-xs font-semibold text-down underline">
            Waiting for you. Open /agent
          </Link>
        ))}
    </div>
  );
}
