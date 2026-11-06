'use client';

import React from 'react';
import { ARKIV_RPC, matchesLedger, type ArkivSeals } from '@/lib/arkiv';

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
    return <p className="font-jet text-[11px] text-down">Could not reach the public record on Arkiv ({error}). Your history above is unaffected.</p>;
  }
  if (!seals || rows.length === 0) return null;

  const sealed = rows.filter((r) => seals.byBet.has(r.id));
  const mismatched = sealed.filter((r) => !matchesLedger(seals.byBet.get(r.id)!, r.payout)).length;

  return (
    <details className="font-jet text-[11px] text-subtle">
      <summary className="cursor-pointer">
        {sealed.length} of {rows.length} rounds verified against the public record
        {sealed.length > 0 ? (mismatched === 0 ? ', all payouts match' : `, ${mismatched} ${mismatched === 1 ? 'does' : 'do'} not match`) : ''}.
        Check it yourself
      </summary>
      <p className="mt-1.5 break-all leading-relaxed text-faint">Your browser asked Arkiv directly ({ARKIV_RPC}), not our server, with this query:</p>
      <p className="mt-1 break-all leading-relaxed text-ink">{seals.query}</p>
    </details>
  );
}
