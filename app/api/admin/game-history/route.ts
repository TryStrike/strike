import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';

export async function GET(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;
    try {
        const { data: bets, error } = await supabase
            .from('bet_history')
            .select('id, wallet_address, asset, direction, amount, payout, won, mode, network, created_at')
            .order('created_at', { ascending: false })
            .limit(500);

        if (error) throw error;

        return NextResponse.json({ bets });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
