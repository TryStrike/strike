'use client';

/**
 * Balance + tier block for /profile.
 *
 * Four distinct states, decided by the pure `resolveBalanceView` in
 * lib/profile/format.ts: disconnected, loading, failed, empty and funded. A
 * failed read says "balance could not be read" — it must never render 0.0000,
 * because that is exactly what an empty account looks like.
 */

import { CircleNotch, WarningCircle, Coins, ArrowCounterClockwise } from '@phosphor-icons/react';
import {
    BALANCE_VIEW_COPY,
    balanceIsStale,
    formatHouseCredits,
    resolveBalanceView,
    type BalanceFacts,
} from '@/lib/profile/format';
import { AddressChip } from './AddressChip';

export interface BalanceTierPanelProps {
    isConnected: boolean;
    address?: string | null;
    accountType: 'real' | 'demo';
    /** House credits from the server (real account). */
    balance: number;
    /** Practice credits (demo account). */
    demoBalance: number;
    tier: string;
    isLoading: boolean;
    error: string | null;
    loadedOnce: boolean;
    onRefresh: () => void;
}

const TIER_CLASS: Record<string, string> = {
    free: 'text-gray-400 border-gray-800 bg-gray-400/5',
    standard: 'text-amber-400 border-amber-800/30 bg-amber-400/5',
    vip: 'text-purple-400 border-purple-800/30 bg-purple-400/5',
};

export function BalanceTierPanel(props: BalanceTierPanelProps) {
    const facts: BalanceFacts = {
        isConnected: props.isConnected,
        hasAddress: !!props.address,
        isLoading: props.isLoading,
        error: props.error,
        accountType: props.accountType,
        balance: props.balance,
        loadedOnce: props.loadedOnce,
    };
    const view = resolveBalanceView(facts);
    const copy = BALANCE_VIEW_COPY[view];
    const stale = balanceIsStale(facts);
    const amount = props.accountType === 'demo' ? props.demoBalance : props.balance;

    const tierClass = TIER_CLASS[props.tier] ?? TIER_CLASS.free;

    return (
        <div className="text-right" data-testid="balance-panel" data-view={view}>
            <p className="mb-1 text-[9px] font-black uppercase tracking-[0.2em] text-white/20">{copy.label}</p>

            {view === 'loading' && (
                <div className="ml-auto w-32 space-y-1.5" aria-hidden>
                    <div className="h-5 w-28 animate-pulse rounded bg-white/10" />
                    <div className="h-2 w-20 animate-pulse rounded bg-white/5" />
                </div>
            )}

            {view === 'failed' && (
                <div className="flex flex-col items-end gap-1.5">
                    <p className="flex items-center gap-1.5 text-sm font-black uppercase tracking-widest text-rose-400">
                        <WarningCircle className="h-4 w-4" />
                        Unreadable
                    </p>
                    <p className="max-w-[240px] text-[8px] font-bold uppercase leading-relaxed tracking-widest text-white/30">
                        {copy.hint}
                    </p>
                    <button
                        type="button"
                        onClick={props.onRefresh}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-white/40 transition-all hover:text-white"
                    >
                        <ArrowCounterClockwise className="h-3 w-3" />
                        Retry balance
                    </button>
                </div>
            )}

            {(view === 'ready' || view === 'empty' || view === 'demo') && (
                <>
                    <p className="font-mono text-xl font-bold">
                        {view === 'empty' ? '—' : formatHouseCredits(amount)}{' '}
                        <span className="text-xs text-white/40">USDC</span>
                    </p>
                    <p className="mt-0.5 text-[8px] font-bold uppercase tracking-wider text-white/25">
                        {view === 'empty' ? copy.hint : view === 'demo' ? copy.hint : 'Settled in USDC on Arc'}
                    </p>
                    {stale && (
                        <p className="mt-0.5 text-[8px] font-bold uppercase tracking-wider text-amber-400/80">
                            Could not refresh — last known figure
                        </p>
                    )}
                </>
            )}

            {view === 'disconnected' && (
                <p className="text-[10px] font-black uppercase tracking-widest text-white/25">{copy.hint}</p>
            )}

            <div className="mt-2 flex items-center justify-end gap-2">
                <span className={`rounded border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${tierClass}`}>
                    {props.tier}
                </span>
                <Coins className="h-3 w-3 text-white/15" />
            </div>

            {props.isConnected && (
                <div className="mt-2 flex justify-end">
                    <AddressChip address={props.address} label="Wallet" />
                </div>
            )}

            {props.isLoading && view !== 'loading' && (
                <p className="mt-1 flex items-center justify-end gap-1 text-[8px] font-bold uppercase tracking-widest text-white/20">
                    <CircleNotch className="h-3 w-3 animate-spin" /> syncing
                </p>
            )}
        </div>
    );
}

export default BalanceTierPanel;
