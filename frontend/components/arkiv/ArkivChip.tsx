"use client";

import React from "react";
import { ShieldCheck, Warning } from "@phosphor-icons/react";
import { entityUrl, matchesLedger, type ArkivSeals } from "@/lib/arkiv";

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
      <span
        title="Settled. Publishing a public record of this round, usually a few seconds"
        className="text-[11px] text-faint"
      >
        Verifying…
      </span>
    );
  }
  const ok = matchesLedger(entity, ledgerPayout);
  return (
    <a
      href={entityUrl(entity.key)}
      target="_blank"
      rel="noopener noreferrer"
      title={
        ok
          ? "The public record on Arkiv matches this payout. Open it to check yourself."
          : `The public record says ${entity.payout}, which does not match this payout`
      }
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ok ? "bg-up-soft text-up" : "bg-down-soft text-down"
      }`}
    >
      {ok ? (
        <ShieldCheck size={12} weight="bold" />
      ) : (
        <Warning size={12} weight="bold" />
      )}
      {ok ? "Verified" : "Mismatch"}
    </a>
  );
}
