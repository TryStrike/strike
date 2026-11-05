'use client';

import React, { useState } from 'react';
import { ArrowUpRight, Check, CheckCircle, Clock, Copy, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/kit';
import { explorerTxUrl } from '@/lib/arc/config';

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
}

function explorerUrl(chain: string, txHash?: string) {
  if (!txHash || txHash === 'PENDING') return null;
  const c = chain.toUpperCase();
  // Arc is the only network; USDC uses the Arc explorer.
  if (c !== 'USDC') return null;
  return explorerTxUrl(txHash);
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
  const tx = receipt?.txHash ? receipt.txHash.split('|')[0] : null;

  if (!open || !receipt) return null;

  const link = explorerUrl(receipt.chain, receipt.txHash);
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
        className="relative z-10 w-full max-w-[400px] rounded-[28px] bg-white p-7 font-tight text-ink ring-1 ring-line shadow-[0_40px_80px_-40px_rgba(10,12,16,0.35)]"
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

        {isPending && (
          <p className="mt-5 text-[13px] leading-relaxed text-muted">
            Paid out to your wallet once reviewed.
          </p>
        )}

        <Button variant="secondary" size="lg" onClick={onClose} className="mt-7 w-full">
          Done
        </Button>
      </div>
    </div>
  );
};
