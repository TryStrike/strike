import { StateCreator } from 'zustand';
import { supabase } from '../supabase/client';

export interface ProfileState {
    username: string | null;
    accessCode: string | null;
    isUpdatingUsername: boolean;
    recentTrades: any[];
    isLoadingTrades: boolean;
    hydrateProfile: () => void;
    fetchProfile: (address: string) => Promise<void>;
    updateUsername: (address: string, username: string) => Promise<boolean>;
    fetchRecentTrades: (address: string) => Promise<void>;
}

export const createProfileSlice: StateCreator<ProfileState> = (set, get) => ({
    username: null,
    accessCode: null,
    isUpdatingUsername: false,
    recentTrades: [],
    isLoadingTrades: false,
    hydrateProfile: () => {
        if (typeof window === 'undefined') return;
        const cached = localStorage.getItem('strike_username');
        if (cached && !get().username) set({ username: cached });
    },
    fetchProfile: async (address: string) => {
        if (!address || address.startsWith('0xDEMO')) return;
        try {
            const { data } = await supabase
                .from('user_profiles')
                .select('username')
                .eq('user_address', address)
                .single();

            if (data) {
                set({ username: data.username });
                if (typeof window !== 'undefined') {
                    if (data.username) localStorage.setItem('strike_username', data.username);
                }
            }
        } catch (error) {
            console.error('Error fetching profile:', error);
        }
    },

    updateUsername: async (address: string, username: string) => {
        set({ isUpdatingUsername: true });
        try {
            // Check if username is already taken
            const { data: existing } = await supabase
                .from('user_profiles')
                .select('user_address')
                .eq('username', username)
                .single();

            if (existing && existing.user_address !== address) {
                throw new Error('Username already taken');
            }

            const { error } = await supabase
                .from('user_profiles')
                .upsert({
                    user_address: address,
                    username: username,
                    updated_at: new Date().toISOString()
                });

            if (error) throw error;

            set({ username });
            return true;
        } catch (error: any) {
            console.error('Error updating username:', error);
            return false;
        } finally {
            set({ isUpdatingUsername: false });
        }
    },

    fetchRecentTrades: async (address: string) => {
        if (!address) return;
        set({ isLoadingTrades: true });
        try {
            // bet_history is not readable with the browser anon key after RLS hardening
            const res = await fetch(
                `/api/bets/history?wallet=${encodeURIComponent(address)}&limit=10`,
            );
            if (!res.ok) {
                console.warn('fetchRecentTrades: API error', res.status);
                set({ recentTrades: [] });
                return;
            }
            const json = (await res.json()) as { bets?: unknown[] };
            set({ recentTrades: Array.isArray(json.bets) ? json.bets : [] });
        } catch (error) {
            console.error('Error fetching recent trades:', error);
            set({ recentTrades: [] });
        } finally {
            set({ isLoadingTrades: false });
        }
    },

});
