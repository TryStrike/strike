'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleNotch, MagnifyingGlass } from '@phosphor-icons/react';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';
import { Badge, Button, Segmented, cx } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import {
  buildBoardUrl,
  buildWalletUrl,
  displayNameOf,
  formatGap,
  formatMetricValue,
  formatMoney,
  formatSignedMoney,
  freshnessText,
  hasUsername,
  isSyncDue,
  metricLabel,
  metricValueOf,
  partialWindowNotice,
  POLL_MS,
  windowLabel,
  WINDOW_OPTIONS,
  METRIC_OPTIONS,
  type BoardMeta,
  type BoardResponse,
  type LeaderboardMetric,
  type LeaderboardRow,
  type LeaderboardWindow,
  type MeResponse,
  type YourStanding,
} from '@/lib/leaderboard';

export default function LeaderboardPage() {
  const [windowKey, setWindowKey] = useState<LeaderboardWindow>('30d');
  const [asset, setAsset] = useState('ALL');
  const [metric, setMetric] = useState<LeaderboardMetric>('netPnl');
  const [entries, setEntries] = useState<LeaderboardRow[]>([]);
  const [boardAssets, setBoardAssets] = useState<string[]>([]);
  const [meta, setMeta] = useState<BoardMeta | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<YourStanding | null>(null);
  const [search, setSearch] = useState('');

  const address = useStore((s) => s.address);
  const isConnected = useStore((s) => s.isConnected);

  const boardToken = useRef(0);
  const meToken = useRef(0);

  const loadBoard = useCallback(async () => {
    const token = ++boardToken.current;
    setLoading(true);
    try {
      const res = await fetch(buildBoardUrl({ window: windowKey, asset, metric }));
      if (!res.ok) throw new Error(`leaderboard ${res.status}`);
      const data = (await res.json()) as BoardResponse;
      if (token !== boardToken.current) return;
      setEntries(data.leaderboard);
      setBoardAssets(data.assets.map((a) => a.asset));
      setMeta(data.meta);
      setFailed(false);
    } catch (err) {
      if (token === boardToken.current) setFailed(true);
      console.error('leaderboard read failed', err);
    } finally {
      if (token === boardToken.current) setLoading(false);
    }
  }, [windowKey, asset, metric]);

  const loadMe = useCallback(async () => {
    const token = ++meToken.current;
    if (!isConnected || !address) return setMe(null);
    const url = buildWalletUrl({ wallet: address, window: windowKey, asset, metric });
    let res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) {
      const { ensureBalanceSession } = await import('@/lib/balance/balanceClientHeaders');
      await ensureBalanceSession();
      res = await fetch(url, { credentials: 'include' });
    }
    if (token !== meToken.current) return;
    setMe(res.ok ? ((await res.json()) as MeResponse).me : null);
  }, [isConnected, address, windowKey, asset, metric]);

  useEffect(() => {
    let lastSync = 0;
    const sync = () => {
      lastSync = Date.now();
      void loadBoard();
      void loadMe().catch((err) => console.error('rank read failed', err));
    };
    const tick = () => {
      if (document.visibilityState === 'visible' && isSyncDue(Date.now(), lastSync)) sync();
    };
    sync();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadBoard, loadMe]);

  const assetOptions = useMemo(() => ['ALL', ...boardAssets.filter((a) => a !== 'ALL')].slice(0, 10), [boardAssets]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter(
      (e) => e.username?.toLowerCase().includes(term) || e.wallet_address.toLowerCase().includes(term)
    );
  }, [entries, search]);

  const partial = partialWindowNotice(meta);
  const updated = meta ? freshnessText(meta.updatedAt, Date.now()) : '';

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <SiteNav wide right={<WalletConnect />} />
      <main className="mx-auto max-w-[1000px] px-5 pb-16 pt-8 sm:px-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">Leaderboard</h1>
            <p className="mt-1 text-sm text-muted">Settled real-money rounds only.</p>
          </div>
          <label className="flex h-10 w-full items-center gap-2 rounded-full px-4 ring-1 ring-ink/[0.08] focus-within:ring-ink/30 sm:w-64">
            <MagnifyingGlass size={15} className="text-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search trader"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
        </header>

        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Segmented
            className="w-full sm:w-auto sm:min-w-[340px]"
            options={WINDOW_OPTIONS.map((w) => ({ value: w.key, label: w.label }))}
            value={windowKey}
            onChange={setWindowKey}
          />
          <Segmented
            className="w-full sm:w-auto sm:min-w-[340px]"
            options={METRIC_OPTIONS.map((m) => ({ value: m.key, label: m.label }))}
            value={metric}
            onChange={setMetric}
          />
        </div>

        {assetOptions.length > 1 && (
          <div className="mb-5 flex flex-wrap gap-1.5">
            {assetOptions.map((a) => (
              <button
                key={a}
                onClick={() => setAsset(a)}
                aria-pressed={asset === a}
                className={cx(
                  'h-8 rounded-full px-3 font-jet text-xs',
                  asset === a ? 'bg-ink text-white' : 'bg-surface text-muted'
                )}
              >
                {a}
              </button>
            ))}
          </div>
        )}

        <YourRank me={me} connected={isConnected && !!address} windowKey={windowKey} />

        {partial && (
          <p role="status" className="mb-4 rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
            {partial.detail}
          </p>
        )}

        <section className="overflow-hidden rounded-3xl ring-1 ring-ink/[0.06]">
          <div className="grid grid-cols-[48px_1fr_auto] items-center gap-3 border-b border-line px-5 py-3 font-jet text-[11px] uppercase tracking-[0.14em] text-faint sm:grid-cols-[56px_1fr_90px_90px_130px]">
            <span>Rank</span>
            <span>Trader</span>
            <span className="hidden text-right sm:block">Rounds</span>
            <span className="hidden text-right sm:block">Win rate</span>
            <span className="text-right">{metricLabel(metric)}</span>
          </div>

          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-faint">
              <CircleNotch size={16} className="animate-spin" /> Loading
            </div>
          ) : rows.length === 0 ? (
            <p className="py-20 text-center text-sm text-faint">
              {failed
                ? 'Board unavailable. Retrying.'
                : search
                  ? `No trader matches "${search}".`
                  : `No settled rounds for ${windowLabel(windowKey).toLowerCase()} yet.`}
            </p>
          ) : (
            <ol className={cx('divide-y divide-line', loading && 'opacity-60')}>
              {rows.map((e) => (
                <Row key={`${e.rank}-${e.wallet_address}`} entry={e} metric={metric} />
              ))}
            </ol>
          )}
        </section>

        {meta && (
          <p className="mt-4 font-jet text-xs text-faint">
            {meta.shown ?? rows.length} of {meta.walletsOnBoard ?? rows.length} wallets
            {updated ? ` · updated ${updated}` : ''}
          </p>
        )}
      </main>
    </div>
  );
}

