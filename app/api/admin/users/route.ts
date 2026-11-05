import { NextRequest, NextResponse } from 'next/server';
import { isDemoBetHistoryRow } from '@/lib/admin/walletAddressVariants';
import { resolveHouseLedgerCurrency } from '@/lib/balance/houseLedgerCurrency';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

function balanceRowKey(userAddress: string, currency: string) {
    return `${canonicalHouseUserAddress(userAddress)}::${currency}`;
}

export async function GET(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;
    try {
        // Paginate — PostgREST defaults to 1000 rows per request
        const balanceList: {
            user_address: string;
            currency: string;
            balance: number;
            status: string;
            user_tier: string;
            updated_at: string;
            created_at: string;
        }[] = [];
        {
            const PAGE = 1000;
            let from = 0;
            for (;;) {
                const { data, error: balanceError } = await supabase
                    .from('user_balances')
                    .select('user_address, currency, balance, status, user_tier, updated_at, created_at')
                    .order('updated_at', { ascending: false })
                    .range(from, from + PAGE - 1);
                if (balanceError) throw balanceError;
                const chunk = data ?? [];
                balanceList.push(...(chunk as typeof balanceList));
                if (chunk.length < PAGE) break;
                from += PAGE;
            }
        }

        // Fetch bet counts per user (real-mode only — exclude demo-* ids)
        const { data: betCounts, error: betError } = await supabase
            .from('bet_history')
            .select('id, wallet_address, amount, payout, won, network, asset');

        if (betError) throw betError;

        // Aggregate bet data by canonical wallet (same total shown on each currency row for that wallet)
        const userActivity: Record<string, { totalBets: number; totalVolume: number; wins: number }> = {};
        (betCounts ?? [])
            .filter((b: any) => !isDemoBetHistoryRow(b))
            .forEach((b: any) => {
                const w = canonicalHouseUserAddress(b.wallet_address ?? '');
                if (!userActivity[w]) {
                    userActivity[w] = { totalBets: 0, totalVolume: 0, wins: 0 };
                }
                userActivity[w].totalBets += 1;
                userActivity[w].totalVolume += Number(b.amount);
                if (b.won) userActivity[w].wins += 1;
            });

        // Wallets that have bet on a (address, currency) pair but no user_balances row yet
        const seenBalanceKeys = new Set(balanceList.map(b => balanceRowKey(b.user_address, b.currency)));
        const syntheticFromBets: typeof balanceList = [];
        for (const b of betCounts ?? []) {
            if (isDemoBetHistoryRow(b as any)) continue;
            const w = canonicalHouseUserAddress((b as any).wallet_address ?? '');
            const cur = resolveHouseLedgerCurrency({
                network: (b as any).network ?? 'ARC',
                selectedCurrency: (b as any).asset,
            });
            const k = balanceRowKey(w, cur);
            if (seenBalanceKeys.has(k)) continue;
            seenBalanceKeys.add(k);
            const now = new Date().toISOString();
            syntheticFromBets.push({
                user_address: w,
                currency: cur,
                balance: 0,
                status: 'active',
                user_tier: 'free',
                updated_at: now,
                created_at: now,
            });
        }

        const balances = [...balanceList, ...syntheticFromBets];

        // Fetch referral data
        const { data: referrals, error: referralError } = await supabase
            .from('user_referrals')
            .select('user_address, referral_code, referral_count, referred_by');

        if (referralError) throw referralError;

        const referralMap: Record<string, any> = {};
        referrals?.forEach(r => {
            referralMap[canonicalHouseUserAddress(r.user_address)] = r;
        });

        // Fetch user profiles for usernames
        const { data: profiles } = await supabase
            .from('user_profiles')
            .select('user_address, username');

        const profileMap: Record<string, string> = {};
        profiles?.forEach(p => {
            profileMap[canonicalHouseUserAddress(p.user_address)] = p.username ?? '';
        });

        // Merge balance data with aggregated activity
        const users = balances.map(b => {
            const addr = canonicalHouseUserAddress(b.user_address);
            return {
                ...b,
                tier: b.user_tier,
                username: profileMap[addr] || null,
                activity: userActivity[addr] || { totalBets: 0, totalVolume: 0, wins: 0 },
                referral: referralMap[addr] || { referral_code: 'NONE', referral_count: 0 },
            };
        });

        return NextResponse.json({ users });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
