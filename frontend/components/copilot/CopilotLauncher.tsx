"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ChatCircleDots, X } from "@phosphor-icons/react";
import { useAgentFeed } from "@/lib/agent/agentFeed";
import { setNavigator, useCopilotView } from "@/lib/copilot/actions";
import { AI_ROUTE } from "@/lib/theme";

const AgentStream = dynamic(() => import("@/components/agent/AgentStream"), {
  ssr: false,
});
const TableOverlay = dynamic(() => import("./TableOverlay"), { ssr: false });
const ChartOverlay = dynamic(() => import("./ChartOverlay"), { ssr: false });

export function CopilotLauncher() {
  const [open, setOpen] = useState(false);
  const session = useAgentFeed((s) => s.session);
  const connectIfLive = useAgentFeed((s) => s.connectIfLive);
  const table = useCopilotView((s) => s.table);
  const chart = useCopilotView((s) => s.chart);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => setNavigator(router.push), [router]);
  useEffect(() => connectIfLive(), [connectIfLive]);
  const follow = session && pathname !== AI_ROUTE;
  return (
    <>
      {follow && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg"
        >
          <ChatCircleDots size={18} weight="fill" /> Agent {session.status}
        </button>
      )}
      {follow && open && (
        <aside
          aria-label="Copilot"
          className="fixed bottom-20 right-4 z-40 flex h-[min(620px,74vh)] w-[min(400px,calc(100vw-2rem))] flex-col gap-3 rounded-3xl bg-white p-4 text-ink shadow-2xl ring-1 ring-ink/10"
        >
          <header className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Copilot</h2>
            <button
              type="button"
              aria-label="Close copilot"
              onClick={() => setOpen(false)}
              className="text-muted"
            >
              <X size={18} />
            </button>
          </header>
          <AgentStream session={session} />
        </aside>
      )}
      {table && <TableOverlay />}
      {chart && <ChartOverlay />}
    </>
  );
}
