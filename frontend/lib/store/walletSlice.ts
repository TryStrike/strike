/**
 * Wallet state slice for Zustand store
 * Manages wallet connection status and address
 * 
 * Note: This slice is now primarily used for storing wallet state.
 * Actual wallet connection is handled by wagmi/ConnectKit against Arc.
 */

import { StateCreator } from "zustand";
import {
  ConnectPhase,
  ConnectEvent,
  ConnectErrorKind,
  transitionConnectPhase,
} from "@/lib/wallet/connectMachine";
import { RecentWallet, upsertRecentWallet, RECENT_WALLETS_CAP } from "@/lib/wallet/recentWallets";

/** Last connection failure, classified for the UI (see CONNECT_COPY). */
export interface WalletLastError {
  kind: ConnectErrorKind;
  /** Short raw message for logging/bookkeeping; never rendered verbatim. */
  message: string;
  /** Epoch ms of the failure. */
  at: number;
}

export interface WalletState {
  // State
  address: string | null;
  walletBalance: number;
  isConnected: boolean;
  network: 'ARC' | null;
  selectedCurrency: string | null;
  error: string | null;
  isConnectModalOpen: boolean;

  // Connection state machine (pure transitions live in lib/wallet/connectMachine)
  connectPhase: ConnectPhase;
  /** Populated on CONNECT_FAILURE / RECONNECT_FAILURE; cleared on success. */
  lastError: WalletLastError | null;
  /** Epoch ms when the in-flight connect/reconnect started; null when idle. */
  connectingSince: number | null;
  /** Recently used wallets (most recent first, capped) — sessionStorage-only mirror. */
  recentWallets: RecentWallet[];

  // Actions
  disconnect: () => void;
  refreshWalletBalance: () => Promise<void>;
  clearError: () => void;
  setConnectModalOpen: (open: boolean) => void;

  // State-machine / bookkeeping actions (pure reducers, no side effects)
  dispatchConnectEvent: (event: ConnectEvent, now?: number) => void;
  resetConnectPhase: () => void;
  setLastError: (error: { kind: ConnectErrorKind; message: string } | null, now?: number) => void;
  clearLastError: () => void;
  recordRecentWallet: (entry: { connectorId: string; name?: string; address: string }, now?: number) => void;
  setRecentWallets: (wallets: RecentWallet[]) => void;
  clearRecentWallets: () => void;

  // Setters for wallet integration
  setAddress: (address: string | null) => void;
  setIsConnected: (connected: boolean) => void;
  setNetwork: (network: 'ARC' | null) => void;
  setSelectedCurrency: (currency: string | null) => void;
}

/**
 * Create wallet slice for Zustand store
 * Handles wallet state management for multi-chain integration
 */
export const createWalletSlice: StateCreator<WalletState> = (set, get) => ({
  // Initial state
  address: null,
  walletBalance: 0,
  isConnected: false,
  network: null,
  selectedCurrency: null,
  error: null,
  isConnectModalOpen: false,
  connectPhase: 'idle',
  lastError: null,
  connectingSince: null,
  recentWallets: [],

  /**
   * Advance the connection state machine via a pure transition. The phase
   * decides UI (disabled buttons + spinner while connecting/reconnecting),
   * so no async work or storage touches happen here.
   */
  dispatchConnectEvent: (event: ConnectEvent, now?: number) => {
    const state = get();
    const next = transitionConnectPhase(state.connectPhase, event);
    const inFlight = next === 'connecting' || next === 'reconnecting';
    const patch: Partial<WalletState> = { connectPhase: next };
    if (inFlight) {
      patch.connectingSince = state.connectingSince ?? (now ?? Date.now());
    } else {
      patch.connectingSince = null;
    }
    if (event.type === 'CONNECT_SUCCESS') {
      patch.lastError = null;
    } else if (event.type === 'CONNECT_FAILURE' || event.type === 'RECONNECT_FAILURE') {
      patch.lastError = {
        kind: event.error,
        message: event.message ?? '',
        at: now ?? Date.now(),
      };
    }
    set(patch);
  },

  /** Drop back to the initial phase (e.g. after a page-level reset). */
  resetConnectPhase: () => {
    set({ connectPhase: 'idle', connectingSince: null, lastError: null });
  },

  /**
   * Record a classified connection failure. `message` is kept for logging
   * only; the UI renders CONNECT_COPY[kind] instead of provider strings.
   */
  setLastError: (error: { kind: ConnectErrorKind; message: string } | null, now?: number) => {
    set({
      lastError: error ? { kind: error.kind, message: error.message, at: now ?? Date.now() } : null,
    } as Partial<WalletState>);
  },

  clearLastError: () => {
    set({ lastError: null } as Partial<WalletState>);
  },

  /**
   * Remember a wallet for one-tap reconnect. Dedupe/cap live in the pure
   * helper; sessionStorage mirroring is the caller's job (never done from
   * here, so the reducer stays pure).
   */
  recordRecentWallet: (entry: { connectorId: string; name?: string; address: string }, now?: number) => {
    const list = upsertRecentWallet(get().recentWallets, { ...entry, lastUsedAt: now ?? Date.now() });
    set({ recentWallets: list } as Partial<WalletState>);
  },

  /** Seed from sessionStorage after mount (client-only hydration). */
  setRecentWallets: (wallets: RecentWallet[]) => {
    set({ recentWallets: wallets.slice(0, RECENT_WALLETS_CAP) } as Partial<WalletState>);
  },

  clearRecentWallets: () => {
    set({ recentWallets: [] } as Partial<WalletState>);
  },

  /**
   * Disconnect wallet
   */
  disconnect: () => {
    set({
      address: null,
      walletBalance: 0,
      isConnected: false,
      network: null,
      selectedCurrency: null,
      error: null,
      connectPhase: 'disconnected',
      connectingSince: null,
      lastError: null
    } as any);
  },

  /**
   * Refresh token balance for connected wallet
   */
  refreshWalletBalance: async () => {
    const { address, isConnected } = get();

    if (!isConnected || !address) {
      return;
    }

    try {
      const { getAssetBalance } = await import('@/lib/arc/client');
      const asset = 'USDC' as const;
      const bal = await getAssetBalance(address, asset);
      set({ walletBalance: bal });
    } catch (error) {
      console.error("Error refreshing wallet balance:", error);
    }
  },

  /**
   * Clear error message
   */
  clearError: () => {
    set({ error: null });
  },

  /**
   * Set connect modal visibility
   */
  setConnectModalOpen: (open: boolean) => {
    set({ isConnectModalOpen: open });
  },

  /**
   * Set address (used by wallet integration)
   */
  setAddress: (address: string | null) => {
    set({ address });
  },

  /**
   * Set connected status (used by wallet integration)
   */
  setIsConnected: (connected: boolean) => {
    set({ isConnected: connected });
  },

  /**
   * Set active network (ARC)
   */
  setNetwork: (network: 'ARC' | null) => {
    set({ network });
  },

  /**
   * Set selected currency for the current network
   */
  setSelectedCurrency: (currency: string | null) => {
    set({ selectedCurrency: currency });
    // Trigger balance refresh when currency changes
    const { isConnected, address } = get();
    if (isConnected && address) {
      get().refreshWalletBalance();
    }
  }
});
