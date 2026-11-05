'use client';

import React, { useEffect } from 'react';
import { X } from '@phosphor-icons/react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  message: string;
  type: ToastType;
  onClose: () => void;
  duration?: number;
  links?: Array<{ label: string; href: string }>;
}

const DOT: Record<ToastType, string> = {
  success: 'bg-up',
  error: 'bg-down',
  warning: 'bg-down',
  info: 'bg-faint',
};

const Toast: React.FC<ToastProps> = ({
  message,
  type,
  onClose,
  duration = 5000,
  links
}) => {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 font-tight text-ink ring-1 ring-line shadow-[0_20px_40px_-24px_rgba(10,12,16,0.3)] animate-slide-in"
    >
      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[type]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{message}</p>
        {links && links.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-3">
            {links.map((link) => (
              <a
                key={`${link.href}-${link.label}`}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-up hover:underline underline-offset-2"
              >
                {link.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 rounded-full p-0.5 text-faint transition-colors hover:text-ink"
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
};

// Toast Container Component
interface ToastContainerProps {
  toasts: Array<{ id: string; message: string; type: ToastType; links?: Array<{ label: string; href: string }> }>;
  onRemove: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemove }) => {
  return (
    <div className="fixed top-4 right-4 z-[200] w-[min(360px,calc(100vw-2rem))] space-y-2">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          links={toast.links}
          onClose={() => onRemove(toast.id)}
        />
      ))}
    </div>
  );
};
