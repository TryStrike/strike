
import { create } from "zustand";
import { WalletState, createWalletSlice } from "./walletSlice";
import { GameState, createGameSlice } from "./gameSlice";
import { HistoryState, createHistorySlice } from "./historySlice";
import { BalanceState, createBalanceSlice } from "./balanceSlice";
import { ReferralState, createReferralSlice } from "./referralSlice";

type Store = WalletState & GameState & HistoryState & BalanceState & ReferralState;

export const useStore = create<Store>()((...args) => ({
  ...createWalletSlice(...args),
  ...createGameSlice(...args),
  ...createHistorySlice(...args),
  ...createBalanceSlice(...args),
  ...createReferralSlice(...args),
}));

export const useHouseBalance = () => useStore(state => state.houseBalance);
