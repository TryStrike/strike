import { NextRequest, NextResponse } from 'next/server';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';

export async function POST(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;
    try {
        const { userAddress, status } = await request.json();

        if (!userAddress || !status) {
            return NextResponse.json({ error: 'Missing userAddress or status' }, { status: 400 });
        }

        if (!['active', 'frozen', 'banned'].includes(status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }

        const variants = walletAddressSearchVariants(userAddress);
        const { error } = await supabase
            .from('user_balances')
            .update({ status })
            .in('user_address', variants);

        if (error) throw error;

        return NextResponse.json({ success: true, status });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
