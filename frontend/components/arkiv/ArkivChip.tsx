'use client';

import React from 'react';
import { entityUrl, matchesLedger, type ArkivSeals } from '@/lib/arkiv';

export function ArkivChip({
  seals,
  betId,
  ledgerPayout,
}: {
  seals: ArkivSeals;
  betId: string;
  ledgerPayout: number | string | null | undefined;
}) {
  const entity = seals.byBet.get(betId);
  if (!entity) {
    return (
      <span title="Settled in the ledger, waiting for the next Arkiv block" className="font-jet text-[11px] text-faint">
        Sealing
      </span>
    );
  }
  const ok = matchesLedger(entity, ledgerPayout);
  return (
    <a
      href={entityUrl(entity.key)}
      target="_blank"
      rel="noopener noreferrer"
      title={ok ? 'Sealed on Arkiv, matches the ledger' : `Arkiv says ${entity.payout}, the ledger disagrees`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-jet text-[11px] font-medium ${
        ok ? 'bg-up-soft text-up' : 'bg-down-soft text-down'
      }`}
    >
      {ok ? 'Arkiv ✓' : 'Arkiv ✗'}
    </a>
  );
}
