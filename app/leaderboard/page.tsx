'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Trophy,
  Pulse as Activity,
  MagnifyingGlass as Search,
  Coins as Volume,
  Target as Accuracy,
  ChartBar as VolumeBars,
  LockKey as LockKeyIcon,
  WarningCircle as WarningIcon,
} from '@phosphor-icons/react';
import GridScan from '@/components/ui/GridScan';
import { useStore } from '@/lib/store';
import { getAssetConfig, isArcAsset, type ArcAsset } from '@/lib/arc/config';
import {
  buildBoardUrl,
  buildWalletUrl,
  displayNameOf,
  formatClimbTarget,
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
  rankDenominatorLabel,
  rankFromBoardSlice,
  standingConfidence,
  utcClock,
  windowBoundaryText,
  windowLabel,
  WINDOW_OPTIONS,
  METRIC_OPTIONS,
  type BoardMeta,
  type BoardResponse,
  type LeaderboardMetric,
  type LeaderboardRow,
  type MeResponse,
  type YourStanding,
} from '@/lib/leaderboard';

/** The server truncates to `0x1234…abcd`; match that shape, nothing looser. */
function shortAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const FALLBACK_ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'BNB', 'GOLD', 'NVDA', 'TSLA'];

export default function LeaderboardPage() {
  const [windowKey, setWindowKey] = useState<'today' | '7d' | '30d' | 'all'>('30d');
  const [asset, setAsset] = useState('ALL');
  const [metric, setMetric] = useState<LeaderboardMetric>('netPnl');
  const [entries, setEntries] = useState<LeaderboardRow[]>([]);
  const [boardAssets, setBoardAssets] = useState<string[]>([]);
  const [meta, setMeta] = useState<BoardMeta | null>(null);
  const [failed, setFailed] = useState(false);
  const [boardLoading, setBoardLoading] = useState(true);

  const [me, setMe] = useState<YourStanding | null>(null);
  const [meLoading, setMeLoading] = useState(false);
  const [meDenied, setMeDenied] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [tick, setTick] = useState(() => Date.now());

  const address = useStore((s) => s.address);
  const isConnected = useStore((s) => s.isConnected);
  const setConnectModalOpen = useStore((s) => s.setConnectModalOpen);

  // Guard against a slow response for a previous tab overwriting the current one.
  const boardToken = useRef(0);
  const meToken = useRef(0);

  const loadBoard = useCallback(async () => {
    const token = ++boardToken.current;
    setBoardLoading(true);
    setFailed(false);
    try {
      const res = await fetch(buildBoardUrl({ limit: 50, window: windowKey, asset, metric }));
      if (!res.ok) throw new Error(`leaderboard ${res.status}`);
      const data = (await res.json()) as Partial<BoardResponse>;
      if (token !== boardToken.current) return;
      // Keep the previous rows painted while the new ones arrive: no collapse,
      // no reflow, just a dimmed table and a progress hairline.
      setEntries(Array.isArray(data.leaderboard) ? data.leaderboard : []);
      setBoardAssets(
        (Array.isArray(data.assets) ? data.assets : [])
          .map((a) => a.asset)
          .filter(Boolean)
      );
      setMeta((data.meta ?? null) as BoardMeta | null);
    } catch (err) {
      if (token === boardToken.current) setFailed(true);
      console.error('Failed to fetch leaderboard:', err);
    } finally {
      if (token === boardToken.current) setBoardLoading(false);
    }
  }, [windowKey, asset, metric]);

  const loadMe = useCallback(async () => {
    const token = ++meToken.current;
    if (!isConnected || !address) {
      setMe(null);
      setMeLoading(false);
      setMeDenied(false);
      return;
    }
    setMeLoading(true);
    try {
      const url = buildWalletUrl({ wallet: address, window: windowKey, asset, metric });
      let res = await fetch(url, { credentials: 'include' });
      // The wallet lookup requires the first-party balance-session cookie
      // (same guard as /api/bets/history). A deep link to /leaderboard can beat
      // the app shell's session mint, so mint once and retry on 401.
      if (res.status === 401) {
        const { ensureBalanceSession } = await import('@/lib/balance/balanceClientHeaders');
        await ensureBalanceSession();
        res = await fetch(url, { credentials: 'include' });
      }
      if (!res.ok) throw new Error(`rank ${res.status}`);
      const data = (await res.json()) as Partial<MeResponse>;
      if (token !== meToken.current) return;
      setMe((data.me ?? null) as YourStanding | null);
      setMeDenied(false);
    } catch (err) {
      // Degrade to the rank derivable from the public board slice, if any.
      if (token === meToken.current) {
        setMe(null);
        setMeDenied(true);
      }
      console.error('Failed to fetch your rank:', err);
    } finally {
      if (token === meToken.current) setMeLoading(false);
    }
  }, [isConnected, address, windowKey, asset, metric]);

  // One effect drives both reads: the board and the caller's own standing share
  // the window/asset/metric selection. Polling respects the server's
  // s-maxage=30 / 60s snapshot TTL and pauses while the tab is hidden, syncing
  // at most once per visible interval and catching up on return.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastSync = 0;

    const sync = () => {
      lastSync = Date.now();
      void loadBoard();
      void loadMe();
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === 'visible' && isSyncDue(Date.now(), lastSync)) sync();
      }, POLL_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return; // the interval no-ops while hidden
      if (isSyncDue(Date.now(), lastSync)) sync();
      start();
    };

    sync();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadBoard, loadMe]);

  // Cheap clock for the "updated Ns ago" label only.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') setTick(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const getCurrencySymbol = (network: string) =>
    isArcAsset(String(network).toUpperCase()) ? String(network).toUpperCase() : 'USDC';

  const getNetworkIcon = (network: string) =>
    getAssetConfig(getCurrencySymbol(network) as ArcAsset).logo;

  // Option list comes from the response's `assets`; the fallback is only for
  // the very first paint before the server has reported any.
  const assetChips = useMemo(() => {
    const seen = new Set<string>(['ALL']);
    boardAssets.forEach((a) => seen.add(a));
    if (seen.size === 1) FALLBACK_ASSETS.forEach((a) => seen.add(a));
    if (asset !== 'ALL') seen.add(asset);
    return [...seen].slice(0, 12);
  }, [boardAssets, asset]);

  const visible = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter(
      (e) =>
        (e.username && e.username.toLowerCase().includes(term)) ||
        e.wallet_address.toLowerCase().includes(term)
    );
  }, [entries, searchTerm]);

  const podium = visible.slice(0, 3);
  const rest = visible.slice(3);
  const hasRows = visible.length > 0;

  const winLabel = windowLabel(windowKey);
  const metricLbl = metricLabel(metric);
  const myTruncated = address ? shortAddress(address) : '';
  // Only a truncated-vs-truncated comparison: the page never needs (or gets)
  // a full address from the board.
  const fallbackRank = rankFromBoardSlice(entries, myTruncated);
  const partialNotice = partialWindowNotice(meta);
  const freshness = freshnessTextOf(meta, tick);

  return (
    <main className="min-h-screen bg-[#02040a] text-white selection:bg-purple-500/30">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none opacity-50">
        <GridScan
          sensitivity={0.01}
          lineThickness={1}
          linesColor="#14141a"
          gridScale={0.1}
          scanColor="#A855F7"
          scanOpacity={0.05}
          scanDuration={16.0}
          enablePost
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-20">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-8 mb-10">
          <div className="space-y-4">
            <div className="flex items-center gap-3 px-4 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-full w-fit">
              <Trophy className="w-4 h-4 text-purple-400" />
              <span className="text-[10px] font-black uppercase tracking-[0.3em] text-purple-400">
                Global Hall of Fame
              </span>
            </div>
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-5xl md:text-7xl font-black tracking-tighter uppercase"
              style={{ fontFamily: 'var(--font-orbitron)' }}
            >
              Top{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-400 text-glow-purple">
                Predicters
              </span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="text-white/30 text-sm font-bold uppercase tracking-widest leading-relaxed max-w-xl"
            >
              Settled real-money rounds only. Play-money bets never touch this board.
            </motion.p>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="relative group w-full md:w-80"
          >
            <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none">
              <Search className="w-4 h-4 text-white/20 group-focus-within:text-purple-400 transition-colors" />
            </div>
            <input
              type="text"
              placeholder="SEARCH TRADER..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white/5 border border-white/5 rounded-2xl pl-12 pr-6 py-4 font-mono text-[10px] tracking-widest focus:outline-none focus:border-purple-500/30 focus:bg-white/[0.08] transition-all"
            />
          </motion.div>
        </div>

        {/* Your rank card — fixed height so switching tabs never moves the page */}
        <section className="mb-6 min-h-[152px]">
          {!isConnected || !address ? (
            <div className="h-[152px] rounded-[2rem] border border-white/10 bg-white/[0.02] backdrop-blur-2xl px-8 py-7 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.3em] text-white/30">
                  <LockKeyIcon className="w-3.5 h-3.5" />
                  Where do I stand
                </p>
                <p className="text-lg font-black uppercase tracking-tight text-white/70">
                  Connect to see your rank
                </p>
                <p className="text-[11px] font-bold uppercase tracking-widest text-white/25">
                  Your position, PnL and what it takes to climb — per window, per asset.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConnectModalOpen(true)}
                className="shrink-0 px-7 py-3.5 rounded-2xl bg-purple-500/20 border border-purple-500/30 text-purple-200 text-[11px] font-black uppercase tracking-[0.2em] hover:bg-purple-500/30 transition-all"
              >
                Connect Wallet
              </button>
            </div>
          ) : meLoading && !me ? (
            <div className="h-[152px] rounded-[2rem] border border-white/10 bg-white/[0.02] px-8 py-7 flex items-center gap-4">
              <div className="animate-spin w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full" />
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/25">
                Reading your standing…
              </p>
            </div>
          ) : !me ? (
            <div className="h-[152px] rounded-[2rem] border border-white/10 bg-white/[0.02] px-8 py-7 flex flex-col justify-center gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">
                Your rank · {winLabel}
              </p>
              <p className="text-lg font-black uppercase tracking-tight text-white/70">
                {fallbackRank ? `At least #${fallbackRank} on this board` : 'Unranked'}
              </p>
              <p className="text-[11px] font-bold uppercase tracking-widest text-white/25">
                {meDenied
                  ? 'Private rank lookup unavailable right now — retrying with the board.'
                  : `No settled real-money rounds in this window${asset !== 'ALL' ? ` for ${asset}` : ''} — one settled bet puts you on the board.`}
              </p>
            </div>
          ) : (
            (() => {
              const confidence = standingConfidence(me);
              const climb = formatClimbTarget(me);
              return (
                <div className="min-h-[152px] rounded-[2rem] border border-purple-500/25 bg-purple-500/[0.06] backdrop-blur-2xl px-8 py-7 flex flex-col justify-between gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-purple-300/70">
                      Your rank · {winLabel}
                      {asset !== 'ALL' ? ` · ${asset}` : ''} · by {metricLbl}
                    </p>
                    <p
                      className={`text-[10px] font-black uppercase tracking-[0.25em] ${
                        me.estimated ? 'text-amber-300' : 'text-white/25'
                      }`}
                      title={confidence.detail}
                    >
                      {confidence.label}
                      {meLoading ? ' · refreshing' : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
                    <div className="space-y-1">
                      <p className="text-4xl font-black font-mono tracking-tighter text-white leading-none tabular-nums">
                        #{me.rank}
                        <span className="text-base text-white/25"> / {me.walletsOnBoard}</span>
                        {me.estimated ? (
                          <span className="ml-2 align-middle text-[9px] font-black uppercase tracking-widest text-amber-300/90 border border-amber-300/30 rounded-md px-1.5 py-0.5">
                            estimated
                          </span>
                        ) : null}
                      </p>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-white/20">
                        {rankDenominatorLabel(me)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[9px] font-black uppercase tracking-[0.25em] text-white/25">
                        Net PnL
                      </p>
                      <p
                        className={`text-xl font-black font-mono tracking-tighter tabular-nums ${
                          me.net_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {formatSignedMoney(me.net_pnl)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[9px] font-black uppercase tracking-[0.25em] text-white/25">
                        Record
                      </p>
                      <p className="text-xl font-black font-mono tracking-tighter text-white/70 tabular-nums">
                        {me.wins}W · {me.losses}L
                      </p>
                    </div>
                    <div className="space-y-1 ml-auto text-right">
                      <p className="text-[9px] font-black uppercase tracking-[0.25em] text-white/25">
                        To climb
                      </p>
                      <p className="text-sm font-black uppercase tracking-wider text-purple-200">
                        {me.gapToNextRank == null
                          ? `Top of ${winLabel.toLowerCase()}`
                          : formatGap(me.gapToNextRank, me.metric)}
                      </p>
                      {climb ? (
                        <p className="text-[10px] font-bold tracking-wide text-white/30 normal-case">
                          {climb}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20">
                    {me.peopleAhead === 0
                      ? 'Nobody is ahead of you in this window.'
                      : `${me.peopleAhead} ${me.peopleAhead === 1 ? 'trader is' : 'traders are'} ahead.`}
                    {me.estimated ? ' Estimated from a partial window scan.' : ''}
                  </p>
                </div>
              );
            })()
          )}
        </section>

        {/* Partial-window qualifier — visible, never a fine-print-only claim */}
        {partialNotice ? (
          <div
            role="status"
            className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-5 py-3.5"
          >
            <WarningIcon className="w-4 h-4 shrink-0 text-amber-300 mt-0.5" />
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-200/90">
              <span className="font-black mr-2">{partialNotice.label}</span>
              <span className="normal-case tracking-wide text-amber-100/60">{partialNotice.detail}</span>
            </p>
          </div>
        ) : null}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-6">
          <div
            role="tablist"
            aria-label="Time window"
            className="flex gap-1 p-1 rounded-2xl bg-white/[0.03] border border-white/5"
          >
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w.key}
                role="tab"
                aria-selected={windowKey === w.key}
                title={w.hint}
                onClick={() => setWindowKey(w.key)}
                className={`w-[92px] py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${
                  windowKey === w.key
                    ? 'bg-blue-500/25 text-blue-200'
                    : 'text-white/35 hover:text-white/60'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          <div className="flex gap-2 flex-wrap" role="group" aria-label="Asset">
            {assetChips.map((a) => (
              <button
                key={a}
                onClick={() => setAsset(a)}
                aria-pressed={asset === a}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-colors ${
                  asset === a ? 'bg-purple-500/25 text-purple-200' : 'bg-white/5 text-white/40 hover:text-white/70'
                }`}
              >
                {a}
              </button>
            ))}
          </div>

          <div className="flex gap-1 ml-auto" role="group" aria-label="Ranking metric">
            {METRIC_OPTIONS.map((m) => {
              const Icon =
                m.key === 'netPnl' ? Trophy : m.key === 'volume' ? Volume : m.key === 'winRate' ? Accuracy : VolumeBars;
              return (
                <button
                  key={m.key}
                  onClick={() => setMetric(m.key)}
                  aria-pressed={metric === m.key}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-colors ${
                    metric === m.key
                      ? 'bg-white/10 text-white'
                      : 'text-white/30 hover:text-white/60'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Podium */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {[1, 2, 3].map((slot) => {
            const entry = podium[slot - 1];
            const style =
              slot === 1
                ? 'border-amber-300/30 bg-gradient-to-b from-amber-300/[0.10] to-transparent sm:order-1'
                : slot === 2
                  ? 'border-slate-200/25 bg-gradient-to-b from-slate-200/[0.07] to-transparent sm:order-2'
                  : 'border-orange-400/25 bg-gradient-to-b from-orange-400/[0.07] to-transparent sm:order-3';
            const medal =
              slot === 1 ? 'text-amber-300' : slot === 2 ? 'text-slate-200' : 'text-orange-400';
            return (
              <div
                key={slot}
                className={`rounded-[1.75rem] border ${style} backdrop-blur-2xl px-6 py-5 flex items-center gap-4 min-h-[104px]`}
              >
                {!entry ? (
                  <div className="flex-1">
                    <div
                      className={`h-3 w-10 rounded-full ${boardLoading ? 'bg-white/10 animate-pulse' : 'bg-white/5'}`}
                    />
                    <p className="mt-3 text-[10px] font-black uppercase tracking-[0.25em] text-white/15">
                      {boardLoading ? `Slot ${slot}` : `No ${slot}${slot === 1 ? 'st' : slot === 2 ? 'nd' : 'rd'} place yet`}
                    </p>
                  </div>
                ) : (
                  <>
                    <span
                      className={`text-3xl font-black font-mono tabular-nums ${medal}`}
                      title={`Rank ${entry.rank} on ${winLabel.toLowerCase()}${partialNotice ? ' (partial window)' : ''}`}
                    >
                      #{entry.rank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black uppercase tracking-tight text-white">
                        {displayNameOf(entry)}
                      </p>
                      <p className="text-[10px] font-mono text-white/25 truncate">
                        {hasUsername(entry)
                          ? // Truncated address only: not a copy target, not a full id.
                            entry.wallet_address
                          : `${formatMetricValue(metricValueOf(entry, metric), metric)} · ${entry.total_bets} rounds`}
                      </p>
                    </div>
                    <p
                      className={`shrink-0 text-lg font-black font-mono tabular-nums ${
                        entry.net_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatSignedMoney(entry.net_pnl)}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Leaderboard table */}
        <div className="relative bg-[#050505]/80 backdrop-blur-2xl border border-white/5 rounded-[2.5rem] overflow-hidden shadow-2xl">
          <div
            className={`absolute top-0 left-0 h-px bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-300 ${
              boardLoading ? 'w-full opacity-70' : 'w-0 opacity-0'
            }`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/5 bg-white/[0.01] text-[10px] uppercase font-black tracking-widest text-white/20">
                  <th className="px-10 py-6 w-24">Rank</th>
                  <th className="px-10 py-6">Identity</th>
                  <th className="px-10 py-6 w-40">Rounds</th>
                  <th className="px-10 py-6 w-32">Win Rate</th>
                  <th className="px-10 py-6 w-36 text-right">Volume</th>
                  <th className="px-10 py-6 w-40 text-right">{metricLbl}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {boardLoading && !hasRows ? (
                  <tr>
                    <td colSpan={6} className="px-10 py-32 text-center">
                      <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-4" />
                      <p className="text-white/20 font-black uppercase text-[10px] tracking-[0.4em]">
                        Synchronizing Registry...
                      </p>
                    </td>
                  </tr>
                ) : hasRows && rest.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-10 py-14 text-center">
                      <p className="text-white/20 font-black uppercase text-[10px] tracking-[0.4em]">
                        The three traders above are the whole {winLabel} board.
                      </p>
                    </td>
                  </tr>
                ) : hasRows ? (
                  rest.map((entry) => (
                    <tr
                      key={`${entry.rank}-${entry.wallet_address}`}
                      className={`group hover:bg-white/[0.01] transition-colors ${
                        boardLoading ? 'opacity-50' : ''
                      }`}
                    >
                      <td className="px-10 py-5">
                        <span className="text-lg font-black font-mono tabular-nums text-white/20">
                          #{entry.rank}
                        </span>
                      </td>
                      <td className="px-10 py-5">
                        <div className="flex items-center gap-4">
                          <div className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center p-2 group-hover:scale-110 transition-transform">
                            <img
                              src={getNetworkIcon(entry.primary_network)}
                              alt={entry.primary_network}
                              className="w-full h-full object-contain"
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="font-black text-sm group-hover:text-purple-400 transition-colors uppercase tracking-tight truncate">
                              {displayNameOf(entry)}
                            </p>
                            <p className="text-[10px] font-mono text-white/20 truncate">
                              {hasUsername(entry)
                                ? entry.wallet_address
                                : `${entry.primary_asset} · ${getCurrencySymbol(entry.primary_network)}`}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-10 py-5">
                        <div className="space-y-1">
                          <p className="text-sm font-bold text-white/60 tabular-nums">
                            {entry.total_bets}
                          </p>
                          <div className="w-24 h-1 bg-white/5 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-white/20"
                              style={{ width: `${Math.min(100, (entry.total_bets / 100) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-10 py-5">
                        <span
                          className={`text-sm font-black px-3 py-1 rounded-lg border tabular-nums ${
                            entry.win_rate >= 50
                              ? 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5'
                              : 'text-rose-400 border-rose-400/20 bg-rose-400/5'
                          }`}
                        >
                          {entry.win_rate.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-10 py-5 text-right text-sm font-bold text-white/50 font-mono tabular-nums">
                        {formatMoney(entry.total_volume)}
                      </td>
                      <td className="px-10 py-5 text-right">
                        <p
                          className={`text-lg font-black font-mono tracking-tighter tabular-nums ${
                            metricValueOf(entry, metric) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {metric === 'netPnl'
                            ? formatSignedMoney(entry.net_pnl)
                            : formatMetricValue(metricValueOf(entry, metric), metric)}
                        </p>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-10 py-32 text-center">
                      <Activity className="w-12 h-12 text-white/5 mx-auto mb-4" />
                      <p className="text-white/20 font-black uppercase text-[10px] tracking-[0.4em]">
                        {failed
                          ? 'Board unavailable — retrying automatically.'
                          : searchTerm
                            ? `Nothing on the ${winLabel} board matches “${searchTerm}”.`
                            : 'No settled real-money bets in this range.'}
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer meta — what these numbers actually are */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[10px] font-black uppercase tracking-[0.2em] text-white/20 px-2">
          <span className="flex items-center gap-2 tabular-nums">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                meta?.stale ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'
              }`}
            />
            Updated {utcClock(meta?.updatedAt ?? null)} UTC
            {meta ? ` · ${freshness}` : ''}
            {meta?.cached ? ' · cached snapshot' : ''}
            {meta?.stale ? ' · stale' : ''}
          </span>
          <span className="text-white/15">
            {windowBoundaryText(meta)} ·{' '}
            {partialNotice
              ? `partial window · ${meta?.shown ?? 0} of ${meta?.walletsOnBoard ?? 0} wallets`
              : `${meta?.shown ?? 0} of ${meta?.walletsOnBoard ?? 0} wallets`}
          </span>
        </div>
      </div>
    </main>
  );
}

function freshnessTextOf(meta: BoardMeta | null, nowMs: number): string {
  if (!meta) return '';
  const text = freshnessText(meta.updatedAt, nowMs);
  return text ? `updated ${text}` : '';
}
