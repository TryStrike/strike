/**
 * Wallet state slice for Zustand store
 * Manages wallet connection status and address
 * 
 * Note: This slice is now primarily used for storing wallet state.
 * Actual wallet connection is handled by wagmi/ConnectKit against Arc.
 */

import { StateCreator } from "zustand";

export interface WalletState {
  // State
  address: string | null;
  walletBalance: number;
  isConnected: boolean;
  network: 'ARC' | null;
  selectedCurrency: string | null;
  error: string | null;
  isConnectModalOpen: boolean;

  // Actions
  disconnect: () => void;
  refreshWalletBalance: () => Promise<void>;
  clearError: () => void;
  setConnectModalOpen: (open: boolean) => void;

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

  /**
   * Disconnect wallet
   * Note: Actual disconnection is handled by Privy integration
   */
  disconnect: () => {
    const state = get() as any;
    const accountType = state.accountType;

    // Reset state
    set({
      address: null,
      walletBalance: 0,
      isConnected: false,
      network: null,
      selectedCurrency: null,
      error: null
    } as any);

    // Only clear profile data if we are NOT in demo mode AND don't have an access code
    // When exiting demo mode, we want to keep the accessCode to show the "Demo Mode" button
    // Also if the user just refreshed, we want to keep the accessCode if it exists
    const currentAccessCode = state.accessCode;
    if (accountType !== 'demo' && !currentAccessCode) {
      set({
        username: null,
        accessCode: null
      } as any);
    }
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
