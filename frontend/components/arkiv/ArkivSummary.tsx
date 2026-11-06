'use client';

import React from 'react';
import { matchesLedger, type ArkivSeals } from '@/lib/arkiv';

export function ArkivSummary({
  seals,
  error,
  rows,
}: {
  seals: ArkivSeals | null;
  error: string | null;
  rows: Array<{ id: string; payout: number | string | null | undefined }>;
}) {
  if (error) {
    return <p className="font-jet text-[11px] text-down">Arkiv could not be read ({error}). The ledger above is unaffected.</p>;
  }
  if (!seals || rows.length === 0) return null;

  const sealed = rows.filter((r) => seals.byBet.has(r.id));
  const mismatched = sealed.filter((r) => !matchesLedger(seals.byBet.get(r.id)!, r.payout)).length;

  return (
    <details className="font-jet text-[11px] text-subtle">
      <summary className="cursor-pointer">
        Arkiv: {sealed.length} of {rows.length} rounds sealed
        {sealed.length > 0 ? (mismatched === 0 ? ', all match the ledger' : `, ${mismatched} ${mismatched === 1 ? 'does' : 'do'} not match the ledger`) : ''}.
        Verify yourself
      </summary>
      <p className="mt-1.5 break-all leading-relaxed text-faint">arkiv_query on {seals.rpc}</p>
      <p className="mt-1 break-all leading-relaxed text-ink">{seals.query}</p>
    </details>
  );
}
