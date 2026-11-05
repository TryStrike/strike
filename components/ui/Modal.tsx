'use client';

import React, { useEffect } from 'react';
import { X } from '@phosphor-icons/react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  showCloseButton?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  showCloseButton = true
}) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }

    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-sm" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[90vh] w-full max-w-[420px] overflow-y-auto rounded-[28px] bg-white p-7 font-tight text-ink ring-1 ring-line shadow-[0_40px_80px_-40px_rgba(10,12,16,0.35)] animate-in fade-in zoom-in-95 duration-200"
      >
        {(title || showCloseButton) && (
          <div className="mb-6 flex items-start justify-between gap-4">
            {title && <h2 className="text-[22px] font-semibold tracking-tight">{title}</h2>}
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 -mt-1 ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-surface hover:text-ink"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
};
