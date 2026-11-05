'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Segmented, glassSelected } from '@/components/ui/kit';
import { ArrowUpRight, CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { useToast } from '@/lib/hooks/useToast';
import { useWalletClient, useAccount, useSwitchChain } from 'wagmi';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';
import { getArcConfig, ARC_ASSETS, explorerTxUrl, explorerAddressUrl, type ArcAsset } from '@/lib/arc/config';
import { shortenAddress } from '@/lib/utils/address';
import { calculateFeeAmount, getFeePercentLabel } from '@/lib/fees/platformFee';

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (amount: number, txHash: string, proof?: DepositProof) => void;
  onError?: (error: Error) => void;
}

/** What the player needs to verify the deposit themselves. */
export interface DepositProof {
  txHash: string;
  currency: ArcAsset;
  chain: string;
  explorerUrl: string;
  /** Server-confirmed facts (present once the ledger credited the deposit). */
  fee?: number;
  netCredited?: number;
  newBalance?: number;
  creditedAt?: string;
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/**
 * The ledger credits only after MIN_CONFIRMATIONS (lib/balance/verifyArcDepositTx).
 * The server sends the real number with every reply; this is the display
 * default before the first answer arrives, never a second threshold.
 */
const REQUIRED_CONFIRMATIONS = 3;
/** Headroom kept on top of the estimated fee, in whole tokens (see handleMaxClick). */
const GAS_BUFFER = 0.005;
/** Amount + fee compared against a float balance needs a tolerance. */
const FLOAT_EPSILON = 1e-9;
const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 24;

/**
 * Deposit lifecycle. 'pending' is the retryable family (the deposit is fine,
 * just not credited yet); 'failed' carries `retryable` so the two families can
 * never be confused on screen.
 */
type DepositPhase =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | {
      kind: 'pending';
      txHash: string;
      confirmations: number | null;
      requiredConfirmations: number;
      note: string;
    }
  | { kind: 'credited'; txHash: string; amount: number }
  | { kind: 'failed'; txHash: string | null; retryable: boolean; code: string; message: string };

type TrackedPhase = Extract<DepositPhase, { kind: 'pending' | 'credited' | 'failed' }>;

interface DepositApiResponse {
  success?: boolean;
  newBalance?: number;
  duplicate?: boolean;
  retryable?: boolean;
  code?: string;
  error?: string;
  confirmations?: number;
  requiredConfirmations?: number;
  /** Server-side facts of the credit; the receipt may show these, nothing else. */
  fee?: number;
  netCredited?: number;
  creditedAt?: string;
}

/** The ledger's own account of a completed credit, when the route supplied one. */
export interface ServerCredit {
  fee?: number;
  netCredited?: number;
  newBalance?: number;
  creditedAt?: string;
}

interface VerificationRecord {
  txHash: string;
  phase: TrackedPhase;
  /** Set once the ledger confirms the credit; lets late joiners replay it. */
  credit: ServerCredit | null;
  listeners: Set<(phase: TrackedPhase) => void>;
  running: boolean;
}

interface VerificationInput {
  userAddress: string;
  amount: number;
  currency: ArcAsset;
  onCredited: (txHash: string, credit?: ServerCredit) => void;
}

/**
 * Shape of GET /api/arc/deposit-precheck. Every field is optional because a
 * failed or partial fetch is stored as null rather than a fake 'not ready'.
 */
interface PreFlight {
  ready?: boolean;
  banned?: boolean;
  code?: string;
  chainId?: number;
  network?: string;
  token?: string;
  decimals?: number;
  treasuryConfigured?: boolean;
  balance?: number | null;
}

/**
 * One verification per tx hash, app-wide. The record outlives the modal, so a
 * resubmitted hash joins the loop that is already running instead of starting a
 * second one, and a hash that already credited reports 'credited' rather than
 * an error. The ledger itself is idempotent (deposit_locks), so this is about
 * not hammering it and not confusing the player.
 */
const verifications = new Map<string, VerificationRecord>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const decimalPlaces = (value: string): number => {
  const [, fraction = ''] = value.split('.');
  return fraction.length;
};

/** Plain-language progress for each retryable reason the verifier can return. */
function pendingNote(code: string | undefined, status: number): string {
  switch (code) {
    case 'tx_not_found':
      return 'Arc has not broadcast the transaction yet — this is normal for a second.';
    case 'insufficient_confirmations':
      return 'The deposit is on Arc. More confirmations are needed before it can be credited.';
    case 'rpc_error':
      return 'Arc is slow to answer. Retrying the same transaction, nothing was lost.';
    case 'config_missing':
      return 'The ledger is temporarily reconfiguring. Your transaction is safe on Arc.';
    default:
      return status === 503
        ? 'The ledger service is busy. Retrying the same transaction.'
        : 'Still checking the deposit on Arc.';
  }
}

/** What the player should actually do, per terminal reason. */
const TERMINAL_GUIDANCE: Record<string, string> = {
  tx_reverted:
    'The transfer reverted on Arc, so no USDC left your wallet and nothing was credited. Deposit again — if it reverts a second time, check the explorer link below.',
  amount_mismatch:
    'No transfer of at least this amount reached the Strike treasury, so nothing was credited. If you sent less, or sent it somewhere else, deposit the correct amount again; the USDC that did move stays on Arc and is recoverable from the sending wallet.',
  sender_mismatch:
    'This transaction was paid from a different address than the one you are signed in with, so it cannot be credited here. Sign in with the wallet that sent the USDC and check this same transaction again.',
  credit_refused:
    'Nothing was credited to your house balance. Check the transaction on the explorer, then deposit again.',
  wallet_banned:
    'This wallet is blocked from the platform, so the deposit cannot be credited. The USDC already sent to Arc stays in the treasury and needs support to recover it.',
  not_signed_in:
    'This browser is not signed in to the ledger, so the deposit could not be attributed. Reload Strike and press Check again — the same transaction is retried, so it cannot be credited twice.',
};

const STILL_PENDING_GUIDANCE =
  'Your deposit is still valid on Arc — it has just not been credited yet. Keep this window or press Check again; the same transaction is retried, so it can never be credited twice.';

async function runVerification(
  record: VerificationRecord,
  input: VerificationInput
): Promise<void> {
  const publish = (phase: TrackedPhase) => {
    record.phase = phase;
    record.listeners.forEach((listener) => listener(phase));
  };

  let confirmations: number | null = null;
  let requiredConfirmations = REQUIRED_CONFIRMATIONS;
  let sessionRefreshed = false;

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    let status = 0;
    let body: DepositApiResponse | null = null;
    try {
      const response = await fetch('/api/balance/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The balance routes authorise the HttpOnly session cookie minted by
        // /api/balance/session; without this the credit answers 401.
        credentials: 'include',
        body: JSON.stringify({
          userAddress: input.userAddress,
          amount: input.amount,
          txHash: record.txHash,
          currency: input.currency,
        }),
      });
      status = response.status;
      body = (await response.json().catch(() => null)) as DepositApiResponse | null;
    } catch {
      status = 0;
      body = null;
    }

