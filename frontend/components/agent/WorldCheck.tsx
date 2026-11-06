'use client';

import { useCallback, useRef } from 'react';
import { any, CredentialRequest, IDKitErrorCodes, IDKitRequestWidget, proofOfHuman, type IDKitResult } from '@worldcoin/idkit';
import { attemptOf, type WorldAttempt, type WorldChallenge } from '@/lib/agent/useAgent';

/** Runs the IDKit proof for one attempt. The server settles it exactly once, whatever the widget does. */
export default function WorldCheck({ challenge, onDone }: { challenge: WorldChallenge; onDone: (a: WorldAttempt) => void }) {
  const { attempt, world } = challenge;
  const sent = useRef<Promise<WorldAttempt> | null>(null);

  const report = useCallback(
    (body: IDKitResult | { error: string }) =>
      (sent.current ??= fetch(`/api/world/attempts/${encodeURIComponent(attempt)}/proof`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(attemptOf)
        .catch((e) => ({ status: 'failed', reason: `Could not send the human check: ${e.message}`, acr: null }) as WorldAttempt)),
    [attempt]
  );

  const finish = useCallback((body: { error: string }) => report(body).then(onDone), [report, onDone]);

  return (
    <IDKitRequestWidget
      open
      app_id={world.app_id}
      action={world.action}
      rp_context={world.rp_context}
      environment={world.environment}
      allow_legacy_proofs={false}
      require_user_presence={world.require_user_presence}
      {...(world.preset === 'orb'
        ? { preset: proofOfHuman({ signal: world.signal }) }
        : { constraints: any(CredentialRequest('selfie', { signal: world.signal }), CredentialRequest('proof_of_human', { signal: world.signal })) })}
      handleVerify={async (result) => {
        const a = await report(result);
        onDone(a);
        if (a.status !== 'approved') throw new Error(a.reason);
      }}
      onSuccess={() => {}}
      onError={(code) => finish({ error: code })}
      onOpenChange={(open) => {
        if (!open) finish({ error: IDKitErrorCodes.Cancelled });
      }}
    />
  );
}
