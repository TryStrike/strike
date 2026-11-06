'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ChatCircleDots } from '@phosphor-icons/react';
import { setNavigator, useCopilotView } from '@/lib/copilot/actions';

const CopilotDrawer = dynamic(() => import('./CopilotDrawer'), { ssr: false });
const TableOverlay = dynamic(() => import('./TableOverlay'), { ssr: false });
const ChartOverlay = dynamic(() => import('./ChartOverlay'), { ssr: false });

/** The only part of the copilot on first paint. The drawer loads on first tap. */
export function CopilotLauncher() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const table = useCopilotView((s) => s.table);
  const chart = useCopilotView((s) => s.chart);
  const router = useRouter();
  useEffect(() => setNavigator(router.push), [router]);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setLoaded(true);
          setOpen((o) => !o);
        }}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg"
      >
        <ChatCircleDots size={18} weight="fill" /> Ask
      </button>
      {loaded && <CopilotDrawer open={open} onClose={() => setOpen(false)} />}
      {table && <TableOverlay />}
      {chart && <ChartOverlay />}
    </>
  );
}