    // Credited, or already on the ledger from an earlier attempt — both are the
    // same end state for the player, so never render the 409 as an error.
    if ((status === 200 && body?.success) || body?.duplicate || status === 409) {
      const credit: ServerCredit = {
        fee: typeof body?.fee === 'number' ? body.fee : undefined,
        netCredited: typeof body?.netCredited === 'number' ? body.netCredited : undefined,
        newBalance: typeof body?.newBalance === 'number' ? body.newBalance : undefined,
        creditedAt: typeof body?.creditedAt === 'string' ? body.creditedAt : undefined,
      };
      record.credit = credit;
      publish({ kind: 'credited', txHash: record.txHash, amount: input.amount });
      input.onCredited(record.txHash, credit);
      return;
    }

    // A missing balance session is ours to fix, not the player's problem: mint
    // the cookie and retry the very same hash once. Still the one crediting
    // path, so a retry can never double-credit (deposit_locks).
    if (status === 401 && !sessionRefreshed) {
      sessionRefreshed = true;
      await ensureBalanceSession();
      publish({
        kind: 'pending',
        txHash: record.txHash,
        confirmations,
        requiredConfirmations,
        note: 'Reconnecting this browser to the ledger. The same transaction is being checked again.',
      });
      continue;
    }

    if (typeof body?.confirmations === 'number') confirmations = body.confirmations;
    if (typeof body?.requiredConfirmations === 'number') {
      requiredConfirmations = body.requiredConfirmations;
    }

