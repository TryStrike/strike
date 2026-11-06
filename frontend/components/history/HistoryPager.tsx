'use client';


import React from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { HISTORY_PAGE_SIZES } from '@/lib/store/historySlice';
import { cx } from '@/components/ui/kit';
import { MAX_HISTORY_OFFSET } from './historyQuery';

interface HistoryPagerProps {
  offset: number;
  limit: number;
  total: number | null;
  rowCount: number;
  hasMore: boolean;
  loading: boolean;
  onPageChange: (offset: number) => void;
  onLimitChange: (limit: number) => void;
}

export const HistoryPager: React.FC<HistoryPagerProps> = ({
  offset,
  limit,
  total,
  rowCount,
  hasMore,
  loading,
  onPageChange,
  onLimitChange,
}) => {
  const page = Math.floor(offset / limit) + 1;
  const totalPages = total !== null && total > 0 ? Math.ceil(total / limit) : null;
  const firstOnPage = total === 0 && rowCount === 0 ? 0 : offset + 1;
  const lastOnPage = offset + rowCount;
  const canPrev = offset > 0 && !loading;
  const canNext =
    (total !== null ? page < (totalPages ?? page) : hasMore) &&
    !loading &&
    offset + limit <= MAX_HISTORY_OFFSET;

  return (
    <nav
      aria-label="Trade history pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4"
    >
      <div className="flex items-center gap-3">
        <span className="font-jet text-xs text-faint">
          {firstOnPage === 0
            ? 'No rounds'
            : `${firstOnPage.toLocaleString()}–${lastOnPage.toLocaleString()} of ${(total ?? lastOnPage).toLocaleString()}`}
        </span>
        <label className="flex items-center gap-2 font-jet text-xs text-faint">
          <span className="uppercase tracking-[0.12em]">Rows</span>
          <select
            value={String(limit)}
            disabled={loading}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="h-8 rounded-full bg-white px-2.5 font-jet text-xs text-ink ring-1 ring-ink/[0.08] outline-none transition-colors focus:ring-ink/30 disabled:opacity-40"
          >
            {HISTORY_PAGE_SIZES.map((size) => (
              <option key={size} value={String(size)}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <PagerButton disabled={!canPrev} onClick={() => onPageChange(Math.max(0, offset - limit))} label="Previous page">
          <CaretLeft size={15} />
        </PagerButton>
        <span className="min-w-[92px] text-center font-jet text-xs text-muted">
          Page {page}
          {totalPages !== null ? ` / ${totalPages}` : ''}
        </span>
        <PagerButton
          disabled={!canNext}
          onClick={() => onPageChange(offset + limit)}
          label="Next page"
        >
          <CaretRight size={15} />
        </PagerButton>
      </div>
    </nav>
  );
};

const PagerButton: React.FC<{
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}> = ({ disabled, onClick, label, children }) => (
  <button
    type="button"
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className={cx(
      'flex h-9 w-9 items-center justify-center rounded-full ring-1 ring-inset transition-all',
      disabled
        ? 'cursor-not-allowed text-faint ring-ink/[0.05] opacity-50'
        : 'text-ink ring-ink/[0.08] hover:bg-surface'
    )}
  >
    {children}
  </button>
);

export default HistoryPager;
