'use client';


import React from 'react';
import { cx } from './kit';

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

  const shifted = shiftDecimal(abs, dp);
  const rounded = shiftDecimal(Math.round(shifted), -dp);
  const negative = num < 0 && rounded !== 0;
  const fixed = rounded.toFixed(dp);

  const [intPart, fracPart] = fixed.split('.');
  const groupedInt = grouped ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  const body = dp > 0 ? `${groupedInt}.${fracPart}` : groupedInt;

  const prefix = negative ? '-' : sign && num > 0 ? '+' : '';
  return `${prefix}${symbol}${body}`;
}

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
  value: number | string;
  decimals?: number;
  symbol?: string;
  showSign?: boolean;
  colorBySign?: boolean;
  className?: string;
}

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
