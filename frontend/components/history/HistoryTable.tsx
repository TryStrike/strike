'use client';


import React from 'react';
import { ArrowSquareOut, ShieldCheck } from '@phosphor-icons/react';
import { explorerTxUrl } from '@/lib/arc/config';
import type { BetHistoryRow } from '@/lib/store/historySlice';
import { SettlementProof, type SettlementProofInput } from '@/components/game/SettlementProof';
import { Badge, cx } from '@/components/ui/kit';
import { ArkivChip } from '@/components/arkiv/ArkivChip';
import type { ArkivSeals } from '@/lib/arkiv';
import {
  asNumber,
  formatAmount,
  formatMultiplier,
  formatPrice,
  formatRowDateTime,
  isDemoRow,
  netOf,
  priceDelta,
  rowTimeMs,
  shortenHash,
} from './historyFormat';

interface HistoryTableProps {
  rows: BetHistoryRow[];
  loading: boolean;
  wallet: string;
  skeletonRows?: number;
  seals?: ArkivSeals | null;
}

const HEAD_CELLS = [
  'Settled',
  'Asset',
  'Side',
  'Stake',
  'Mult',
  'Strike → End',
  'Result',
  'Payout / Net',
  'Proof',
];

export const HistoryTable: React.FC<HistoryTableProps> = ({
  rows,
  loading,
  wallet,
  skeletonRows = 8,
  seals = null,
}) => (
  <div className="overflow-x-auto">
    <table className="w-full min-w-[900px] border-collapse text-left font-tight">
      <thead>
        <tr className="border-b border-line">
          {HEAD_CELLS.map((h) => (
            <th
              key={h}
              className="px-4 py-3 font-jet text-[11px] font-medium uppercase tracking-[0.14em] text-faint"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {loading && rows.length === 0
          ? Array.from({ length: skeletonRows }).map((_, i) => <SkeletonRow key={i} index={i} />)
          : rows.map((row) => <HistoryRow key={String(row.id)} row={row} wallet={wallet} seals={seals} />)}
      </tbody>
    </table>
  </div>
);

const SkeletonRow: React.FC<{ index: number }> = ({ index }) => (
  <tr aria-hidden="true" className={cx('h-14', index % 2 === 1 && 'bg-surface/60')}>
    {HEAD_CELLS.map((_, cell) => (
      <td key={cell} className="px-4 py-4">
        <div
          className="h-3 animate-pulse rounded-full bg-ink/[0.07]"
          style={{ width: cell === 0 ? '80%' : cell === 5 ? '70%' : '55%' }}
        />
      </td>
    ))}
  </tr>
);

export function isDemoHistoryRow(row: BetHistoryRow): boolean {
  return isDemoRow(row);
}

export function proofInputFromRow(row: BetHistoryRow): SettlementProofInput {
  return {
    betId: String(row.id ?? ''),
    asset: row.asset ?? null,
    mode: row.mode ?? null,
    direction: row.direction ?? null,
    stake: asNumber(row.amount),
    multiplier: asNumber(row.multiplier),
    payout: asNumber(row.payout),
    won: !!row.won,
    network: row.network ?? null,
    strikePrice: asNumber(row.strike_price),
    recordedEndPrice: asNumber(row.end_price),
    resolvedAt: rowTimeMs(row),
  };
}

const HistoryRow: React.FC<{ row: BetHistoryRow; wallet: string; seals: ArkivSeals | null }> = ({
  row,
  wallet,
  seals,
}) => {
  const net = netOf(row);
  const delta = priceDelta(row);
  const isDemo = isDemoHistoryRow(row);
  const txHash = typeof row.txHash === 'string' && row.txHash.length > 0 ? row.txHash : null;

  return (
    <tr className="align-middle transition-colors hover:bg-surface/70">
      <td className="whitespace-nowrap px-4 py-3.5 font-jet text-xs text-muted">{formatRowDateTime(row)}</td>

      <td className="px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">{row.asset || '—'}</span>
          {isDemo && <Badge tone="neutral">Demo · play money</Badge>}
        </div>
      </td>

      <td className="px-4 py-3.5">
        <Badge tone={row.direction === 'DOWN' ? 'down' : 'up'}>{row.direction}</Badge>
      </td>

      <td className="whitespace-nowrap px-4 py-3.5 font-jet text-sm tabular-nums text-ink">
        {formatAmount(row.amount)}
      </td>

      <td className="whitespace-nowrap px-4 py-3.5 font-jet text-xs text-muted">
        {formatMultiplier(row.multiplier)}
      </td>

      <td className="whitespace-nowrap px-4 py-3.5">
        <div className="font-jet text-xs tabular-nums text-ink">{formatPrice(row.strike_price)}</div>
        <div className={cx('font-jet text-xs tabular-nums', delta >= 0 ? 'text-up' : 'text-down')}>
          {formatPrice(row.end_price)}
          <span className="ml-1.5 text-faint">
            ({delta >= 0 ? '+' : '−'}
            {formatPrice(Math.abs(delta))})
          </span>
        </div>
      </td>

      <td className="px-4 py-3.5">
        {net === 0 ? (
          <Badge tone="neutral">Refund</Badge>
        ) : (
          <Badge tone={net > 0 ? 'up' : 'down'}>{net > 0 ? 'Won' : 'Lost'}</Badge>
        )}
      </td>

      <td className="whitespace-nowrap px-4 py-3.5 text-right">
        <div className="font-jet text-sm tabular-nums text-ink">{formatAmount(row.payout)}</div>
        <div className={cx('font-jet text-xs tabular-nums', net >= 0 ? 'text-up' : 'text-down')}>
          {net >= 0 ? '+' : '−'}
          {formatAmount(Math.abs(net))} net
        </div>
      </td>

      <td className="whitespace-nowrap px-4 py-3.5">
        <div className="flex items-center gap-2">
          {txHash && (
            <a
              href={explorerTxUrl(txHash)}
              target="_blank"
              rel="noopener noreferrer"
              title={txHash}
              className="inline-flex items-center gap-1.5 rounded-full bg-up/[0.08] px-2.5 py-1 font-jet text-[11px] font-medium text-up ring-1 ring-inset ring-up/20 transition-colors hover:bg-up/[0.14]"
            >
              {shortenHash(txHash)}
              <ArrowSquareOut size={12} />
            </a>
          )}
          <SettlementProof
            bet={proofInputFromRow(row)}
            wallet={wallet || row.wallet_address}
            variant="chip"
            label={`${row.asset} ${row.direction}${isDemo ? ' · demo round' : ''}`}
          />
          {seals && !isDemo ? <ArkivChip seals={seals} betId={String(row.id)} ledgerPayout={row.payout} /> : null}
        </div>
      </td>
    </tr>
  );
};

export const HistoryEmptyState: React.FC<{ filtered: boolean; onClear?: () => void }> = ({
  filtered,
  onClear,
}) => (
  <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-line bg-white/60 px-6 py-14 text-center backdrop-blur-xl">
    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-faint">
      <ShieldCheck size={20} />
    </div>
    <p className="text-[15px] font-semibold text-ink">
      {filtered ? 'No rounds match this filter' : 'No settled rounds yet'}
    </p>
    <p className="max-w-sm text-sm leading-relaxed text-muted">
      {filtered
        ? 'Widen the asset, result or date range to see more of your trade history.'
        : 'Every round you play settles here — stake, strike vs end price, result and payout.'}
    </p>
    {filtered && onClear && (
      <button
        type="button"
        onClick={onClear}
        className="mt-1 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink ring-1 ring-ink/[0.08] transition-colors hover:ring-ink/25"
      >
        Clear filters
      </button>
    )}
  </div>
);

export default HistoryTable;
