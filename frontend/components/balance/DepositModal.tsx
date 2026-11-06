"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  erc20Abi,
  isAddress,
  parseUnits,
  formatUnits,
  type EIP1193Provider,
} from "viem";
import {
  arcPublicClient,
  arcWalletClient,
  readAssetBalance,
} from "@/lib/arc/client";
import { Modal } from "@/components/ui/Modal";
import { Badge, Button, Segmented, glassSelected } from "@/components/ui/kit";
import {
  ArrowUpRight,
  CaretDown,
  CheckCircle,
  CircleNotch,
  WarningCircle,
} from "@phosphor-icons/react";
import { useStore } from "@/lib/store";
import { resolveHouseLedgerCurrency } from "@/lib/balance/houseLedgerCurrency";

import { useToast } from "@/lib/hooks/useToast";
import { useWalletClient, useAccount, useSwitchChain } from "wagmi";
import { ensureBalanceSession } from "@/lib/balance/balanceClientHeaders";
import {
  getArcConfig,
  ARC_ASSETS,
  explorerTxUrl,
  explorerAddressUrl,
  type ArcAsset,
} from "@/lib/arc/config";
import { shortenAddress } from "@/lib/utils/address";
import { calculateFeeAmount, getFeePercentLabel } from "@/lib/fees/platformFee";
import { needsSession } from "@/lib/api/errors";
import { HumanStatus } from "@/components/world/HumanStatus";

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (amount: number, txHash: string, proof?: DepositProof) => void;
  onError?: (error: Error) => void;
}

export interface DepositProof {
  txHash: string;
  currency: ArcAsset;
  chain: string;
  explorerUrl: string;
  fee?: number;
  netCredited?: number;
  newBalance?: number;
  creditedAt?: string;
}

const REQUIRED_CONFIRMATIONS = 3;
const GAS_BUFFER = 0.005;
const FLOAT_EPSILON = 1e-9;
const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 24;

type DepositPhase =
  | { kind: "idle" }
  | { kind: "signing" }
  | {
      kind: "pending";
      txHash: string;
      confirmations: number | null;
      requiredConfirmations: number;
      note: string;
    }
  | { kind: "credited"; txHash: string; amount: number }
  | {
      kind: "failed";
      txHash: string | null;
      retryable: boolean;
      code: string;
      message: string;
    };

type TrackedPhase = Extract<
  DepositPhase,
  { kind: "pending" | "credited" | "failed" }
>;

interface DepositApiResponse {
  success?: boolean;
  newBalance?: number;
  duplicate?: boolean;
  retryable?: boolean;
  code?: string;
  error?: string;
  confirmations?: number;
  requiredConfirmations?: number;
  fee?: number;
  netCredited?: number;
  creditedAt?: string;
}

export interface ServerCredit {
  fee?: number;
  netCredited?: number;
  newBalance?: number;
  creditedAt?: string;
}

