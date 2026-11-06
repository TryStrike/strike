import { create } from 'zustand';
import { useStore } from '@/lib/store';
import type { AssetType } from '@/lib/utils/priceFeed';

export interface TableAction {
  type: 'show_table';
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
}

export interface ChartAction {
  type: 'show_chart';
  symbol: string;
  points: { at: number; price: number }[];
}

export interface Ticket {
  symbol: AssetType;
  direction: 'UP' | 'DOWN';
  amount: number;
  seconds: number;
}

interface CopilotView {
  table: TableAction | null;
  chart: ChartAction | null;
  ticket: Ticket | null;
  closeTable: () => void;
  closeChart: () => void;
  clearTicket: () => void;
}

export const useCopilotView = create<CopilotView>((set) => ({
  table: null,
  chart: null,
  ticket: null,
  closeTable: () => set({ table: null }),
  closeChart: () => set({ chart: null }),
  clearTicket: () => set({ ticket: null }),
}));

let navigate: ((path: string) => void) | null = null;

export function setNavigator(push: (path: string) => void): void {
  navigate = push;
}

function go(path: string): void {
  if (useCopilotView.getState().ticket) throw new Error('A trade ticket is open, so the copilot did not navigate away');
  if (!navigate) throw new Error('Copilot navigation is not ready');
  navigate(path);
}

type Action = Record<string, unknown>;

const text = (action: Action, key: string): string => {
  const value = action[key];
  if (typeof value !== 'string') throw new Error(`Copilot action is missing ${key}`);
  return value;
};

const HANDLERS: Record<string, (action: Action) => void> = {
  show_table: (action) => {
    if (!Array.isArray(action.columns) || !Array.isArray(action.rows)) throw new Error('show_table action is malformed');
    useCopilotView.setState({ table: { ...(action as unknown as TableAction), title: text(action, 'title') } });
  },
  show_chart: (action) => {
    if (!Array.isArray(action.points)) throw new Error('show_chart action is malformed');
    useCopilotView.setState({ chart: { ...(action as unknown as ChartAction), symbol: text(action, 'symbol') } });
  },
  open_page: (action) => go(text(action, 'page')),
  open_market: (action) => {
    const symbol = text(action, 'symbol') as AssetType;
    go('/trade');
    useStore.getState().setSelectedAsset(symbol);
  },
  fill_trade_ticket: (action) => {
    const direction = text(action, 'direction');
    if (direction !== 'UP' && direction !== 'DOWN') throw new Error('Ticket direction must be UP or DOWN');
    if (typeof action.amount !== 'number' || typeof action.seconds !== 'number') throw new Error('Ticket is malformed');
    const ticket: Ticket = { symbol: text(action, 'symbol') as AssetType, direction, amount: action.amount, seconds: action.seconds };
    const store = useStore.getState();
    store.setGameMode('binomo');
    store.setSelectedAsset(ticket.symbol);
    useCopilotView.setState({ ticket });
    navigate?.('/trade');
  },
};

export function dispatch(action: unknown): void {
  const typed = action as Action | null;
  const handler = typeof typed?.type === 'string' ? HANDLERS[typed.type] : undefined;
  if (!handler || !typed) throw new Error(`Copilot sent an action it may not run: ${String(typed?.type)}`);
  handler(typed);
}
