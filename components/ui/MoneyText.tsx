'use client';

/**
 * MoneyText — fixed-decimal currency rendering with deterministic
 * half-away-from-zero rounding (never JS banker's rounding surprises like
 * (1.005).toFixed(2) === "1.00"), thousands grouping and an optional symbol.
 */

import React from 'react';
import { cx } from './kit';

/**
 * Pure: round `value` to `decimals` places, half away from zero, and group
 * thousands. Accepts numbers and numeric strings (e.g. wei-scaled decimal
 * strings from the backend). Non-finite input → the zero form.
 */
export function formatMoney(
  value: number | string,
  decimals: number = 2,
  opts?: { symbol?: string; sign?: boolean; grouped?: boolean }
): string {
  const { symbol = '', sign = false, grouped = true } = opts ?? {};
  const dp = Math.max(0, Math.min(18, Math.trunc(decimals) || 0));

  let num = typeof value === 'string' ? parseFloat(value.replace(/[, ]/g, '')) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) num = 0;

  const abs = Math.abs(num);

  // Half-away-from-zero rounding at dp places, via string exponent shift to
  // dodge binary-float edge cases (1.005, 0.145, …).
  const shifted = shiftDecimal(abs, dp);
  // Math.round is half-up; `abs` is non-negative so that is half-away-from-zero.
  const rounded = shiftDecimal(Math.round(shifted), -dp);
  // A value that rounds to zero must never render as "-0.00" — the sign was
  // only cosmetic, and "-0" reads as a bug (and breaks delta semantics).
  const negative = num < 0 && rounded !== 0;
  const fixed = rounded.toFixed(dp);

  const [intPart, fracPart] = fixed.split('.');
  const groupedInt = grouped ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  const body = dp > 0 ? `${groupedInt}.${fracPart}` : groupedInt;

  const prefix = negative ? '-' : sign && num > 0 ? '+' : '';
  return `${prefix}${symbol}${body}`;
}

/**
 * Pure: move the decimal point `dp` places to the RIGHT (negative dp moves
 * it left), using digit-string surgery so values like 1.005 land exactly on
 * 100.5 instead of 100.49999999999999.
 */
export function shiftDecimal(x: number, dp: number): number {
  if (x === 0 || dp === 0 || !Number.isFinite(x)) return x;
  const neg = x < 0;
  const s = Math.abs(x).toString();
  if (s.includes('e')) {
    const [mant, exp] = s.split('e');
    return parseFloat(`${mant}e${Number(exp) + dp}`);
  }
  const [int, frac = ''] = s.split('.');
  const digits = int + frac;
  const pointPos = int.length + dp;
  let out: string;
  if (pointPos <= 0) out = `0.${'0'.repeat(-pointPos)}${digits}`;
  else if (pointPos >= digits.length) out = digits + '0'.repeat(pointPos - digits.length);
  else out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  return parseFloat((neg ? '-' : '') + out);
}

export interface MoneyTextProps {
  /** Amount in the display unit (not cents) — number or numeric string. */
  value: number | string;
  decimals?: number;
  /** Prefix symbol, e.g. "$". Empty string renders bare. */
  symbol?: string;
  /** Always show + for positive values. */
  showSign?: boolean;
  /** Color by sign: green up / orange down, using theme tokens. */
  colorBySign?: boolean;
  className?: string;
}

/**
 * Pure: the sign the VIEWER actually sees after rounding to `decimals`.
 * A value like -0.004 renders as 0.00, so it must stay colour-neutral.
 */
export function moneyTone(value: number | string, decimals = 2): 'up' | 'down' | 'flat' {
  const dp = Math.max(0, Math.min(18, Math.trunc(decimals) || 0));
  const num = typeof value === 'string' ? parseFloat(value.replace(/[, ]/g, '')) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return 'flat';
  if (Math.round(shiftDecimal(Math.abs(num), dp)) === 0) return 'flat';
  return num > 0 ? 'up' : 'down';
}

const TONE_CLASS: Record<ReturnType<typeof moneyTone>, string> = {
  up: ' text-up',
  down: ' text-down',
  flat: '',
};

export const MoneyText: React.FC<MoneyTextProps> = ({
  value,
  decimals = 2,
  symbol = '$',
  showSign = false,
  colorBySign = false,
  className,
}) => {
  const tone = colorBySign ? TONE_CLASS[moneyTone(value, decimals)] : '';

  return (
    <span className={cx('font-jet tabular-nums', tone, className)}>
      {formatMoney(value, decimals, { symbol, sign: showSign })}
    </span>
  );
};

export default MoneyText;
