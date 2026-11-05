import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

// Session timeout: if no ping for 90s, that session is considered ended
const SESSION_TIMEOUT_SECONDS = 90;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { wallet_address, network = 'ARC', session_id } = body as {
      wallet_address: string;
      network?: string;
      session_id?: string;
    };

    if (!wallet_address) {
      return NextResponse.json({ error: 'wallet_address required' }, { status: 400 });
    }

    const w = canonicalHouseUserAddress(wallet_address);

    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_SECONDS * 1000).toISOString();

    // If client sends an existing session_id, try to update it
    if (session_id) {
      const { data: existing } = await supabaseService
        .from('user_sessions')
        .select('id, last_ping_at')
        .eq('id', session_id)
        .eq('wallet_address', w)
        .is('ended_at', null)
        .single();

      if (existing && existing.last_ping_at > cutoff) {
        await supabaseService
          .from('user_sessions')
          .update({ last_ping_at: now })
          .eq('id', session_id);

        return NextResponse.json({ session_id, status: 'updated' });
      }
    }

    // Check for a recent open session for this wallet (resume it)
    const { data: active } = await supabaseService
      .from('user_sessions')
      .select('id')
      .eq('wallet_address', w)
      .is('ended_at', null)
      .gt('last_ping_at', cutoff)
      .order('last_ping_at', { ascending: false })
      .limit(1)
      .single();

    if (active) {
      await supabaseService
        .from('user_sessions')
        .update({ last_ping_at: now })
        .eq('id', active.id);
      return NextResponse.json({ session_id: active.id, status: 'updated' });
    }

    // Close any stale open sessions for this wallet
    await supabaseService
      .from('user_sessions')
      .update({ ended_at: cutoff })
      .eq('wallet_address', w)
      .is('ended_at', null)
      .lt('last_ping_at', cutoff);

    // Create a new session
    const { data: created, error } = await supabaseService
      .from('user_sessions')
      .insert({ wallet_address: w, network, started_at: now, last_ping_at: now })
      .select('id')
      .single();

    if (error) {
      return NextResponse.json({ error: 'Session creation failed' }, { status: 500 });
    }

    return NextResponse.json({ session_id: created!.id, status: 'created' });
  } catch {
    return NextResponse.json({ error: 'Session update failed' }, { status: 500 });
  }
}

// Called when wallet disconnects
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { session_id, wallet_address } = body as {
      session_id: string;
      wallet_address: string;
    };

    if (!session_id || !wallet_address) {
      return NextResponse.json({ error: 'session_id and wallet_address required' }, { status: 400 });
    }

    const w = canonicalHouseUserAddress(wallet_address);

    await supabaseService
      .from('user_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', session_id)
      .eq('wallet_address', w)
      .is('ended_at', null);

    return NextResponse.json({ status: 'closed' });
  } catch {
    return NextResponse.json({ error: 'Session close failed' }, { status: 500 });
  }
}
