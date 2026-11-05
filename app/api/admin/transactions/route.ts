import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';

export async function GET(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;
    try {
        // Fetch recent deposits and withdrawals from audit log
        // Explicit column selection to avoid exposing sensitive future columns
        const { data: transactions, error } = await supabase
            .from('balance_audit_log')
            .select('id, user_address, currency, operation_type, amount, balance_before, balance_after, transaction_hash, bet_id, created_at')
            .in('operation_type', ['deposit', 'withdrawal'])
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        return NextResponse.json({ transactions });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
