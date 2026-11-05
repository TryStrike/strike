'use client';


import React from 'react';
import { ToastContainer } from './Toast';
import { useToastStore } from '@/lib/hooks/useToast';

export const ToastProvider: React.FC = () => {
  const { toasts, removeToast } = useToastStore();
  
  return <ToastContainer toasts={toasts} onRemove={removeToast} />;
};
