'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { List, Sparkle, X } from '@phosphor-icons/react';
import { BRAND } from '@/lib/brand';
import { cx } from '@/components/ui/kit';
import { useAiModeToggle } from '@/lib/useTheme';

const LINKS = [
  { href: '/trade', label: 'Trade' },
  { href: '/markets', label: 'Markets' },
  { href: '/history', label: 'History' },
];

function AiModeButton({ className }: { className?: string }) {
  const { inAi, toggle } = useAiModeToggle();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={inAi}
      className={cx(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold',
        inAi ? 'bg-ink text-white' : 'bg-up-soft text-up',
        className
      )}
    >
      <Sparkle size={14} weight="fill" aria-hidden="true" />
      {inAi ? 'Exit AI' : 'AI mode'}
    </button>
  );
}

function isActive(pathname: string | null, href: string) {
  return pathname === href || (pathname !== null && pathname.startsWith(`${href}/`));
}

export function SiteNav({ right, sticky, wide }: { right: ReactNode; sticky?: boolean; wide?: boolean }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  return (
    <nav aria-label="Main" className={cx('relative z-30 shrink-0 border-b border-ink/[0.06] bg-white/80 font-tight backdrop-blur-md', sticky && 'sticky top-0')}>
      <div className={cx('mx-auto grid h-16 grid-cols-[1fr_auto_1fr] items-center px-5 sm:px-8', !wide && 'max-w-[1200px]')}>
        <Link href="/" className="justify-self-start text-[17px] font-bold tracking-tight text-ink">
          {BRAND.wordmark}
          <span className="text-up" aria-hidden="true">.</span>
        </Link>
        <div className="hidden items-center gap-8 text-sm font-medium md:flex">
          {LINKS.map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cx('transition-colors', active ? 'font-semibold text-ink underline decoration-2 underline-offset-8' : 'text-muted hover:text-ink')}
              >
                {l.label}
              </Link>
            );
          })}
          <AiModeButton />
        </div>
        <div ref={menuRef} className="col-start-3 flex items-center justify-self-end gap-2">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'site-nav-mobile-menu' : undefined}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink transition-colors hover:bg-surface md:hidden"
          >
            {menuOpen ? <X size={20} aria-hidden="true" /> : <List size={20} aria-hidden="true" />}
          </button>
          {right}
        </div>
        {menuOpen && (
          <div
            id="site-nav-mobile-menu"
            className="absolute inset-x-0 top-full z-40 border-b border-ink/[0.06] bg-white/95 px-5 py-3 shadow-[0_20px_40px_-24px_rgba(10,12,16,0.25)] backdrop-blur-md md:hidden"
          >
            {LINKS.map((l) => {
              const active = isActive(pathname, l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={cx(
                    'block rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    active ? 'bg-ink/[0.04] font-semibold text-ink' : 'text-muted hover:bg-surface hover:text-ink'
                  )}
                >
                  {l.label}
                </Link>
              );
            })}
            <AiModeButton className="mt-2 w-full justify-center" />
          </div>
        )}
      </div>
    </nav>
  );
}
