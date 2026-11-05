import { NextRequest, NextResponse } from 'next/server';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';

export async function GET(request: NextRequest) {
  // Require first-party authorization header to prevent enumeration of any wallet's withdrawals
  const unauthorized = assertBalanceApiAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get('address');
    if (!address) {
      return NextResponse.json({ error: 'address is required' }, { status: 400 });
    }

    const variants = walletAddressSearchVariants(address);
    // Explicit column selection - never expose internal fields like signature
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('id, user_address, currency, amount, net_amount, fee_amount, requested_at, status, tx_hash, created_at')
      .in('user_address', variants)
      .order('requested_at', { ascending: false })
      .limit(100);

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch withdrawals' }, { status: 500 });
    }
    return NextResponse.json({ withdrawals: data || [] });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch withdrawals' }, { status: 500 });
  }
}

