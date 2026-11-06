'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { Badge, Button } from '@/components/ui/kit';
import { readApiError, needsSession, toMs, wait, type StepUp, type StepUpStatus } from '@/lib/api/errors';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';

const MIN_POLL_MS = 2_000;

const STATE: Record<StepUpStatus, { label: string; tone: 'up' | 'down' | 'neutral'; copy: string }> = {
  pending: { label: 'waiting', tone: 'neutral', copy: 'Open World App, check the code matches, and approve.' },
  approved: { label: 'approved', tone: 'up', copy: 'Approved in World App. Continuing.' },
  used: { label: 'used', tone: 'neutral', copy: 'This approval was already used. Nothing else happens with it.' },
  denied: { label: 'denied', tone: 'down', copy: 'Denied in World App. Nothing happened, no money moved.' },
  cancelled: { label: 'cancelled', tone: 'neutral', copy: 'Cancelled. Nothing happened, no money moved.' },
  expired: { label: 'expired', tone: 'neutral', copy: 'The approval window closed. Nothing happened, no money moved.' },
  mismatch: {
    label: 'wrong human',
    tone: 'down',
    copy: 'A different World ID approved this than the one linked to you. Nothing happened, no money moved.',
  },
  failed: {
    label: 'failed',
    tone: 'down',
    copy: 'World could not finish the approval. Nothing happened, no money moved.',
  },
};

export const stepUpSettled = (s: StepUpStatus) => s !== 'pending';

export function useNow(active: boolean, tickMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [active, tickMs]);
  return now;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const send = () => fetch(path, { credentials: 'include', cache: 'no-store', ...init });
  const res = await send();
  if (res.status !== 401 || !needsSession(await readApiError(res.clone()))) return res;
  await ensureBalanceSession();
  return send();
}

export function StepUpCard({ stepup, onSettled }: { stepup: StepUp; onSettled?: (s: StepUp) => void }) {
  const [s, setS] = useState(stepup);
  const [note, setNote] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const pending = s.status === 'pending';
  const now = useNow(pending);
  const expiresAt = toMs(s.expiresAt);

  useEffect(() => {
    if (!pending) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await call(`/api/stepups/${encodeURIComponent(s.id)}`);
        if (stop) return;
        if (res.ok) {
          const next = (await res.json()) as StepUp;
          setNote(null);
          setS(next);
          if (next.status !== 'pending') return;
        } else {
          setNote(`Could not read the approval (${(await readApiError(res)).error}). Still waiting, nothing has run.`);
        }
      } catch {
        if (!stop) setNote('Lost the connection. Still waiting, nothing has run.');
      }
      if (!stop) timer = setTimeout(tick, Math.max(MIN_POLL_MS, s.intervalMs || 0));
    };
    timer = setTimeout(tick, Math.max(MIN_POLL_MS, s.intervalMs || 0));
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pending, s.id, s.intervalMs]);

  useEffect(() => {
    if (!pending) onSettled?.(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status]);

  const cancel = async () => {
    setCancelling(true);
    try {
      const res = await call(`/api/stepups/${encodeURIComponent(s.id)}/cancel`, { method: 'POST' });
      if (res.ok) setS((await res.json()) as StepUp);
      else setNote((await readApiError(res)).error);
    } catch {
      setNote('Could not cancel. It will expire on its own and nothing runs without your approval.');
    } finally {
      setCancelling(false);
    }
  };

  const st = STATE[s.status] ?? STATE.failed;
  return (
    <section aria-live="polite" className="flex flex-col gap-3 rounded-2xl bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold">{s.summary}</p>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>

      {pending && (
        <>
          <div className="text-center">
            <div className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">Code</div>
            <div className="font-jet text-3xl font-semibold tracking-[0.2em]">{s.userCode}</div>
          </div>
          <a
            href={s.verifyUriComplete || s.verifyUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-up px-5 text-[15px] font-semibold text-white hover:brightness-110"
          >
            Approve with World <ArrowUpRight size={16} />
          </a>
          <p className="text-xs text-muted">
            {st.copy}{' '}
            {expiresAt > now ? `Expires in ${wait(expiresAt, now)}.` : 'Expiring now.'}
          </p>
          <Button variant="ghost" size="sm" onClick={cancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        </>
      )}

      {!pending && <p className="text-xs text-muted">{s.reason && s.status !== 'approved' ? `${st.copy} ${s.reason}` : st.copy}</p>}
      {note && <p role="status" className="text-xs text-down">{note}</p>}
    </section>
  );
}
