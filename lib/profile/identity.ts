/**
 * Identity reads/writes for /profile, on the same gateway path the rest of the
 * app uses (lib/supabase/client.ts -> POST /api/db -> backend/crates/core/src/gateway.rs
 * `user_profiles` rules). No new endpoint, no direct database access.
 *
 * Two rules this module exists to hold:
 *
 * 1. `user_profiles.user_address` is the PRIMARY KEY and is stored canonically
 *    (lowercase for `0x…`), so every read and every write intent goes through
 *    canonicalHouseUserAddress() here. A checksummed upsert would create a
 *    second row for the same wallet — two identities for one player.
 *
 * 2. "No profile row yet" and "the request failed" are different facts.
 *    `.maybeSingle()` yields `{data: null, error: null}` for the first and an
 *    error object for the second, and `readProfile` keeps them apart so the UI
 *    never shows "anonymous" for a wallet whose profile simply could not be read.
 */

import { supabase } from '@/lib/supabase/client';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { validateUsername, type UsernameError } from './username';

export type ProfileRead =
    | { kind: 'found'; username: string | null }
    | { kind: 'missing' }
    | { kind: 'failed'; message: string };

export type UsernameWriteIntent =
    | { ok: true; address: string; stored: string; handle: string }
    | { ok: false; error: UsernameError };

/**
 * Read the connected wallet's stored username. `address` may be checksummed;
 * it is canonicalised here so callers cannot get that wrong.
 */
export async function readProfile(address: string): Promise<ProfileRead> {
    const key = canonicalHouseUserAddress(address);
    if (!key) return { kind: 'failed', message: 'No wallet address to read.' };
    try {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('username')
            .eq('user_address', key)
            .maybeSingle();

        if (error) return { kind: 'failed', message: error.message || 'Profile read failed.' };
        if (!data) return { kind: 'missing' };
        return { kind: 'found', username: (data as { username?: string | null }).username ?? null };
    } catch (err) {
        return { kind: 'failed', message: (err as Error)?.message ?? 'Profile read failed.' };
    }
}

/**
 * The write intent behind a username save: the canonical row key plus the
 * canonical stored spelling, or the rule that refused it. The caller performs
 * the actual upsert through the shared profile path (store -> profileSlice ->
 * /api/db), so there is exactly one writer in the app; this is what makes the
 * validation rules and the identity key impossible to skip at the call site.
 */
export function prepareUsernameWrite(address: string | null | undefined, raw: string): UsernameWriteIntent {
    const key = canonicalHouseUserAddress(address ?? '');
    if (!key) {
        return { ok: false, error: { code: 'not_a_string', message: 'Connect a wallet before registering a name.' } };
    }
    const validation = validateUsername(raw);
    if (!validation.ok) return { ok: false, error: validation.error };
    return { ok: true, address: key, stored: validation.stored, handle: validation.handle };
}

/**
 * The four read states collapsed into what the identity block shows. `unknown`
 * is deliberately distinct from `anonymous`: the first means "we could not ask",
 * the second means "the registry has no name for this wallet yet".
 */
export type IdentityDisplayState = 'loading' | 'named' | 'anonymous' | 'unknown';

export function identityDisplayState(read: ProfileRead | null, loading: boolean): IdentityDisplayState {
    if (loading && read === null) return 'loading';
    if (!read || read.kind === 'failed') return 'unknown';
    if (read.kind === 'missing' || !read.username) return 'anonymous';
    return 'named';
}
