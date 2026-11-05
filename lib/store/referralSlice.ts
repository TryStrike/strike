import { StateCreator } from 'zustand';

export interface ReferralState {
    referralCode: string | null;
    referredBy: string | null;
    referralCount: number;
    referralLeaderboard: any[];
    isLoadingReferrals: boolean;

    setReferredBy: (code: string) => void;
    fetchReferralInfo: (address: string) => Promise<void>;
    createReferralCode: (address: string) => Promise<string>;
    fetchReferralLeaderboard: () => Promise<void>;
}

export const createReferralSlice: StateCreator<ReferralState> = (set, get) => ({
    referralCode: null,
    referredBy: typeof window !== 'undefined' ? localStorage.getItem('referred_by') : null,
    referralCount: 0,
    referralLeaderboard: [],
    isLoadingReferrals: false,

    setReferredBy: (code: string) => {
        if (code && !get().referredBy) {
            localStorage.setItem('referred_by', code);
            set({ referredBy: code });
        }
    },

    fetchReferralInfo: async (address: string) => {
        try {
            const res = await fetch(`/api/referral?address=${encodeURIComponent(address)}`);
            if (!res.ok) {
                console.warn('fetchReferralInfo: API returned', res.status);
                return;
            }
            const { referral } = await res.json();
            if (referral) {
                set({ referralCode: referral.referral_code, referralCount: referral.referral_count });
            } else {
                // No record yet — create one server-side
                await (get() as any).createReferralCode(address);
            }
        } catch (error) {
            console.error('Error fetching referral info:', error);
        }
    },

    createReferralCode: async (address: string) => {
        try {
            const referredByCode = get().referredBy;
            const res = await fetch('/api/referral', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ address, referredByCode: referredByCode ?? undefined }),
            });
            if (!res.ok) {
                console.warn('createReferralCode: API returned', res.status);
                return '';
            }
            const data = await res.json();
            set({ referralCode: data.referral_code, referralCount: data.referral_count ?? 0 });
            return data.referral_code ?? '';
        } catch (error) {
            console.error('Error creating referral code:', error);
            return '';
        }
    },

    fetchReferralLeaderboard: async () => {
        set({ isLoadingReferrals: true });
        try {
            const res = await fetch('/api/referral?leaderboard=1');
            if (!res.ok) return;
            const { leaderboard } = await res.json();
            if (leaderboard) set({ referralLeaderboard: leaderboard });
        } catch (error) {
            console.error('Error fetching referral leaderboard:', error);
        } finally {
            set({ isLoadingReferrals: false });
        }
    },
});
