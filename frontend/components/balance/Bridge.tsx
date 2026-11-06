'use client';

import React, { useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import type { EIP1193Provider } from 'viem';
import { bridging } from '@/lib/bridge/bridging';
import { arc } from '@/lib/arc/wagmi';
import { explorerTxUrl } from '@/lib/arc/config';
import type { BridgeDirection } from '@/lib/bridge/cctp';

type State =
  | { kind: 'idle' }
  | { kind: 'running'; step: string }
  | { kind: 'done'; mintTx: string | null }
  | { kind: 'failed'; message: string };

const COPY = {
  in: {
    title: 'USDC on Base Sepolia?',
    hint: 'Bring it to Arc in about 20 seconds, then deposit it below. Circle covers the Arc gas.',
    button: 'Bring to Arc',
    done: 'Arrived on Arc.',
  },
  out: {
    title: 'Want it on Base Sepolia?',
    hint: 'Send USDC from your Arc wallet to Base Sepolia over CCTP in about 15 seconds. Circle covers the Base gas.',
    button: 'Send to Base',
    done: 'Arrived on Base Sepolia.',
  },
} as const;

export default function Bridge({ direction, onArrived }: { direction: BridgeDirection; onArrived: () => void }) {
  const copy = COPY[direction];
  const { address, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [amount, setAmount] = useState('5');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const run = async () => {
    if (!address || !connector || state.kind === 'running') return;
    const source = direction === 'in' ? baseSepolia.id : arc.id;
    setState({ kind: 'running', step: direction === 'in' ? 'Switching to Base Sepolia' : 'Starting' });
    bridging.set(true);
    try {
      await switchChainAsync({ chainId: source });
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const { bridgeUsdc } = await import('@/lib/bridge/cctp');
      const out = await bridgeUsdc(provider, address, amount, direction, (step) => setState({ kind: 'running', step }));
      setState({ kind: 'done', mintTx: out.mintTx });
      onArrived();
    } catch (err) {
      console.error(`[bridge] ${direction} failed`, err);
      setState({ kind: 'failed', message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    } finally {
      bridging.set(false);
      await switchChainAsync({ chainId: arc.id }).catch((err) => console.error('[bridge] could not switch back to Arc', err));
    }
  };

  return (
    <div className="mb-6 rounded-2xl bg-surface px-4 py-3">
      <div className="text-[13px] font-medium text-ink">{copy.title}</div>
      <p className="mt-0.5 text-xs text-muted">{copy.hint}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <input
          aria-label={`${copy.button} amount`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          disabled={state.kind === 'running'}
          className="h-10 w-24 rounded-xl bg-white px-3 font-jet text-sm ring-1 ring-line outline-none focus:ring-ink"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={state.kind === 'running' || !Number(amount)}
          className="h-10 rounded-xl bg-ink px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {state.kind === 'running' ? 'Bridging…' : copy.button}
        </button>
      </div>
      {state.kind === 'running' && <p className="mt-2 font-jet text-[11px] text-muted">{state.step}</p>}
      {state.kind === 'failed' && <p className="mt-2 text-[11px] text-down">{state.message}</p>}
      {state.kind === 'done' && (
        <p className="mt-2 text-[11px] text-up">
          {copy.done}{' '}
          {state.mintTx ? (
            <a
              href={direction === 'in' ? explorerTxUrl(state.mintTx) : `https://sepolia.basescan.org/tx/${state.mintTx}`}
              target="_blank" rel="noopener noreferrer" className="underline">
              View mint
            </a>
          ) : null}
        </p>
      )}
    </div>
  );
}
