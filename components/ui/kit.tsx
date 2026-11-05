/**
 * Minimal light UI kit (landing + trade). Tokens: app/globals.css
 * (ink, muted, subtle, faint, line, surface, up, up-soft, down, down-soft;
 * fonts: font-tight, font-serif, font-jet).
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'up' | 'down';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-up',
  secondary: 'bg-white/70 backdrop-blur-xl ring-1 ring-ink/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(10,12,16,0.04)] text-ink hover:ring-ink/30',
  ghost: 'text-muted hover:text-ink hover:bg-surface',
  up: 'bg-up text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_8px_20px_-8px_rgba(33,81,245,0.6)] hover:brightness-110 active:scale-[0.98]',
  down: 'bg-white/70 backdrop-blur-xl ring-1 ring-ink/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(10,12,16,0.04)] text-ink hover:bg-ink hover:text-white active:scale-[0.98]',
};
const SIZE = {
  sm: 'h-9 px-3.5 text-sm rounded-full',
  md: 'h-11 px-5 text-[15px] rounded-full',
  lg: 'h-14 px-6 text-base rounded-full',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZE }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 font-semibold transition-all disabled:pointer-events-none disabled:opacity-40',
        VARIANT[variant],
        SIZE[size],
        className
      )}
    />
  );
}

/** Small uppercase mono eyebrow above a control or value. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mb-2.5 font-jet text-[11px] uppercase tracking-[0.14em] text-faint', className)}>{children}</div>;
}

/** Pill-style single choice. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
  disabled,
}: {
  options: { value: T; label: ReactNode; hint?: ReactNode; tour?: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      className={cx('grid gap-1 rounded-full bg-ink/[0.04] p-1 backdrop-blur-xl', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            data-tour={o.tour}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex flex-col items-center justify-center rounded-full py-2 text-sm font-semibold transition-all disabled:opacity-40',
              on ? 'bg-white text-ink shadow-[inset_0_1px_0_rgba(255,255,255,1),0_2px_8px_-2px_rgba(10,12,16,0.12)]' : 'text-subtle hover:text-ink'
            )}
          >
            {o.label}
            {o.hint && <span className={cx('font-jet text-[11px] font-medium', on ? 'text-up' : 'text-faint')}>{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Input with an optional trailing unit. */
export function Field({ unit, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { unit?: ReactNode }) {
  return (
    <div className={cx('flex h-12 items-center rounded-full px-5 bg-white/70 backdrop-blur-xl ring-1 ring-ink/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(10,12,16,0.04)] focus-within:ring-ink/40', className)}>
      <input {...props} className="min-w-0 flex-1 bg-transparent font-jet text-base outline-none placeholder:text-faint" />
      {unit && <span className="ml-2 font-jet text-xs font-medium text-faint">{unit}</span>}
    </div>
  );
}

/** Tiny status chip. */
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'up' | 'down'; children: ReactNode }) {
  const t = { neutral: 'bg-surface text-muted', up: 'bg-up-soft text-up', down: 'bg-down-soft text-down' }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 font-jet text-[11px] font-medium', t)}>{children}</span>;
}
