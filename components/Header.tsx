'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HeaderMenu } from './game/HeaderMenu';
import { WalletConnect } from './wallet';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { motion } from 'framer-motion';
import { BRAND } from '@/lib/brand';

export function Header() {
    const [demoActivated, setDemoActivated] = useState(false);
    const pathname = usePathname();

    const {
        setAddress,
        setBalance,
        setIsConnected,
        toggleAccountType,
        accountType,
        accessCode,
    } = useStore(useShallow((s) => ({ setAddress: s.setAddress, setBalance: s.setBalance, setIsConnected: s.setIsConnected, toggleAccountType: s.toggleAccountType, accountType: s.accountType, accessCode: s.accessCode })));

    const activateDemoMode = () => {
        if (accountType === 'demo') {
            // Exit demo mode
            toggleAccountType();
            setAddress(null);
            setIsConnected(false);
            return;
        }

        setAddress('0xDEMO_1234567890');
        setBalance(5000); // Increased demo balance for better testing
        setIsConnected(true);
        if (accountType === 'real') toggleAccountType();
        setDemoActivated(true);
        setTimeout(() => setDemoActivated(false), 2000);
    };


    // Routes that bring their own light SiteNav: rendering this dark bar on
    // top of it would double-nest two headers and two wallet controls.
    const LIGHT_NAV_ROUTES = ['/', '/trade', '/history'];
    if (LIGHT_NAV_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))) return null;

    return (
        <header className="z-[100] px-4 sm:px-8 py-3 flex justify-between items-center bg-black/40 backdrop-blur-3xl border-b border-white/5">
            <div className="flex items-center gap-4">
                <Link href="/" aria-label={`${BRAND.name} home`} className="group flex items-center gap-2">
                    <motion.span
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        className="text-xl sm:text-2xl font-black tracking-tighter sm:tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-white via-purple-400 to-white cursor-pointer select-none"
                        style={{ fontFamily: 'var(--font-orbitron)' }}
                    >
                        {BRAND.name.toUpperCase()}
                    </motion.span>
                </Link>
                {demoActivated && (
                    <span role="status" className="text-[8px] font-mono text-emerald-400 border border-emerald-400/30 px-2 py-0.5 rounded bg-emerald-400/5 animate-pulse uppercase tracking-widest">
                        Demo Activated
                    </span>
                )}
            </div>

            <div className="flex items-center gap-2 sm:gap-4">
                {accessCode !== null && (
                    <button
                        type="button"
                        onClick={activateDemoMode}
                        aria-pressed={accountType === 'demo'}
                        className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-full transition-all group"
                    >
                        <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" aria-hidden="true" />
                        <span className="text-[9px] font-black uppercase tracking-widest text-emerald-400/80 group-hover:text-emerald-400">
                            Demo Mode
                        </span>
                    </button>
                )}

                <HeaderMenu />
                <WalletConnect />
            </div>
        </header>
    );
}
