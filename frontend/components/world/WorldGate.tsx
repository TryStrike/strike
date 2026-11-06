'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button } from '@/components/ui/kit';
import { StepUpCard, useNow } from '@/components/world/StepUpCard';
import { useStore } from '@/lib/store';
import { useGate } from '@/lib/world/gate';
import { startHuman, useHuman, useWorldConfig, type WorldAttempt, type WorldChallenge } from '@/lib/world/human';
import { wait } from '@/lib/api/errors';
import type { StepUp } from '@/lib/api/errors';

const WorldCheck = dynamic(() => import('@/components/agent/WorldCheck'), { ssr: false });

const OUTCOME: Record<WorldAttempt['status'], { label: string; tone: 'up' | 'down' | 'neutral'; copy: string }> = {
  approved: { label: 'verified', tone: 'up', copy: 'Verified. This wallet is linked to you.' },
  denied: { label: 'not verified', tone: 'down', copy: 'Not verified. Nothing was charged.' },
  expired: { label: 'expired', tone: 'neutral', copy: 'The check expired. Nothing was charged, start again.' },
  mismatch: {
    label: 'different human',
    tone: 'down',
    copy: 'This wallet is already linked to a different human, so it stays blocked.',
  },
  failed: { label: 'failed', tone: 'down', copy: 'The check did not finish. Nothing was charged.' },
  pending: { label: 'pending', tone: 'neutral', copy: 'Still waiting for World App.' },
  unknown: { label: 'unknown', tone: 'neutral', copy: '' },
};

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

function HumanGate() {
  const request = useGate((s) => s.human);
  const address = useStore((s) => s.address);
  const queryClient = useQueryClient();
  const config = useWorldConfig().data;
  const human = useHuman(request ? address : null);
  const [challenge, setChallenge] = useState<WorldChallenge | null>(null);
  const [outcome, setOutcome] = useState<WorldAttempt | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(!!request);

  if (!request) return null;
  const h = human.data;
  const wantOrb = request.tier === 'orb';
  const satisfied = !!h?.verified && (!wantOrb || h.tier === 'orb');

  const close = (ok = satisfied) => {
    setOutcome(null);
    setError(null);
    request.done(ok);
  };

  const verify = async (tier?: 'orb') => {
    if (!address) return setError('Connect a wallet first.');
    setStarting(true);
    setError(null);
    setOutcome(null);
    try {
      setChallenge(await startHuman(address, tier));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start World ID.');
    } finally {
      setStarting(false);
    }
  };

  const done = async (a: WorldAttempt) => {
    setChallenge(null);
    setOutcome(a);
    if (a.status !== 'approved') return;
    void queryClient.invalidateQueries({ queryKey: ['world-human'] });
    const next = (await human.refetch()).data;
    if (next?.verified && (!wantOrb || next.tier === 'orb')) close(true);
  };

  if (challenge) return <WorldCheck key={challenge.attempt} challenge={challenge} onDone={done} />;

  const caps = config?.tiers;
  const o = outcome && OUTCOME[outcome.status];
  return (
    <Modal isOpen onClose={() => close()} title={wantOrb ? 'Upgrade to Orb' : "Verify you're human"}>
      <div className="-mt-2 flex flex-col gap-4 text-sm">
        <p className="text-muted">
          {wantOrb
            ? 'This action needs an Orb-verified World ID.'
            : 'Strike limits are per human, across every wallet you use. Verify once with World ID and this wallet is linked to you.'}
        </p>

        {caps && (
          <dl className="grid grid-cols-2 gap-2 font-jet text-[12px]">
            <div className={`rounded-xl p-3 ${h?.tier === 'selfie' ? 'bg-up-soft' : 'bg-surface'}`}>
              <dt className="text-subtle">Selfie</dt>
              <dd>{caps.selfie.openCap} USDC open</dd>
              <dd>{caps.selfie.dailyLoss} USDC daily loss</dd>
            </div>
            <div className={`rounded-xl p-3 ${h?.tier === 'orb' ? 'bg-up-soft' : 'bg-surface'}`}>
              <dt className="text-subtle">Orb</dt>
              <dd>{caps.orb.openCap} USDC open</dd>
              <dd>{caps.orb.dailyLoss} USDC daily loss</dd>
              <dd>YOLO agent</dd>
            </div>
          </dl>
        )}

        {h?.verified && (
          <div className="flex flex-col gap-1 font-jet text-[12px] text-muted">
            <span>
              <Badge tone="up">{h.tier}</Badge> {h.open.toFixed(2)} USDC open · {h.lostToday.toFixed(2)} USDC lost today
            </span>
            <span>Linked wallets: {h.wallets.map(short).join(', ')}</span>
            {h.cooloffUntil && h.cooloffUntil > now && <span className="text-down">Cool-off ends in {wait(h.cooloffUntil, now)}</span>}
          </div>
        )}

        {config?.devBypass && <p className="text-xs text-faint">Dev mode: World checks are skipped on this server.</p>}
        {config && !config.enabled && !config.devBypass && (
          <p className="text-xs text-down">World ID is not configured on this server, so trading is turned off.</p>
        )}

        {o && (
          <p role="status" className="flex items-start gap-2">
            <Badge tone={o.tone}>{o.label}</Badge>
            <span className="text-muted">
              {o.copy} {outcome!.reason}
            </span>
          </p>
        )}
        {error && <p role="alert" className="rounded-xl bg-down-soft px-3.5 py-2.5 text-[13px] text-down">{error}</p>}

        {satisfied ? (
          <Button size="lg" onClick={() => close(true)}>Continue</Button>
        ) : h?.verified && h.tier === 'selfie' ? (
          <Button size="lg" onClick={() => verify('orb')} disabled={starting}>
            {starting ? 'Starting…' : 'Upgrade to Orb'}
          </Button>
        ) : (
          <Button size="lg" onClick={() => verify(wantOrb ? 'orb' : undefined)} disabled={starting || !address}>
            {starting ? 'Starting…' : 'Verify with World ID'}
          </Button>
        )}
        {h?.verified && h.tier === 'selfie' && satisfied && (
          <Button variant="ghost" size="sm" onClick={() => verify('orb')} disabled={starting}>
            Upgrade to Orb for higher limits
          </Button>
        )}
      </div>
    </Modal>
  );
}

function StepUpGate() {
  const request = useGate((s) => s.stepup);
  const [settled, setSettled] = useState<StepUp | null>(null);
  if (!request) return null;
  const finish = (s: StepUp) => {
    setSettled(null);
    request.done(s);
  };
  const close = () => {
    if (settled) return finish(settled);
    void fetch(`/api/stepups/${encodeURIComponent(request.stepup.id)}/cancel`, { method: 'POST', credentials: 'include' }).catch(() => {});
    finish({ ...request.stepup, status: 'cancelled' });
  };
  return (
    <Modal isOpen onClose={close} title="Approve with World">
      <StepUpCard
        key={request.stepup.id}
        stepup={request.stepup}
        onSettled={(s) => (s.status === 'approved' ? finish(s) : setSettled(s))}
      />
      {settled && (
        <Button className="mt-4 w-full" variant="secondary" onClick={close}>
          Close
        </Button>
      )}
    </Modal>
  );
}

export function WorldGate() {
  return (
    <>
      <HumanGate />
      <StepUpGate />
    </>
  );
}
