import { StateCreator } from 'zustand';

/**
 * The pending referral claim (a ref code someone shared with us, not yet bound).
 * Stored under the same key as before so codes captured by an earlier release
 * survive the upgrade. `null` / absent means "nothing to attach" — once a claim
 * is successfully sent to the server it is cleared so a refresh cannot re-attach
 * it (a second attempt would also be a server-side no-op).
 */
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
    } catch {
        /* storage unavailable — in-memory pending state still works for this tab */
    }
}

function removePendingCode(): void {
    try {
        window.localStorage.removeItem(PENDING_KEY);
    } catch {
        /* ignore */
    }
}

/**
 * Attribution claims already accepted by the server in THIS browser session,
 * keyed `address|code`. localStorage cannot carry this (a consumed code is
 * deleted), but a still-open tab re-POSTs the same claim when the visitor
 * refreshes a `/?ref=…` link or the sync effect re-runs after a route change.
 * The server would reject it anyway (`referred_by IS NULL`), so this guard is
 * about not making the request at all — and about a re-mounted ReferralSync
 * never re-crediting a referrer.
 */
const acceptedClaims = new Set<string>();

function claimKey(address: string, code: string): string {
    return `${canonical(address)}|${code}`;
}

function canonical(address: string): string {
    const t = (address || '').trim();
    return t.startsWith('0x') ? t.toLowerCase() : t;
}

/**
 * Counts POSTs that carried a claim. A connect sync uses this to decide whether
 * the create/load step already spoke for the pending code: if it did, the late
 * attach is skipped for this run — including when that attempt FAILED, so one
 * connect never fires two attribution POSTs back to back.
 */
let claimAttempts = 0;

export type ReferralFriendStatus = 'pending' | 'qualified';

export interface ReferralFriend {
    /** Already truncated server-side; the browser never sees a full referee address. */
    address: string;
    joinedAt: string | null;
    /**
     * `pending` = joined but no real-money bet in the ledger yet, so NO reward has
     * been earned. `qualified` = the server saw at least one non-demo bet.
     */
    status: ReferralFriendStatus;
    realBets: number;
    firstRealBetAt: string | null;
}

/**
 * Server-computed headline numbers behind the friend list. `joined` is the DB
 * total; `qualified` / `pending` always describe the page that was returned, so a
 * truncated list can never be read as "these are all my nodes".
 */
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

/**
 * Shared POST /api/referral call. The server decides create-with-referrer,
 * late-bind (only when referred_by IS NULL), or no-op, so re-sending the same
 * claim never double-increments. Returns null on any non-2xx / network failure
 * so the caller keeps the pending code for a later retry, and `'claimed'` when
 * this session already landed that exact claim — the request is then skipped
 * entirely rather than replayed.
 */
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

/** Public board entry: the address is already truncated server-side, no code. */
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
    /** Server-side totals behind the friend list (joined / qualified / pending). */
    referralTotals: ReferralTotals | null;
    isLoadingReferrals: boolean;
    /** Last friends/leaderboard refresh failed — the UI must say so, not show zeros. */
    referralLoadError: string | null;

    setReferredBy: (code: string) => void;
    clearReferredBy: () => void;
    fetchReferralInfo: (address: string) => Promise<void>;
    createReferralCode: (address: string) => Promise<string>;
    attachReferralIfPending: (address: string) => Promise<boolean>;
    /** One connect-time pass: load/create, late-attach only if nothing was sent yet. */
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

    /**
     * Capture a shared ref code. First capture wins so a single visitor can only
     * ever attach one referrer; later links on the same device are ignored.
     */
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
                // No record yet — create one server-side; this path also attaches
                // any pending referrer and consumes it exactly once.
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
            // This session already bound that exact claim; drop the local copy so
            // nothing replays it, and keep the code we already hold.
            if (pending) get().clearReferredBy();
            return get().referralCode ?? '';
        }
        set({ referralCode: data.referral_code, referralCount: data.referral_count ?? 0 });
        // The claim reached the server (created, bound, or no-op) — consume it so a
        // refresh never re-attaches.
        if (pending) get().clearReferredBy();
        return data.referral_code ?? '';
    },

    /**
     * Bind a still-pending referrer to an EXISTING record (late attribution).
     * Runs after fetchReferralInfo: if that call created the record it already
     * consumed the code, so this is a no-op; it only fires when a record predates
     * the link click. Safe to call repeatedly — the server binds at most once, and
     * a claim this session already landed is never sent again at all.
     */
    attachReferralIfPending: async (address: string) => {
        const pending = get().referredBy;
        if (!pending) return false;
        const data = await postRegistration(address, pending);
        if (!data) return false; // keep pending for the next connect; never loses the claim
        if (data === 'claimed') {
            get().clearReferredBy();
            return false;
        }
        set({ referralCode: data.referral_code, referralCount: data.referral_count ?? 0 });
        get().clearReferredBy();
        return true;
    },

    /**
     * The whole connect-time pass, in one place so a re-mounted ReferralSync runs
     * the same sequence and cannot overlap itself: load or create the record, then
     * late-attach ONLY if that step did not already carry the claim (whether it
     * succeeded or failed — a failed claim stays in storage for the next connect).
     */
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

/**
 * Defensive read of the friend rows: a missing/unknown status stays `pending`,
 * because an unverified node must never render as a reward already earned.
 */
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

/** Test-only: forget the session's landed-claim ledger. */
export function __resetAcceptedClaimsForTests(): void {
    acceptedClaims.clear();
}
