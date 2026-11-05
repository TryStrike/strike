'use client';

/**
 * Small motion pieces for the landing page, modelled on Motion Primitives'
 * Sliding Number, Magic UI's Word Rotate / Marquee / Blur Fade. CSS and
 * framer-motion only — no extra packages.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Odometer-style number: each digit rolls to its new value. */
export function SlidingNumber({ value, className }: { value: string; className?: string }) {
  return (
    <span className={className} aria-label={value} role="text">
      {value.split('').map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} aria-hidden="true" className="relative inline-block h-[1em] overflow-hidden align-top leading-none">
            <span
              className="flex flex-col transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)]"
              style={{ transform: `translateY(-${Number(ch) * 10}%)` }}
            >
              {DIGITS.map((d) => (
                <span key={d} className="h-[1em] leading-none">{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} aria-hidden="true" className="inline-block leading-none">{ch}</span>
        )
      )}
    </span>
  );
}

/** Cycles through words with a short slide/blur. */
export function WordRotate({ words, index, className }: { words: string[]; index: number; className?: string }) {
  const word = words[index % words.length];
  return (
    <span className="relative inline-flex overflow-hidden align-bottom">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={word}
          className={className}
          initial={{ y: '60%', opacity: 0, filter: 'blur(6px)' }}
          animate={{ y: '0%', opacity: 1, filter: 'blur(0px)' }}
          exit={{ y: '-60%', opacity: 0, filter: 'blur(6px)' }}
          transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {word}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Fades children in from a slight blur, staggered by `delay`. */
export function BlurFade({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, delay, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Infinite horizontal scroll; content is rendered twice for a seamless loop. */
export function Marquee({ children, seconds = 40 }: { children: ReactNode; seconds?: number }) {
  return (
    <div className="group relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
      {[0, 1].map((k) => (
        <div
          key={k}
          aria-hidden={k === 1}
          className="flex shrink-0 items-center gap-10 pr-10 animate-[marquee_var(--d)_linear_infinite] group-hover:[animation-play-state:paused]"
          style={{ ['--d' as string]: `${seconds}s` }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}

/** A ring that drains over `seconds`, restarting forever. */
export function CountdownRing({ seconds = 5, size = 72 }: { seconds?: number; size?: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => (s <= 1 ? seconds : s - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" role="img" aria-label={`${left} seconds left in this round`}>
      <circle cx="36" cy="36" r={r} fill="none" stroke="#E3E6EB" strokeWidth="6" />
      <circle
        cx="36" cy="36" r={r} fill="none" stroke="#2151F5" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c}
        style={{ strokeDashoffset: c * (1 - left / seconds), transition: 'stroke-dashoffset 1s linear' }}
        transform="rotate(-90 36 36)"
      />
      <text x="36" y="42" textAnchor="middle" className="font-[family-name:var(--font-jetbrains-mono)]" fontSize="17" fontWeight="600" fill="#0A0C10">{left}s</text>
    </svg>
  );
}
