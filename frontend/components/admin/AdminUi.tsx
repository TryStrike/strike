'use client';


import React, { useState } from 'react';

export function shortenAddress(addr: string): string {
    return addr ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : 'N/A';
}

export function fmtPnL(n: number | undefined | null): string {
    if (n === undefined || n === null || !Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export const Table = ({ children }: { children: React.ReactNode }) => (
    <table className="w-full text-left border-collapse">{children}</table>
);

export const THead = ({ labels }: { labels: string[] }) => (
    <thead>
        <tr className="border-b border-line text-xs font-black uppercase tracking-wide text-subtle">
            {labels.map((l, i) => (
                <th key={l} className={`px-8 py-6 ${i === labels.length - 1 ? 'text-right' : ''}`}>{l}</th>
            ))}
        </tr>
    </thead>
);

export const StatBox = ({ title, value, label }: { title: string; value: React.ReactNode; label?: string }) => (
    <div className="p-8 bg-surface border border-line rounded-[2.5rem] space-y-4">
        <p className="text-xs font-black uppercase tracking-wider text-subtle">{title}</p>
        <div>
            <h3 className="text-4xl font-black text-ink tracking-tight">{value}</h3>
            {label && <p className="text-xs font-bold text-faint uppercase tracking-widest">{label}</p>}
        </div>
    </div>
);

export const TabBtn = ({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) => (
    <button
        onClick={onClick}
        aria-pressed={active}
        className={`pb-4 text-xs font-black uppercase tracking-widest transition-all border-b-2 ${
            active ? 'text-ink border-ink/20' : 'text-faint border-transparent hover:text-subtle'
        }`}
    >
        {label}
    </button>
);

export function SkeletonRows({ rows = 6, className = '' }: { rows?: number; className?: string }) {
    return (
        <div className={`space-y-3 ${className}`} role="status" aria-label="Loading">
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="animate-pulse flex items-center gap-4 px-8 py-4">
                    <div className="h-3 w-24 rounded bg-surface" />
                    <div className="h-3 flex-1 rounded bg-surface" />
                    <div className="h-3 w-16 rounded bg-surface" />
                    <div className="h-3 w-20 rounded bg-surface" />
                </div>
            ))}
        </div>
    );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
    return (
        <div className="px-8 py-16 text-center space-y-2">
            <p className="text-xs font-black uppercase tracking-widest text-faint">{title}</p>
            {hint && <p className="text-xs text-faint max-w-xl mx-auto leading-relaxed">{hint}</p>}
            {action}
        </div>
    );
}

export function ErrorState({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
    return (
        <div className="px-8 py-10 text-center space-y-3" role="alert">
            <p className="text-xs font-black uppercase tracking-widest text-down">Request failed</p>
            <p className="text-xs text-subtle font-mono max-w-xl mx-auto break-words">{message}</p>
            <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="px-5 py-2 rounded-full bg-surface hover:bg-surface border border-line text-[10px] font-black uppercase tracking-widest text-ink transition-all disabled:opacity-50"
            >
                {retrying ? 'Retrying…' : 'Retry'}
            </button>
        </div>
    );
}

export function PanelHeader({
    eyebrow, title, right,
}: {
    eyebrow?: string;
    title?: React.ReactNode;
    right?: React.ReactNode;
}) {
    return (
        <div className="p-6 border-b border-line flex flex-wrap gap-4 items-center justify-between bg-surface">
            <div>
                {eyebrow && <p className="text-xs font-black uppercase tracking-wider text-subtle">{eyebrow}</p>}
                {title && <p className="text-sm text-muted">{title}</p>}
            </div>
            <div className="flex gap-3 items-center flex-wrap justify-end">{right}</div>
        </div>
    );
}

export function Pagination({
    offset, limit, total, onPage, loading,
}: {
    offset: number;
    limit: number;
    total: number | null | undefined;
    onPage: (nextOffset: number) => void;
    loading?: boolean;
}) {
    const t = typeof total === 'number' && Number.isFinite(total) ? Math.max(total, 0) : null;
    const hasPrev = offset > 0;
    const hasNext = t === null ? limit > 0 && offset + limit < (t ?? Infinity) : offset + limit < t;
    const from = t === null || t === 0 ? 0 : Math.min(offset + 1, t);
    const to = t === null ? offset + limit : Math.min(offset + limit, t);
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 px-8 py-4 border-t border-line">
            <p className="text-[11px] font-mono text-subtle">
                {t === null ? '—' : `${from}–${to} of ${t.toLocaleString()}`} rows
            </p>
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => onPage(Math.max(0, offset - limit))}
                    disabled={!hasPrev || loading}
                    className="px-4 py-1.5 rounded-lg bg-surface hover:bg-surface border border-line text-[10px] font-black uppercase tracking-widest text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                    ← Prev
                </button>
                <button
                    type="button"
                    onClick={() => onPage(offset + limit)}
                    disabled={!hasNext || loading}
                    className="px-4 py-1.5 rounded-lg bg-surface hover:bg-surface border border-line text-[10px] font-black uppercase tracking-widest text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                    Next →
                </button>
            </div>
        </div>
    );
}

export function TypedConfirmButton({
    phrase, label, onConfirm, buttonClassName = '', disabled, busy,
}: {
    phrase: string;
    label: string;
    onConfirm: () => Promise<void> | void;
    buttonClassName?: string;
    disabled?: boolean;
    busy?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState('');
    const [working, setWorking] = useState(false);
    const matches = typed.trim() === phrase;

    return (
        <span className="inline-flex flex-col items-end gap-2">
            {!open ? (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    disabled={disabled || busy}
                    className={buttonClassName}
                >
                    {busy ? '…' : label}
                </button>
            ) : (
                <span className="flex flex-col gap-1.5 items-end">
                    <span className="text-[10px] font-mono text-subtle whitespace-nowrap">
                        Type <span className="text-ink font-black">{phrase}</span> to confirm
                    </span>
                    <span className="flex gap-1.5 items-center">
                        <input
                            autoFocus
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && matches && !working) {
                                    e.preventDefault();
                                    setWorking(true);
                                    Promise.resolve(onConfirm())
                                        .then(() => { setOpen(false); setTyped(''); })
                                        .finally(() => setWorking(false));
                                }
                                if (e.key === 'Escape') { setOpen(false); setTyped(''); }
                            }}
                            placeholder={phrase}
                            aria-label={`Confirm by typing ${phrase}`}
                            className="w-28 px-2 py-1 rounded bg-ink/60 border border-line text-ink text-xs font-mono placeholder:text-faint focus:outline-none focus:border-ink/20"
                        />
                        <button
                            type="button"
                            disabled={!matches || working || busy}
                            onClick={async () => {
                                setWorking(true);
                                try {
                                    await onConfirm();
                                    setOpen(false);
                                    setTyped('');
                                } finally {
                                    setWorking(false);
                                }
                            }}
                            className="px-2.5 py-1 rounded bg-ink text-white text-[10px] font-black uppercase tracking-wider disabled:opacity-30"
                        >
                            {working ? '…' : 'Go'}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setOpen(false); setTyped(''); }}
                            className="px-2 py-1 rounded text-[10px] font-bold uppercase text-subtle hover:text-muted"
                        >
                            Cancel
                        </button>
                    </span>
                </span>
            )}
        </span>
    );
}
