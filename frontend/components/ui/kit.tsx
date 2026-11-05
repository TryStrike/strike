import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const glassPrimary = 'bg-up text-white transition-all hover:brightness-110 active:scale-[0.98]';
export const glassSelected = 'bg-up/[0.08] text-up ring-1 ring-inset ring-up/20 backdrop-blur-xl';

type Variant = 'primary' | 'secondary' | 'ghost' | 'up' | 'down';
const VARIANT: Record<Variant, string> = {
  primary: glassPrimary,
  secondary: 'bg-white ring-1 ring-ink/[0.08] text-ink hover:ring-ink/30',
  ghost: 'text-muted hover:text-ink hover:bg-surface',
  up: 'bg-up text-white hover:brightness-110 active:scale-[0.98]',
  down: 'bg-white ring-1 ring-ink/[0.08] text-ink hover:bg-ink hover:text-white active:scale-[0.98]',
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

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mb-2.5 font-jet text-[11px] uppercase tracking-[0.14em] text-faint', className)}>{children}</div>;
}

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
              on ? 'bg-white text-ink shadow-sm' : 'text-subtle hover:text-ink'
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

export function Field({ unit, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { unit?: ReactNode }) {
  return (
    <div className={cx('flex h-12 items-center rounded-full px-5 bg-white ring-1 ring-ink/[0.08] focus-within:ring-ink/40', className)}>
      <input {...props} className="min-w-0 flex-1 bg-transparent font-jet text-base outline-none placeholder:text-faint" />
      {unit && <span className="ml-2 font-jet text-xs font-medium text-faint">{unit}</span>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'up' | 'down'; children: ReactNode }) {
  const t = { neutral: 'bg-surface text-muted', up: 'bg-up-soft text-up', down: 'bg-down-soft text-down' }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 font-jet text-[11px] font-medium', t)}>{children}</span>;
}
