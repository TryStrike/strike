'use client';


import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowsLeftRight,
  CircleNotch,
  ClockCounterClockwise,
  ShieldCheck,
  Wallet,
  WarningCircle,
} from '@phosphor-icons/react';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';
import {
  HistoryEmptyState,
  HistoryFilters,
  HistoryPager,
  HistoryTable,
  StockTrades,
} from '@/components/history';
import {
  buildHistoryCsv,
  buildHistoryExportFilename,
  formatAmount,
  hasActiveFilters,
  isDemoRow,
  shortenAddress,
  splitDemoRows,
  summarizeRealRows,
} from '@/components/history/historyFormat';
import {
  HISTORY_FILTER_DEBOUNCE_MS,
  applyViewPatch,
  clearFiltersPatch,
  isDefaultView,
  parseHistoryView,
  viewKey,
  viewToSearchParams,
  type HistoryView,
  type HistoryViewPatch,
} from '@/components/history/historyQuery';
import {
  HistoryFeedError,
  loadHistoryViewPage,
  rowsToBetRecords,
  type HistoryErrorKind,
} from '@/components/history/historyFeed';
import { Badge, Label, cx } from '@/components/ui/kit';
import { useToast } from '@/lib/hooks/useToast';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import {
  fetchAllFilteredBetHistory,
  type BetHistoryPage,
  type BetHistoryRow,
} from '@/lib/store/historySlice';
import { useArkivSeals } from '@/lib/arkiv';
import { ArkivSummary } from '@/components/arkiv/ArkivSummary';

const EpochStrip = dynamic(() => import('@/components/history/EpochStrip'), { ssr: false });

interface LoadedPage {
  wallet: string;
  urlKey: string;
  rows: BetHistoryRow[];
  total: number | null;
  hasMore: boolean;
}

interface ShownError {
  kind: HistoryErrorKind;
  message: string;
}

interface FeedState {
  key: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  loaded: LoadedPage | null;
  error: ShownError | null;
}

const EMPTY_FEED: FeedState = { key: '', status: 'idle', loaded: null, error: null };

