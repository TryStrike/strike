/**
 * Non-identifying UI state for /profile.
 *
 * Policy (see lib/wallet/recentWallets.ts for the same reasoning): nothing
 * wallet-linked may be written to localStorage. What survives here is a stats
 * window choice — a UI preference that says nothing about who the player is —
 * and it lives in sessionStorage only, so it dies with the tab. Every touch is
 * defensive: disabled storage and private-mode getters must not break the page.
 */

import { getSessionStore } from '@/lib/wallet/recentWallets';
import { DEFAULT_STATS_WINDOW, isStatsWindow, type StatsWindow } from './stats';

export const STATS_WINDOW_STORAGE_KEY = 'strike_profile_stats_window';

/** Read the saved window; any unknown or corrupt value falls back to the default. */
export function loadStatsWindow(): StatsWindow {
    const store = getSessionStore();
    if (!store) return DEFAULT_STATS_WINDOW;
    try {
        const raw = store.getItem(STATS_WINDOW_STORAGE_KEY);
        return isStatsWindow(raw) ? raw : DEFAULT_STATS_WINDOW;
    } catch {
        return DEFAULT_STATS_WINDOW;
    }
}

/** Persist the window. Returns false when storage is unavailable (never throws). */
export function saveStatsWindow(window: StatsWindow): boolean {
    if (!isStatsWindow(window)) return false;
    const store = getSessionStore();
    if (!store) return false;
    try {
        store.setItem(STATS_WINDOW_STORAGE_KEY, window);
        return true;
    } catch {
        return false;
    }
}
