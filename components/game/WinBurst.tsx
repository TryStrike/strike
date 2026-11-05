'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ShareNetwork } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { BRAND } from '@/lib/brand';

const COLORS = ['#2151F5', '#7C9BFF', '#0A0C10', '#C2410C', '#B7C6FF'];

/** X intent for sharing a win. */
export function shareWinUrl(payout: number, market: string) {
  const text = `Just called ${market} on ${BRAND.name} and won +${payout.toFixed(2)} USDC, settled in USDC on Arc.`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(BRAND.url)}`;
}

/** Confetti + counting payout whenever a new round is won. Sits over the chart. */
export function WinBurst() {
  const selectedAsset = useStore((s) => s.selectedAsset);
  const gameMode = useStore((s) => s.gameMode);
  const reduceMotion = useReducedMotion();
  const [win, setWin] = useState<{ id: string; payout: number } | null>(null);
  const [shown, setShown] = useState(0);

  // Fire once per newly settled winning round (existing history never triggers it).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useStore.subscribe((state, prev) => {
      const latest = state.bets[0];
      if (!latest || latest.id === prev.bets[0]?.id || !latest.won) return;
      setWin({ id: latest.id, payout: parseFloat(latest.payout) || 0 });
      clearTimeout(timer);
      timer = setTimeout(() => setWin(null), 2600);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  // Count the payout up over ~0.6s.
  useEffect(() => {
    if (!win) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min((now - start) / 600, 1);
      setShown(win.payout * (1 - Math.pow(1 - k, 3)));
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [win]);

  return (
    <AnimatePresence>
      {win && (
        <motion.div
          key={win.id}
          className="pointer-events-none absolute inset-0 z-40 grid place-items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {!reduceMotion &&
            Array.from({ length: 28 }, (_, i) => {
              const angle = (i / 28) * Math.PI * 2;
              const dist = 140 + (i % 5) * 34;
              return (
                <motion.span
                  key={i}
                  className="absolute h-2 w-1.5 rounded-[2px]"
                  style={{ background: COLORS[i % COLORS.length] }}
                  initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                  animate={{ x: Math.cos(angle) * dist, y: Math.sin(angle) * dist + 60, rotate: 360 + i * 25, opacity: 0 }}
                  transition={{ duration: 1.4, ease: [0.2, 0.8, 0.2, 1] }}
                />
              );
            })}
          <motion.div
            role="status"
            initial={{ scale: 0.9, y: 8 }}
            // Box mode: lift the card into the chart's top third so it doesn't
            // cover grid cells the player may want to tap (transform moves the
            // hit area too; the confetti layer stays centered).
            animate={{ scale: 1, y: gameMode === 'box' ? -110 : 0 }}
            className="pointer-events-auto flex flex-col items-center rounded-[28px] bg-white/80 px-8 py-6 font-tight shadow-[0_30px_80px_-30px_rgba(33,81,245,0.45)] ring-1 ring-ink/[0.06] backdrop-blur-xl"
          >
            <span className="text-sm text-subtle">You called it</span>
            <span className="mt-1 font-jet text-[44px] font-medium leading-none tracking-[-0.04em] text-up">
              +{shown.toFixed(2)}
            </span>
            <span className="mt-1 font-jet text-xs text-faint">USDC</span>
            <a
              href={shareWinUrl(win.payout, selectedAsset)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium text-muted ring-1 ring-ink/[0.08] hover:text-ink"
            >
              <ShareNetwork size={15} /> Share
            </a>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
