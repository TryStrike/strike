'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { getFeePercentLabel } from '@/lib/fees/platformFee';
import { getArcConfig } from '@/lib/arc/config';
import { Button } from '@/components/ui/kit';
import {
    safeStorage,
    clampTourStep,
    readTourStep,
    writeTourStep,
    clearTourProgress,
    isTourDismissed,
    setTourDismissed,
    hasSeenTour,
    markTourSeen,
    shouldAutoStartTour,
    normalizeTourScope,
} from './tourProgress';

interface TourStep {
    /** Anchor selector: a real element carrying data-tour="<name>". */
    target: string;
    title: string;
    content: string;
    howTo?: string[];   // numbered action steps shown below the content
    win?: string;       // "you win when…" line (rule, not a promise)
    note?: string;      // honest caveat (fees, draws, stake risk)
    position: 'top' | 'bottom' | 'left' | 'right';
}

const TOUR_HOST_ID = 'strike-tour-host';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Own `prefers-reduced-motion` read so the tour never depends on motion-lib internals. */
function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReduced(mq.matches);
        if (typeof mq.addEventListener !== 'function') return;
        const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);
    return reduced;
}

/**
 * Portal host at the end of <body> while the tour is open; removed on close
 * so an interrupted tour can never leave an orphaned overlay behind.
 */
function useTourHost(active: boolean): HTMLElement | null {
    const [host, setHost] = useState<HTMLElement | null>(null);
    useEffect(() => {
        if (!active || typeof document === 'undefined') return;
        let el = document.getElementById(TOUR_HOST_ID);
        let created = false;
        if (!el) {
            el = document.createElement('div');
            el.id = TOUR_HOST_ID;
            el.setAttribute('data-tour-host', '');
            document.body.appendChild(el);
            created = true;
        }
        setHost(el);
        return () => {
            setHost(null);
            if (created && el && !el.hasChildNodes()) el.remove();
        };
    }, [active]);
    return host;
}

/**
 * While the tour is open the rest of the page is taken out of the a11y tree
 * and the tab order (`aria-hidden` + `inert` on every body child except the
 * tour's own portal host). Prior attribute values are restored on close.
 */
function useInertRestOfPage(isOpen: boolean, host: HTMLElement | null): void {
    useEffect(() => {
        if (!isOpen || !host || typeof document === 'undefined') return;
        const reverted: Array<{ el: Element; aria: string | null; inert: boolean }> = [];
        Array.from(document.body.children).forEach((el) => {
            if (el === host) return;
            reverted.push({ el, aria: el.getAttribute('aria-hidden'), inert: el.hasAttribute('inert') });
            el.setAttribute('aria-hidden', 'true');
            el.setAttribute('inert', '');
        });
        return () => {
            reverted.forEach(({ el, aria, inert }) => {
                if (aria === null) el.removeAttribute('aria-hidden');
                else el.setAttribute('aria-hidden', aria);
                if (!inert) el.removeAttribute('inert');
            });
        };
    }, [isOpen, host]);
}

