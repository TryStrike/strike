
import { StateCreator } from "zustand";
import type { Store } from "./index";
import { resolveHouseLedgerCurrency } from "@/lib/balance/houseLedgerCurrency";
import { ApiFailure, readApiError } from "@/lib/api/errors";
import { sendGuarded } from "@/lib/world/gate";

export interface BalanceState {
  houseBalance: number;
  /** False until a fetch lands for the current wallet and currency; houseBalance is then not meaningful. */
  houseBalanceKnown: boolean;
  userTier: 'free' | 'standard' | 'vip';
  isLoading: boolean;
  error: string | null;

  fetchBalance: (address: string) => Promise<void>;
  setBalance: (balance: number) => void;
  updateBalance: (amount: number, operation: 'add' | 'subtract') => void;
  withdrawFunds: (
    address: string,
    amount: number,
    security?: { signature?: string; signedAt?: number }
  ) => Promise<Record<string, unknown>>;
  clearError: () => void;
}

let fetchSeq = 0;

export const createBalanceSlice: StateCreator<Store, [], [], BalanceState> = (set, get) => ({
  houseBalance: 0,
  houseBalanceKnown: false,
  userTier: 'free',
  isLoading: false,
  error: null,

  fetchBalance: async (address: string) => {
    const currency = resolveHouseLedgerCurrency({
      selectedCurrency: get().selectedCurrency,
    });

    if (!address) return;
    const seq = ++fetchSeq;

    try {
      set({ isLoading: true, error: null });

      const response = await fetch(`/api/balance/${address}?currency=${currency}`);

      if (!response.ok) throw new ApiFailure(await readApiError(response));

      const data = await response.json();

      // Drop stale replies: a newer fetch started, or the wallet or currency changed meanwhile.
      const cur = get();
      if (
        seq !== fetchSeq ||
        (cur.address && cur.address.toLowerCase() !== address.toLowerCase()) ||
        resolveHouseLedgerCurrency({ selectedCurrency: cur.selectedCurrency }) !== currency
      )
        return;

      set({
        houseBalance: data.balance || 0,
        houseBalanceKnown: true,
        userTier: data.tier || 'free',
        isLoading: false,
        error: null
      });
    } catch (error) {
      console.error('Error fetching balance:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch balance'
      });
    }
  },

  setBalance: (balance: number) => {
    set({ houseBalance: balance, houseBalanceKnown: true });
  },

  updateBalance: (amount: number, operation: 'add' | 'subtract') => {
    const { houseBalance } = get();

    const newBalance = operation === 'add'
      ? houseBalance + amount
      : Math.max(0, houseBalance - amount);

    set({ houseBalance: newBalance });
  },

  withdrawFunds: async (
    address: string,
    amount: number,
    security?: { signature?: string; signedAt?: number }
  ) => {
    const currency = resolveHouseLedgerCurrency({
      selectedCurrency: get().selectedCurrency,
    });

    try {
      set({ isLoading: true, error: null });

      const response = await sendGuarded((stepupId) =>
        fetch('/api/balance/withdraw', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userAddress: address,
            amount,
            currency: currency,
            userTier: get().userTier || 'free',
            signature: security?.signature,
            signedAt: security?.signedAt,
            stepupId,
          }),
        })
      );

      if (!response.ok) throw new ApiFailure(await readApiError(response));

      const data = await response.json();

      set({
        houseBalance: data.newBalance,
        houseBalanceKnown: true,
        isLoading: false,
        error: null
      });

      setTimeout(() => get().fetchBalance(address), 1500);

      return data;
    } catch (error) {
      console.error('Error processing withdrawal:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to process withdrawal'
      });
      throw error;
    }
  },

  clearError: () => {
    set({ error: null });
  }
});
