"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ShareNetwork } from "@phosphor-icons/react";
import { useStore } from "@/lib/store";
import { BRAND } from "@/lib/brand";
import { isRealWin } from "@/lib/types/bet";

const CANNON_MS = 1500;
const GRAVITY = 0.35;

function fireSideCannons(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const css = getComputedStyle(document.documentElement);
  const colors = ["--up", "--ink", "--down", "--muted"].map(
    (v) => css.getPropertyValue(v).trim() || "#2151f5",
  );
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  type P = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    spin: number;
    color: string;
    life: number;
  };
  const parts: P[] = [];
  const spawn = (fromLeft: boolean) => {
    const angle =
      ((fromLeft ? 60 : 120) + (Math.random() - 0.5) * 55) * (Math.PI / 180);
    const speed = 11 + Math.random() * 7;
    parts.push({
      x: fromLeft ? 0 : w,
      y: h * 0.5,
      vx: Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
      color: colors[parts.length % colors.length],
      life: 1,
    });
  };

  const end = performance.now() + CANNON_MS;
  let frame = 0;
  const tick = (now: number) => {
    if (now < end)
      for (let i = 0; i < 2; i++) {
        spawn(true);
        spawn(false);
      }
    ctx.clearRect(0, 0, w, h);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vx *= 0.97;
      p.vy = p.vy * 0.97 + GRAVITY;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      p.life -= 0.008;
      if (p.life <= 0 || p.y > h + 20) {
        parts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-4, -2.5, 8, 5);
      ctx.restore();
    }
    if (now < end || parts.length) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

export function shareWinUrl(payout: number, market: string) {
  const text = `Just called ${market} on ${BRAND.name} and won +${payout.toFixed(2)} USDC, settled in USDC on Arc.`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(BRAND.url)}`;
}

export function WinBurst() {
  const selectedAsset = useStore((s) => s.selectedAsset);
  const gameMode = useStore((s) => s.gameMode);
  const reduceMotion = useReducedMotion();
  const [win, setWin] = useState<{ id: string; payout: number } | null>(null);
  const [shown, setShown] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!win || reduceMotion || !canvasRef.current) return;
    return fireSideCannons(canvasRef.current);
  }, [win, reduceMotion]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useStore.subscribe((state, prev) => {
      const latest = state.bets[0];
      if (!latest || latest.id === prev.bets[0]?.id || !isRealWin(latest))
        return;
      setWin({ id: latest.id, payout: parseFloat(latest.payout) || 0 });
      clearTimeout(timer);
      timer = setTimeout(() => setWin(null), 2600);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

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
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full"
            aria-hidden
          />
          <motion.div
            role="status"
            initial={{ scale: 0.9, y: 8 }}
            animate={{ scale: 1, y: gameMode === "box" ? -110 : 0 }}
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
