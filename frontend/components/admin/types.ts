/**
 * Shared shapes for the admin dashboard panels (extracted from the old
 * monolithic page; field names mirror the API responses).
 */

import { isArcAsset } from '@/lib/arc/config';

export interface NetworkPnLRow {
    volume: number;
    payout: number;
    platformPnL: number;
}

export interface ModeStats {
    totalVolume: number;
    totalBets: number;
    platformPnL: number;
    /** House edge Σ(stake−payout) per `bet_history.network` in that chain's native units */
    platformPnLByNetwork?: Record<string, NetworkPnLRow>;
    totalUsers: number;
    totalReferrals: number;
    /** Mean session length from `user_sessions` (ping tracker); seconds. */
    averageSessionSeconds?: number;
    sessionSampleCount?: number;
}

export interface Stats {
    demo: ModeStats;
    real: ModeStats;
}

export interface UserRow {
    user_address: string;
    username: string | null;
    currency: string;
    balance: number;
    status?: string;
    updated_at: string;
    activity: {
        totalBets: number;
        totalVolume: number;
        wins: number;
    };
    referral?: {
        referral_code: string;
        referral_count: number;
        referred_by?: string | null;
    };
}

export interface Transaction {
    id: number;
    user_address: string;
    operation_type: 'deposit' | 'withdrawal' | string;
    amount: number;
    currency: string;
    transaction_hash: string;
    created_at: string;
}

export interface MarketToken {
    symbol: string;
    price: number;
    category: string;
}

export interface BetHistory {
    id: string;
    wallet_address: string;
    asset: string;
    direction: 'UP' | 'DOWN' | string;
    amount: number;
    payout: number;
    won: boolean;
    mode?: string;
    network?: string;
    created_at: string;
}

export interface BannedWalletRow {
    wallet_address: string;
    reason: string | null;
    created_at: string;
}

export interface TreasuryBalanceApiRow {
    chain: string;
    label: string;
    address: string;
    asset: string;
    balance: number | null;
    formatted: string;
    balanceUsd: number | null;
    formattedUsd: string;
    unitUsd: number | null;
    explorerUrl: string | null;
    error: string | null;
}

/** A row of /api/admin/withdrawal-requests/pending (signed_at powers the countdown). */
export interface PendingWithdrawal {
    id: number;
    user_address: string;
    currency: string;
    amount: number;
    net_amount?: number | null;
    fee_amount?: number | null;
    requested_at: string | null;
    status: string;
    decided_by?: string | null;
    tx_hash?: string | null;
    created_at?: string;
    signed_at?: number | string | null;
}

/** Debited but not settled: a payout still running, or one parked for an operator. */
export interface UnresolvedWithdrawal {
    id: number;
    user_address: string;
    currency: string;
    amount: number;
    net_amount?: number | null;
    status: string;
    notes?: string | null;
    decided_at?: string | null;
}

export interface Paged<T> {
    total?: number;
    limit?: number;
    offset?: number;
}

export const MARKET_CATEGORY_ORDER = ['Crypto', 'Forex', 'Metals', 'Stocks', 'Commodities'] as const;

/** Ledger token ticker for bet_history.network. */
export function tokenSymbolForNetwork(net: string): string {
    const u = (net ?? '').trim().toUpperCase();
    try {
        return isArcAsset(u) ? u : 'USDC';
    } catch {
        return 'USDC';
    }
}
