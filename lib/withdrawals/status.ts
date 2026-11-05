/**
 * Withdrawal status → player-facing view model.
 *
 * The schema allows exactly four statuses (db/schema.sqlite.sql): 'pending', 'accepted', 'rejected', 'paid_needs_reconciliation'.
 * Anything else (a future migration, a synced legacy row) must degrade to an
 * honest "we are watching this" state rather than pretending to be rejected.
 *
 * Nothing here writes to the ledger; it is a pure read-side mapper.
 */

import { explorerTxUrl } from '@/lib/arc/config';
import { describeIntentWindow, formatRemaining, windowMinutes } from '@/lib/withdrawals/expiry';

/** Status values enforced by withdrawal_requests_status_check. */
export const KNOWN_WITHDRAWAL_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'paid_needs_reconciliation',
] as const;

export type KnownWithdrawalStatus = (typeof KNOWN_WITHDRAWAL_STATUSES)[number];

/** Placeholder hashes written before a payout exists; never linkable. */
const NON_HASH_VALUES = new Set(['', 'PENDING', 'INTERNAL', 'null', 'undefined']);

export type TimelineStepState = 'done' | 'active' | 'upcoming' | 'failed' | 'attention';

export interface TimelineStep {
  key: 'requested' | 'review' | 'approved' | 'sent' | 'confirmed';
  label: string;
  state: TimelineStepState;
  detail?: string;
}

export type WithdrawalTone = 'waiting' | 'info' | 'success' | 'danger' | 'attention' | 'unknown';

export interface WithdrawalRowLike {
  id?: number;
  status?: string | null;
  requested_at?: string | null;
  decided_at?: string | null;
  tx_hash?: string | null;
  fee_tx_hash?: string | null;
  /** Epoch ms (BIGINT column) of the stored signature. Timestamp only —
   * the signature itself never leaves the server. */
  signed_at?: number | string | null;
}

export interface WithdrawalViewModel {
  /** Normalised status; unknown values become 'unknown'. */
  kind: KnownWithdrawalStatus | 'unknown';
  label: string;
  tone: WithdrawalTone;
  /** What the player should actually do, in one or two sentences. */
  playerMessage: string;
  steps: TimelineStep[];
  /** True when polling for progress is pointless (terminal row). */
  terminal: boolean;
  netTxHash: string | null;
  feeTxHash: string | null;
  /** Pending whose signature has left the acceptance window: the operator
   * can no longer pay this intent, so nothing will move without a re-request. */
  intentExpired: boolean;
  /** Ms left in the acceptance window while it is still open; null otherwise. */
  intentRemainingMs: number | null;
}

/** True for values that are actual chain hashes, not 'PENDING' placeholders. */
export function isRealTxHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  const t = hash.trim();
  return t.length > 0 && !NON_HASH_VALUES.has(t.toUpperCase());
}

/**
 * True only for a real 32-byte EVM transaction hash. Placeholders pass
 * isRealTxHash; nothing that fails THIS check may ever become an explorer
 * link or be presented as a recorded chain hash.
 */
export function isChainTxHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  return /^0[xX][0-9a-fA-F]{64}$/.test(hash.trim());
}

/**
 * The accept route stores tx_hash as `feeTxHash|netTx:withdrawTxHash` when a
 * platform fee was collected, or a bare net hash otherwise. Split it so each
 * half can be linked and copied separately.
 */
export function parseCombinedTxHash(txHash: string | null | undefined): {
  netTx: string | null;
  feeTx: string | null;
} {
  const raw = (txHash ?? '').trim();
  if (!raw || NON_HASH_VALUES.has(raw.toUpperCase())) {
    return { netTx: null, feeTx: null };
  }
  const marker = raw.indexOf('|netTx:');
  if (marker >= 0) {
    const fee = raw.slice(0, marker).trim();
    const net = raw.slice(marker + '|netTx:'.length).trim();
    return {
      netTx: isRealTxHash(net) ? net : null,
      feeTx: isRealTxHash(fee) ? fee : null,
    };
  }
  return { netTx: isRealTxHash(raw) ? raw : null, feeTx: null };
}

