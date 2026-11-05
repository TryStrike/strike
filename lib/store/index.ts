/**
 * Main Zustand store for STRIKE dApp
 * Combines wallet, game, history, balance, referral and profile slices.
 * Game logic is off-chain; deposits/withdrawals settle on Arc.
 */

import { create } from "zustand";
import { WalletState, createWalletSlice } from "./walletSlice";
import { GameState, createGameSlice } from "./gameSlice";
import { HistoryState, createHistorySlice } from "./historySlice";
import { BalanceState, createBalanceSlice } from "./balanceSlice";
import { ReferralState, createReferralSlice } from "./referralSlice";
import { ProfileState, createProfileSlice } from "./profileSlice";

type Store = WalletState & GameState & HistoryState & BalanceState & ReferralState & ProfileState;

export const useStore = create<Store>()((...args) => ({
  ...createWalletSlice(...args),
  ...createGameSlice(...args),
  ...createHistorySlice(...args),
  ...createBalanceSlice(...args),
  ...createReferralSlice(...args),
  ...createProfileSlice(...args)
}));

/** Individual selectors for optimized re-renders */
export const useWalletAddress = () => useStore(state => state.address);
export const useIsConnected = () => useStore(state => state.isConnected);
export const useHouseBalance = () => useStore(state => state.houseBalance);
export const useUserTier = () => useStore(state => state.userTier);

