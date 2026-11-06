
import { explorerTxUrl } from '@/lib/arc/config';
import { describeIntentWindow, formatRemaining, windowMinutes } from '@/lib/withdrawals/expiry';

export const KNOWN_WITHDRAWAL_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'paid_needs_reconciliation',
] as const;

export type KnownWithdrawalStatus = (typeof KNOWN_WITHDRAWAL_STATUSES)[number];

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
  signed_at?: number | string | null;
}

export interface WithdrawalViewModel {
  kind: KnownWithdrawalStatus | 'unknown';
  label: string;
  tone: WithdrawalTone;
  playerMessage: string;
  steps: TimelineStep[];
  terminal: boolean;
  netTxHash: string | null;
  feeTxHash: string | null;
  intentExpired: boolean;
  intentRemainingMs: number | null;
}

export function isRealTxHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  const t = hash.trim();
  return t.length > 0 && !NON_HASH_VALUES.has(t.toUpperCase());
}

export function isChainTxHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  return /^0[xX][0-9a-fA-F]{64}$/.test(hash.trim());
}

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

export function explorerLinkForHash(hash: string | null | undefined): string | null {
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
    requested: { key: 'requested', label: 'Requested', state: 'done', detail: 'Signed intent received by Strike' },
    review: {
      key: 'review',
      label: 'Checks',
      state: 'active',
      detail: 'Signature, balance and caps are checked automatically',
    },
    approved: { key: 'approved', label: 'Approved', state: 'upcoming' },
    sent: { key: 'sent', label: 'Sent on-chain', state: 'upcoming', detail: 'Treasury pays USDC on Arc' },
    confirmed: { key: 'confirmed', label: 'Confirmed', state: 'upcoming', detail: 'Payout settled in your wallet' },
  };
}

type LedgerViewModel = Omit<WithdrawalViewModel, 'intentExpired' | 'intentRemainingMs'>;

function describeLedgerStatus(row: WithdrawalRowLike | null | undefined): LedgerViewModel {
  const rawStatus = String(row?.status ?? '').trim().toLowerCase();
  const parsed = parseCombinedTxHash(row?.tx_hash);
  const feeTx = isRealTxHash(row?.fee_tx_hash) ? String(row?.fee_tx_hash).trim() : parsed.feeTx;
  const netTx = parsed.netTx;
  const steps = baseSteps();

  switch (rawStatus) {
    case 'pending':
      return {
        kind: 'pending',
        label: 'Paying out',
        tone: 'waiting',
        playerMessage:
          'Your request passed the signature check and is being paid. This takes a few seconds; your house balance is only deducted when the payout actually runs.',
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
      s.approved.detail = 'Checks passed; payout is being finalised';
      return {
        kind: 'accepted',
        label: 'Approved — paying out',
        tone: 'info',
        playerMessage:
          'Your request passed every check and the treasury payout is being finalised. The transaction hash appears here as soon as it is recorded.',
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
      s.approved.label = 'Refused';
      s.approved.detail = 'A check failed before any money moved';
      s.sent.state = 'upcoming';
      s.sent.detail = 'No transaction — the request was not paid';
      s.confirmed.state = 'upcoming';
      return {
        kind: 'rejected',
        label: 'Rejected',
        tone: 'danger',
        playerMessage:
          'This request was refused before any money moved: it was over a cap (50 USDC per request, 200 per day) or a check failed. Nothing was sent on-chain and your house balance was not deducted. You can request again.',
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
      s.confirmed.detail = 'Held for reconciliation';
      return {
        kind: 'paid_needs_reconciliation',
        label: 'Needs reconciliation',
        tone: 'attention',
        playerMessage:
          'A payout attempt for this request was made but could not be confirmed, so it is held for reconciliation and will not be paid twice. Do NOT submit the same withdrawal again; keep the request ID below.',
        steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
        terminal: true,
        netTxHash: netTx,
        feeTxHash: feeTx,
      };
    }

    default: {
      const s = baseSteps();
      s.review.detail = `Status reported by the server: ${rawStatus || 'missing'}`;
      return {
        kind: 'unknown',
        label: rawStatus || 'Unknown status',
        tone: 'unknown',
        playerMessage:
          'This request has a status this app does not recognise yet. It refreshes automatically; keep the request ID below.',
        steps: [s.requested, s.review, s.approved, s.sent, s.confirmed],
        terminal: false,
        netTxHash: netTx,
        feeTxHash: feeTx,
      };
    }
  }
}

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
    s.requested.detail = `Signed intent received by Strike at ${formatWhenMs(intent.signedAtMs)}`;
    s.review.state = 'failed';
    s.review.label = 'Signature expired';
    s.review.detail = `It was not paid within the ${windowMinutes(intent.maxAgeMs)}-minute signing window`;
    s.approved.state = 'upcoming';
    s.approved.detail = 'The expired signature can no longer be approved';
    s.sent.detail = 'Nothing was sent on-chain';
    return {
      ...view,
      label: 'Signature expired',
      tone: 'danger',
      playerMessage:
        `Your signed authorization is older than ${windowMinutes(intent.maxAgeMs)} minutes, so this request can no longer ` +
        `be paid. Nothing was sent and your house balance was not deducted. ` +
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
            detail: `Checking automatically — the signature stays valid for another ${formatRemaining(intent.remainingMs)}`,
          }
        : step,
    );
    return { ...view, steps, intentExpired: false, intentRemainingMs: intent.remainingMs };
  }

  return { ...view, intentExpired: false, intentRemainingMs: null };
}

function formatWhenMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function hasOpenWithdrawals(
  rows: WithdrawalRowLike[] | null | undefined,
  now: number = Date.now(),
): boolean {
  return (rows ?? []).some((r) => !describeWithdrawal(r, now).terminal);
}