/** Explorer deep link built from the configured base (lib/arc/config), never hardcoded. */
export function explorerLinkForHash(hash: string | null | undefined): string | null {
  // Invariant: an explorer link only exists for a genuine 32-byte chain hash.
  if (!isChainTxHash(hash)) return null;
  return explorerTxUrl(String(hash).trim());
}

function baseSteps(): {
  requested: TimelineStep;
  review: TimelineStep;
  approved: TimelineStep;
  sent: TimelineStep;
  confirmed: TimelineStep;
} {
  return {
    requested: { key: 'requested', label: 'Requested', state: 'done', detail: 'Signed intent received by STRIKE' },
    review: {
      key: 'review',
      label: 'Under review',
      state: 'active',
      detail: 'Manual review by an operator — no fixed timer on the queue',
    },
    approved: { key: 'approved', label: 'Approved & signed', state: 'upcoming' },
    sent: { key: 'sent', label: 'Sent on-chain', state: 'upcoming', detail: 'Treasury pays USDC on Arc' },
    confirmed: { key: 'confirmed', label: 'Confirmed', state: 'upcoming', detail: 'Payout settled in your wallet' },
  };
}

type LedgerViewModel = Omit<WithdrawalViewModel, 'intentExpired' | 'intentRemainingMs'>;

/** Pure ledger-status mapping; the exported wrapper below adds intent-window truth. */
function describeLedgerStatus(row: WithdrawalRowLike | null | undefined): LedgerViewModel {
  const rawStatus = String(row?.status ?? '').trim().toLowerCase();
  const parsed = parseCombinedTxHash(row?.tx_hash);
  // fee_tx_hash is authoritative when present; otherwise recover the fee half
  // from the combined tx_hash written by the accept route.
  const feeTx = isRealTxHash(row?.fee_tx_hash) ? String(row?.fee_tx_hash).trim() : parsed.feeTx;
  const netTx = parsed.netTx;
  const steps = baseSteps();

  switch (rawStatus) {
    case 'pending':
      return {
        kind: 'pending',
        label: 'Pending review',
        tone: 'waiting',
        playerMessage:
          'Your request is in the manual approval queue. An operator reviews and pays it; you do not need to do anything. Your house balance is only deducted when the payout actually runs.',
        steps: [steps.requested, steps.review, steps.approved, steps.sent, steps.confirmed],
        terminal: false,
        netTxHash: null,
        feeTxHash: null,
      };

    case 'accepted': {
      if (netTx) {
        const s = baseSteps();
        for (const step of [s.requested, s.review, s.approved, s.sent, s.confirmed]) step.state = 'done';
        s.sent.detail = 'Payout transaction broadcast from the treasury';
        s.confirmed.detail = 'Accepted payout confirmed by the treasury flow';
        return {
          kind: 'accepted',
          label: 'Paid on Arc',
          tone: 'success',
          playerMessage:
            'The payout transaction is on Arc. Check the transfer in your wallet using the explorer link below.',
          steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
          terminal: true,
          netTxHash: netTx,
          feeTxHash: feeTx,
        };
      }
      const s = baseSteps();
      s.review.state = 'done';
      s.approved.state = 'active';
      s.approved.detail = 'Approved by an operator; payout is being finalised';
      return {
        kind: 'accepted',
        label: 'Approved — paying out',
        tone: 'info',
        playerMessage:
          'An operator approved your request and the treasury payout is being finalised. The transaction hash appears here as soon as it is recorded.',
        steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
        terminal: false,
        netTxHash: null,
        feeTxHash: feeTx,
      };
    }

    case 'rejected': {
      const s = baseSteps();
      s.requested.state = 'done';
      s.review.state = 'done';
      s.approved.state = 'failed';
      s.approved.label = 'Rejected';
      s.approved.detail = 'Decision recorded by an operator';
      s.sent.state = 'upcoming';
      s.sent.detail = 'No transaction — the request was not paid';
      s.confirmed.state = 'upcoming';
      return {
        kind: 'rejected',
        label: 'Rejected',
        tone: 'danger',
        playerMessage:
          'An operator rejected this request, so nothing was sent on-chain and your house balance was not deducted for it. If the reason was not clear, contact support before submitting a new request.',
        steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
        terminal: true,
        netTxHash: null,
        feeTxHash: null,
      };
    }

    case 'paid_needs_reconciliation': {
      const s = baseSteps();
      s.requested.state = 'done';
      s.review.state = 'done';
      s.approved.state = 'done';
      s.sent.state = 'attention';
      s.sent.detail = 'Payout attempt was made but could not be finalised automatically';
      s.confirmed.state = 'attention';
      s.confirmed.detail = 'Awaiting operator reconciliation';
      return {
        kind: 'paid_needs_reconciliation',
        label: 'Needs reconciliation',
        tone: 'attention',
        playerMessage:
          'A payout attempt for this request was made but could not be completed cleanly, so a STRIKE operator must reconcile it manually. Do NOT submit the same withdrawal again — copy your request ID below and contact support with it.',
        steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
        terminal: true,
        netTxHash: netTx,
        feeTxHash: feeTx,
      };
    }

    default: {
      // Unknown / future schema value: stay honest and keep refreshing.
      const s = baseSteps();
      s.review.detail = `Status reported by the server: ${rawStatus || 'missing'}`;
      return {
        kind: 'unknown',
        label: rawStatus || 'Unknown status',
        tone: 'unknown',
        playerMessage:
          'This request has a status this app does not recognise yet. It refreshes automatically; if it does not move, contact support with the request ID.',
        steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
        terminal: false,
        netTxHash: netTx,
        feeTxHash: feeTx,
      };
    }
  }
}

