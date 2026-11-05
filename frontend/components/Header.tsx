'use client';

import { usePathname } from 'next/navigation';
import { SiteNav } from './SiteNav';
import { WalletConnect } from './wallet';

// These routes render their own SiteNav with a custom right column.
const OWN_NAV = ['/', '/trade', '/history', '/agent'];

export function Header() {
  const pathname = usePathname();
  if (OWN_NAV.some((r) => pathname === r || pathname.startsWith(`${r}/`))) return null;
  return <SiteNav wide right={<WalletConnect />} />;
}
