import { StateCreator } from 'zustand';

const PENDING_KEY = 'referred_by';

function readPendingCode(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const v = window.localStorage.getItem(PENDING_KEY);
        return v && v.trim() ? v.trim() : null;
    } catch {
        return null;
    }
}

function writePendingCode(code: string): void {
    try {
        window.localStorage.setItem(PENDING_KEY, code);
    } catch {}
}

function removePendingCode(): void {
    try {
        window.localStorage.removeItem(PENDING_KEY);
    } catch {}
}

const acceptedClaims = new Set<string>();

function claimKey(address: string, code: string): string {
    return `${canonical(address)}|${code}`;
}

function canonical(address: string): string {
    const t = (address || '').trim();
    return t.startsWith('0x') ? t.toLowerCase() : t;
}

let claimAttempts = 0;

export type ReferralFriendStatus = 'pending' | 'qualified';

export interface ReferralFriend {
    address: string;
    joinedAt: string | null;
    status: ReferralFriendStatus;
    realBets: number;
    firstRealBetAt: string | null;
}

export interface ReferralTotals {
    joined: number;
    pageJoined: number;
    qualified: number;
    pending: number;
    truncated: boolean;
    qualifiedExact: boolean;
}

interface RegistrationResult {
    referral_code: string;
    referral_count: number;
}

async function postRegistration(
    address: string,
    referredByCode: string | null
): Promise<RegistrationResult | 'claimed' | null> {
    const code = referredByCode?.trim() || null;
    const key = code ? claimKey(address, code) : null;
    if (key && acceptedClaims.has(key)) return 'claimed';
    if (key) claimAttempts += 1;

    try {
        const res = await fetch('/api/referral', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, referredByCode: code ?? undefined }),
        });
        if (!res.ok) {
            console.warn('postRegistration: API returned', res.status);
            return null;
        }
        const data = await res.json();
        if (!data || typeof data.referral_code !== 'string') return null;
        if (key) acceptedClaims.add(key);
        return { referral_code: data.referral_code, referral_count: data.referral_count ?? 0 };
    } catch (error) {
        console.error('Error registering referral:', error);
        return null;
    }
}

export interface ReferralLeaderboardEntry {
    user_address: string;
    referral_count: number;
}

export interface ReferralState {
    referralCode: string | null;
    referredBy: string | null;
    referralCount: number;
    referralLeaderboard: ReferralLeaderboardEntry[];
    referralFriends: ReferralFriend[];
    referralTotals: ReferralTotals | null;
    isLoadingReferrals: boolean;
    referralLoadError: string | null;

    setReferredBy: (code: string) => void;
    clearReferredBy: () => void;
    fetchReferralInfo: (address: string) => Promise<void>;
    createReferralCode: (address: string) => Promise<string>;
    attachReferralIfPending: (address: string) => Promise<boolean>;
    syncOnConnect: (address: string) => Promise<void>;
    fetchReferralFriends: (address: string) => Promise<void>;
    fetchReferralLeaderboard: () => Promise<void>;
}

