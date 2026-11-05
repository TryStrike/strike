'use client';

import React, { useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  message: string;
  type: ToastType;
  onClose: () => void;
  duration?: number;
  links?: Array<{ label: string; href: string }>;
}

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

  const typeStyles = {
    success: 'bg-green-900/90 border-green-500 text-green-100',
    error: 'bg-red-900/90 border-red-500 text-red-100',
    warning: 'bg-yellow-900/90 border-yellow-500 text-yellow-100',
    info: 'bg-blue-900/90 border-blue-500 text-blue-100'
  };

  const icons = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ'
  };

  return (
    <div className={`
      ${typeStyles[type]}
      border-2 rounded-lg p-4 shadow-lg
      flex items-center gap-3
      animate-slide-in
    `}>
      <span className="text-2xl">{icons[type]}</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium">{message}</p>
        {links && links.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {links.map((link) => (
              <a
                key={`${link.href}-${link.label}`}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline underline-offset-2 hover:opacity-80"
              >
                {link.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onClose}
        className="text-xl hover:opacity-70 transition-opacity"
      >
        ×
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
    <div className="fixed top-4 right-4 z-[200] space-y-2 max-w-md">
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