interface VerificationRecord {
  txHash: string;
  phase: TrackedPhase;
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

const verifications = new Map<string, VerificationRecord>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const decimalPlaces = (value: string): number => {
  const [, fraction = ""] = value.split(".");
  return fraction.length;
};

function pendingNote(code: string | undefined, status: number): string {
  switch (code) {
    case "tx_not_found":
      return "Arc has not broadcast the transaction yet — this is normal for a second.";
    case "insufficient_confirmations":
      return "The deposit is on Arc. More confirmations are needed before it can be credited.";
    case "rpc_error":
      return "Arc is slow to answer. Retrying the same transaction, nothing was lost.";
    case "config_missing":
      return "The ledger is temporarily reconfiguring. Your transaction is safe on Arc.";
    default:
      return status === 503
        ? "The ledger service is busy. Retrying the same transaction."
        : "Still checking the deposit on Arc.";
  }
}

const TERMINAL_GUIDANCE: Record<string, string> = {
  tx_reverted:
    "The transfer reverted on Arc, so no USDC left your wallet and nothing was credited. Deposit again — if it reverts a second time, check the explorer link below.",
  amount_mismatch:
    "No transfer of at least this amount reached the Strike treasury, so nothing was credited. If you sent less, or sent it somewhere else, deposit the correct amount again; the USDC that did move stays on Arc and is recoverable from the sending wallet.",
  sender_mismatch:
    "This transaction was paid from a different address than the one you are signed in with, so it cannot be credited here. Sign in with the wallet that sent the USDC and check this same transaction again.",
  credit_refused:
    "Nothing was credited to your house balance. Check the transaction on the explorer, then deposit again.",
  wallet_banned:
    "This wallet is blocked from the platform, so the deposit cannot be credited. The USDC already sent to Arc stays in the treasury and needs support to recover it.",
  not_signed_in:
    "This browser is not signed in to the ledger, so the deposit could not be attributed. Reload Strike and press Check again — the same transaction is retried, so it cannot be credited twice.",
};

const STILL_PENDING_GUIDANCE =
  "Your deposit is still valid on Arc — it has just not been credited yet. Keep this window or press Check again; the same transaction is retried, so it can never be credited twice.";

async function runVerification(
  record: VerificationRecord,
  input: VerificationInput,
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
      const response = await fetch("/api/balance/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          userAddress: input.userAddress,
          amount: input.amount,
          txHash: record.txHash,
          currency: input.currency,
        }),
      });
      status = response.status;
      body = (await response
        .json()
        .catch(() => null)) as DepositApiResponse | null;
    } catch (err) {
      console.error(
        "[deposit] credit request failed, will retry",
        record.txHash,
        err,
      );
      status = 0;
      body = null;
    }

    if (
      (status === 200 && body?.success) ||
      body?.duplicate ||
      status === 409
    ) {
      const credit: ServerCredit = {
        fee: typeof body?.fee === "number" ? body.fee : undefined,
        netCredited:
          typeof body?.netCredited === "number" ? body.netCredited : undefined,
        newBalance:
          typeof body?.newBalance === "number" ? body.newBalance : undefined,
        creditedAt:
          typeof body?.creditedAt === "string" ? body.creditedAt : undefined,
      };
      record.credit = credit;
      publish({
        kind: "credited",
        txHash: record.txHash,
        amount: input.amount,
      });
      input.onCredited(record.txHash, credit);
      return;
    }

    if (needsSession({ status, code: body?.code }) && !sessionRefreshed) {
      sessionRefreshed = true;
      await ensureBalanceSession();
      publish({
        kind: "pending",
        txHash: record.txHash,
        confirmations,
        requiredConfirmations,
        note: "Reconnecting this browser to the ledger. The same transaction is being checked again.",
      });
      continue;
    }

    if (typeof body?.confirmations === "number")
      confirmations = body.confirmations;
    if (typeof body?.requiredConfirmations === "number") {
      requiredConfirmations = body.requiredConfirmations;
    }

    if (
      body?.retryable === true ||
      status === 0 ||
      status === 429 ||
      (status >= 500 && status < 600)
    ) {
      publish({
        kind: "pending",
        txHash: record.txHash,
        confirmations,
        requiredConfirmations,
        note: pendingNote(body?.code, status),
      });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    publish({
      kind: "failed",
      txHash: record.txHash,
      retryable: false,
      code:
        body?.code ||
        (status === 403
          ? "wallet_banned"
          : status === 401
            ? "not_signed_in"
            : "credit_refused"),
      message: body?.error || "The deposit could not be credited.",
    });
    return;
  }

  publish({
    kind: "failed",
    txHash: record.txHash,
    retryable: true,
    code: "still_pending",
    message: "Still waiting for this deposit to be credited on Arc.",
  });
  verifications.delete(record.txHash);
}