/**
 * Ledger status is necessary but not sufficient: a 'pending' row whose signed
 * intent has left the 10-minute acceptance window can never be paid by an
 * operator (the accept route refuses it). Showing it as "in review" forever is
 * dishonest — the player sits waiting on a request that will never move. The
 * wrapper turns that recorded timestamp into an explicit expired state with a
 * next action, and annotates a still-open window with its real remaining time.
 * It derives NOTHING from the clock about payments: expired ≠ paid, always.
 */
export function describeWithdrawal(
  row: WithdrawalRowLike | null | undefined,
  now: number = Date.now(),
): WithdrawalViewModel {
  const view = describeLedgerStatus(row);
  const intent = describeIntentWindow(row?.signed_at, now);

  if (view.kind !== 'pending') {
    return { ...view, intentExpired: false, intentRemainingMs: null };
  }

  if (intent.state === 'expired') {
    const s = baseSteps();
    s.requested.detail = `Signed intent received by STRIKE at ${formatWhenMs(intent.signedAtMs)}`;
    s.review.state = 'failed';
    s.review.label = 'Review window elapsed';
    s.review.detail = `No operator accepted it within the ${windowMinutes(intent.maxAgeMs)}-minute signing window`;
    s.approved.state = 'upcoming';
    s.approved.detail = 'The expired signature can no longer be approved';
    s.sent.detail = 'Nothing was sent on-chain';
    return {
      ...view,
      label: 'Signature expired',
      tone: 'danger',
      playerMessage:
        `Your signed authorization is older than ${windowMinutes(intent.maxAgeMs)} minutes, so no operator can pay this request ` +
        `anymore — that is why nothing moved. Nothing was sent and your house balance was not deducted. ` +
        `Request the withdrawal again from the trade screen to create a fresh signed intent.`,
      steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
      terminal: true,
      intentExpired: true,
      intentRemainingMs: null,
    };
  }

  if (intent.state === 'open') {
    const steps = view.steps.map((step) =>
      step.key === 'review'
        ? {
            ...step,
            detail: `Manual review by an operator — the signature can be accepted for another ${formatRemaining(intent.remainingMs)}`,
          }
        : step,
    );
    return { ...view, steps, intentExpired: false, intentRemainingMs: intent.remainingMs };
  }

  // Unknown signed_at (legacy / missing row): stay in the generic pending view,
  // polling continues, no expiry is asserted.
  return { ...view, intentExpired: false, intentRemainingMs: null };
}

function formatWhenMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** True while any row can still legitimately change (drives polling). */
export function hasOpenWithdrawals(
  rows: WithdrawalRowLike[] | null | undefined,
  now: number = Date.now(),
): boolean {
  return (rows ?? []).some((r) => !describeWithdrawal(r, now).terminal);
}