function HistoryPageInner() {
  const { address, isConnected } = useStore(
    useShallow((s) => ({ address: s.address, isConnected: s.isConnected }))
  );
  const reset = useStore((s) => s.resetBetHistory);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlView = useMemo<HistoryView>(
    () => parseHistoryView(searchParams ?? new URLSearchParams()),
    [searchParams]
  );
  const urlKey = searchParams?.toString() ?? '';

  const [draft, setDraft] = useState<HistoryView>(urlView);

  const [draftUrlKey, setDraftUrlKey] = useState(urlKey);
  if (draftUrlKey !== urlKey) {
    setDraft(urlView);
    setDraftUrlKey(urlKey);
  }

  const draftKey = useMemo(() => viewKey(draft), [draft]);

  useEffect(() => {
    if (draftKey === urlKey) return;
    const handle = setTimeout(() => {
      const search = viewToSearchParams(draft).toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    }, HISTORY_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, draftKey, urlKey, router, pathname]);

  const patchView = useCallback((patch: HistoryViewPatch) => {
    setDraft((prev) => applyViewPatch(prev, patch));
  }, []);

  const clearFilters = useCallback(() => {
    setDraft((prev) => applyViewPatch(prev, clearFiltersPatch()));
  }, []);

  const [reloadToken, setReloadToken] = useState(0);
  const authKey = isConnected && address ? `${address}|${urlKey}|${reloadToken}` : `anon|${urlKey}`;

  const [feed, setFeed] = useState<FeedState>(EMPTY_FEED);
  if (feed.key !== authKey) {
    setFeed({
      key: authKey,
      status: isConnected && address ? 'loading' : 'idle',
      loaded: null,
      error: null,
    });
  }

  const seqRef = useRef(0);

  useEffect(() => {
    if (!isConnected || !address) {
      reset();
      return;
    }

    const controller = new AbortController();
    const seq = ++seqRef.current;
    const key = authKey;

    loadHistoryViewPage(address, urlView, controller.signal)
      .then((page: BetHistoryPage) => {
        if (seq !== seqRef.current) return;
        setFeed({
          key,
          status: 'ready',
          loaded: { wallet: address, urlKey, rows: page.rows, total: page.total, hasMore: page.hasMore },
          error: null,
        });
        useStore.setState({
          historyRows: page.rows,
          historyTotal: page.total,
          historyLimit: page.limit,
          historyOffset: page.offset,
          isHistoryLoading: false,
          historyError: null,
        });
        if (page.offset === 0 && !hasActiveFilters(urlView.filters) && page.rows.length > 0) {
          useStore.setState({ bets: rowsToBetRecords(page.rows) });
        }
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError' || seq !== seqRef.current) return;
        const shown: ShownError =
          err instanceof HistoryFeedError
            ? { kind: err.kind, message: err.message }
            : { kind: 'network', message: 'Could not load your history.' };
        setFeed({ key, status: 'error', loaded: null, error: shown });
        useStore.setState({ isHistoryLoading: false, historyError: shown.message });
      });

    return () => controller.abort();
  }, [isConnected, address, urlView, urlKey, authKey, reset]);

  const loading = feed.status === 'loading';
  const error = feed.error;
  const rows = useMemo(() => feed.loaded?.rows ?? [], [feed.loaded]);
  const total = feed.loaded?.total ?? null;
  const hasMore = feed.loaded?.hasMore ?? false;

  const { real: realRows, demo: demoRows } = useMemo(() => splitDemoRows(rows), [rows]);
  const displayRows = urlView.hideDemo ? realRows : rows;

  const sealable = useMemo(
    () => displayRows.filter((row) => !isDemoRow(row)).map((row) => ({ id: String(row.id), payout: row.payout })),
    [displayRows]
  );
  const sealIds = useMemo(() => sealable.map((row) => row.id), [sealable]);
  const { seals, error: sealsError } = useArkivSeals(address ?? '', sealIds);

  const summary = useMemo(() => summarizeRealRows(rows), [rows]);

  const [exporting, setExporting] = useState(false);
  const [exportedRows, setExportedRows] = useState<number | null>(null);
  const toast = useToast();

  const handleExport = useCallback(async () => {
    if (!address || exporting) return;
    setExporting(true);
    try {
      const all = await fetchAllFilteredBetHistory(address, urlView.filters);
      const exportable = urlView.hideDemo ? all.filter((row) => !isDemoRow(row)) : all;
      if (exportable.length === 0) {
        toast.info('Nothing to export for this filter');
        return;
      }
      const csv = buildHistoryCsv(exportable);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = buildHistoryExportFilename({ address, filters: urlView.filters });
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setExportedRows(exportable.length);
      toast.success(`Exported ${exportable.length} round${exportable.length === 1 ? '' : 's'} to CSV`);
    } catch (err) {
      console.error('[history] export failed', err);
      toast.error('Export failed — please retry');
    } finally {
      setExporting(false);
    }
  }, [address, exporting, urlView, toast]);

  if (!isConnected || !address) {
    return (
      <div className="flex h-full w-full flex-col bg-white font-tight text-ink">
        <SiteNav wide right={<WalletConnect />} />
        <main className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-surface text-faint">
              <Wallet size={22} />
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-ink">Connect to see your history</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Your settled rounds are stored against your wallet address, so the ledger needs a wallet
              to read.
            </p>
            <Link
              href="/trade"
              className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[15px] font-semibold text-ink ring-1 ring-ink/[0.08] transition-colors hover:ring-ink/25"
            >
              <ArrowLeft size={16} />
              Back to trade
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <SiteNav
        wide
        right={
          <>
            <Link
              href="/trade"
              className="hidden h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-ink sm:inline-flex"
            >
              <ArrowLeft size={15} />
              Trade
            </Link>
            <WalletConnect />
          </>
        }
      />

      <main className="mx-auto max-w-[1200px] px-5 pb-16 pt-8 sm:px-8">
        <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 font-jet text-[11px] uppercase tracking-[0.14em] text-faint">
              <ClockCounterClockwise size={14} />
              Trade history
            </div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
              Every trade and round you settled
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
              Stock trades from the chain, rounds from the ledger. Nothing here moves your balance.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1.5 font-jet text-xs text-muted ring-1 ring-ink/[0.06] backdrop-blur-xl">
              <ShieldCheck size={14} className="text-up" />
              {shortenAddress(address)}
            </span>
            <button
              type="button"
              onClick={() => setReloadToken((t) => t + 1)}
              disabled={loading}
              className={cx(
                'inline-flex h-9 items-center gap-2 rounded-full bg-white/70 px-3.5 text-sm font-medium text-ink ring-1 ring-ink/[0.06] backdrop-blur-xl transition-colors hover:ring-ink/25 disabled:opacity-40'
              )}
            >
              {loading ? <CircleNotch size={15} className="animate-spin" /> : <ArrowsLeftRight size={15} />}
              Refresh
            </button>
          </div>
        </header>

        <div className="mb-6">
          <StockTrades wallet={address} />
        </div>

        <section aria-label="Round summary" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Rounds loaded"
            value={summary.rounds.toLocaleString()}
            sub={
              summary.practiceRounds > 0
                ? `+${summary.practiceRounds} practice (not counted)`
                : 'This page, real money only'
            }
          />
          <Stat label="Win rate" value={`${summary.winRate.toFixed(1)}%`} sub={`${summary.wins}W / ${summary.losses}L`} />
          <Stat label="Wagered" value={formatAmount(summary.wagered)} sub="USDC staked" />
          <Stat
            label="Net (this page)"
            value={`${summary.net >= 0 ? '+' : '−'}${formatAmount(Math.abs(summary.net))}`}
            sub={`credited ${formatAmount(summary.credited)}`}
            tone={summary.net > 0 ? 'up' : summary.net < 0 ? 'down' : 'neutral'}
          />
        </section>

        <div className="space-y-5">
          <HistoryFilters
            view={draft}
            onPatch={patchView}
            onClear={clearFilters}
            onExport={handleExport}
            exporting={exporting}
            exportedRows={exportedRows}
            disabled={loading}
          />

          {error && (
            <HistoryErrorCard
              error={error}
              onClearFilters={clearFilters}
              onRetry={() => setReloadToken((t) => t + 1)}
            />
          )}

          <section className="rounded-3xl bg-white/70 p-5 ring-1 ring-ink/[0.06] backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between">
              <Label>Settled rounds</Label>
              {total !== null && !error && (
                <span className="font-jet text-[11px] text-faint">
                  {total.toLocaleString()} matching {(total === 1 ? 'round' : 'rounds')}
                </span>
              )}
            </div>

            {loading ? (
              <HistoryTable rows={[]} loading wallet={address} skeletonRows={Math.min(urlView.limit, 8)} />
            ) : error ? (
              <HistoryErrorBody />
            ) : displayRows.length === 0 ? (
              rows.length > 0 && urlView.hideDemo ? (
                <HistoryAllPracticeState
                  count={demoRows.length}
                  onShow={() => patchView({ hideDemo: false })}
                />
              ) : (
                <HistoryEmptyState filtered={!isDefaultView(urlView)} onClear={clearFilters} />
              )
            ) : (
              <>
                <HistoryTable rows={displayRows} loading={false} wallet={address} seals={seals} />
                <div className="mt-4">
                  <HistoryPager
                    offset={urlView.offset}
                    limit={urlView.limit}
                    total={total}
                    rowCount={displayRows.length}
                    hasMore={hasMore}
                    loading={false}
                    onPageChange={(next) => patchView({ offset: next })}
                    onLimitChange={(next) => patchView({ limit: next })}
                  />
                </div>
                <div className="mt-3">
                  <ArkivSummary seals={seals} error={sealsError} rows={sealable} />
                </div>
              </>
            )}
          </section>

          <EpochStrip />

        </div>
      </main>
    </div>
  );
}

const HistoryErrorCard: React.FC<{
  error: ShownError;
  onClearFilters: () => void;
  onRetry: () => void;
}> = ({ error, onClearFilters, onRetry }) => {
  const copy =
    error.kind === 'unauthorized'
      ? {
          title: 'This session is not authorised for ledger reads',
          hint: 'The balance session was not accepted (HTTP 401). Your rounds are safe — retry and the app will re-mint the session.',
          cta: 'Re-authorise & retry',
        }
      : error.kind === 'invalid'
        ? {
            title: 'These filters were rejected by the ledger',
            hint: 'The URL carries a filter the server could not parse (HTTP 400). Nothing was changed — clear the filters to get back to your rounds.',
            cta: 'Reset filters',
          }
        : error.kind === 'network'
          ? {
              title: 'Could not reach the ledger',
              hint: 'The request never got an answer. This is a connection problem, not an empty history.',
              cta: 'Retry',
            }
          : {
              title: 'The ledger query failed',
              hint: 'The server reported an error (HTTP 5xx). Your history is intact — this is the house side of the read failing.',
              cta: 'Retry',
            };

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-down-soft px-5 py-4 ring-1 ring-down/20"
    >
      <div className="flex items-start gap-3">
        <WarningCircle size={18} className="mt-0.5 shrink-0 text-down" />
        <div>
          <p className="text-sm font-semibold text-ink">{copy.title}</p>
          <p className="mt-0.5 text-xs text-muted">{copy.hint}</p>
          <p className="mt-0.5 font-jet text-[11px] text-faint">{error.message}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={error.kind === 'invalid' ? onClearFilters : onRetry}
        className="inline-flex h-9 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-ink ring-1 ring-ink/[0.08] transition-colors hover:ring-ink/25"
      >
        <ArrowsLeftRight size={15} />
        {copy.cta}
      </button>
    </div>
  );
};

const HistoryErrorBody: React.FC = () => (
  <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-down/30 bg-down-soft/60 px-6 py-12 text-center">
    <WarningCircle size={22} className="text-down" />
    <p className="text-[15px] font-semibold text-ink">This page could not be read</p>
    <p className="max-w-sm text-sm leading-relaxed text-muted">
      Use Retry above. We are not showing “no settled rounds yet” — the read simply failed, and the
      two are not the same thing.
    </p>
  </div>
);

const HistoryAllPracticeState: React.FC<{ count: number; onShow: () => void }> = ({ count, onShow }) => (
  <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-line bg-white/60 px-6 py-12 text-center">
    <p className="text-[15px] font-semibold text-ink">
      This page only holds practice rounds ({count} of them)
    </p>
    <p className="max-w-sm text-sm leading-relaxed text-muted">
      Real-money rows may exist on other pages. Show practice rounds again to see the whole ledger.
    </p>
    <button
      type="button"
      onClick={onShow}
      className="mt-1 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink ring-1 ring-ink/[0.08] transition-colors hover:ring-ink/25"
    >
      Show practice rounds
    </button>
  </div>
);

const Stat: React.FC<{
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down' | 'neutral';
}> = ({ label, value, sub, tone = 'neutral' }) => (
  <div className="rounded-3xl bg-white/70 px-4 py-3.5 ring-1 ring-ink/[0.06] backdrop-blur-xl">
    <div className="flex items-center justify-between gap-2">
      <span className="font-jet text-[11px] uppercase tracking-[0.12em] text-faint">{label}</span>
      {tone !== 'neutral' && <Badge tone={tone}>{tone === 'up' ? 'profit' : 'loss'}</Badge>}
    </div>
    <div
      className={cx(
        'mt-1.5 font-jet text-[19px] font-medium tabular-nums',
        tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink'
      )}
    >
      {value}
    </div>
    {sub && <div className="mt-0.5 truncate font-jet text-[11px] text-faint">{sub}</div>}
  </div>
);

export default function HistoryPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-full bg-white px-6 py-16">
          <div className="mx-auto h-10 w-64 max-w-[1200px] animate-pulse rounded-2xl bg-ink/[0.05]" />
        </div>
      }
    >
      <HistoryPageInner />
    </Suspense>
  );
}
