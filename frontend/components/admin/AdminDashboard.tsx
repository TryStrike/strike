'use client';

/**
 * Admin dashboard shell.
 *
 * Owns: the auth gate (cookie-backed session probed through /api/admin/stats),
 * the deep-linked tab + filter state (everything lives in the URL so any view
 * is shareable and survives a reload), the keyboard shortcuts, and the
 * auto-refresh cadence (polling pauses while the document is hidden and a
 * refresh fires the moment the tab becomes visible again).
 *
 * Panels under components/admin/* do the data work; this file never fetches a
 * list itself.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DASHBOARD_TABS, TAB_SHORTCUT_ORDER, type DashboardTab } from '@/lib/admin/dashboardTabs';
import { LIST_MAX_LIMIT } from '@/lib/admin/listParams';
import { dashQuery, parseDashFilters, type DashFilters } from './dashQuery';
import { TabBtn } from './AdminUi';
import OverviewStatsPanel from './OverviewStatsPanel';
import TreasuryPanel from './TreasuryPanel';
import WalletIntelPanel from './WalletIntelPanel';
import UsersPanel from './UsersPanel';
import PlayerPnlPanel from './PlayerPnlPanel';
import GameplayPanel from './GameplayPanel';
import FinancialPanel from './FinancialPanel';
import MarketsPanel from './MarketsPanel';
import ReferralsPanel from './ReferralsPanel';
import AccessCodesPanel from './AccessCodesPanel';
import DangerZonePanel from './DangerZonePanel';

const TAB_LABELS: Record<DashboardTab, string> = {
    wallet_intel: 'Wallet Intel',
    users: 'Ledger',
    player_pnl: 'Player P&L',
    gameplay: 'Gameplay',
    financial: 'Financials',
    markets: 'Inventory',
    referrals: 'Referrals',
    access_codes: 'Access Codes',
    danger: 'Danger Zone',
};

/** Which ?status= values each tab understands (mirrors the route enums). */
const TAB_STATUS_OPTIONS: Partial<Record<DashboardTab, { value: string; label: string }[]>> = {
    users: [
        { value: 'active', label: 'Active' },
        { value: 'frozen', label: 'Frozen' },
        { value: 'banned', label: 'Banned' },
    ],
    player_pnl: [],
    gameplay: [
        { value: 'won', label: 'Won' },
        { value: 'lost', label: 'Lost' },
    ],
    financial: [
        { value: 'deposit', label: 'Deposits' },
        { value: 'withdrawal', label: 'Withdrawals' },
    ],
    access_codes: [
        { value: 'ready', label: 'Ready' },
        { value: 'consumed', label: 'Consumed' },
    ],
};

const AUTO_REFRESH_MS = 30_000;
const Q_DEBOUNCE_MS = 450;

const isTypingTarget = (el: EventTarget | null): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

