'use client';

import { LiveChart } from '@/components/game/LiveChart';
import { AgentPanel } from '@/components/agent/AgentPanel';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';

export default function AgentPage() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-white font-tight text-ink">
      <SiteNav wide right={<WalletConnect />} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative min-h-[420px] flex-1 lg:min-h-0">
          <LiveChart betAmount="1" />
        </div>
        <aside className="w-full shrink-0 overflow-y-auto border-t border-line lg:w-[400px] lg:border-l lg:border-t-0">
          <AgentPanel />
        </aside>
      </div>
    </div>
  );
}
