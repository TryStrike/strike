'use client';

/**
 * HistoryFilters — the control strip for /history.
 *
 * Every filter the GET /api/bets/history contract supports gets a control:
 *   asset (chips) · outcome (won/lost) · direction (UP/DOWN/DRAW) · from/to
 * (inclusive date window), plus the client-side practice-rows toggle for the
 * play-money rows the route flags but cannot yet filter server-side.
 *
 * The component is fully controlled: it renders the draft view and reports
 * patches; the page owns the draft -> debounced-URL -> fetch pipeline, so
 * rapid edits (e.g. date typing) coalesce into one request. The applied set
 * is echoed back as removable chips with a one-click "clear filters".
 */

import React, { useCallback, useMemo } from 'react';
import { DownloadSimple, X } from '@phosphor-icons/react';
import type { BetHistoryFilters } from '@/lib/store/historySlice';
import { Button, Field, Label, Segmented, cx, glassSelected } from '@/components/ui/kit';
import {
  activeFilterChips,
  type HistoryView,
  type HistoryViewPatch,
} from './historyQuery';
import { dayEndIso, dayStartIso, formatDateTime, toDateInputValue } from './historyFormat';

interface HistoryFiltersProps {
  /** The draft view — what the controls show, pending the debounced URL write. */
  view: HistoryView;
  assets: string[];
  onPatch: (patch: HistoryViewPatch) => void;
  onClear: () => void;
  onExport: () => void;
  exporting: boolean;
  exportedRows?: number | null;
  disabled?: boolean;
}

export const HistoryFilters: React.FC<HistoryFiltersProps> = ({
  view,
  assets,
  onPatch,
  onClear,
  onExport,
  exporting,
  exportedRows,
  disabled,
}) => {
  const filters = view.filters;
  const setFilters = useCallback(
    (patch: Partial<BetHistoryFilters>) => onPatch({ filters: { ...filters, ...patch } }),
    [filters, onPatch]
  );

  const fromValue = useMemo(() => toDateInputValue(filters.from), [filters.from]);
  const toValue = useMemo(() => toDateInputValue(filters.to), [filters.to]);

  const setFrom = useCallback(
    (value: string) => setFilters({ from: dayStartIso(value) }),
    [setFilters]
  );

  const setTo = useCallback(
    (value: string) => setFilters({ to: dayEndIso(value) }),
    [setFilters]
  );

  const maxDate = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  const chips = useMemo(() => activeFilterChips(view, (iso) => formatDateTime(iso)), [view]);

  return (
    <section
      aria-label="Filter trade history"
      className="space-y-5 rounded-3xl bg-white/70 p-5 ring-1 ring-ink/[0.06] backdrop-blur-xl"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Label>Asset</Label>
          <div className="flex flex-wrap gap-1.5">
            <AssetChip
              label="All"
              selected={!filters.asset || filters.asset === 'ALL'}
              disabled={disabled}
              onClick={() => setFilters({ asset: null })}
            />
            {assets.map((asset) => (
              <AssetChip
                key={asset}
                label={asset}
                selected={filters.asset === asset}
                disabled={disabled}
                onClick={() => setFilters({ asset: filters.asset === asset ? null : asset })}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onExport}
            disabled={disabled || exporting}
            aria-label="Download the current filter as CSV"
          >
            {exporting ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
                Building…
              </>
            ) : (
              <>
                <DownloadSimple size={16} />
                CSV{exportedRows ? ` (${exportedRows})` : ''}
              </>
            )}
          </Button>

          {chips.length > 0 && (
            <Button variant="ghost" size="sm" type="button" onClick={onClear} disabled={disabled}>
              <X size={14} />
              Clear filters
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
        <div>
          <Label>Result</Label>
          <Segmented
            value={filters.outcome ?? 'all'}
            disabled={disabled}
            onChange={(v) => setFilters({ outcome: v === 'all' ? null : (v as 'won' | 'lost') })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'won', label: 'Wins' },
              { value: 'lost', label: 'Losses' },
            ]}
          />
        </div>

        <div>
          <Label>Direction</Label>
          <Segmented
            value={filters.direction ?? 'ANY'}
            disabled={disabled}
            onChange={(v) =>
              setFilters({ direction: v === 'ANY' ? null : (v as BetHistoryFilters['direction']) })
            }
            options={[
              { value: 'ANY', label: 'Any' },
              { value: 'UP', label: 'Up' },
              { value: 'DOWN', label: 'Down' },
              // The route accepts direction=DRAW; the panel filter must show it too.
              { value: 'DRAW', label: 'Draw' },
            ]}
          />
        </div>

        <div>
          <Label className="lg:text-right">From</Label>
          <Field
            type="date"
            max={maxDate}
            value={fromValue}
            disabled={disabled}
            onChange={(e) => setFrom(e.target.value)}
            className="lg:w-[190px]"
            aria-label="History range start"
          />
        </div>

        <div>
          <Label>To</Label>
          <Field
            type="date"
            max={maxDate}
            value={toValue}
            disabled={disabled}
            onChange={(e) => setTo(e.target.value)}
            className="lg:w-[190px]"
            aria-label="History range end"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div>
          <Label>Practice rounds</Label>
          <Segmented
            value={view.hideDemo ? 'hide' : 'show'}
            disabled={disabled}
            onChange={(v) => onPatch({ hideDemo: v === 'hide' })}
            options={[
              { value: 'show', label: 'Shown' },
              { value: 'hide', label: 'Hidden' },
            ]}
          />
        </div>
        <p className="max-w-md font-jet text-[11px] leading-relaxed text-faint">
          Play-money rows are badged and never counted in the real totals. Hiding them applies to
          the loaded page — the server has no demo filter yet, so the matching-rounds count still
          includes practice rounds.
        </p>
      </div>

      {chips.length > 0 && (
        <div
          role="group"
          aria-label="Applied filters"
          className="flex flex-wrap items-center gap-1.5 border-t border-line pt-4"
        >
          <span className="mr-1 font-jet text-[11px] uppercase tracking-[0.12em] text-faint">
            Filtering by
          </span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              disabled={disabled}
              onClick={() => onPatch(chip.patch)}
              aria-label={`Remove filter: ${chip.label}`}
              className={cx(
                'inline-flex h-7 items-center gap-1.5 rounded-full bg-up/[0.08] px-2.5 font-jet text-[11px] font-medium text-up ring-1 ring-inset ring-up/20 transition-colors hover:bg-up/[0.14] disabled:opacity-40'
              )}
            >
              {chip.label}
              <X size={12} />
            </button>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="ml-1 inline-flex h-7 items-center rounded-full px-2.5 font-jet text-[11px] font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      )}
    </section>
  );
};

const AssetChip: React.FC<{
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, selected, disabled, onClick }) => (
  <button
    type="button"
    aria-pressed={selected}
    disabled={disabled}
    onClick={onClick}
    className={cx(
      'h-8 rounded-full px-3 font-jet text-[12px] font-medium uppercase tracking-[0.08em] transition-all disabled:opacity-40',
      selected
        ? glassSelected
        : 'bg-ink/[0.04] text-subtle hover:bg-ink/[0.07] hover:text-ink'
    )}
  >
    {label}
  </button>
);

export default HistoryFilters;
