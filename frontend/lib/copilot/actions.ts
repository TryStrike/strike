import { create } from 'zustand';

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

interface CopilotView {
  table: TableAction | null;
  chart: ChartAction | null;
  closeTable: () => void;
  closeChart: () => void;
}

export const useCopilotView = create<CopilotView>((set) => ({
  table: null,
  chart: null,
  closeTable: () => set({ table: null }),
  closeChart: () => set({ chart: null }),
}));

let navigate: ((path: string) => void) | null = null;

/** The launcher hands over the app router once it mounts. */
export function setNavigator(push: (path: string) => void): void {
  navigate = push;
}

function go(path: string): void {
  if (!navigate) throw new Error('Copilot navigation is not ready');
  navigate(path);
}

type Action = Record<string, unknown>;

const text = (action: Action, key: string): string => {
  const value = action[key];
  if (typeof value !== 'string') throw new Error(`Copilot action is missing ${key}`);
  return value;
};

/** The only actions the copilot may run. Anything else is refused. */
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
};

export function dispatch(action: unknown): void {
  const typed = action as Action | null;
  const handler = typeof typed?.type === 'string' ? HANDLERS[typed.type] : undefined;
  if (!handler || !typed) throw new Error(`Copilot sent an action it may not run: ${String(typed?.type)}`);
  handler(typed);
}