    // The retryable family: keep watching the same hash. Server-side faults
    // count here too — the route releases the lock when nothing was credited.
    if (body?.retryable === true || status === 0 || (status >= 500 && status < 600)) {
      publish({
        kind: 'pending',
        txHash: record.txHash,
        confirmations,
        requiredConfirmations,
        note: pendingNote(body?.code, status),
      });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Everything else is a refusal the ledger will repeat: stop, explain, and
    // tell the player what to do instead of leaving the deposit hanging.
    publish({
      kind: 'failed',
      txHash: record.txHash,
      retryable: false,
      code:
        body?.code ||
        (status === 403 ? 'wallet_banned' : status === 401 ? 'not_signed_in' : 'credit_refused'),
      message: body?.error || 'The deposit could not be credited.',
    });
    return;
  }

  // Out of patience on a deposit that is still not rejected: this is NOT a
  // failure. Release the record so 'Check again' can start a fresh verification
  // of the same hash.
  publish({
    kind: 'failed',
    txHash: record.txHash,
    retryable: true,
    code: 'still_pending',
    message: 'Still waiting for this deposit to be credited on Arc.',
  });
  verifications.delete(record.txHash);
}

export const DepositModal: React.FC<DepositModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onError,
}) => {
  const address = useStore(state => state.address);
  const fetchBalance = useStore(state => state.fetchBalance);
  const setSelectedCurrency = useStore(state => state.setSelectedCurrency);
  const userTier = useStore(state => state.userTier);
  const toast = useToast();

  const { data: walletClient } = useWalletClient();
  const { connector, chainId: accountChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<DepositPhase>({ kind: 'idle' });
  const [walletBalance, setWalletBalance] = useState(0);
  const [balanceState, setBalanceState] = useState<'loading' | 'ready' | 'error'>('loading');
  /** Estimated transfer fee in whole tokens; the reserve adds GAS_BUFFER on top. */
  const [gasFee, setGasFee] = useState<number | null>(null);
  const [feeState, setFeeState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [precheck, setPrecheck] = useState<PreFlight | null>(null);
  const [recheckKey, setRecheckKey] = useState(0);

  // getArcConfig() rebuilds its object (and the assets map) on every call, so it
  // must be memoised: kept as a render-time value it would be a new dependency
  // for the balance and fee effects below, which then re-fire on every render —
  // the balance check would flip back to 'loading' constantly and the pre-flight
  // would refuse to sign even with funds on screen.
  const config = useMemo(getArcConfig, []);
  const asset: ArcAsset = 'USDC';
  const assetConfig = config.assets[asset];
  const quickAmounts = [1, 5, 10, 25];
  const gasReserve = gasFee == null ? null : gasFee + GAS_BUFFER;

  const treasuryConfigured = ethers.isAddress(config.treasuryAddress || '');

  const connectedChainId = typeof accountChainId === 'number' ? accountChainId : null;

  const wrongNetwork = connectedChainId !== null && connectedChainId !== config.chainId;

  const activeRecord = useRef<VerificationRecord | null>(null);
  const submitted = useRef<{ txHash: string; amount: number; userAddress: string } | null>(null);

  const handlePhase = useCallback((next: TrackedPhase) => setPhase(next), []);

  const startVerification = useCallback(
    (txHash: string, input: VerificationInput) => {
      let record = verifications.get(txHash);
      if (!record) {
        record = {
          txHash,
          phase: {
            kind: 'pending',
            txHash,
            confirmations: null,
            requiredConfirmations: REQUIRED_CONFIRMATIONS,
            note: 'Submitting the deposit for on-chain verification…',
          },
          credit: null,
          listeners: new Set(),
          running: false,
        };
        verifications.set(txHash, record);
      }

      const previous = activeRecord.current;
      if (previous && previous !== record) previous.listeners.delete(handlePhase);
      activeRecord.current = record;
      record.listeners.add(handlePhase);
      setPhase(record.phase);

      // Late joiner: this hash already credited while another modal instance
      // owned the loop. Replay the confirmation so this player sees the credit
      // and the balance refreshes for them too — a read, never a second POST.
      if (record.phase.kind === 'credited' && !record.running) {
        input.onCredited(txHash, record.credit ?? undefined);
        return;
      }

      // Duplicate protection: a verification for this hash is already in flight.
      if (!record.running) {
        record.running = true;
        void runVerification(record, input).finally(() => {
          record.running = false;
        });
      }
    },
    [handlePhase]
  );

  useEffect(
    () => () => {
      // Read the ref at cleanup time: at mount the record may not exist yet,
      // and a value captured then would unhook nothing on unmount.
      const record = activeRecord.current;
      if (record) record.listeners.delete(handlePhase);
    },
    [handlePhase]
  );

  // Reopening after a finished deposit starts from a clean slate; a verification
  // that is still running (or that failed) keeps showing its real state.
  useEffect(() => {
    if (isOpen) setPhase((current) => (current.kind === 'credited' ? { kind: 'idle' } : current));
  }, [isOpen]);

  /** Reads the connected wallet's balance of the selected asset. */
  useEffect(() => {
    if (!isOpen || !address) return;
    let cancelled = false;
    setBalanceState('loading');

    (async () => {
      try {
        const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
          chainId: config.chainId,
          name: config.name,
        });
        const raw = await new ethers.Contract(
          assetConfig.address,
          ERC20_ABI,
          provider
        ).balanceOf(address);
        if (!cancelled) {
          setWalletBalance(parseFloat(ethers.formatUnits(raw, assetConfig.decimals)));
          setBalanceState('ready');
        }
      } catch (err) {
        console.error('Failed to read wallet balance:', err);
        if (!cancelled) {
          setWalletBalance(0);
          setBalanceState('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, address, asset, assetConfig, config.chainId, config.name, config.rpcEndpoint, recheckKey]);

  /**
   * On Arc the native gas token and the deposited ERC-20 are the same USDC
   * balance (18 vs 6 decimals — see lib/arc/config.ts). Transferring the
   * full balance would leave nothing to pay for the transfer itself, so Max
   * reserves the estimated tx fee plus a small buffer, and the pre-flight
   * refuses anything that would leave the fee unpaid.
   */
  const estimateGasFee = useCallback(
    async (wholeTokens: number): Promise<number> => {
      try {
        const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
          chainId: config.chainId,
          name: config.name,
        });
        const value = ethers.parseUnits(wholeTokens.toString(), assetConfig.decimals);
        // The loose string-ABI contract type leaves estimateGas unindexed; the
        // call shape is fixed by ERC20_ABI above.
        const readonlyContract: any = new ethers.Contract(
          assetConfig.address,
          ERC20_ABI,
          provider
        );
        const gas = await readonlyContract.estimateGas.transfer(config.treasuryAddress, value);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
        if (gasPrice == null) return 0.01;
        // Gas is priced in 18-decimal native USDC; convert to the deposit unit.
        return parseFloat(ethers.formatUnits(gas * gasPrice, 18));
      } catch {
        // If the node is unreachable, keep a conservative flat headroom.
        return 0.01;
      }
    },
    [
      assetConfig,
      config.chainId,
      config.name,
      config.rpcEndpoint,
      config.treasuryAddress,
    ]
  );

  // Live gas check for the pre-flight panel (Max still estimates on click).
  useEffect(() => {
    if (!isOpen || balanceState !== 'ready' || walletBalance <= 0) {
      setFeeState('loading');
      setGasFee(null);
      return;
    }
    let cancelled = false;
    setFeeState('loading');
    void (async () => {
      const fee = await estimateGasFee(walletBalance);
      if (cancelled) return;
      setGasFee(fee);
      setFeeState('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, balanceState, walletBalance, estimateGasFee, recheckKey]);

  /**
   * Server-side pre-flight: the two things the browser cannot establish —
   * whether this wallet may deposit at all, and whether this deployment is
   * configured to credit it. Advisory: if it cannot be reached the deposit is
   * not blocked, because the on-chain verifier is still authoritative.
   */
  useEffect(() => {
    if (!isOpen || !address) {
      setPrecheck(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/arc/deposit-precheck?address=${encodeURIComponent(address)}`,
          { credentials: 'include' }
        );
        const body = await response.json().catch(() => null);
        if (!cancelled) setPrecheck(response.ok && body ? body : null);
      } catch {
        if (!cancelled) setPrecheck(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, address, recheckKey]);

  const parsedAmount = parseFloat(amount);
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const feePreview = hasAmount ? calculateFeeAmount(parsedAmount, userTier) : 0;
  const netPreview = hasAmount ? parsedAmount - feePreview : 0;

  const validate = (value: string): string | null => {
    if (!value.trim()) return 'Enter an amount';
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 'Amount must be greater than zero';
    // Token guard: USDC has 6 decimals, so finer precision can never arrive.
    if (decimalPlaces(value) > assetConfig.decimals) {
      return `${asset} supports at most ${assetConfig.decimals} decimal places`;
    }
    if (balanceState === 'ready' && parsed > walletBalance) return `Insufficient ${asset} balance`;
    if (
      balanceState === 'ready' &&
      gasReserve != null &&
      parsed + gasReserve > walletBalance + FLOAT_EPSILON
    ) {
      return `Not enough ${asset} to cover the network fee — leave about ${gasReserve.toFixed(4)} spare`;
    }
    return null;
  };

  /** Everything that must be true before a signature is asked for. */
  const preFlightError = (): string | null => {
    const amountError = validate(amount);
    if (amountError) return amountError;
    if (!address) return 'Connect a wallet first';
    if (!walletClient && !connector) return 'Wallet is not connected';
    if (wrongNetwork) {
      return `Your wallet is on chain ${connectedChainId}, not ${config.name} (${config.chainId}). Switch before depositing`;
    }
    if (!treasuryConfigured) {
      return 'Deposits are unavailable: no Strike treasury address is configured';
    }
    if (precheck?.banned === true) return 'This wallet is banned from the platform.';
    if (precheck && precheck.ready === false && precheck.code === 'treasury_not_configured') {
      return 'Deposits are unavailable: the treasury address on the server is not configured';
    }
    return null;
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Digits with at most one decimal point.
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    setAmount(value);
    setError(null);
  };

  const handleQuickSelect = (value: number) => {
    setAmount(value.toString());
    setError(null);
  };

  const handleMaxClick = async () => {
    if (walletBalance <= 0) return;
    const reserve = (await estimateGasFee(walletBalance)) + GAS_BUFFER;
    const max = Math.max(0, walletBalance - reserve);
    if (max <= 0) {
      setError(`Balance is too small to cover the ${asset} gas fee`);
      return;
    }
    setAmount(Number(max.toFixed(assetConfig.decimals)).toString());
    setError(null);
  };

  const handleAssetChange = (next: ArcAsset) => {
    setSelectedCurrency(next);
    setAmount('');
    setError(null);
  };

  const switchToArc = useCallback(async () => {
    try {
      if (connector) await switchChainAsync({ chainId: config.chainId });
      else setError(`Add ${config.name} (chain ${config.chainId}) to your wallet and try again`);
    } catch {
      setError(`Switch your wallet to ${config.name} and try again`);
    }
  }, [config.chainId, config.name, connector, switchChainAsync]);

  const resolveWalletProvider = useCallback(async (): Promise<ethers.Eip1193Provider> => {
    if (connector) {
      return (await connector.getProvider()) as ethers.Eip1193Provider;
    }
    if (walletClient) {
      throw new Error('This wallet does not expose a signing provider. Reconnect and try again.');
    }
    throw new Error('Wallet is not connected');
  }, [connector, walletClient]);

  const markCredited = useCallback(
    async (txHash: string, creditedAmount: number, walletAddress: string, credit?: ServerCredit) => {
      // Always re-read the ledger after a credit: the server value is the truth,
      // the cached balance is whatever it was before the deposit landed.
      await fetchBalance(walletAddress);
      toast.success(
        `Successfully deposited ${creditedAmount.toFixed(4)} ${asset}! Balance updated.`
      );
      onSuccess?.(creditedAmount, txHash, {
        txHash,
        currency: asset,
        chain: config.name,
        explorerUrl: explorerTxUrl(txHash),
        ...(credit ?? {}),
      });
      setAmount('');
      onClose();
    },
    [asset, config.name, fetchBalance, onClose, onSuccess, toast]
  );

  const isBusy = phase.kind === 'signing' || phase.kind === 'pending';

  const handleDeposit = async () => {
    if (isBusy) return;
    const validationError = preFlightError();
    if (validationError) {
      setError(validationError);
      return;
    }

    const depositAmount = parseFloat(amount);
    const walletAddress = address as string;
    setError(null);
    setPhase({ kind: 'signing' });

    try {
      const provider = new ethers.BrowserProvider(await resolveWalletProvider());

      // Offer the switch rather than just refusing, then confirm it landed —
      // this native USDC transfer must not be signed on another network.
      if (Number((await provider.getNetwork()).chainId) !== config.chainId) {
        await switchToArc();
      }
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== config.chainId) {
        throw new Error(`Switch your wallet to ${config.name} and try again`);
      }

      const signer = await provider.getSigner();
      const from = await signer.getAddress();
      if (from.toLowerCase() !== walletAddress.toLowerCase()) {
        // Attribution is by Transfer-log payer: signing with another account
        // would pay gas for a deposit the ledger can never credit to us.
        throw new Error(
          `The wallet asked to sign (${shortenAddress(from)}) is not the account you are signed in with (${shortenAddress(
            walletAddress
          )}). Connect the right account first.`
        );
      }

      const value = ethers.parseUnits(amount, assetConfig.decimals);
      const tx = await new ethers.Contract(
        assetConfig.address,
        ERC20_ABI,
        signer
      ).transfer(config.treasuryAddress, value);

      if (!tx.hash) throw new Error('The wallet returned a transaction without a hash');

      // The backend re-verifies the transaction on-chain before crediting; this
      // keeps watching the same hash and reports n/3 progress.
      submitted.current = { txHash: tx.hash, amount: depositAmount, userAddress: walletAddress };
      const txHash = tx.hash;
      startVerification(txHash, {
        userAddress: walletAddress,
        amount: depositAmount,
        currency: asset,
        onCredited: (hash, credit) => {
          void markCredited(hash, depositAmount, walletAddress, credit);
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Deposit failed. Please try again.';
      console.error('Deposit error:', err);
      setPhase({ kind: 'idle' });
      setError(message);
      toast.error(message);
      onError?.(err instanceof Error ? err : new Error(message));
    }
  };

  /** Re-check the same hash: never a second payment, never a fresh signature. */
  const recheckSameTx = () => {
    const last = submitted.current;
    if (!last) return;
    startVerification(last.txHash, {
      userAddress: last.userAddress,
      amount: last.amount,
      currency: asset,
      onCredited: (hash, credit) => {
        void markCredited(hash, last.amount, last.userAddress, credit);
      },
    });
  };

  const chip = (on: boolean) =>
    `h-9 rounded-full font-jet text-[13px] transition-colors disabled:opacity-40 ${
      on ? glassSelected : 'bg-ink/[0.04] text-muted hover:text-ink'
    }`;

  const summaryRow = (label: string, value: React.ReactNode, hint?: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right">
        {value}
        {hint ? <span className="ml-1 text-faint">{hint}</span> : null}
      </dd>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Deposit ${asset}`}
      showCloseButton={phase.kind !== 'signing'}
    >
      <p className="-mt-4 mb-6 text-[15px] text-muted">
        Move USDC from your wallet to your trading balance.
      </p>
      {config.chainId === 5042002 && (
        <a
          href="https://faucet.circle.com"
          target="_blank"
          rel="noopener noreferrer"
          className="-mt-3 mb-6 inline-flex items-center gap-1 text-sm font-medium text-up hover:underline"
        >
          Need test USDC? Get it free from Circle&apos;s faucet <ArrowUpRight size={14} />
        </a>
      )}

      {ARC_ASSETS.length > 1 && (
        <Segmented
          className="mb-4"
          options={ARC_ASSETS.map(token => ({ value: token, label: token }))}
          value={asset}
          onChange={handleAssetChange}
          disabled={isBusy}
        />
      )}

      <label htmlFor="deposit-amount" className="sr-only">Amount to deposit</label>
      <div
        className={`flex h-16 items-center rounded-2xl bg-white px-5 ring-1 ring-inset transition-shadow focus-within:ring-ink ${
          error ? 'ring-down' : 'ring-line'
        }`}
      >
        <input
          id="deposit-amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={handleAmountChange}
          placeholder="0.00"
          disabled={isBusy}
          className="min-w-0 flex-1 bg-transparent font-jet text-[28px] font-semibold tracking-[-0.03em] outline-none placeholder:text-faint disabled:opacity-50"
        />
        <span className="ml-2 font-jet text-sm text-faint">{asset}</span>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-2">
        {quickAmounts.map(quickAmount => (
          <button
            key={quickAmount}
            type="button"
            onClick={() => handleQuickSelect(quickAmount)}
            disabled={
              isBusy ||
              (balanceState === 'ready' &&
                gasReserve != null &&
                quickAmount + gasReserve > walletBalance + FLOAT_EPSILON)
            }
            className={chip(amount === quickAmount.toString())}
          >
            {quickAmount}
          </button>
        ))}
        <button
          type="button"
          onClick={handleMaxClick}
          disabled={isBusy || walletBalance <= 0}
          className={chip(false)}
        >
          Max
        </button>
      </div>

      {wrongNetwork && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-2 rounded-2xl bg-down-soft px-3.5 py-3 text-[13px]"
        >
          <WarningCircle size={16} className="mt-0.5 shrink-0 text-down" />
          <div>
            <p className="font-semibold text-down">
              Your wallet is not on {config.name}
            </p>
            <p className="mt-1 text-muted">
              It is on chain {connectedChainId}; Strike only credits deposits made on{' '}
              {config.name} (chain {config.chainId}). Switch first — do not sign on the other
              network.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={switchToArc}
              disabled={isBusy}
              className="mt-2.5"
            >
              Switch to {config.name}
            </Button>
          </div>
        </div>
      )}

      <dl className="mt-6 space-y-2 font-jet text-[13px]">
        {summaryRow(
          'You send',
          hasAmount ? `${parsedAmount.toFixed(4)} ${asset}` : `— ${asset}`
        )}
        {summaryRow('Token', `${asset} · ${assetConfig.decimals} decimals`)}
        {summaryRow('Network', `${config.name} · ${config.chainId}`)}
        {summaryRow(
          'Sending to',
          treasuryConfigured ? shortenAddress(config.treasuryAddress) : 'not configured',
          treasuryConfigured ? (
            <a
              href={explorerAddressUrl(config.treasuryAddress)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View treasury on explorer"
              className="text-up hover:underline"
            >
              <ArrowUpRight size={12} className="inline" />
            </a>
          ) : undefined
        )}
        {summaryRow(
          'Wallet',
          balanceState === 'loading'
            ? `reading…`
            : `${walletBalance.toFixed(4)} ${asset}`
        )}
        {summaryRow(
          'Network fee (est.)',
          balanceState === 'error'
            ? 'unavailable'
            : feeState === 'loading' || gasFee == null
              ? 'checking…'
              : `~${gasFee.toFixed(4)} ${asset}`,
          gasFee != null && balanceState === 'ready' ? (
            <span>· keep {gasReserve?.toFixed(4)} spare</span>
          ) : undefined
        )}
        {summaryRow(
          `Credited after ${getFeePercentLabel(userTier)} fee`,
          hasAmount ? `${netPreview.toFixed(4)} ${asset}` : `0.0000 ${asset}`
        )}
        <div className="flex items-center justify-between gap-3 pt-1">
          <dt className="text-subtle">Pre-flight</dt>
          <dd>
            {precheck === null ? (
              <Badge tone="neutral">checks unavailable</Badge>
            ) : precheck.banned === true ? (
              <Badge tone="down">wallet banned</Badge>
            ) : precheck.ready === true ? (
              <Badge tone="up">ready</Badge>
            ) : (
              <Badge tone="down">{String(precheck.code ?? 'not ready')}</Badge>
            )}
            <button
              type="button"
              onClick={() => setRecheckKey((k) => k + 1)}
              disabled={isBusy}
              className="ml-2 font-jet text-[12px] text-up hover:underline disabled:opacity-40"
            >
              Re-check
            </button>
          </dd>
        </div>
      </dl>

      {phase.kind === 'signing' && (
        <div
          role="status"
          aria-live="polite"
          className="mt-5 flex items-center gap-2 rounded-2xl bg-surface px-3.5 py-3 font-jet text-[13px]"
        >
          <CircleNotch size={16} className="animate-spin text-up" />
          Confirm the USDC transfer in your wallet — nothing is credited until Arc shows it.
        </div>
      )}

      {phase.kind === 'pending' && (
        <div role="status" aria-live="polite" className="mt-5 rounded-2xl bg-surface px-3.5 py-3">
          <div className="flex items-center gap-2 font-jet text-[13px] font-semibold">
            <CircleNotch size={16} className="animate-spin text-up" />
            Verifying your deposit
          </div>
          <ol className="mt-2.5 space-y-1 font-jet text-[12px] text-muted">
            <li className="flex items-center gap-1.5">
              <CheckCircle size={13} weight="fill" className="text-up" />
              Submitted from your wallet
            </li>
            <li className="flex items-center gap-1.5">
              <CircleNotch size={13} className="animate-spin text-up" />
              Waiting for confirmations — {Math.min(phase.confirmations ?? 0, phase.requiredConfirmations)}/
              {phase.requiredConfirmations}
            </li>
            <li className="flex items-center gap-1.5 text-faint">
              <span aria-hidden>○</span> Credited to your house balance
            </li>
          </ol>
          <p className="mt-2 text-[12px] leading-relaxed text-subtle">{phase.note}</p>
          {phase.txHash && (
            <a
              href={explorerTxUrl(phase.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 font-jet text-[12px] text-up hover:underline"
            >
              Verify {shortenAddress(phase.txHash, 6)} on explorer <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      )}

      {phase.kind === 'credited' && (
        <div role="status" className="mt-5 rounded-2xl bg-up-soft px-3.5 py-3">
          <div className="flex items-center gap-2 font-jet text-[13px] font-semibold text-up">
            <CheckCircle size={16} weight="fill" />
            Credited on Arc
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            {phase.amount.toFixed(4)} {asset} paid into {shortenAddress(config.treasuryAddress)}{' '}
            and credited to your house balance. Transaction{' '}
            <a
              href={explorerTxUrl(phase.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-up hover:underline"
            >
              {shortenAddress(phase.txHash, 6)}
            </a>
            .
          </p>
        </div>
      )}

      {phase.kind === 'failed' && (
        <div role="alert" className="mt-5 rounded-2xl bg-down-soft px-3.5 py-3">
          <div className="flex items-start gap-2">
            <WarningCircle size={16} className="mt-0.5 shrink-0 text-down" />
            <div className="min-w-0">
              <p className="font-jet text-[13px] font-semibold text-down">
                {phase.retryable ? 'Not credited yet' : 'Deposit rejected'}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{phase.message}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink">
                {phase.retryable
                  ? STILL_PENDING_GUIDANCE
                  : TERMINAL_GUIDANCE[phase.code] || TERMINAL_GUIDANCE.credit_refused}
              </p>
              {phase.txHash && (
                <a
                  href={explorerTxUrl(phase.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 font-jet text-[12px] text-up hover:underline"
                >
                  View {shortenAddress(phase.txHash, 6)} on explorer <ArrowUpRight size={12} />
                </a>
              )}
              <div className="mt-2.5 flex gap-2">
                {phase.retryable && (
                  <Button variant="secondary" size="sm" onClick={recheckSameTx}>
                    Check again
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPhase({ kind: 'idle' });
                    submitted.current = null;
                  }}
                >
                  {phase.retryable ? 'Close this status' : 'Start a new deposit'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-down-soft px-3.5 py-2.5 text-[13px] text-down">
          {error}
        </p>
      )}

      <Button
        size="lg"
        onClick={handleDeposit}
        disabled={isBusy || wrongNetwork || !amount || phase.kind === 'credited'}
        className="mt-6 w-full"
      >
        {phase.kind === 'signing'
          ? 'Confirm in your wallet…'
          : phase.kind === 'pending'
            ? 'Verifying deposit…'
            : phase.kind === 'credited'
              ? 'Credited'
              : `Deposit ${asset}`}
      </Button>
    </Modal>
  );
};
