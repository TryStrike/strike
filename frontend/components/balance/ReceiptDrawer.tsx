'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, CheckCircle, Clock, Copy, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/kit';
import { explorerTxUrl } from '@/lib/arc/config';
import { parseCombinedTxHash } from '@/lib/withdrawals/status';

export interface ReceiptData {
  kind: 'deposit' | 'withdrawal';
  amount: number;
  fee: number;
  net: number;
  chain: string;
  currency: string;
  txHash?: string;
  createdAt: number;
  status?: 'confirmed' | 'pending';
  /** withdrawal_requests.id, when the caller has it — links the receipt to
   * the status timeline at /withdrawals. */
  requestId?: number | string | null;
}

/** A real 32-byte tx hash is 0x + 64 hex chars. Placeholders are not. Case-insensitive: hex is hex. */
const REAL_TX_HASH = /^0x[0-9a-f]{64}$/i;

export function isLinkableTxHash(hash: string | null | undefined): boolean {
  return typeof hash === 'string' && REAL_TX_HASH.test(hash.trim());
}

/**
 * Explorer link only for a genuine 32-byte hash: 'PENDING' strings, partial
 * or malformed values must never produce a dead or attacker-shaped link.
 * Arc is the only network, so the chain label is display-only here.
 */
function explorerUrl(txHash?: string) {
  if (!txHash || txHash === 'PENDING') return null;
  // Accept flows store `feeTx|netTx:hash`; link the net payout half.
  const { netTx } = parseCombinedTxHash(txHash);
  const candidate = (netTx ?? txHash).trim();
  return isLinkableTxHash(candidate) ? explorerTxUrl(candidate) : null;
}

function formatAmount(n: number) {
  if (!Number.isFinite(n)) return '0.0000';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toFixed(4);
}

function maskHash(hash: string) {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export const ReceiptDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  receipt: ReceiptData | null;
}> = ({ open, onClose, receipt }) => {
  // Hooks run before the early return so their order never changes between renders.
  const [copied, setCopied] = useState(false);
  // Prefer the net payout half of the stored `feeTx|netTx:hash` format. Only a
  // real 32-byte hash is shown at all — placeholders are not facts.
  const tx = (() => {
    const raw = receipt?.txHash;
    if (!raw || raw === 'PENDING') return null;
    const { netTx } = parseCombinedTxHash(raw);
    const candidate = (netTx ?? raw).trim();
    return isLinkableTxHash(candidate) ? candidate : null;
  })();

  // Close on Escape, mirroring Modal.tsx. onClose is kept in a ref because
  // callers pass inline closures that change on every rerender.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);

  if (!open || !receipt) return null;

  const link = explorerUrl(receipt.txHash);
  const isPending = receipt.status === 'pending';
  const title = receipt.kind === 'deposit' ? 'Deposit' : 'Withdrawal';
  const StatusIcon = isPending ? Clock : CheckCircle;

  const rows = [
    { label: 'Fee', value: `${formatAmount(receipt.fee)} ${receipt.currency}` },
    { label: 'Net', value: `${formatAmount(receipt.net)} ${receipt.currency}` },
    { label: 'Network', value: receipt.chain },
  ];

  return (
    <div className="fixed inset-0 z-[12000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-sm" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} receipt`}
        className="relative z-10 max-h-[80vh] w-full max-w-[400px] overflow-y-auto rounded-[28px] bg-white p-7 font-tight text-ink ring-1 ring-line shadow-[0_40px_80px_-40px_rgba(10,12,16,0.35)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
              <StatusIcon size={20} className={isPending ? 'text-subtle' : 'text-up'} />
              {title} {isPending ? 'pending' : 'confirmed'}
            </h2>
            <p className="mt-1 text-[13px] text-subtle">
              {new Date(receipt.createdAt).toLocaleString()}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-surface hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-7 flex items-baseline gap-2">
          <span className="font-jet text-[36px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
            {formatAmount(receipt.amount)}
          </span>
          <span className="font-jet text-sm text-faint">{receipt.currency}</span>
        </div>

        <dl className="mt-6 space-y-2 font-jet text-[13px]">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex justify-between">
              <dt className="text-subtle">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {tx && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-subtle">Transaction</dt>
              <dd className="flex items-center gap-1">
                <span>{maskHash(tx)}</span>
                <button
                  type="button"
                  aria-label={copied ? 'Copied' : 'Copy transaction hash'}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(tx);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    } catch { /* ignore */ }
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface hover:text-ink"
                >
                  {copied ? <Check size={14} weight="bold" className="text-up" /> : <Copy size={16} />}
                </button>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="View on explorer"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface hover:text-ink"
                  >
                    <ArrowUpRight size={16} />
                  </a>
                )}
              </dd>
            </div>
          )}
        </dl>

        {isPending && receipt.kind === 'withdrawal' && (
          <p className="mt-5 text-[13px] leading-relaxed text-muted">
            Your signed withdrawal request is queued for manual review. An operator approves it, then the
            treasury pays USDC to your wallet on Arc — open the status timeline for the exact step it is on.
          </p>
        )}
        {isPending && receipt.kind !== 'withdrawal' && (
          <p className="mt-5 text-[13px] leading-relaxed text-muted">
            Paid out to your wallet once reviewed.
          </p>
        )}

        <div className="mt-7 flex flex-col gap-3">
          {receipt.kind === 'withdrawal' && (
            <Link
              href={
                receipt.requestId != null && receipt.requestId !== ''
                  ? `/withdrawals?request=${encodeURIComponent(String(receipt.requestId))}`
                  : '/withdrawals'
              }
              scroll
              onClick={onClose}
              aria-label="View withdrawal history"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-surface px-4 py-3 font-jet text-sm font-semibold text-ink transition-colors hover:bg-line"
            >
              View withdrawal status
              <ArrowUpRight size={16} />
            </Link>
          )}
          <Button variant="secondary" size="lg" onClick={onClose} className="w-full">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
};
