import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { appendSupabaseServiceKeyHint, supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';

function randomAccessCodeSegment(len: number): string {
    const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[bytes[i]! % alphabet.length];
    return s;
}

// GET all access codes
export async function GET(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;
    try {
        // Schema: wallet_address links a consumed code to a user (not used_by)
        const { data, error } = await supabase
            .from('access_codes')
            .select('id, code, is_used, wallet_address, used_at, created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;

        return NextResponse.json({ codes: data });
    } catch (error: any) {
        const msg = appendSupabaseServiceKeyHint(error?.message ?? String(error));
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

// POST generate new access codes
export async function POST(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;
    try {
        let body: { count?: number } = {};
        try {
            body = await request.json();
        } catch {
            body = {};
        }
        const raw = Number(body.count);
        const count = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 500) : 1;

        const newCodes: { code: string }[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < count; i++) {
            let code: string;
            let guard = 0;
            do {
                code = `${randomAccessCodeSegment(6)}${randomAccessCodeSegment(6)}`;
                guard++;
            } while (seen.has(code) && guard < 20);
            seen.add(code);
            newCodes.push({ code });
        }

        const { data, error } = await supabase
            .from('access_codes')
            .insert(newCodes)
            .select('id, code, is_used, wallet_address, used_at, created_at');

        if (error) throw error;

        return NextResponse.json({ codes: data });
    } catch (error: any) {
        const msg = appendSupabaseServiceKeyHint(error?.message ?? String(error));
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
