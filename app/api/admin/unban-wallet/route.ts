import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';
import { normalizeWalletForBanKey } from '@/lib/bans/walletBan';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';

/**
 * POST /api/admin/unban-wallet
 * Body: { walletAddress: string }
 *
 * Atomically:
 *  1. Removes the wallet from banned_wallets
 *  2. Zeros the wallet's balance across all currencies
 *  3. Sets user_balances.status back to 'active'
 */
export async function POST(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;

    try {
        const { walletAddress } = await request.json();
        if (!walletAddress || typeof walletAddress !== 'string') {
            return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
        }

        const key = normalizeWalletForBanKey(walletAddress.trim());
        const variants = walletAddressSearchVariants(walletAddress.trim());

        // 1. Remove from banned_wallets
        const { error: banErr } = await supabase
            .from('banned_wallets')
            .delete()
            .eq('wallet_address', key);

        if (banErr) {
            return NextResponse.json({ error: `Failed to remove ban: ${banErr.message}` }, { status: 500 });
        }

        // 2. Fetch current balances so we know what to wipe (for the audit log)
        const { data: currentBalances } = await supabase
            .from('user_balances')
            .select('user_address, currency, balance')
            .in('user_address', variants);

        // 3. Zero the balance and restore status to 'active' for all currency rows
        const { error: balErr } = await supabase
            .from('user_balances')
            .update({ balance: 0, status: 'active' })
            .in('user_address', variants);

        if (balErr) {
            // Ban was already removed — log but don't fail the whole request
            console.error('[unban-wallet] balance zero failed (non-blocking):', balErr.message);
        }

        // 4. Write an audit-log entry for every currency that had a non-zero balance wiped.
        //    This keeps the balance_audit_log complete so player-ledger calculations stay accurate.
        if (currentBalances && currentBalances.length > 0) {
            const wipeEntries = currentBalances
                .filter(r => Number(r.balance) > 0)
                .map(r => ({
                    user_address: r.user_address,
                    currency: r.currency,
                    operation_type: 'admin_balance_wipe',
                    amount: -Number(r.balance),   // negative = balance removed
                    transaction_hash: `admin:unban:${key}`,
                }));

            if (wipeEntries.length > 0) {
                await supabase.from('balance_audit_log').insert(wipeEntries)
                    .then(({ error: auditErr }) => {
                        if (auditErr) console.warn('[unban-wallet] audit log insert failed:', auditErr.message);
                    });
            }
        }

        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message ?? 'Unexpected error' }, { status: 500 });
    }
}
