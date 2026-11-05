import { create } from 'zustand';

export interface TableAction {
  type: 'show_table';
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
}

interface CopilotView {
  table: TableAction | null;
  closeTable: () => void;
}

export const useCopilotView = create<CopilotView>((set) => ({
  table: null,
  closeTable: () => set({ table: null }),
}));

function isTable(action: Record<string, unknown>): action is Record<string, unknown> & TableAction {
  return typeof action.title === 'string' && Array.isArray(action.columns) && Array.isArray(action.rows);
}

/** The only actions the copilot may run. Anything else is refused. */
const HANDLERS: Record<string, (action: Record<string, unknown>) => void> = {
  show_table: (action) => {
    if (!isTable(action)) throw new Error('show_table action is malformed');
    useCopilotView.setState({ table: action });
  },
};

export function dispatch(action: unknown): void {
  const typed = action as Record<string, unknown> | null;
  const handler = typeof typed?.type === 'string' ? HANDLERS[typed.type] : undefined;
  if (!handler || !typed) throw new Error(`Copilot sent an action it may not run: ${String(typed?.type)}`);
  handler(typed);
}
