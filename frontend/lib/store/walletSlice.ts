
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
  /** Null until a read has succeeded for this address: unknown is not zero. */
  walletBalance: number | null;
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

// Spaced out on purpose: each read already tries every RPC several times.
const WALLET_READ_RETRY_MS = [3_000, 10_000];
let walletRead = 0;

export const createWalletSlice: StateCreator<Store, [], [], WalletState> = (set, get) => ({
  address: null,
  walletBalance: null,
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
      walletBalance: null,
      houseBalanceKnown: false,
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

    // A newer read replaces this one, and its retries with it.
    const read = ++walletRead;
    const { readAssetBalance } = await import('@/lib/arc/client');

    for (let attempt = 0; ; attempt++) {
      try {
        const bal = await readAssetBalance(address, 'USDC');
        if (read === walletRead && get().address === address) set({ walletBalance: bal });
        return;
      } catch (error) {
        // A failed read keeps the last balance instead of showing a false 0.
        if (attempt === WALLET_READ_RETRY_MS.length) {
          console.error("Error refreshing wallet balance:", error);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, WALLET_READ_RETRY_MS[attempt]));
      if (read !== walletRead || get().address !== address) return;
    }
  },

  clearError: () => {
    set({ error: null });
  },

  setConnectModalOpen: (open: boolean) => {
    set({ isConnectModalOpen: open });
  },

  setAddress: (address: string | null) => {
    if (address !== get().address) set({ address, walletBalance: null, houseBalanceKnown: false } as Partial<WalletState>);
  },

  setIsConnected: (connected: boolean) => {
    set({ isConnected: connected });
  },

  setNetwork: (network: 'ARC' | null) => {
    set({ network });
  },

  setSelectedCurrency: (currency: string | null) => {
    set({ selectedCurrency: currency, houseBalanceKnown: false } as Partial<WalletState>);
    const { isConnected, address } = get();
    if (isConnected && address) {
      get().refreshWalletBalance();
    }
  }
});
