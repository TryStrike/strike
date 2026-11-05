/**
 * Deterministic identity mark for /profile.
 *
 * There is no avatar column: the browser gateway's `user_profiles` rule only
 * exposes `user_address`, `username`, `updated_at` (backend/crates/core/src/gateway.rs),
 * so an uploaded picture could not be persisted without widening that allow-list
 * — which would publish a new column to every browser. Until it does, the avatar
 * is derived from the wallet, identically for every viewer, and rendered as an
 * accessible SVG (no image URL, no third-party tracker).
 *
 * Pure functions only: hash -> palette/initials.
 */

import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { displayUsername } from './username';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a — stable across runs and browsers, no crypto dependency. */
export function fnv1a(value: string): number {
    let hash = FNV_OFFSET;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash >>> 0;
}

export const AVATAR_PALETTE = [
    '#00ff88',
    '#7c5cff',
    '#2151F5',
    '#f5a524',
    '#fb7185',
    '#22d3ee',
    '#a3e635',
    '#e879f9',
] as const;

export interface AvatarSpec {
    /** Two-stop gradient-ish pair for the disc + ring. */
    hue: string;
    accent: string;
    /** 1-2 character monogram. */
    initials: string;
    /** 0-360 rotation used to place the mark so identical wallets align. */
    angle: number;
}

/**
 * Build the avatar from the CANONICAL address (lowercase for `0x…`), so a
 * checksummed spelling cannot render a different identity for the same wallet.
 */
export function avatarFor(address: string | null | undefined, username?: string | null): AvatarSpec {
    const key = canonicalHouseUserAddress(address ?? '');
    // fnv1a is unsigned: `>>` would reinterpret it as a negative int32 and index
    // the palette out of range, so every shift here stays unsigned.
    const hash = key ? fnv1a(key) : 0;
    const hue = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
    const accent = AVATAR_PALETTE[(hash >>> 8) % AVATAR_PALETTE.length];
    return {
        hue,
        accent,
        initials: monogram(username ?? null, key),
        angle: hash % 360,
    };
}

/**
 * Monogram: the username's first alphanumeric (any script) when set, else the
 * address tail. Never the whole name, and never an address.
 */
export function monogram(username: string | null | undefined, address?: string | null): string {
    const name = displayUsername(username ?? null);
    if (name) {
        const first = Array.from(name).find((ch) => /\p{L}|\p{N}/u.test(ch));
        if (first) return first.toUpperCase();
    }
    const addr = (address ?? '').trim();
    if (addr.length >= 4) return addr.slice(-3, -2).toUpperCase();
    return '?';
}
