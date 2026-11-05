'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function SlidingNumber({ value, className }: { value: string; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <span className={className} aria-label={value} role="text">
        {value}
      </span>
    );
  }
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

export function WordRotate({ words, index, className }: { words: string[]; index: number; className?: string }) {
  const reduce = useReducedMotion();
  const word = words[index % words.length];
  if (reduce) {
    return (
      <span className="relative inline-flex overflow-hidden align-bottom">
        <span className={className}>{word}</span>
      </span>
    );
  }
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

export function BlurFade({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) {
    return <div className={className}>{children}</div>;
  }
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

export function Marquee({ children, seconds = 40 }: { children: ReactNode; seconds?: number }) {
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <div className="relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
        <div className="flex shrink-0 items-center gap-10 pr-10">{children}</div>
      </div>
    );
  }
  return (
    <div className="relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
      {[0, 1].map((k) => (
        <div
          key={k}
          aria-hidden={k === 1}
          className="flex shrink-0 items-center gap-10 pr-10 animate-[marquee_var(--d)_linear_infinite]"
          style={{ ['--d' as string]: `${seconds}s` }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}

export function CountdownRing({ seconds = 5, size = 72 }: { seconds?: number; size?: number }) {
  const reduce = useReducedMotion();
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => (s <= 1 ? seconds : s - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" role="img" aria-label={`${left} seconds left in this round`}>
      <circle cx="36" cy="36" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle
        cx="36" cy="36" r={r} fill="none" stroke="var(--up)" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c}
        style={{ strokeDashoffset: c * (1 - left / seconds), transition: reduce ? 'none' : 'stroke-dashoffset 1s linear' }}
        transform="rotate(-90 36 36)"
      />
      <text x="36" y="42" textAnchor="middle" className="font-jet" fontSize="17" fontWeight="600" fill="var(--ink)">{left}s</text>
    </svg>
  );
}