export const DepositModal: React.FC<DepositModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onError,
}) => {
  const address = useStore((state) => state.address);
  const fetchBalance = useStore((state) => state.fetchBalance);
  const setSelectedCurrency = useStore((state) => state.setSelectedCurrency);
  const userTier = useStore((state) => state.userTier);
  const toast = useToast();

  const { data: walletClient } = useWalletClient();
  const { connector, chainId: accountChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<DepositPhase>({ kind: "idle" });
  const [walletBalance, setWalletBalance] = useState(0);
  const [balanceState, setBalanceState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [gasFee, setGasFee] = useState<number | null>(null);
  const [feeState, setFeeState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [precheck, setPrecheck] = useState<PreFlight | null>(null);
  const [recheckKey, setRecheckKey] = useState(0);

  const config = useMemo(() => getArcConfig(), []);
  const selectedCurrency = useStore((state) => state.selectedCurrency);
  const asset: ArcAsset = resolveHouseLedgerCurrency({ selectedCurrency });
  const assetConfig = config.assets[asset];
  const quickAmounts = [1, 5, 10, 25];
  const gasReserve = gasFee == null ? null : gasFee + GAS_BUFFER;

  const treasuryConfigured = isAddress(config.treasuryAddress || "");

  const connectedChainId =
    typeof accountChainId === "number" ? accountChainId : null;

  const wrongNetwork =
    connectedChainId !== null && connectedChainId !== config.chainId;

  const activeRecord = useRef<VerificationRecord | null>(null);
  const submitted = useRef<{
    txHash: string;
    amount: number;
    userAddress: string;
  } | null>(null);

  const handlePhase = useCallback((next: TrackedPhase) => setPhase(next), []);

  const startVerification = useCallback(
    (txHash: string, input: VerificationInput) => {
      let record = verifications.get(txHash);
      if (!record) {
        record = {
          txHash,
          phase: {
            kind: "pending",
            txHash,
            confirmations: null,
            requiredConfirmations: REQUIRED_CONFIRMATIONS,
            note: "Submitting the deposit for on-chain verification…",
          },
          credit: null,
          listeners: new Set(),
          running: false,
        };
        verifications.set(txHash, record);
      }

      const previous = activeRecord.current;
      if (previous && previous !== record)
        previous.listeners.delete(handlePhase);
      activeRecord.current = record;
      record.listeners.add(handlePhase);
      setPhase(record.phase);

      if (record.phase.kind === "credited" && !record.running) {
        input.onCredited(txHash, record.credit ?? undefined);
        return;
      }

      if (!record.running) {
        record.running = true;
        void runVerification(record, input).finally(() => {
          record.running = false;
        });
      }
    },
    [handlePhase],
  );

  useEffect(
    () => () => {
      const record = activeRecord.current;
      if (record) record.listeners.delete(handlePhase);
    },
    [handlePhase],
  );

  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen && phase.kind === "credited") setPhase({ kind: "idle" });
  }

  useEffect(() => {
    if (!isOpen || !address) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a fetch effect marks its own request as loading
    setBalanceState("loading");

    (async () => {
      try {
        const balance = await readAssetBalance(address, asset);
        if (!cancelled) {
          setWalletBalance(balance);
          setBalanceState("ready");
        }
      } catch (err) {
        console.error("Failed to read wallet balance:", err);
        if (!cancelled) {
          setWalletBalance(0);
          setBalanceState("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    address,
    asset,
    assetConfig,
    config.chainId,
    config.name,
    config.rpcEndpoint,
    recheckKey,
  ]);

  const estimateGasFee = useCallback(
    async (wholeTokens: number): Promise<number> => {
      try {
        const client = arcPublicClient();
        const [gas, gasPrice] = await Promise.all([
          client.estimateContractGas({
            address: assetConfig.address,
            abi: erc20Abi,
            functionName: "transfer",
            args: [
              config.treasuryAddress as `0x${string}`,
              parseUnits(wholeTokens.toString(), assetConfig.decimals),
            ],
            account: address as `0x${string}`,
          }),
          client.getGasPrice(),
        ]);
        return Number(formatUnits(gas * gasPrice, 18));
      } catch (err) {
        console.warn("[deposit] gas estimate failed, reserving 0.01 USDC", err);
        return 0.01;
      }
    },
    [address, assetConfig, config.treasuryAddress],
  );

  useEffect(() => {
    if (!isOpen || balanceState !== "ready" || walletBalance <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a fetch effect resets its result when its inputs go away
      setFeeState("loading");
      setGasFee(null);
      return;
    }
    let cancelled = false;
    setFeeState("loading");
    void (async () => {
      const fee = await estimateGasFee(walletBalance);
      if (cancelled) return;
      setGasFee(fee);
      setFeeState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, balanceState, walletBalance, estimateGasFee, recheckKey]);

  useEffect(() => {
    if (!isOpen || !address) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrecheck(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/arc/deposit-precheck?address=${encodeURIComponent(address)}`,
          { credentials: "include" },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok)
          console.error(`[deposit] precheck answered ${response.status}`, body);
        if (!cancelled) setPrecheck(response.ok && body ? body : null);
      } catch (err) {
        console.error("[deposit] precheck failed", err);
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
    if (!value.trim()) return "Enter an amount";
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
      return "Amount must be greater than zero";
    if (decimalPlaces(value) > assetConfig.decimals) {
      return `${asset} supports at most ${assetConfig.decimals} decimal places`;
    }
    if (balanceState === "ready" && parsed > walletBalance)
      return `Insufficient ${asset} balance`;
    if (
      balanceState === "ready" &&
      gasReserve != null &&
      parsed + gasReserve > walletBalance + FLOAT_EPSILON
    ) {
      return `Not enough ${asset} to cover the network fee — leave about ${gasReserve.toFixed(4)} spare`;
    }
    return null;
  };

  const preFlightError = (): string | null => {
    const amountError = validate(amount);
    if (amountError) return amountError;
    if (!address) return "Connect a wallet first";
    if (!walletClient && !connector) return "Wallet is not connected";
    if (wrongNetwork) {
      return `Your wallet is on chain ${connectedChainId}, not ${config.name} (${config.chainId}). Switch before depositing`;
    }
    if (!treasuryConfigured) {
      return "Deposits are unavailable: no Strike treasury address is configured";
    }
    if (precheck?.banned === true)
      return "This wallet is banned from the platform.";
    if (
      precheck &&
      precheck.ready === false &&
      precheck.code === "treasury_not_configured"
    ) {
      return "Deposits are unavailable: the treasury address on the server is not configured";
    }
    return null;
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value !== "" && !/^\d*\.?\d*$/.test(value)) return;
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
    setAmount("");
    setError(null);
  };

  const switchToArc = useCallback(async () => {
    try {
      if (connector) await switchChainAsync({ chainId: config.chainId });
      else
        setError(
          `Add ${config.name} (chain ${config.chainId}) to your wallet and try again`,
        );
    } catch (err) {
      console.warn("[deposit] chain switch rejected or failed", err);
      setError(`Switch your wallet to ${config.name} and try again`);
    }
  }, [config, connector, switchChainAsync]);

  const resolveWalletProvider =
    useCallback(async (): Promise<EIP1193Provider> => {
      if (connector) {
        return (await connector.getProvider()) as EIP1193Provider;
      }
      if (walletClient) {
        throw new Error(
          "This wallet does not expose a signing provider. Reconnect and try again.",
        );
      }
      throw new Error("Wallet is not connected");
    }, [connector, walletClient]);

  const markCredited = useCallback(
    async (
      txHash: string,
      creditedAmount: number,
      walletAddress: string,
      credit?: ServerCredit,
    ) => {
      await Promise.all([
        fetchBalance(walletAddress),
        useStore.getState().refreshWalletBalance(),
      ]);
      toast.success(
        `Successfully deposited ${creditedAmount.toFixed(4)} ${asset}! Balance updated.`,
      );
      onSuccess?.(creditedAmount, txHash, {
        txHash,
        currency: asset,
        chain: config.name,
        explorerUrl: explorerTxUrl(txHash),
        ...(credit ?? {}),
      });
      setAmount("");
      onClose();
    },
    [asset, config, fetchBalance, onClose, onSuccess, toast],
  );

  const isBusy = phase.kind === "signing" || phase.kind === "pending";

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
    setPhase({ kind: "signing" });

    try {
      const wallet = arcWalletClient(
        await resolveWalletProvider(),
        walletAddress as `0x${string}`,
      );

      if ((await wallet.getChainId()) !== config.chainId) {
        await switchToArc();
      }
      if ((await wallet.getChainId()) !== config.chainId) {
        throw new Error(`Switch your wallet to ${config.name} and try again`);
      }

      const [from] = await wallet.getAddresses();
      if (!from || from.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error(
          `The wallet asked to sign (${shortenAddress(from ?? "none")}) is not the account you are signed in with (${shortenAddress(
            walletAddress,
          )}). Connect the right account first.`,
        );
      }

      const txHash = await wallet.writeContract({
        address: assetConfig.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [
          config.treasuryAddress as `0x${string}`,
          parseUnits(amount, assetConfig.decimals),
        ],
      });
      if (!txHash)
        throw new Error("The wallet returned a transaction without a hash");

      submitted.current = {
        txHash,
        amount: depositAmount,
        userAddress: walletAddress,
      };
      startVerification(txHash, {
        userAddress: walletAddress,
        amount: depositAmount,
        currency: asset,
        onCredited: (hash, credit) => {
          void markCredited(hash, depositAmount, walletAddress, credit);
        },
      });
    } catch (err) {
      const message = walletErrorText(err);
      console.error("Deposit error:", err);
      setPhase({ kind: "idle" });
      setError(message);
      toast.error(message);
      onError?.(err instanceof Error ? err : new Error(message));
    }
  };

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
      on ? glassSelected : "bg-ink/[0.04] text-muted hover:text-ink"
    }`;

  const summaryRow = (
    label: string,
    value: React.ReactNode,
    hint?: React.ReactNode,
  ) => (
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
      showCloseButton={phase.kind !== "signing"}
    >
      <p className="-mt-4 mb-6 text-[15px] text-muted">
        Move {asset} from your Arc wallet to your trading balance.
      </p>
      <div className="-mt-4 mb-6">
        <HumanStatus nudge />
      </div>
      {config.chainId === 5042002 && (
        <a
          href="https://faucet.circle.com"
          target="_blank"
          rel="noopener noreferrer"
          className="-mt-3 mb-6 inline-flex items-center gap-1 text-sm font-medium text-up hover:underline"
        >
          Need test USDC? Get it free from Circle&apos;s faucet{" "}
          <ArrowUpRight size={14} />
        </a>
      )}

      {ARC_ASSETS.length > 1 && (
        <Segmented
          className="mb-3"
          options={ARC_ASSETS.map((token) => ({ value: token, label: token }))}
          value={asset}
          onChange={handleAssetChange}
          disabled={isBusy}
        />
      )}
      <label htmlFor="deposit-amount" className="sr-only">
        Amount to deposit
      </label>
      <div
        className={`flex h-16 items-center rounded-2xl bg-white px-5 ring-1 ring-inset transition-shadow focus-within:ring-ink ${
          error ? "ring-down" : "ring-line"
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
        {quickAmounts.map((quickAmount) => (
          <button
            key={quickAmount}
            type="button"
            onClick={() => handleQuickSelect(quickAmount)}
            disabled={
              isBusy ||
              (balanceState === "ready" &&
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
              It is on chain {connectedChainId}; Strike only credits deposits
              made on {config.name} (chain {config.chainId}). Switch first — do
              not sign on the other network.
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
          "You send",
          hasAmount ? `${parsedAmount.toFixed(4)} ${asset}` : `— ${asset}`,
        )}
        {summaryRow(
          "Wallet",
          balanceState === "loading"
            ? `reading…`
            : balanceState === "error"
              ? "unavailable"
              : `${walletBalance.toFixed(4)} ${asset}`,
        )}
        {summaryRow(
          "Network fee (est.)",
          balanceState === "error"
            ? "unavailable"
            : feeState === "loading" || gasFee == null
              ? "checking…"
              : `~${gasFee.toFixed(4)} ${asset}`,
        )}
        {summaryRow(
          `Credited after ${getFeePercentLabel(userTier)} fee`,
          hasAmount ? `${netPreview.toFixed(4)} ${asset}` : `0.0000 ${asset}`,
        )}
      </dl>
      <details className="group mt-3 font-jet text-[13px]">
        <summary className="flex cursor-pointer list-none items-center justify-between text-subtle [&::-webkit-details-marker]:hidden">
          Details
          <CaretDown
            size={14}
            aria-hidden="true"
            className="text-faint transition-transform group-open:rotate-180"
          />
        </summary>
        <dl className="mt-2 space-y-2">
          {summaryRow("Token", `${asset} · ${assetConfig.decimals} decimals`)}
          {summaryRow("Network", `${config.name} · ${config.chainId}`)}
          {summaryRow(
            "Sending to",
            treasuryConfigured
              ? shortenAddress(config.treasuryAddress)
              : "not configured",
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
            ) : undefined,
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
                <Badge tone="down">
                  {String(precheck.code ?? "not ready")}
                </Badge>
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
      </details>

      {phase.kind === "signing" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-5 flex items-center gap-2 rounded-2xl bg-surface px-3.5 py-3 font-jet text-[13px]"
        >
          <CircleNotch size={16} className="animate-spin text-up" />
          Confirm the USDC transfer in your wallet — nothing is credited until
          Arc shows it.
        </div>
      )}

      {phase.kind === "pending" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-5 rounded-2xl bg-surface px-3.5 py-3"
        >
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
              Waiting for confirmations —{" "}
              {Math.min(phase.confirmations ?? 0, phase.requiredConfirmations)}/
              {phase.requiredConfirmations}
            </li>
            <li className="flex items-center gap-1.5 text-faint">
              <span aria-hidden>○</span> Credited to your house balance
            </li>
          </ol>
          <p className="mt-2 text-[12px] leading-relaxed text-subtle">
            {phase.note}
          </p>
          {phase.txHash && (
            <a
              href={explorerTxUrl(phase.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 font-jet text-[12px] text-up hover:underline"
            >
              Verify {shortenAddress(phase.txHash, 6)} on explorer{" "}
              <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      )}

      {phase.kind === "credited" && (
        <div role="status" className="mt-5 rounded-2xl bg-up-soft px-3.5 py-3">
          <div className="flex items-center gap-2 font-jet text-[13px] font-semibold text-up">
            <CheckCircle size={16} weight="fill" />
            Credited on Arc
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            {phase.amount.toFixed(4)} {asset} paid into{" "}
            {shortenAddress(config.treasuryAddress)} and credited to your house
            balance. Transaction{" "}
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

      {phase.kind === "failed" && (
        <div role="alert" className="mt-5 rounded-2xl bg-down-soft px-3.5 py-3">
          <div className="flex items-start gap-2">
            <WarningCircle size={16} className="mt-0.5 shrink-0 text-down" />
            <div className="min-w-0">
              <p className="font-jet text-[13px] font-semibold text-down">
                {phase.retryable ? "Not credited yet" : "Deposit rejected"}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                {phase.message}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink">
                {phase.retryable
                  ? STILL_PENDING_GUIDANCE
                  : TERMINAL_GUIDANCE[phase.code] ||
                    TERMINAL_GUIDANCE.credit_refused}
              </p>
              {phase.txHash && (
                <a
                  href={explorerTxUrl(phase.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 font-jet text-[12px] text-up hover:underline"
                >
                  View {shortenAddress(phase.txHash, 6)} on explorer{" "}
                  <ArrowUpRight size={12} />
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
                    setPhase({ kind: "idle" });
                    submitted.current = null;
                  }}
                >
                  {phase.retryable
                    ? "Close this status"
                    : "Start a new deposit"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-down-soft px-3.5 py-2.5 text-[13px] text-down"
        >
          {error}
        </p>
      )}

      <Button
        size="lg"
        onClick={handleDeposit}
        disabled={
          isBusy || wrongNetwork || !amount || phase.kind === "credited"
        }
        className="mt-6 w-full"
      >
        {phase.kind === "signing"
          ? "Confirm in your wallet…"
          : phase.kind === "pending"
            ? "Verifying deposit…"
            : phase.kind === "credited"
              ? "Credited"
              : `Deposit ${asset}`}
      </Button>
    </Modal>
  );
};

function walletErrorText(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${(err as { shortMessage?: string }).shortMessage ?? ""} ${err.message}`
      : String(err);
  if (/user rejected|denied|rejected the request/i.test(raw))
    return "You cancelled the transaction in your wallet.";
  if (/rate limit|429|too many requests/i.test(raw))
    return "Arc RPC is busy. Wait a few seconds and deposit again.";
  if (/insufficient funds|exceeds balance/i.test(raw))
    return "Not enough USDC in your wallet for this amount plus gas.";
  const short = (err as { shortMessage?: string })?.shortMessage;
  return (
    short ||
    (err instanceof Error
      ? err.message.split("\n")[0]
      : "Deposit failed. Please try again.")
  );
}