export default function AdminDashboard() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const filters = useMemo<DashFilters>(
        () => parseDashFilters(new URLSearchParams(searchParams?.toString() ?? '')),
        [searchParams],
    );

    const [isAuthorized, setIsAuthorized] = useState(false);
    const [probing, setProbing] = useState(true);
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState<string | null>(null);
    const [loggingIn, setLoggingIn] = useState(false);
    const [sessionExpired, setSessionExpired] = useState(false);

    const [nonce, setNonce] = useState(0);
    // On-chain treasury reads are RPC-bound, so they only re-run on an explicit
    // re-sync — the 30s poll and the visibility pulse refresh the DB panels.
    const [treasuryNonce, setTreasuryNonce] = useState(0);
    const [lastSync, setLastSync] = useState<number | null>(null);
    const [autoSync, setAutoSync] = useState(true);
    const [qDraft, setQDraft] = useState(filters.q);
    const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Keep the visible search box aligned with the URL when it changes elsewhere.
    useEffect(() => setQDraft(filters.q), [filters.q]);
    useEffect(() => () => { if (qTimer.current) clearTimeout(qTimer.current); }, []);

    // ── Auth gate ────────────────────────────────────────────────────────────
    useEffect(() => {
        let alive = true;
        fetch('/api/admin/stats', { credentials: 'include' })
            .then((r) => {
                if (!alive) return;
                if (r.ok) {
                    setIsAuthorized(true);
                    setLastSync(Date.now());
                }
            })
            .catch(() => { /* treated as logged out */ })
            .finally(() => { if (alive) setProbing(false); });
        return () => { alive = false; };
    }, []);

    const handleUnauthorized = useCallback(() => {
        setIsAuthorized(false);
        setSessionExpired(true);
    }, []);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoggingIn(true);
        setLoginError(null);
        try {
            const res = await fetch('/api/admin/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ password }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body?.ok) {
                setIsAuthorized(true);
                setSessionExpired(false);
                setPassword('');
                // Panels mount on the authorized flip and fetch immediately; only
                // the header clock needs pinning.
                setLastSync(Date.now());
                return;
            }
            setLoginError(typeof body?.error === 'string' ? body.error : 'Wrong password.');
        } catch {
            setLoginError('Auth check failed. Try again.');
        } finally {
            setLoggingIn(false);
        }
    };

    const handleLogout = useCallback(async () => {
        await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
        setIsAuthorized(false);
        setSessionExpired(false);
        setPassword('');
    }, []);

    // ── URL state ────────────────────────────────────────────────────────────
    const onPatch = useCallback((patch: Partial<DashFilters>) => {
        const merged: DashFilters = { ...filters, ...patch };
        const filterKeys: (keyof DashFilters)[] = ['tab', 'q', 'status', 'currency', 'from', 'to', 'account', 'limit'];
        if (patch.offset === undefined && filterKeys.some((k) => k in patch)) merged.offset = 0;
        if (patch.tab !== undefined && patch.status === undefined && patch.tab !== filters.tab) merged.status = '';
        router.replace(`/dashboard${dashQuery(merged)}`, { scroll: false });
    }, [filters, router]);

    const bumpSync = useCallback(() => {
        setNonce((n) => n + 1);
        setTreasuryNonce((t) => t + 1);
        setLastSync(Date.now());
    }, []);

    const bumpLists = useCallback(() => {
        setNonce((n) => n + 1);
        setLastSync(Date.now());
    }, []);

    // ── Auto-refresh: paused while hidden, fires on return ───────────────────
    useEffect(() => {
        if (!isAuthorized || !autoSync) return;
        const id = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            bumpLists();
        }, AUTO_REFRESH_MS);
        return () => clearInterval(id);
    }, [isAuthorized, autoSync, bumpLists]);

    useEffect(() => {
        if (!isAuthorized) return;
        const onVisibility = () => {
            if (typeof document !== 'undefined' && !document.hidden) bumpLists();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [isAuthorized, bumpLists]);

    // ── Keyboard shortcuts: 1..9 switch tabs, r re-sync ──────────────────────
    useEffect(() => {
        if (!isAuthorized) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (isTypingTarget(e.target)) return;
            const idx = Number(e.key);
            if (Number.isInteger(idx) && idx >= 1 && idx <= TAB_SHORTCUT_ORDER.length) {
                const tab = TAB_SHORTCUT_ORDER[idx - 1];
                if (tab && tab !== filters.tab) {
                    e.preventDefault();
                    onPatch({ tab, offset: 0, status: '' });
                }
                return;
            }
            if (e.key.toLowerCase() === 'r') {
                e.preventDefault();
                bumpSync();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isAuthorized, filters.tab, onPatch, bumpSync]);

    const commitQ = (raw: string) => {
        if (qTimer.current) clearTimeout(qTimer.current);
        qTimer.current = setTimeout(() => {
            const v = raw.trim().slice(0, 100);
            if (v !== filters.q) onPatch({ q: v });
        }, Q_DEBOUNCE_MS);
    };

    // ── Login gate ───────────────────────────────────────────────────────────
    if (probing) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
                <p className="text-xs font-mono text-white/30 animate-pulse">Checking session…</p>
            </div>
        );
    }

    if (!isAuthorized) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
                <div className="w-full max-w-sm bg-white/[0.02] border border-white/10 rounded-3xl p-8 backdrop-blur-xl">
                    <div className="text-center mb-8">
                        <h2 className="text-xl font-black text-white uppercase tracking-tight">Neural Access</h2>
                        <p className="text-xs text-white/30 uppercase tracking-wide font-bold mt-2">Restricted Area</p>
                        {sessionExpired && (
                            <p className="mt-3 text-xs text-amber-400/80 font-mono">Session expired — please log in again.</p>
                        )}
                    </div>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="ACCESS KEY"
                            aria-label="Access key"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-center text-white font-mono text-sm tracking-[0.5em] placeholder:tracking-normal placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-all"
                            autoFocus
                        />
                        {loginError && (
                            <p role="alert" className="text-center text-xs font-mono text-rose-400">{loginError}</p>
                        )}
                        <button
                            type="submit"
                            disabled={loggingIn || password.length === 0}
                            className="w-full bg-white text-black font-bold uppercase tracking-widest text-xs py-3 rounded-xl hover:bg-white/90 transition-colors disabled:opacity-50"
                        >
                            {loggingIn ? 'Checking…' : 'Authorize'}
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    const statusOptions = TAB_STATUS_OPTIONS[filters.tab];
    // /api/admin/player-ledger has no status enum, so a stale ?status= deep link
    // would bounce off the route's 400 guard instead of filtering anything.
    const pnlFilters: DashFilters = filters.status ? { ...filters, status: '' } : filters;

    return (
        <div className="min-h-screen bg-[#050505] text-[#a0a0a0] p-6 lg:p-12 font-sans selection:bg-white selection:text-black">
            <div className="max-w-[1400px] mx-auto space-y-12">
                {/* Header */}
                <header className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-white/5 pb-8">
                    <div className="space-y-2">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                            <h1 className="text-sm font-bold tracking-wider text-white uppercase">System Terminal v3.1</h1>
                        </div>
                        <p className="text-4xl md:text-5xl font-black text-white tracking-tight">Core Operations</p>
                        <p className="text-[11px] font-mono text-white/25">
                            Auto-sync {autoSync ? `every ${AUTO_REFRESH_MS / 1000}s` : 'off'} · paused while this tab is hidden ·{' '}
                            {lastSync ? `last pulse ${new Date(lastSync).toLocaleTimeString()}` : 'idle'} ·{' '}
                            <span className="text-white/35">shortcuts: 1–{DASHBOARD_TABS.length} tabs, r re-sync</span>
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <button
                            type="button"
                            onClick={() => setAutoSync((v) => !v)}
                            aria-pressed={autoSync}
                            className={`px-6 py-3 border rounded-full text-xs font-black uppercase tracking-widest transition-all ${
                                autoSync
                                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200 hover:bg-emerald-500/20'
                                    : 'bg-white/5 border-white/10 text-white/40 hover:text-white'
                            }`}
                        >
                            {autoSync ? 'Live sync' : 'Sync paused'}
                        </button>
                        <button
                            type="button"
                            onClick={bumpSync}
                            className="px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs font-black text-white uppercase tracking-widest transition-all"
                        >
                            Sync Terminal
                        </button>
                        <button
                            type="button"
                            onClick={handleLogout}
                            className="px-6 py-3 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-full text-xs font-black text-rose-300 uppercase tracking-widest transition-all"
                        >
                            Log out
                        </button>
                    </div>
                </header>

                {/* Overview + treasury (always visible) */}
                <OverviewStatsPanel nonce={nonce} onUnauthorized={handleUnauthorized} />
                <TreasuryPanel nonce={treasuryNonce} onUnauthorized={handleUnauthorized} />

                {/* Navigation & global filters */}
                <div className="space-y-6">
                    <div className="flex flex-col gap-6 border-b border-white/5 pb-6">
                        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                            <nav className="flex flex-wrap gap-8" role="tablist" aria-label="Dashboard sections">
                                {DASHBOARD_TABS.map((tab, i) => (
                                    <span key={tab} className="relative">
                                        <TabBtn
                                            active={filters.tab === tab}
                                            onClick={() => onPatch({ tab, offset: 0, status: '' })}
                                            label={TAB_LABELS[tab]}
                                        />
                                        <span className="absolute -top-1 -right-4 text-[9px] font-mono text-white/15">{i + 1}</span>
                                    </span>
                                ))}
                            </nav>
                            <div className="w-full xl:w-96 relative">
                                <input
                                    type="text"
                                    placeholder="Global Search (q)…"
                                    value={qDraft}
                                    onChange={(e) => { setQDraft(e.target.value); commitQ(e.target.value); }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (qTimer.current) clearTimeout(qTimer.current);
                                            onPatch({ q: qDraft.trim().slice(0, 100) });
                                        }
                                        if (e.key === 'Escape') { setQDraft(''); onPatch({ q: '' }); }
                                    }}
                                    aria-label="Global search"
                                    className="w-full bg-white/[0.03] border border-white/10 rounded-2xl px-6 py-4 text-xs text-white focus:outline-none focus:border-white/30 transition-all"
                                />
                            </div>
                        </div>

                        {/* Filter rail — writes the same params every list route reads */}
                        <div className="flex flex-wrap gap-3 items-end">
                            {statusOptions && statusOptions.length > 0 && (
                                <label className="flex flex-col gap-1">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-white/25">Status</span>
                                    <select
                                        value={filters.status}
                                        onChange={(e) => onPatch({ status: e.target.value })}
                                        className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-white/30"
                                    >
                                        <option value="">Any</option>
                                        {statusOptions.map((o) => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] font-black uppercase tracking-widest text-white/25">Currency</span>
                                <input
                                    value={filters.currency}
                                    onChange={(e) => onPatch({ currency: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) })}
                                    placeholder="ANY"
                                    className="w-28 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] font-black uppercase tracking-widest text-white/25">From</span>
                                <input
                                    type="date"
                                    value={/^\d{4}-\d{2}-\d{2}/.test(filters.from) ? filters.from.slice(0, 10) : ''}
                                    onChange={(e) => onPatch({ from: e.target.value ? `${e.target.value}T00:00:00Z` : '' })}
                                    className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] font-black uppercase tracking-widest text-white/25">To</span>
                                <input
                                    type="date"
                                    value={/^\d{4}-\d{2}-\d{2}/.test(filters.to) ? filters.to.slice(0, 10) : ''}
                                    onChange={(e) => onPatch({ to: e.target.value ? `${e.target.value}T23:59:59Z` : '' })}
                                    className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] font-black uppercase tracking-widest text-white/25">Page size</span>
                                <select
                                    value={String(filters.limit)}
                                    onChange={(e) => onPatch({ limit: Number(e.target.value) })}
                                    className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                                >
                                    {[25, 50, 100, LIST_MAX_LIMIT].map((n) => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                            </label>
                            {(filters.q || filters.status || filters.currency || filters.from || filters.to || filters.offset > 0) && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (qTimer.current) clearTimeout(qTimer.current);
                                        setQDraft('');
                                        onPatch({ q: '', status: '', currency: '', from: '', to: '', offset: 0 });
                                    }}
                                    className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-white transition-all"
                                >
                                    Clear filters
                                </button>
                            )}
                            <span className="ml-auto text-[10px] font-mono text-white/20 self-center">
                                URL is the state — this view is shareable as-is.
                            </span>
                        </div>
                    </div>

                    {/* Active panel */}
                    <div className="bg-white/[0.01] border border-white/5 rounded-[2.5rem] overflow-hidden">
                        <div className="overflow-x-auto">
                            {filters.tab === 'wallet_intel' && (
                                <WalletIntelPanel filters={filters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'users' && (
                                <UsersPanel filters={filters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'player_pnl' && (
                                <PlayerPnlPanel filters={pnlFilters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'gameplay' && (
                                <GameplayPanel filters={filters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'financial' && (
                                <FinancialPanel
                                    filters={filters}
                                    nonce={nonce}
                                    onUnauthorized={handleUnauthorized}
                                    onPatch={onPatch}
                                    onQueueChanged={bumpLists}
                                />
                            )}
                            {filters.tab === 'markets' && (
                                <MarketsPanel filters={filters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'referrals' && (
                                <ReferralsPanel filters={filters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'access_codes' && (
                                <AccessCodesPanel filters={filters} nonce={nonce} onUnauthorized={handleUnauthorized} onPatch={onPatch} />
                            )}
                            {filters.tab === 'danger' && (
                                <DangerZonePanel
                                    filters={filters}
                                    nonce={nonce}
                                    onUnauthorized={handleUnauthorized}
                                    onPatch={onPatch}
                                    onQueueChanged={bumpLists}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
