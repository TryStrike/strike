
import { StateCreator } from "zustand";
import type { Store } from "./index";
import {
  ConnectPhase,
  ConnectEvent,
  ConnectErrorKind,
  transitionConnectPhase,
} from "@/lib/wallet/connectMachine";
import { RecentWallet, upsertRecentWallet, RECENT_WALLETS_CAP } from "@/lib/wallet/recentWallets";

export interface WalletLastError {
  kind: ConnectErrorKind;
  message: string;
  at: number;
}

export interface WalletState {
  address: string | null;
  walletBalance: number;
  isConnected: boolean;
  network: 'ARC' | null;
  selectedCurrency: string | null;
  error: string | null;
  isConnectModalOpen: boolean;

  connectPhase: ConnectPhase;
  lastError: WalletLastError | null;
  connectingSince: number | null;
  recentWallets: RecentWallet[];

  disconnect: () => void;
  refreshWalletBalance: () => Promise<void>;
  clearError: () => void;
  setConnectModalOpen: (open: boolean) => void;

  dispatchConnectEvent: (event: ConnectEvent, now?: number) => void;
  resetConnectPhase: () => void;
  setLastError: (error: { kind: ConnectErrorKind; message: string } | null, now?: number) => void;
  clearLastError: () => void;
  recordRecentWallet: (entry: { connectorId: string; name?: string; address: string }, now?: number) => void;
  setRecentWallets: (wallets: RecentWallet[]) => void;
  clearRecentWallets: () => void;

  setAddress: (address: string | null) => void;
  setIsConnected: (connected: boolean) => void;
  setNetwork: (network: 'ARC' | null) => void;
  setSelectedCurrency: (currency: string | null) => void;
}

export const createWalletSlice: StateCreator<Store, [], [], WalletState> = (set, get) => ({
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

  resetConnectPhase: () => {
    set({ connectPhase: 'idle', connectingSince: null, lastError: null });
  },

  setLastError: (error: { kind: ConnectErrorKind; message: string } | null, now?: number) => {
    set({
      lastError: error ? { kind: error.kind, message: error.message, at: now ?? Date.now() } : null,
    } as Partial<WalletState>);
  },

  clearLastError: () => {
    set({ lastError: null } as Partial<WalletState>);
  },

  recordRecentWallet: (entry: { connectorId: string; name?: string; address: string }, now?: number) => {
    const list = upsertRecentWallet(get().recentWallets, { ...entry, lastUsedAt: now ?? Date.now() });
    set({ recentWallets: list } as Partial<WalletState>);
  },

  setRecentWallets: (wallets: RecentWallet[]) => {
    set({ recentWallets: wallets.slice(0, RECENT_WALLETS_CAP) } as Partial<WalletState>);
  },

  clearRecentWallets: () => {
    set({ recentWallets: [] } as Partial<WalletState>);
  },

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
    });
  },

  refreshWalletBalance: async () => {
    const { address, isConnected } = get();

    if (!isConnected || !address) {
      return;
    }

    try {
      // A failed read keeps the last balance instead of showing a false 0.
      const { readAssetBalance } = await import('@/lib/arc/client');
      const bal = await readAssetBalance(address, 'USDC');
      set({ walletBalance: bal });
    } catch (error) {
      console.error("Error refreshing wallet balance:", error);
    }
  },

  clearError: () => {
    set({ error: null });
  },

  setConnectModalOpen: (open: boolean) => {
    set({ isConnectModalOpen: open });
  },

  setAddress: (address: string | null) => {
    set({ address });
  },

  setIsConnected: (connected: boolean) => {
    set({ isConnected: connected });
  },

  setNetwork: (network: 'ARC' | null) => {
    set({ network });
  },

  setSelectedCurrency: (currency: string | null) => {
    set({ selectedCurrency: currency });
    const { isConnected, address } = get();
    if (isConnected && address) {
      get().refreshWalletBalance();
    }
  }
});
