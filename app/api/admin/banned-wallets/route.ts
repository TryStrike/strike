import { NextRequest, NextResponse } from 'next/server';
import {
  appendSupabaseServiceKeyHint,
  isSupabaseServiceRoleConfigured,
  supabaseService,
} from '@/lib/supabase/serviceClient';
import { normalizeWalletForBanKey } from '@/lib/bans/walletBan';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';

const isProdDeployment =
  process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

function requireServiceRoleInProduction(): NextResponse | null {
  if (!isProdDeployment || isSupabaseServiceRoleConfigured) return null;
  return NextResponse.json(
    {
      error:
        'SUPABASE_SERVICE_KEY is not set on this server. In Vercel: Settings → Environment Variables → add SUPABASE_SERVICE_KEY (Supabase Dashboard → Project Settings → API → service_role secret). Redeploy.',
    },
    { status: 503 },
  );
}

function unknownErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function respondSupabaseError(message: string) {
  const missingTable = isMissingTableMessage(message);
  const body = appendSupabaseServiceKeyHint(message + (missingTable ? missingTableHint() : ''));
  return NextResponse.json({ error: body }, { status: missingTable ? 503 : 500 });
}

function missingTableHint() {
  return ' Run supabase/migrations/002_banned_wallets.sql (or full 001_complete_schema.sql) on your Supabase project.';
}

export async function GET(request: NextRequest) {
  const deny = requireAdminAuth(request);
  if (deny) return deny;
  const block = requireServiceRoleInProduction();
  if (block) return block;
  try {
    const { data, error } = await supabaseService
      .from('banned_wallets')
      .select('wallet_address, reason, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return respondSupabaseError(error.message);
    }

    return NextResponse.json({ bans: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ error: appendSupabaseServiceKeyHint(unknownErr(e)) }, { status: 500 });
  }
}

function isMissingTableMessage(msg: string) {
  return /schema cache|does not exist|banned_wallets/i.test(msg);
}

export async function POST(request: NextRequest) {
  const deny = requireAdminAuth(request);
  if (deny) return deny;
  const block = requireServiceRoleInProduction();
  if (block) return block;
  try {
    const body = await request.json();
    const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress.trim() : '';
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Banned by administrator';

    if (!walletAddress) {
      return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
    }

    const key = normalizeWalletForBanKey(walletAddress);

    const { data, error } = await supabaseService
      .from('banned_wallets')
      .upsert({ wallet_address: key, reason }, { onConflict: 'wallet_address' })
      .select()
      .single();

    if (error) {
      return respondSupabaseError(error.message);
    }

    return NextResponse.json({ success: true, ban: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: appendSupabaseServiceKeyHint(unknownErr(e)) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const deny = requireAdminAuth(request);
  if (deny) return deny;
  const block = requireServiceRoleInProduction();
  if (block) return block;
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get('walletAddress') || '';
    const walletAddress = raw.trim();
    if (!walletAddress) {
      return NextResponse.json({ error: 'walletAddress query param is required' }, { status: 400 });
    }

    const key = normalizeWalletForBanKey(walletAddress);

    const { error } = await supabaseService.from('banned_wallets').delete().eq('wallet_address', key);

    if (error) {
      return respondSupabaseError(error.message);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: appendSupabaseServiceKeyHint(unknownErr(e)) }, { status: 500 });
  }
}
