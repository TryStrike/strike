'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@/lib/store';
import { Button } from '@/components/ui/kit';

interface TourStep {
    target: string;
    title: string;
    content: string;
    howTo?: string[];   // numbered action steps shown below the content
    win?: string;       // "you win when…" line
    position: 'top' | 'bottom' | 'left' | 'right';
}

export const QuickTour: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

    // Use specific selectors for stability
    const isConnected = useStore(state => state.isConnected);
    const setActiveTab = useStore(state => state.setActiveTab);
    const setGameMode = useStore(state => state.setGameMode);

    // Memoize steps to prevent infinite loops
    const steps: TourStep[] = useMemo(() => [
        ...(isConnected ? [] : [{
            target: '[data-tour="connect-button"]',
            title: 'Connect first',
            content: 'Connect a wallet on Arc to start.',
            position: 'bottom' as const
        }]),
        {
            target: '[data-tour="asset-selector"]',
            title: 'Pick a market',
            content: 'Every asset trades on live prices.',
            howTo: [
                'Open the selector above the chart',
                'Browse crypto, stocks, metals or forex',
                'Pick one; the chart updates instantly',
            ],
            position: 'bottom' as const
        },
        {
            target: '[data-tour="classic-mode"]',
            title: 'Classic: higher or lower',
            content: 'Set a timer, pick a direction, win if you\'re right at expiry.',
            howTo: [
                'Enter an amount',
                'Choose an expiry: 5s, 10s, 30s or 1m',
                'Tap Higher or Lower',
                'If price moves your way, you win the shown multiplier',
            ],
            win: 'Price ends above (Higher) or below (Lower) your entry.',
            position: 'bottom' as const
        },
        {
            target: '[data-tour="box-mode"]',
            title: 'Box: pick a cell',
            content: 'The chart becomes a grid. Click a cell to bet on that price zone.',
            howTo: [
                'Enter an amount',
                'Choose a time column (5s to 60s)',
                'Click a cell on the grid',
                'Cells further from price pay more',
            ],
            win: 'Price is inside your cell when its column expires.',
            position: 'bottom' as const
        },
        {
            target: '[data-tour="draw-mode"]',
            title: 'Draw: your own range',
            content: 'Draw a rectangle to set both the price range and the time window.',
            howTo: [
                'Enter an amount (duration is fixed at 5s)',
                'Drag on the chart to draw a box',
                'Height is the price range, width the time',
                'Release, then Confirm',
            ],
            win: 'Price stays inside your box for the full 5 seconds.',
            position: 'bottom' as const
        },
        {
            target: '[data-tour="deposit-section"]',
            title: 'Add funds',
            content: isConnected
                ? 'Deposit USDC on Arc. Your balance updates after confirmation.'
                : 'After connecting, deposit USDC on Arc to start trading.',
            howTo: [
                'Open the Wallet tab',
                'Tap Deposit and enter an amount',
                'Confirm in your wallet',
            ],
            position: 'bottom' as const
        },
    ], [isConnected]);

    // Handle view state changes (tabs/modes) independently of positioning
    useEffect(() => {
        if (!isOpen) return;

        const step = steps[currentStep];
        if (!step) return;

        // Force open the mobile panel if a target is inside it
        const isTargetInPanel = [
            '[data-tour="classic-mode"]',
            '[data-tour="box-mode"]',
            '[data-tour="draw-mode"]',
            '[data-tour="wallet-tab"]',
            '[data-tour="deposit-section"]'
        ].includes(step.target);

        if (isTargetInPanel && window.innerWidth < 640) {
            const panel = document.querySelector('.sm\\:w-\\[300px\\]');
            if (panel && panel.classList.contains('translate-y-full')) {
                // This is a bit hacky but we need to ensure the panel is visible
                // For a real fix, we should use a shared state, but this works given the current structure
                // Assuming GameBoard has a way to reactive to these changes
            }
            // Better: use the store to ensure panel is open
            // Since we don't have setIsPanelOpen in store, we hope the component handles it
        }

        if (step.target === '[data-tour="classic-mode"]') setGameMode('binomo');
        if (step.target === '[data-tour="box-mode"]') setGameMode('box');
        if (step.target === '[data-tour="draw-mode"]') setGameMode('draw');
        if (step.target === '[data-tour="wallet-tab"]') setActiveTab('bet');
        if (step.target === '[data-tour="deposit-section"]') setActiveTab('wallet');
    }, [currentStep, isOpen, steps, setGameMode, setActiveTab]);

    const updateTargetRect = useCallback(() => {
        const step = steps[currentStep];
        if (!step) return;

        const element = document.querySelector(step.target);
        if (element) {
            setTargetRect(element.getBoundingClientRect());
        }
    }, [currentStep, steps]);

    useEffect(() => {
        if (isOpen) {
            // Initial position and scroll
            const step = steps[currentStep];
            setTimeout(() => {
                const element = document.querySelector(step?.target || '');
                if (element) {
                    // Tall wallet column: "center" can scroll the viewport such that the tooltip clips; "nearest" keeps more UI in view.
                    const block =
                        step?.target === '[data-tour="deposit-section"]' ? 'nearest' : 'center';
                    element.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });
                    updateTargetRect();
                }
            }, 300); // Increased timeout for panel animations

            window.addEventListener('resize', updateTargetRect);
            window.addEventListener('scroll', updateTargetRect);
            return () => {
                window.removeEventListener('resize', updateTargetRect);
                window.removeEventListener('scroll', updateTargetRect);
            };
        }
    }, [isOpen, currentStep, steps, updateTargetRect]);

    if (!isOpen || !targetRect) return null;

    const currentStepData = steps[currentStep];
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
    const tooltipWidth = isMobile ? Math.min(window.innerWidth - 32, 300) : 340;
    // Layout estimate for viewport math (real card is taller; must not under-estimate or the bottom clips).
    const tooltipLayoutHeight = isMobile ? 340 : 380;

    // Calculate clamped position
    const calculatePosition = () => {
        const padding = 16;
        const gap = 16;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

        let left = targetRect.left + (targetRect.width / 2) - (tooltipWidth / 2);
        let preferBottom = currentStepData.position === 'bottom';
        let top = preferBottom ? targetRect.bottom + gap : targetRect.top - tooltipLayoutHeight - gap;

        if (currentStepData.position === 'right' && !isMobile) {
            left = targetRect.right + gap;
            top = targetRect.top;
        } else if (currentStepData.position === 'left' && !isMobile) {
            left = targetRect.left - tooltipWidth - gap;
            top = targetRect.top;
        }

        // Mobile: pick side with more room
        if (isMobile) {
            const spaceAbove = targetRect.top - padding;
            const spaceBelow = vh - padding - targetRect.bottom;
            preferBottom = spaceBelow >= spaceAbove;
            top = preferBottom ? targetRect.bottom + gap : targetRect.top - tooltipLayoutHeight - gap;
        }

        // If "top" placement would go above viewport, flip below (and vice versa when possible).
        if (!preferBottom && top < padding) {
            top = targetRect.bottom + gap;
            preferBottom = true;
        }
        if (preferBottom && top + tooltipLayoutHeight > vh - padding) {
            const above = targetRect.top - tooltipLayoutHeight - gap;
            if (above >= padding) {
                top = above;
                preferBottom = false;
            }
        }

        left = Math.max(padding, Math.min(left, window.innerWidth - tooltipWidth - padding));
        top = Math.max(padding, Math.min(top, vh - tooltipLayoutHeight - padding));

        // Arrow sits on the edge of the tooltip that faces the highlight.
        const tooltipBelowTarget = preferBottom;
        return { left, top, tooltipBelowTarget };
    };

    const pos = calculatePosition();

    const handleNext = () => {
        if (currentStep < steps.length - 1) {
            setCurrentStep(currentStep + 1);
        } else {
            onClose();
            setCurrentStep(0);
        }
    };

    const handleBack = () => {
        if (currentStep > 0) {
            setCurrentStep(currentStep - 1);
        }
    };

    return (
        <div className="fixed inset-0 z-[120] pointer-events-none font-tight">
            {/* Dimmed background with a hole over the target */}
            <svg className="absolute inset-0 w-full h-full pointer-events-auto">
                <defs>
                    <mask id="tour-mask">
                        <rect width="100%" height="100%" fill="white" />
                        <rect
                            x={targetRect.left - 8}
                            y={targetRect.top - 8}
                            width={targetRect.width + 16}
                            height={targetRect.height + 16}
                            rx="16"
                            fill="black"
                        />
                    </mask>
                </defs>
                <rect
                    width="100%"
                    height="100%"
                    fill="rgba(10, 12, 16, 0.28)"
                    mask="url(#tour-mask)"
                    onClick={onClose}
                />
            </svg>

            {/* Spotlight ring */}
            <motion.div
                initial={false}
                animate={{
                    left: targetRect.left - 8,
                    top: targetRect.top - 8,
                    width: targetRect.width + 16,
                    height: targetRect.height + 16,
                }}
                className="absolute rounded-2xl ring-2 ring-up pointer-events-none"
            />

            {/* Popover */}
            <motion.div
                role="dialog"
                aria-label={currentStepData.title}
                initial={{ opacity: 0, y: 8 }}
                animate={{
                    opacity: 1,
                    y: 0,
                    left: pos.left,
                    top: pos.top,
                }}
                transition={{ type: 'spring', damping: 28, stiffness: 300 }}
                className="absolute flex max-h-[min(420px,calc(100vh-2rem))] flex-col rounded-3xl bg-white p-6 text-ink ring-1 ring-line shadow-[0_40px_80px_-40px_rgba(10,12,16,0.35)] pointer-events-auto"
                style={{ width: tooltipWidth }}
            >
                <div className="mb-2 flex shrink-0 items-start justify-between gap-3">
                    <h3 className="text-[17px] font-semibold leading-snug tracking-tight">
                        {currentStepData.title}
                    </h3>
                    <span className="mt-1 shrink-0 font-jet text-xs text-faint">
                        {currentStep + 1}/{steps.length}
                    </span>
                </div>

                <div className="mb-5 min-h-0 space-y-3 overflow-y-auto overscroll-contain">
                    <p className="text-sm leading-relaxed text-muted">
                        {currentStepData.content}
                    </p>

                    {currentStepData.howTo && currentStepData.howTo.length > 0 && (
                        <ol className="space-y-1.5">
                            {currentStepData.howTo.map((step, i) => (
                                <li key={i} className="flex items-start gap-2.5 text-[13px] leading-snug text-muted">
                                    <span className="w-3 shrink-0 font-jet text-xs leading-[18px] text-faint">{i + 1}</span>
                                    <span>{step}</span>
                                </li>
                            ))}
                        </ol>
                    )}

                    {currentStepData.win && (
                        <p className="rounded-xl bg-up-soft px-3 py-2 text-[13px] leading-snug text-ink">
                            <span className="font-semibold text-up">You win when </span>
                            {currentStepData.win.charAt(0).toLowerCase() + currentStepData.win.slice(1)}
                        </p>
                    )}
                </div>

                <div className="mt-auto flex shrink-0 items-center justify-between">
                    <Button variant="ghost" size="sm" onClick={onClose} className="-ml-3">
                        Skip
                    </Button>
                    <div className="flex gap-2">
                        {currentStep > 0 && (
                            <Button variant="secondary" size="sm" onClick={handleBack}>
                                Back
                            </Button>
                        )}
                        <Button size="sm" onClick={handleNext}>
                            {currentStep === steps.length - 1 ? 'Finish' : 'Next'}
                        </Button>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};
