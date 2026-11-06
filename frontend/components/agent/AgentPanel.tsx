'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useAccount } from 'wagmi';
import { Lightning, Play, Stop } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { Badge, Button, Field, Label, Segmented, cx } from '@/components/ui/kit';
import {
  useAgent,
  useWorldAttempt,
  type AgentSession,
  type Decision,
  type StartLimits,
  type WorldAttempt,
} from '@/lib/agent/useAgent';

const SettlementProof = dynamic(() => import('@/components/game/SettlementProof'), { ssr: false });
const WorldCheck = dynamic(() => import('@/components/agent/WorldCheck'), { ssr: false });

const MINUTES = [
  { value: 5, label: '5m' },
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
];

type Limits = Omit<StartLimits, 'asset'>;

/** `agent::WAITING_FOR_HUMAN` in the Rust core. */
const WAITING_FOR_HUMAN = 'Waiting for a human';

export function AgentPanel() {
  const asset = useStore((s) => s.selectedAsset);
  const { address } = useAccount();
  const { session, decisions, error, busy, start, stop, answer, checkpoint, challenge, settle } = useAgent();
  const [world, setWorld] = useWorldAttempt();
  const [limits, setLimits] = useState<Limits>({ mode: 'normal', budget: 20, maxPerTrade: 2, stopLoss: 5, minutes: 15 });
  const running = session?.status === 'running';
  const newest = decisions.reduce<Decision | undefined>((a, d) => (!a || d.createdAt > a.createdAt ? d : a), undefined);
  const waiting = running && newest?.verdict === 'blocked' && newest.reason === WAITING_FOR_HUMAN;
  const shown: Limits = running
    ? {
        mode: session.mode,
        budget: session.budget,
        maxPerTrade: session.maxPerTrade,
        stopLoss: session.stopLoss,
        minutes: Math.round((session.endsAt - session.startsAt) / 60_000),
      }
    : limits;
  const set = <K extends keyof Limits>(k: K, v: Limits[K]) => setLimits((l) => ({ ...l, [k]: v }));
  const num = (k: 'budget' | 'maxPerTrade' | 'stopLoss') => ({
    value: String(shown[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Math.max(0, Number(e.target.value) || 0)),
    inputMode: 'decimal' as const,
    disabled: running,
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent</h1>
        <Badge tone={running ? 'up' : 'neutral'}>{running ? `running on ${session.asset}` : 'idle'}</Badge>
      </header>

      <section className="grid grid-cols-3 gap-2">
        <div>
          <Label>Budget</Label>
          <Field unit="USDC" {...num('budget')} />
        </div>
        <div>
          <Label>Per trade</Label>
          <Field unit="max" {...num('maxPerTrade')} />
        </div>
        <div>
          <Label>Stop-loss</Label>
          <Field unit="USDC" {...num('stopLoss')} />
        </div>
      </section>

      <section className="flex items-end gap-3">
        <div className="flex-1">
          <Label>Session</Label>
          <Segmented options={MINUTES} value={shown.minutes} onChange={(v) => set('minutes', v)} disabled={running} />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={shown.mode === 'yolo'}
          disabled={running}
          onClick={() => set('mode', limits.mode === 'yolo' ? 'normal' : 'yolo')}
          className={cx(
            'flex h-[44px] items-center gap-2 rounded-full px-4 text-sm font-semibold disabled:opacity-40',
            shown.mode === 'yolo' ? 'bg-down text-white' : 'bg-surface text-muted'
          )}
        >
          <Lightning size={16} weight="fill" />
          YOLO {shown.mode === 'yolo' ? 'on' : 'off'}
        </button>
      </section>
      <p className="-mt-3 text-xs text-faint">
        {shown.mode === 'yolo'
          ? `The agent trades ${running ? session.asset : asset} on its own at up to your per trade cap. YOLO needs a fresh World ID check. One human, one YOLO agent. Budgets over 10 USDC need Orb, over 50 need Orb + face. At half the stop-loss it pauses until you check again.`
          : `You approve every trade on ${running ? session.asset : asset}. 1 USDC each, and a proposal you don't answer in 5 seconds is skipped.`}
      </p>

      {waiting && (
        <div className="flex flex-col gap-2">
          <p role="status" className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
            The agent lost half its stop-loss and paused. Confirm you are still here within 2 minutes or it stops.
          </p>
          <Button
            size="lg"
            onClick={() => {
              setWorld(null);
              checkpoint();
            }}
            disabled={busy}
          >
            <Play size={18} weight="fill" /> Continue with World ID
          </Button>
        </div>
      )}

      {running ? (
        <Button variant="secondary" size="lg" onClick={stop} disabled={busy}>
          <Stop size={18} weight="fill" /> Stop agent
        </Button>
      ) : (
        <Button
          size="lg"
          onClick={() => {
            setWorld(null);
            start({ ...limits, asset });
          }}
          disabled={busy || !address || limits.budget <= 0 || limits.maxPerTrade <= 0 || limits.stopLoss <= 0}
        >
          <Play size={18} weight="fill" />{' '}
          {!address ? 'Connect a wallet to start' : limits.mode === 'yolo' ? 'Sign and verify with World ID' : 'Sign and start'}
        </Button>
      )}

      {challenge && (
        <WorldCheck
          key={challenge.attempt}
          challenge={challenge}
          onDone={(a) => {
            settle(a);
            setWorld(a);
          }}
        />
      )}

      {world && <HumanCheck attempt={world} />}

      {error && (
        <p role="alert" className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
          {error}
        </p>
      )}

      {session && <SessionStats session={session} />}

      {session?.status === 'stopped' && session.stoppedReason && (
        <p role="status" className="rounded-2xl bg-surface px-4 py-3 text-sm text-muted">
          Stopped: {session.stoppedReason}
        </p>
      )}

      <section>
        <Label>Decisions</Label>
        {decisions.length === 0 ? (
          <p className="py-8 text-center text-sm text-faint">Start the agent to see every decision and why.</p>
        ) : (
          <ol className="space-y-2">
            {decisions.map((d) => (
              <DecisionRow key={d.id} d={d} session={session} onAnswer={answer} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function SessionStats({ session }: { session: AgentSession }) {
  const [now, setNow] = useState(() => Date.now());
  const running = session.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const left = running ? Math.max(0, session.endsAt - now) : 0;
  const pnl = session.realizedPnl;
  return (
    <section className="grid grid-cols-3 gap-2 rounded-3xl bg-surface px-4 py-3 text-center">
      <Stat label="Spent" value={`${session.spent.toFixed(2)}/${session.budget}`} />
      <Stat label="PnL" value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`} tone={pnl > 0 ? 'up' : pnl < 0 ? 'down' : undefined} />
      <Stat
        label="Time left"
        value={`${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`}
      />
    </section>
  );
}

const ACR: Record<string, string> = { orb: 'Orb', selfie: 'Selfie', 'orb-face': 'Orb + face' };

const HUMAN_CHECK: Record<WorldAttempt['status'], { label: string; tone: 'up' | 'down' | 'neutral'; copy: (a: WorldAttempt) => string }> = {
  approved: {
    label: 'human verified',
    tone: 'up',
    copy: (a) => {
      const acr = a.acr?.split('/').pop() ?? '';
      return `Human verified, ${ACR[acr] ?? acr}`;
    },
  },
  denied: { label: 'denied', tone: 'down', copy: (a) => `${a.reason}. No agent started, nothing spent.` },
  expired: { label: 'expired', tone: 'neutral', copy: () => 'Human check expired. Nothing started.' },
  mismatch: { label: 'mismatch', tone: 'down', copy: () => 'A different human approved this. This wallet belongs to someone else.' },
  failed: { label: 'failed', tone: 'down', copy: (a) => a.reason },
  pending: { label: 'pending', tone: 'neutral', copy: () => 'Waiting for World App. Finish there or sign again.' },
  unknown: { label: 'used', tone: 'neutral', copy: (a) => a.reason },
};

const RESUME_CHECK: Partial<Record<WorldAttempt['status'], string>> = {
  approved: 'Human verified, the agent resumed.',
  denied: 'Human check denied. The agent stopped.',
  mismatch: 'A different human answered. The agent stopped.',
  expired: 'Human check expired.',
};

function HumanCheck({ attempt }: { attempt: WorldAttempt }) {
  const c = HUMAN_CHECK[attempt.status];
  const resume = attempt.kind === 'checkpoint' ? RESUME_CHECK[attempt.status] : undefined;
  return (
    <p role="status" className="-mt-3 flex items-start gap-2 text-sm text-muted">
      <Badge tone={c.tone}>{c.label}</Badge>
      <span>{resume ?? c.copy(attempt)}</span>
    </p>
  );
}

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

function DecisionRow({
  d,
  session,
  onAnswer,
}: {
  d: Decision;
  session: AgentSession | null;
  onAnswer: (id: string, action: 'approve' | 'reject') => void;
}) {
  const v = VERDICT[d.verdict];
  return (
    <li className="rounded-2xl px-4 py-3 ring-1 ring-ink/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-jet text-sm font-semibold">
          {d.direction ? `${d.direction === 'UP' ? '↑' : '↓'} ` : ''}
          {session?.asset}
          {d.stake !== null && ` · ${d.stake.toFixed(2)}`}
        </span>
        <span className="flex items-center gap-1.5">
          {d.skipCount > 1 && <Badge>{`×${d.skipCount}`}</Badge>}
          <Badge tone={v.tone}>{v.label}</Badge>
          {d.pnl !== null && <Badge tone={d.pnl >= 0 ? 'up' : 'down'}>{`${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`}</Badge>}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{d.reason}</p>
      <p className="mt-1 font-jet text-xs text-faint">
        {d.confidence !== null && `jev confidence ${(d.confidence * 100).toFixed(0)}% · `}
        {d.result && `${RESULT[d.result] ?? d.result} · `}
        {new Date(d.createdAt).toLocaleTimeString()}
      </p>
      {d.verdict === 'awaiting' && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => onAnswer(d.id, 'approve')}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAnswer(d.id, 'reject')}>
            Reject
          </Button>
        </div>
      )}
      {d.betId && (
        <div className="mt-2">
          <SettlementProof
            variant="chip"
            wallet={session?.wallet}
            bet={{ betId: d.betId, asset: session?.asset, mode: 'binomo', direction: d.direction, stake: d.stake }}
          />
        </div>
      )}
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <p className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className={cx('font-jet text-sm font-semibold tabular-nums', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>{value}</p>
    </div>
  );
}