function Row({ entry, metric }: { entry: LeaderboardRow; metric: LeaderboardMetric }) {
  const value = metricValueOf(entry, metric);
  const top = entry.rank <= 3;
  return (
    <li className="grid grid-cols-[48px_1fr_auto] items-center gap-3 px-5 py-3.5 sm:grid-cols-[56px_1fr_90px_90px_130px]">
      <span className={cx('font-jet text-sm tabular-nums', top ? 'font-semibold text-ink' : 'text-faint')}>
        {entry.rank}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium">{displayNameOf(entry)}</p>
        {hasUsername(entry) && <p className="truncate font-jet text-xs text-faint">{entry.wallet_address}</p>}
      </div>
      <span className="hidden text-right font-jet text-sm tabular-nums text-muted sm:block">{entry.total_bets}</span>
      <span className="hidden text-right font-jet text-sm tabular-nums text-muted sm:block">
        {entry.win_rate.toFixed(1)}%
      </span>
      <span
        className={cx(
          'text-right font-jet text-sm font-semibold tabular-nums',
          metric === 'netPnl' ? (value >= 0 ? 'text-up' : 'text-down') : 'text-ink'
        )}
      >
        {metric === 'netPnl' ? formatSignedMoney(value) : formatMetricValue(value, metric)}
      </span>
    </li>
  );
}

function YourRank({
  me,
  connected,
  windowKey,
}: {
  me: YourStanding | null;
  connected: boolean;
  windowKey: LeaderboardWindow;
}) {
  const setConnectModalOpen = useStore((s) => s.setConnectModalOpen);

  if (!connected) {
    return (
      <div className="mb-5 flex items-center justify-between gap-4 rounded-3xl bg-surface px-5 py-4">
        <p className="text-sm text-muted">Connect to see where you rank.</p>
        <Button size="sm" onClick={() => setConnectModalOpen(true)}>
          Connect
        </Button>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="mb-5 rounded-3xl bg-surface px-5 py-4 text-sm text-muted">
        Unranked for {windowLabel(windowKey).toLowerCase()}. One settled round puts you on the board.
      </div>
    );
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-3xl bg-up-soft px-5 py-4">
      <div>
        <p className="font-jet text-[11px] uppercase tracking-[0.14em] text-up">Your rank</p>
        <p className="font-jet text-2xl font-semibold tabular-nums">
          #{me.rank}
          <span className="text-sm font-normal text-faint"> / {me.walletsOnBoard}</span>
        </p>
      </div>
      <Stat label="Net PnL" value={formatSignedMoney(me.net_pnl)} tone={me.net_pnl >= 0 ? 'up' : 'down'} />
      <Stat label="Record" value={`${me.wins}W ${me.losses}L`} />
      <Stat label="Volume" value={formatMoney(me.total_volume)} />
      <div className="ml-auto text-right text-sm text-muted">
        {me.gapToNextRank == null ? 'Top of the board' : `${formatGap(me.gapToNextRank, me.metric)} to climb`}
        {me.estimated && (
          <span className="ml-2">
            <Badge>estimated</Badge>
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <p className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className={cx('font-jet text-base font-semibold tabular-nums', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>
        {value}
      </p>
    </div>
  );
}
