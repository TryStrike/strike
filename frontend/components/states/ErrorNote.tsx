'use client';


import React from 'react';
import { ShieldWarning, ArrowCounterClockwise } from '@phosphor-icons/react';

export const defaultErrorHeadline = 'Something went wrong';

const MAX_LEN = 160;

const PATH_RE = /(?:file:\/\/)?(?:[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*|\/(?:[\w.\-]+\/){1,}[\w.\-]+|~\/[\w.\-\/]+)/g;
const STACK_FRAME_RE = /\bat\s+[^\n]{0,120}/g;
const SQL_RE = /\b(?:select\s+.{0,80}?\bfrom\b|insert\s+into\b.{0,60}|update\s+\w+\s+set\b.{0,60}|delete\s+from\b.{0,60}|create\s+(?:table|index|trigger)\b.{0,60}|(?:relation|constraint)\s+"?[\w.]+"?\s+(?:does not exist|already exists)|\b(?:where|join)\s+[\w."']+\s*=\s*[\w."'$:{}-]+\b(?:\s+\w+\s+[\w."'$:{}-]+\b)*)/gi;
const SECRET_RE = /\b(?:NEXT_PUBLIC_\w+|process\.env(?:\.\w+)?|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+|[A-Z]{8,}|sk(?:_\w+)?[-_][A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|0x[A-Za-z0-9]{24,})/g;
const ASSIGNMENT_RE = /\b(?:api[-_ ]?key|access[-_ ]?token|key|secret|token|password|passwd)\s*[:=]\s*\S+/gi;
const FILE_RE = /\b[\w.\-$]+\.(?:tsx?|jsx?|mjs|cjs|css|map|sql|json)(?::\d+(?::\d+)?)?\b/g;

function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function sanitizeUserError(raw: unknown, maxLen: number = MAX_LEN): string {
  let text: string;
  if (raw instanceof Error) {
    text = raw.message || raw.name;
  } else if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    text = String(raw);
  } else {
    return defaultErrorHeadline;
  }

  text = text.replace(STACK_FRAME_RE, ' ');
  text = text.replace(PATH_RE, ' ');
  text = text.replace(FILE_RE, ' ');
  text = text.replace(SQL_RE, ' ');
  text = text.replace(SECRET_RE, ' ');
  text = text.replace(ASSIGNMENT_RE, ' ');
  text = text.replace(/["'`][^"'`]{20,}["'`]/g, ' ').replace(/[{}\[\]<>|]/g, ' ');
  text = tidy(text);

  if (text.length < 6) return defaultErrorHeadline;

  if (text.length > maxLen) {
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    text = `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,\.;:\s]+$/, '')}…`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface ErrorNoteProps {
  error?: unknown;
  message?: string;
  className?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export const ErrorNote: React.FC<ErrorNoteProps> = ({
  error,
  message,
  className = '',
  onRetry,
  retryLabel = 'Try again',
}) => {
  const text = message ? tidy(message).slice(0, MAX_LEN) : sanitizeUserError(error);
  return (
    <p
      role="note"
      className={`inline-flex items-start gap-2 rounded-xl bg-down-soft px-3 py-2 text-left font-jet text-[11px] font-medium leading-snug text-down ${className}`}
    >
      <ShieldWarning size={14} weight="fill" className="mt-px shrink-0" aria-hidden="true" />
      <span>{text}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-down ring-1 ring-down/30 transition-colors hover:bg-white"
        >
          <ArrowCounterClockwise size={11} weight="bold" aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </p>
  );
};

export default ErrorNote;
