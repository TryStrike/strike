/**
 * Wallet connection state machine — pure transitions so the whole table is
 * unit-testable without React, wagmi or a browser.
 *
 * Phases:
 *   idle          nothing attempted yet in this page load
 *   connecting    a provider prompt / dapp link is in flight (UI: spinner,
 *                 buttons disabled — double-clicks must not stack prompts)
 *   authed        wallet connected and adopted by the app
 *   reconnecting  one-tap reconnect to a recently-used wallet in flight
 *   failed        last attempt errored; `lastError.kind` says why
 *   disconnected  user (or wallet) ended an authed session
 *
 * Unknown (phase, event) pairs return the phase unchanged, so the reducer is
 * total and stray events can never corrupt it.
 */

export type ConnectPhase = 'idle' | 'connecting' | 'authed' | 'reconnecting' | 'failed' | 'disconnected';

export type ConnectErrorKind = 'rejected' | 'no_provider' | 'locked' | 'wrong_network' | 'timeout' | 'unknown';

export type ConnectEvent =
  | { type: 'START_CONNECT' }
  | { type: 'CONNECT_SUCCESS' }
  | { type: 'CONNECT_FAILURE'; error: ConnectErrorKind; message?: string }
  | { type: 'START_RECONNECT' }
  | { type: 'RECONNECT_FAILURE'; error: ConnectErrorKind; message?: string }
  | { type: 'DISCONNECT' }
  | { type: 'RESET' };

const TRANSITIONS: Record<ConnectPhase, Partial<Record<ConnectEvent['type'], ConnectPhase>>> = {
  idle: {
    START_CONNECT: 'connecting',
    START_RECONNECT: 'reconnecting',
    // Wallet already connected when the UI mounts (restored session).
    CONNECT_SUCCESS: 'authed',
    DISCONNECT: 'disconnected',
  },
  connecting: {
    CONNECT_SUCCESS: 'authed',
    CONNECT_FAILURE: 'failed',
    DISCONNECT: 'disconnected',
    RESET: 'idle',
  },
  authed: {
    START_RECONNECT: 'reconnecting',
    DISCONNECT: 'disconnected',
    RESET: 'idle',
    // Re-confirming an authed wallet (e.g. ConnectKit opened again) is a no-op,
    // never a second stacked prompt.
    START_CONNECT: 'authed',
  },
  reconnecting: {
    CONNECT_SUCCESS: 'authed',
    RECONNECT_FAILURE: 'failed',
    CONNECT_FAILURE: 'failed',
    DISCONNECT: 'disconnected',
    RESET: 'idle',
  },
  failed: {
    START_CONNECT: 'connecting',
    START_RECONNECT: 'reconnecting',
    CONNECT_SUCCESS: 'authed',
    DISCONNECT: 'disconnected',
    RESET: 'idle',
  },
  disconnected: {
    START_CONNECT: 'connecting',
    START_RECONNECT: 'reconnecting',
    CONNECT_SUCCESS: 'authed',
    RESET: 'idle',
  },
};

export function transitionConnectPhase(phase: ConnectPhase, event: ConnectEvent): ConnectPhase {
  return TRANSITIONS[phase]?.[event.type] ?? phase;
}

/** Phases where a connect is in flight and buttons must be disabled. */
export function isConnectingPhase(phase: ConnectPhase): boolean {
  return phase === 'connecting' || phase === 'reconnecting';
}

export interface ConnectCopy {
  /** One-line, non-technical headline. */
  title: string;
  /** Concrete next step for the user. */
  hint: string;
}

/** User-facing copy per failure kind — no RPC jargon, no stack traces. */
export const CONNECT_COPY: Record<ConnectErrorKind, ConnectCopy> = {
  rejected: {
    title: 'Request declined',
    hint: 'You turned down the connection in your wallet. Press Connect again when you are ready.',
  },
  no_provider: {
    title: 'No wallet found',
    hint: 'This browser has no wallet extension. Install MetaMask (or any WalletConnect-compatible wallet) and refresh the page.',
  },
  locked: {
    title: 'Your wallet is locked',
    hint: 'Open your wallet app, unlock it with your password, then try connecting again.',
  },
  wrong_network: {
    title: 'Wrong network',
    hint: 'Your wallet is on a different network. Switch it to Arc and connect again.',
  },
  timeout: {
    title: 'Connection timed out',
    hint: 'The wallet took too long to answer. Make sure its popup is not waiting on you, then try again.',
  },
  unknown: {
    title: 'Could not connect',
    hint: 'Something went wrong. Try again, or pick a different wallet.',
  },
};

export function connectCopyForError(kind: ConnectErrorKind | null | undefined): ConnectCopy | null {
  if (!kind) return null;
  return CONNECT_COPY[kind] ?? CONNECT_COPY.unknown;
}
