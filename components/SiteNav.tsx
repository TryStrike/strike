'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import { cx } from '@/components/ui/kit';

const LINKS = [
  { href: '/trade', label: 'Trade' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/profile', label: 'Profile' },
];

/** Light nav shared by the landing page and the trade screen. `right` fills the right column. */
export function SiteNav({ right, sticky, wide }: { right: ReactNode; sticky?: boolean; wide?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className={cx('z-30 shrink-0 border-b border-ink/[0.06] bg-white/80 font-tight backdrop-blur-md', sticky && 'sticky top-0')}>
      <div className={cx('mx-auto grid h-16 grid-cols-[1fr_auto_1fr] items-center px-5 sm:px-8', !wide && 'max-w-[1200px]')}>
        <Link href="/" className="justify-self-start text-[17px] font-bold tracking-tight text-ink">
          {BRAND.wordmark}
          <span className="text-up">.</span>
        </Link>
        <div className="hidden items-center gap-8 text-sm font-medium md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cx('transition-colors', pathname === l.href ? 'text-ink' : 'text-muted hover:text-ink')}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="col-start-3 flex items-center justify-self-end gap-2">{right}</div>
      </div>
    </nav>
  );
}
