'use client';

import { useEffect, useRef, useState } from 'react';
import { Brain, CheckCircle, PaperPlaneRight, Stop, StopCircle, WarningCircle } from '@phosphor-icons/react';
import { Button, Field, cx } from '@/components/ui/kit';
import { DecisionRow } from '@/components/agent/DecisionRow';
import { WHY_REACH, useAgentFeed, type AgentSession, type Decision, type Thought, type ToolStep } from '@/lib/agent/agentFeed';
import { useCopilot, type ChatMessage } from '@/lib/copilot/useCopilot';

function SessionStrip({ session }: { session: AgentSession }) {
  const [now, setNow] = useState(() => Date.now());
  const running = session.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const left = running ? Math.max(0, session.endsAt - now) : 0;
  const pnl = session.realizedPnl;
  const stats: [string, string, string?][] = [
    ['Spent', `${session.spent.toFixed(2)}/${session.budget}`],
    ['PnL', `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`, pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : undefined],
    ['Stop-loss', session.stopLoss.toFixed(2)],
    ['Time left', `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`],
    ['Status', session.status],
  ];
  return (
    <section className="grid grid-cols-5 gap-1 rounded-2xl bg-surface px-3 py-2 text-center">
      {stats.map(([label, value, tone]) => (
        <div key={label} className="min-w-0">
          <p className="truncate font-jet text-[10px] uppercase text-faint">{label}</p>
          <p className={cx('truncate font-jet text-xs font-semibold tabular-nums', tone)}>{value}</p>
        </div>
      ))}
    </section>
  );
}

function Step({ step }: { step: ToolStep }) {
  return (
    <p className={cx('mb-1 flex items-center gap-1.5 text-xs', step.ok ? 'text-subtle' : 'text-down')}>
      {step.ok ? <CheckCircle size={13} weight="fill" className="text-up" /> : <WarningCircle size={13} weight="fill" />}
      {step.ok ? step.label : `${step.label} failed: ${step.error}`}
    </p>
  );
}

function ThoughtRow({ t }: { t: Thought }) {
  return (
    <div className="rounded-2xl bg-surface px-3 py-2 text-xs text-muted">
      <p className="mb-1 flex items-center gap-1 font-jet text-[10px] uppercase tracking-wider text-faint">
        <Brain size={12} /> Watcher, read only
      </p>
      {t.steps.map((step, i) => (
        <Step key={i} step={step} />
      ))}
      {t.thinking && <p className="whitespace-pre-wrap text-subtle">{t.thinking}</p>}
      {t.text && <p className="mt-1 whitespace-pre-wrap text-ink">{t.text}</p>}
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  return (
    <div className={cx('w-fit max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm', m.role === 'user' ? 'ml-auto bg-ink text-white' : 'bg-surface')}>
      {m.steps?.map((step, i) => (
        <Step key={i} step={step} />
      ))}
      {m.label ?? m.content}
      {m.role === 'assistant' && !m.content && !m.steps?.length && '…'}
    </div>
  );
}

type Row =
  | { at: number; key: string; decision: Decision; index: number }
  | { at: number; key: string; message: ChatMessage }
  | { at: number; key: string; thought: Thought };

/** One line of everything a session did: decisions, tool steps, chat, and how it ended. */
export default function AgentStream({
  session,
  onAnswer,
  footer,
}: {
  session: AgentSession;
  onAnswer?: (id: string, action: 'approve' | 'reject') => void;
  footer?: React.ReactNode;
}) {
  const decisions = useAgentFeed((s) => s.decisions);
  const thoughts = useAgentFeed((s) => s.thoughts);
  const { messages, busy, error, send } = useCopilot();
  const [draft, setDraft] = useState('');
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const following = useRef(true);

  const byTime = [...decisions].sort((a, b) => b.createdAt - a.createdAt);
  const rows: Row[] = [
    ...byTime.map((decision, index) => ({ at: decision.createdAt, key: decision.id, decision, index })),
    ...messages.map((message, i) => ({ at: message.at, key: `chat-${i}`, message })),
    ...thoughts.map((thought) => ({ at: thought.at, key: thought.id, thought })),
  ].sort((a, b) => a.at - b.at);
  const newest = byTime.find((d) => d.verdict !== 'skipped');
  const tail = rows.length + messages.reduce((n, m) => n + m.content.length, 0) + (byTime[0]?.skipCount ?? 0) + thoughts.reduce((n, t) => n + t.thinking.length + t.text.length, 0);
  useEffect(() => {
    if (following.current) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [tail, session.status]);

  const why = (d: Decision) => send(`Explain decision ${d.id} of this session.`, 'Why this decision?');

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch('/api/agent/stop', { method: 'POST' });
      if (res.ok) {
        useAgentFeed.getState().showSession((await res.json()).session);
        return;
      }
      const body = await res.json().catch(() => null);
      setStopError(`The agent is still running. ${body?.error ?? `Stop failed with ${res.status}`}`);
    } catch (e) {
      setStopError(`The agent is still running. ${e instanceof Error ? e.message : 'Stop failed'}`);
    } finally {
      setStopping(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setDraft('');
    send(question);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <SessionStrip session={session} />
      {session.status === 'running' ? (
        <Button variant="secondary" size="sm" onClick={stop} disabled={stopping}>
          <Stop size={14} weight="fill" /> Stop agent
        </Button>
      ) : (
        footer
      )}
      {stopError && (
        <p role="alert" className="rounded-2xl bg-down-soft px-3 py-2 text-xs text-down">
          {stopError}
        </p>
      )}
      <ol
        ref={list}
        onScroll={(e) => {
          const { scrollHeight, scrollTop, clientHeight } = e.currentTarget;
          following.current = scrollHeight - scrollTop - clientHeight < 40;
        }}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto"
      >
        {rows.map((row) => (
          <li key={row.key}>
            {'decision' in row ? (
              <DecisionRow
                d={row.decision}
                session={session}
                newest={row.decision.id === newest?.id}
                later={row.index > 0}
                canWhy={row.index < WHY_REACH && !busy}
                onWhy={why}
                onAnswer={onAnswer}
              />
            ) : 'thought' in row ? (
              <ThoughtRow t={row.thought} />
            ) : (
              <Message m={row.message} />
            )}
          </li>
        ))}
        {session.status === 'stopped' && (
          <li className="flex items-center justify-between gap-2 rounded-2xl bg-ink px-3 py-2 text-sm text-white">
            <span className="flex items-center gap-1.5">
              <StopCircle size={15} weight="fill" /> Stopped: {session.stoppedReason}
            </span>
            <button type="button" disabled={busy} onClick={() => send('Why did my agent stop?')} className="text-xs font-semibold underline disabled:opacity-40">
              Why?
            </button>
          </li>
        )}
      </ol>
      {error && (
        <p role="alert" className="rounded-2xl bg-down-soft px-3 py-2 text-xs text-down">
          {error}
        </p>
      )}
      {session.status === 'running' && footer}
      <form onSubmit={submit} className="flex items-center gap-2">
        <Field
          aria-label="Ask the copilot"
          placeholder="Ask about this session"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          className="h-10 flex-1"
        />
        <Button type="submit" size="sm" disabled={busy || !draft.trim()} aria-label="Send">
          <PaperPlaneRight size={15} weight="fill" />
        </Button>
      </form>
    </div>
  );
}