export const createReferralSlice: StateCreator<ReferralState> = (set, get) => ({
    referralCode: null,
    referredBy: readPendingCode(),
    referralCount: 0,
    referralLeaderboard: [],
    referralFriends: [],
    referralTotals: null,
    isLoadingReferrals: false,
    referralLoadError: null,

    setReferredBy: (code: string) => {
        const clean = (code || '').trim();
        if (!clean) return;
        if (get().referredBy) return;
        writePendingCode(clean);
        set({ referredBy: clean });
    },

    clearReferredBy: () => {
        removePendingCode();
        set({ referredBy: null });
    },

    fetchReferralInfo: async (address: string) => {
        try {
            const res = await fetch(`/api/referral?address=${encodeURIComponent(address)}`);
            if (!res.ok) {
                console.warn('fetchReferralInfo: API returned', res.status);
                set({ referralLoadError: 'Could not load your referral record.' });
                return;
            }
            const { referral } = await res.json();
            if (referral) {
                set({
                    referralCode: referral.referral_code,
                    referralCount: referral.referral_count,
                    referralLoadError: null,
                });
            } else {
                await get().createReferralCode(address);
            }
        } catch (error) {
            console.error('Error fetching referral info:', error);
            set({ referralLoadError: 'Could not load your referral record.' });
        }
    },

    createReferralCode: async (address: string) => {
        const pending = get().referredBy;
        const data = await postRegistration(address, pending);
        if (!data) return '';
        if (data === 'claimed') {
            if (pending) get().clearReferredBy();
            return get().referralCode ?? '';
        }
        set({ referralCode: data.referral_code, referralCount: data.referral_count ?? 0 });
        if (pending) get().clearReferredBy();
        return data.referral_code ?? '';
    },

    attachReferralIfPending: async (address: string) => {
        const pending = get().referredBy;
        if (!pending) return false;
        const data = await postRegistration(address, pending);
        if (!data) return false;
        if (data === 'claimed') {
            get().clearReferredBy();
            return false;
        }
        set({ referralCode: data.referral_code, referralCount: data.referral_count ?? 0 });
        get().clearReferredBy();
        return true;
    },

    syncOnConnect: async (address: string) => {
        const attemptsBefore = claimAttempts;
        await get().fetchReferralInfo(address);
        const claimedThisRun = claimAttempts !== attemptsBefore;
        if (!claimedThisRun) {
            await get().attachReferralIfPending(address);
        }
        await get().fetchReferralFriends(address);
    },

    fetchReferralFriends: async (address: string) => {
        try {
            const res = await fetch(
                `/api/referral?friends=1&address=${encodeURIComponent(address)}`
            );
            if (!res.ok) {
                set({ referralFriends: [], referralTotals: null, referralLoadError: 'Could not load your referred nodes.' });
                return;
            }
            const { friends, totals } = await res.json();
            set({
                referralFriends: Array.isArray(friends) ? normaliseFriends(friends) : [],
                referralTotals: normaliseTotals(totals),
                referralLoadError: null,
            });
        } catch (error) {
            console.error('Error fetching referral friends:', error);
            set({ referralFriends: [], referralTotals: null, referralLoadError: 'Could not load your referred nodes.' });
        }
    },

    fetchReferralLeaderboard: async () => {
        set({ isLoadingReferrals: true });
        try {
            const res = await fetch('/api/referral?leaderboard=1');
            if (!res.ok) {
                set({ referralLeaderboard: [], referralLoadError: 'Could not load the leaderboard.' });
                return;
            }
            const { leaderboard } = await res.json();
            if (leaderboard) set({ referralLeaderboard: leaderboard, referralLoadError: null });
        } catch (error) {
            console.error('Error fetching referral leaderboard:', error);
            set({ referralLeaderboard: [], referralLoadError: 'Could not load the leaderboard.' });
        } finally {
            set({ isLoadingReferrals: false });
        }
    },
});

function normaliseFriends(rows: unknown[]): ReferralFriend[] {
    return rows.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
            address: String(r.address ?? ''),
            joinedAt: r.joinedAt ? String(r.joinedAt) : null,
            status: r.status === 'qualified' && Number(r.realBets ?? 0) > 0 ? 'qualified' : 'pending',
            realBets: Number(r.realBets ?? 0) || 0,
            firstRealBetAt: r.firstRealBetAt ? String(r.firstRealBetAt) : null,
        };
    });
}

function normaliseTotals(raw: unknown): ReferralTotals | null {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    const num = (v: unknown, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    return {
        joined: num(t.joined),
        pageJoined: num(t.pageJoined),
        qualified: num(t.qualified),
        pending: num(t.pending),
        truncated: !!t.truncated,
        qualifiedExact: t.qualifiedExact !== false,
    };
}

export function __resetAcceptedClaimsForTests(): void {
    acceptedClaims.clear();
}
