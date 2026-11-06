'use client';

import { usePathname } from 'next/navigation';
import { SiteNav } from './SiteNav';
import { WalletConnect } from './wallet';

const OWN_NAV = ['/', '/trade', '/history', '/agent', '/markets'];

export function Header() {
  const pathname = usePathname();
  if (OWN_NAV.some((r) => pathname === r || pathname.startsWith(`${r}/`))) return null;
  return <SiteNav wide right={<WalletConnect />} />;
}