export const QuickTour: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    /** Resume from sessionStorage for the connected wallet (default: true). */
    resumable?: boolean;
}> = ({ isOpen, onClose, resumable = true }) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
    const [anchorMissing, setAnchorMissing] = useState(false);
    const [dontShowAgain, setDontShowAgain] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);
    const storageRef = useRef<ReturnType<typeof safeStorage>>(null);
    const loadedScopeRef = useRef<string | null>(null);
    const restoreFocusRef = useRef<Element | null>(null);

    const isConnected = useStore(state => state.isConnected);
    const address = useStore(state => state.address);
    const userTier = useStore(state => state.userTier);
    const setActiveTab = useStore(state => state.setActiveTab);
    const setGameMode = useStore(state => state.setGameMode);

    const reduceMotion = usePrefersReducedMotion();
    const host = useTourHost(isOpen);
    useInertRestOfPage(isOpen, host);

    // Per-wallet storage scope: hashed address, never the raw one.
    const scope = useMemo(() => normalizeTourScope(address), [address]);

    // Honest sources for anything numeric/geographic in the copy.
    const networkName = getArcConfig().name;
    const feeLabel = getFeePercentLabel(userTier);

    const steps: TourStep[] = useMemo(() => [
        ...(isConnected ? [] : [{
            target: '[data-tour="connect-button"]',
            title: 'Connect first',
            content: `Connect a wallet on ${networkName}. Connecting only shares your address — nothing is wagered until you place a round.`,
            howTo: [
                'Open the connect button in the header',
                'Choose your wallet and approve the request',
            ],
            position: 'bottom' as const,
        }]),
        {
            target: '[data-tour="asset-selector"]',
            title: 'Pick a market',
            content: 'Charts follow live Pyth prices across crypto, stocks, metals and forex.',
            howTo: [
                'Open the selector above the chart',
                'Choose an asset',
                'The chart and price update instantly',
            ],
            position: 'bottom' as const,
        },
        {
            target: '[data-tour="classic-mode"]',
            title: 'Classic: higher or lower',
            content: 'Choose a duration, then bet whether the price ends above or below its entry when the timer closes.',
            howTo: [
                'Enter an amount',
                'Choose an expiry (5s to 60s)',
                'Tap Higher or Lower',
                'The payout multiplier for that round is shown before you confirm',
            ],
            win: 'the final price is above (Higher) or below (Lower) the entry price at expiry.',
            note: 'A round closing exactly on its entry price is a draw and returns your stake. Every other outcome risks the full stake.',
            position: 'bottom' as const,
        },
        {
            target: '[data-tour="box-mode"]',
            title: 'Box: pick a cell',
            content: 'The chart becomes a grid. Click a cell to bet the price lands inside that zone when the column expires.',
            howTo: [
                'Enter an amount',
                'Choose a time column (5s to 60s)',
                'Click a cell on the grid',
                'Cells further from the current price pay a higher multiplier',
            ],
            win: 'the price is inside the cell you picked when its column expires.',
            note: 'Losing rounds forfeit the stake you placed.',
            position: 'bottom' as const,
        },
        {
            target: '[data-tour="draw-mode"]',
            title: 'Draw: your own range',
            content: 'Drag a rectangle on the chart to set both the price range and the window.',
            howTo: [
                'Enter an amount (drawn rounds use a fixed 5-second window)',
                'Drag on the chart to draw a box',
                'Height is the price range, width the time',
                'Release, then confirm the round',
            ],
            win: 'the price stays inside your box until the round expires.',
            note: 'Losing rounds forfeit the stake you placed.',
            position: 'bottom' as const,
        },
        {
            target: '[data-tour="deposit-section"]',
            title: 'Fund your balance',
            content: `Rounds settle in USDC on ${networkName}. Keep your balance topped up to place more rounds.`,
            howTo: [
                'Open the Wallet section below the bet panel',
                'Enter an amount and confirm the deposit in your wallet',
            ],
            note: `A ${feeLabel} platform fee applies to deposits and withdrawals.`,
            position: 'bottom' as const,
        },
        {
            target: '[data-tour="active-bets"]',
            title: 'Follow your rounds',
            content: 'Every live and settled round shows up here with its countdown. Results settle automatically from the price feed at expiry.',
            position: 'top' as const,
        },
    ], [isConnected, networkName, feeLabel]);

    // ── Persistence: resume, record, dismiss (per wallet scope) ────────────
    // On (re)open — or when the connected wallet changes — restore the step
    // persisted for THAT wallet; a finished/dismissed tour restarts from 0.
    useEffect(() => {
        if (!isOpen) return;
        const storage = safeStorage();
        storageRef.current = storage;
        loadedScopeRef.current = scope;
        setDontShowAgain(isTourDismissed(storage, scope));
        if (resumable) {
            setCurrentStep(clampTourStep(readTourStep(storage, scope, steps.length), steps.length));
        } else {
            setCurrentStep(0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open / wallet change
    }, [isOpen, scope]);

    // Persist the resume index, but only once the current step actually
    // belongs to the current wallet scope (prevents a wallet switch mid-open
    // from writing another wallet's step into the new scope).
    useEffect(() => {
        if (!isOpen || !resumable) return;
        if (loadedScopeRef.current !== scope) return;
        writeTourStep(storageRef.current, scope, currentStep);
    }, [isOpen, scope, currentStep, resumable]);

    const finishTour = useCallback((opts?: { dismissed?: boolean }) => {
        const storage = storageRef.current ?? safeStorage();
        markTourSeen(storage, scope);
        clearTourProgress(storage, scope);
        if (opts?.dismissed || dontShowAgain) setTourDismissed(storage, scope, true);
        // NB: no setCurrentStep(0) here — it would re-trigger the persist
        // effect and re-write the progress key we just cleared. The read
        // effect restores 0 on the next open.
        onClose();
    }, [scope, dontShowAgain, onClose]);

    // ── View state changes (tabs/modes) driven by the current step ─────────
    useEffect(() => {
        if (!isOpen) return;

        const step = steps[currentStep];
        if (!step) return;

        if (step.target === '[data-tour="classic-mode"]') setGameMode('binomo');
        if (step.target === '[data-tour="box-mode"]') setGameMode('box');
        if (step.target === '[data-tour="draw-mode"]') setGameMode('draw');
        if (step.target === '[data-tour="wallet-tab"]') setActiveTab('bet');
        if (step.target === '[data-tour="deposit-section"]') setActiveTab('wallet');
    }, [currentStep, isOpen, steps, setGameMode, setActiveTab]);

    // ── Anchor measurement: real elements only, with a graceful fallback ───
    const measure = useCallback(() => {
        const step = steps[currentStep];
        if (!step) {
            setTargetRect(null);
            setAnchorMissing(true);
            return;
        }
        const element = document.querySelector(step.target);
        if (element) {
            setAnchorMissing(false);
            setTargetRect(element.getBoundingClientRect());
        } else {
            // Anchor absent (e.g. board not rendered until a wallet connects):
            // degrade to a plain card instead of hiding the tour or crashing.
            setTargetRect(null);
            setAnchorMissing(true);
        }
    }, [currentStep, steps]);

    useEffect(() => {
        if (!isOpen || !host) return;

        measure();

        const scrollOnce = () => {
            const step = steps[currentStep];
            if (!step) return;
            const element = document.querySelector(step.target);
            if (element && typeof element.scrollIntoView === 'function') {
                // Tall wallet column: "center" can scroll the viewport such that the tooltip clips; "nearest" keeps more UI in view.
                const block =
                    step.target === '[data-tour="deposit-section"]' ? 'nearest' : 'center';
                element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block, inline: 'nearest' });
            }
        };

        // A couple of retries: mode switches re-mount anchors after animations.
        const timers = [
            setTimeout(() => { scrollOnce(); measure(); }, 300),
            setTimeout(measure, 700),
            setTimeout(measure, 1200),
        ];

        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
            timers.forEach(clearTimeout);
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [isOpen, host, currentStep, steps, measure, reduceMotion]);

    // ── Keyboard: arrows navigate steps, Esc closes, Tab is trapped ────────
    const goNext = useCallback(() => {
        setCurrentStep((s) => {
            if (s < steps.length - 1) return s + 1;
            return s;
        });
    }, [steps.length]);

    const goBack = useCallback(() => {
        setCurrentStep((s) => Math.max(0, s - 1));
    }, []);

    useEffect(() => {
        if (!isOpen || !host) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'Escape':
                    e.preventDefault();
                    finishTour();
                    return;
                case 'ArrowRight':
                case 'ArrowDown':
                    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
                    e.preventDefault();
                    goNext();
                    return;
                case 'ArrowLeft':
                case 'ArrowUp':
                    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
                    e.preventDefault();
                    goBack();
                    return;
                case 'Home':
                    e.preventDefault();
                    setCurrentStep(0);
                    return;
                case 'End':
                    e.preventDefault();
                    setCurrentStep(Math.max(0, steps.length - 1));
                    return;
                case 'Tab': {
                    // Focus trap inside the popover while the tour is open.
                    const popover = popoverRef.current;
                    if (!popover) return;
                    const focusable = Array.from(
                        popover.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
                    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
                    if (focusable.length === 0) {
                        e.preventDefault();
                        popover.focus();
                        return;
                    }
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    const active = document.activeElement;
                    if (e.shiftKey) {
                        if (active === first || active === popover || !popover.contains(active)) {
                            e.preventDefault();
                            last.focus();
                        }
                    } else if (active === last || !popover.contains(active)) {
                        e.preventDefault();
                        first.focus();
                    }
                    return;
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [isOpen, host, steps.length, goNext, goBack, finishTour]);

    // Move focus into the card on open and on every step change, and restore
    // the launcher's focus when the tour goes away.
    useEffect(() => {
        if (!isOpen) return;
        restoreFocusRef.current = document.activeElement;
        return () => {
            const prev = restoreFocusRef.current as HTMLElement | null;
            restoreFocusRef.current = null;
            if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
                prev.focus();
            }
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !host) return;
        const raf = requestAnimationFrame(() => popoverRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [isOpen, host, currentStep]);

    if (!isOpen) return null;
    // The portal host is created in an effect right after open; render the
    // card into it on the following commit (never against a null container).
    if (!host) return null;

    const currentStepData = steps[currentStep];
    if (!currentStepData) return null;

    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
    const tooltipWidth = isMobile ? Math.min(window.innerWidth - 32, 300) : 340;
    // Layout estimate for viewport math (real card is taller; must not under-estimate or the bottom clips).
    const tooltipLayoutHeight = isMobile ? 360 : 420;
    const anchored = host !== null && targetRect !== null && !anchorMissing;

    // Calculate clamped position
    const calculatePosition = () => {
        const padding = 16;
        const gap = 16;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

        if (!anchored || !targetRect) {
            // Unanchored fallback: bottom-center above the mobile tab bar /
            // viewport bottom on desktop. A plain card — no spotlight.
            return {
                left: Math.max(padding, (vw - tooltipWidth) / 2),
                top: Math.max(padding, vh - tooltipLayoutHeight - padding),
                tooltipBelowTarget: true,
            };
        }

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

        left = Math.max(padding, Math.min(left, vw - tooltipWidth - padding));
        top = Math.max(padding, Math.min(top, vh - tooltipLayoutHeight - padding));

        // Arrow sits on the edge of the tooltip that faces the highlight.
        const tooltipBelowTarget = preferBottom;
        return { left, top, tooltipBelowTarget };
    };

    const pos = calculatePosition();

    const handleNext = () => {
        if (currentStep < steps.length - 1) {
            goNext();
        } else {
            finishTour();
        }
    };

    const titleId = 'strike-tour-title';

    return createPortal(
        <div className="fixed inset-0 z-[120] pointer-events-none font-tight">
            {/* Dimmed background with a hole over the target (only when anchored) */}
            <svg className="absolute inset-0 w-full h-full pointer-events-auto" aria-hidden="true">
                <defs>
                    <mask id="tour-mask">
                        <rect width="100%" height="100%" fill="white" />
                        {anchored && targetRect && (
                            <rect
                                x={targetRect.left - 8}
                                y={targetRect.top - 8}
                                width={targetRect.width + 16}
                                height={targetRect.height + 16}
                                rx="16"
                                fill="black"
                            />
                        )}
                    </mask>
                </defs>
                <rect
                    width="100%"
                    height="100%"
                    fill={anchored ? 'rgba(10, 12, 16, 0.28)' : 'rgba(10, 12, 16, 0.45)'}
                    mask={anchored ? 'url(#tour-mask)' : undefined}
                    onClick={() => finishTour()}
                />
            </svg>

            {/* Spotlight ring — anchored steps only */}
            {anchored && targetRect && (
                reduceMotion ? (
                    <div
                        className="absolute rounded-2xl ring-2 ring-up pointer-events-none"
                        style={{
                            left: targetRect.left - 8,
                            top: targetRect.top - 8,
                            width: targetRect.width + 16,
                            height: targetRect.height + 16,
                        }}
                    />
                ) : (
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
                )
            )}

            {/* Screen-reader announcement of the current step */}
            <div aria-live="polite" role="status" className="sr-only">
                Step {currentStep + 1} of {steps.length}: {currentStepData.title}
            </div>

            {/* Step card */}
            <motion.div
                ref={popoverRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                data-tour="quick-tour-card"
                data-reduced-motion={reduceMotion ? 'true' : undefined}
                data-anchor={anchorMissing ? 'missing' : currentStepData.target}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0, left: pos.left, top: pos.top }}
                transition={reduceMotion ? { duration: 0 } : { type: 'spring', damping: 28, stiffness: 300 }}
                style={{ width: tooltipWidth, ...(reduceMotion ? { left: pos.left, top: pos.top } : null) }}
                className="absolute flex max-h-[min(460px,calc(100vh-2rem))] flex-col rounded-3xl bg-white p-6 text-ink ring-1 ring-line shadow-[0_40px_80px_-40px_rgba(10,12,16,0.35)] pointer-events-auto outline-none"
            >
                <div className="mb-2 flex shrink-0 items-start justify-between gap-3">
                    <h3 id={titleId} className="text-[17px] font-semibold leading-snug tracking-tight">
                        {currentStepData.title}
                    </h3>
                    <div className="flex shrink-0 items-center gap-2">
                        <span className="font-jet text-xs text-faint">
                            {currentStep + 1}/{steps.length}
                        </span>
                        <button
                            type="button"
                            aria-label="Close tour"
                            onClick={() => finishTour()}
                            className="-mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface hover:text-ink"
                        >
                            <X size={14} weight="bold" />
                        </button>
                    </div>
                </div>

                <div className="mb-4 min-h-0 space-y-3 overflow-y-auto overscroll-contain">
                    <p className="text-sm leading-relaxed text-muted">
                        {currentStepData.content}
                    </p>

                    {anchorMissing && (
                        <p className="rounded-xl bg-surface px-3 py-2 text-[12px] leading-snug text-muted">
                            This control isn&rsquo;t on screen right now — it appears once the board is ready. The steps below still apply.
                        </p>
                    )}

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

                    {currentStepData.note && (
                        <p className="text-[12px] leading-snug text-subtle">
                            {currentStepData.note}
                        </p>
                    )}
                </div>

                <label className="mb-3 flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-muted hover:text-ink">
                    <input
                        type="checkbox"
                        checked={dontShowAgain}
                        onChange={(e) => {
                            setDontShowAgain(e.target.checked);
                            setTourDismissed(storageRef.current ?? safeStorage(), scope, e.target.checked);
                        }}
                        className="h-3.5 w-3.5 accent-[#2151F5]"
                    />
                    Don&rsquo;t show again
                </label>

                <div className="mt-auto flex shrink-0 items-center justify-between">
                    <Button variant="ghost" size="sm" onClick={() => finishTour()} className="-ml-3">
                        Skip
                    </Button>
                    <div className="flex gap-2">
                        {currentStep > 0 && (
                            <Button variant="secondary" size="sm" onClick={goBack}>
                                Back
                            </Button>
                        )}
                        <Button size="sm" onClick={handleNext}>
                            {currentStep === steps.length - 1 ? 'Finish' : 'Next'}
                        </Button>
                    </div>
                </div>
            </motion.div>
        </div>,
        host
    );
};

/**
 * Uncontrolled onboarding state for surfaces outside the trade page's
 * zustand-driven tour. Auto-opens once per wallet for first-run users
 * (never after "Don't show again" or a completed tour for that wallet)
 * and stays mountable anywhere. Progress lives in sessionStorage only.
 */
export function useOnboardingTour(options?: { autoStartDelayMs?: number }) {
    const [isOpen, setIsOpen] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const startedScopesRef = useRef<Set<string>>(new Set());

    const address = useStore(state => state.address);
    const scope = normalizeTourScope(address);

    useEffect(() => {
        const storage = safeStorage();
        setDismissed(isTourDismissed(storage, scope));
        if (startedScopesRef.current.has(scope)) return;
        if (
            shouldAutoStartTour({
                dismissed: isTourDismissed(storage, scope),
                seen: hasSeenTour(storage, scope),
            })
        ) {
            startedScopesRef.current.add(scope);
            const delay = options?.autoStartDelayMs ?? 1200;
            const t = setTimeout(() => setIsOpen(true), delay);
            return () => clearTimeout(t);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- delay read once per scope
    }, [scope]);

    return {
        isOpen,
        dismissed,
        scope,
        open: () => setIsOpen(true),
        close: () => setIsOpen(false),
    };
}

/**
 * Self-contained launcher: a "How to play" chip + the tour itself.
 * Mount <TourLauncher /> anywhere (e.g. SiteNav right slot) on pages that do
 * not already render the store-driven <QuickTour> — avoid double-mounting.
 */
export const TourLauncher: React.FC<{ className?: string }> = ({ className = '' }) => {
    const tour = useOnboardingTour();
    return (
        <>
            <button
                type="button"
                onClick={tour.open}
                aria-label="Open the how-to-play tour"
                className={`h-9 rounded-full px-3.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-ink ${className}`}
            >
                How to play
            </button>
            <QuickTour isOpen={tour.isOpen} onClose={tour.close} />
        </>
    );
};
