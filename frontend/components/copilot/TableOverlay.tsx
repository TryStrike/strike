'use client';

import { Modal } from '@/components/ui/Modal';
import { useCopilotView } from '@/lib/copilot/actions';

function cell(key: string, value: string | number | undefined): string {
  if (typeof value !== 'number') return value ?? '';
  if (key === 'changePct') return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export default function TableOverlay() {
  const table = useCopilotView((s) => s.table);
  const close = useCopilotView((s) => s.closeTable);
  if (!table) return null;
  return (
    <Modal isOpen onClose={close} title={table.title}>
      {table.rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-faint">No live prices in the last 15 minutes yet.</p>
      ) : (
        <table className="w-full font-jet text-sm tabular-nums">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-faint">
              {table.columns.map((c) => (
                <th key={c.key} className="pb-2 font-normal">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-t border-line">
                {table.columns.map((c) => (
                  <td
                    key={c.key}
                    className={
                      c.key === 'changePct'
                        ? Number(row[c.key]) >= 0
                          ? 'py-2 text-up'
                          : 'py-2 text-down'
                        : 'py-2'
                    }
                  >
                    {cell(c.key, row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-faint">Change over the last 15 minutes of live ticks.</p>
    </Modal>
  );
}
