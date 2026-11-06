'use client';

import React, { useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import type { EIP1193Provider } from 'viem';
import { bridging } from '@/lib/bridge/bridging';
import { arc } from '@/lib/arc/wagmi';
import { explorerTxUrl } from '@/lib/arc/config';

type State =
  | { kind: 'idle' }
  | { kind: 'running'; step: string }
  | { kind: 'done'; mintTx: string | null }
  | { kind: 'failed'; message: string };

/** USDC on Base Sepolia to this wallet on Arc, then the normal deposit below credits it. */
export default function BridgeIn({ onArrived }: { onArrived: () => void }) {
  const { address, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [amount, setAmount] = useState('5');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const run = async () => {
    if (!address || !connector || state.kind === 'running') return;
    setState({ kind: 'running', step: 'Switching to Base Sepolia' });
    bridging.set(true);
    try {
      await switchChainAsync({ chainId: baseSepolia.id });
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const { bridgeUsdcToArc } = await import('@/lib/bridge/toArc');
      const out = await bridgeUsdcToArc(provider, address, amount, (step) => setState({ kind: 'running', step }));
      setState({ kind: 'done', mintTx: out.mintTx });
      onArrived();
    } catch (err) {
      console.error('[bridge] Base Sepolia to Arc failed', err);
      setState({ kind: 'failed', message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    } finally {
      bridging.set(false);
      await switchChainAsync({ chainId: arc.id }).catch((err) => console.error('[bridge] could not switch back to Arc', err));
    }
  };

  return (
    <div className="mb-6 rounded-2xl bg-surface px-4 py-3">
      <div className="text-[13px] font-medium text-ink">USDC on Base Sepolia?</div>
      <p className="mt-0.5 text-xs text-muted">Bring it to Arc in about 20 seconds, then deposit it below. Circle covers the Arc gas.</p>
      <div className="mt-2.5 flex items-center gap-2">
        <input
          aria-label="Amount to bring from Base Sepolia"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          disabled={state.kind === 'running'}
          className="h-10 w-24 rounded-xl bg-white px-3 font-jet text-sm ring-1 ring-line outline-none"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={state.kind === 'running' || !Number(amount)}
          className="h-10 rounded-xl bg-ink px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {state.kind === 'running' ? 'Bridging…' : 'Bring to Arc'}
        </button>
      </div>
      {state.kind === 'running' && <p className="mt-2 font-jet text-[11px] text-muted">{state.step}</p>}
      {state.kind === 'failed' && <p className="mt-2 text-[11px] text-down">{state.message}</p>}
      {state.kind === 'done' && (
        <p className="mt-2 text-[11px] text-up">
          Arrived on Arc.{' '}
          {state.mintTx ? (
            <a href={explorerTxUrl(state.mintTx)} target="_blank" rel="noopener noreferrer" className="underline">
              View mint
            </a>
          ) : null}
        </p>
      )}
    </div>
  );
}
