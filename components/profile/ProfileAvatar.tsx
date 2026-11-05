'use client';

/**
 * Deterministic identity mark. Rendered from the wallet (lib/profile/avatar.ts),
 * so it needs no stored avatar column and no external image host.
 */

import { avatarFor } from '@/lib/profile/avatar';

export interface ProfileAvatarProps {
    address?: string | null;
    username?: string | null;
    size?: number;
    className?: string;
}

export function ProfileAvatar({ address, username, size = 64, className = '' }: ProfileAvatarProps) {
    const spec = avatarFor(address ?? null, username ?? null);
    const id = `avatar-${(address ?? '').slice(-6)}`;
    const cx = 32 + Math.cos((spec.angle * Math.PI) / 180) * 18;
    const cy = 32 + Math.sin((spec.angle * Math.PI) / 180) * 18;

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 64 64"
            role="img"
            aria-label={`Identity mark for ${username || 'this wallet'}`}
            className={className}
            data-testid="profile-avatar"
        >
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={spec.hue} stopOpacity="0.85" />
                    <stop offset="100%" stopColor={spec.accent} stopOpacity="0.25" />
                </linearGradient>
            </defs>
            <rect x="1.5" y="1.5" width="61" height="61" rx="16" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" />
            <circle cx={cx} cy={cy} r="14" fill={`url(#${id})`} opacity="0.55" />
            <text
                x="32"
                y="32"
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize="26"
                fontWeight="900"
                fill="#ffffff"
                opacity="0.85"
            >
                {spec.initials}
            </text>
        </svg>
    );
}

export default ProfileAvatar;
