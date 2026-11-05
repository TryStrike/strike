'use client';

/**
 * Wallet chip for /profile.
 *
 * Default display is always the shortened form from lib/utils/address.ts. The
 * full address is never rendered, never a `title`, never in a `data-*`
 * attribute — it only leaves this component through an explicit copy click, and
 * it is written to the clipboard rather than shown.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, WarningCircle } from '@phosphor-icons/react';
import { shortenAddress } from '@/lib/utils/address';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

export interface AddressChipProps {
    address?: string | null;
    /** Prefix label, e.g. the connected wallet. */
    label?: string;
    className?: string;
}

export function AddressChip({ address, label = 'Wallet', className = '' }: AddressChipProps) {
    const [copied, setCopied] = useState(false);
    const [denied, setDenied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);

    const copy = useCallback(async () => {
        const value = (address ?? '').trim();
        if (!value) return;
        setDenied(false);
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard is blocked (permissions, non-secure context): say so
            // instead of pretending the copy happened.
            setCopied(false);
            setDenied(true);
        }
    }, [address]);

    const short = shortenAddress(address);
    // Spelling only; the value is derived from the same wallet the page shows.
    const canonical = canonicalHouseUserAddress(address ?? '');

    return (
        <span className={`inline-flex items-center gap-2 ${className}`} data-testid="address-chip">
            <span className="text-[10px] font-mono text-white/40" aria-label={`${label} address, shortened`}>
                {short || 'no wallet'}
            </span>
            {canonical && (
                <button
                    type="button"
                    onClick={copy}
                    aria-label={`Copy full ${label.toLowerCase()} address`}
                    title="Copy the full address to the clipboard"
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-white/35 transition-colors hover:text-white hover:bg-white/10"
                >
                    {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            )}
            {denied && (
                <span className="inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-rose-400">
                    <WarningCircle className="h-3 w-3" /> Clipboard blocked
                </span>
            )}
        </span>
    );
}

export default AddressChip;
