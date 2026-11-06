
import { create } from "zustand";
import { WalletState, createWalletSlice } from "./walletSlice";
import { GameState, createGameSlice } from "./gameSlice";
import { HistoryState, createHistorySlice } from "./historySlice";
import { BalanceState, createBalanceSlice } from "./balanceSlice";

export type Store = WalletState & GameState & HistoryState & BalanceState;

export const useStore = create<Store>()((...args) => ({
  ...createWalletSlice(...args),
  ...createGameSlice(...args),
  ...createHistorySlice(...args),
  ...createBalanceSlice(...args),
}));

export const useHouseBalance = () => useStore(state => state.houseBalance);
