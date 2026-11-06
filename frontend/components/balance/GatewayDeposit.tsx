"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
} from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";
import { useAccount, useSwitchChain } from "wagmi";
import { ArrowsClockwise, CircleNotch } from "@phosphor-icons/react";
import { Button } from "@/components/ui/kit";
import { arcPublicClient, arcWalletClient } from "@/lib/arc/client";
import { getArcConfig } from "@/lib/arc/config";
import {
  GATEWAY_CHAINS,
  depositToGateway,
  gatewayBalances,
  spendToArc,
  type GatewayBalance,
  type GatewayChain,
} from "@/lib/gateway/gateway";

/** Covers Circle's Gateway fee on testnet sources; the unused part stays in the balance. */
const MAX_FEE = parseUnits("0.05", 6);
const VIEM_CHAINS = {
  [baseSepolia.id]: baseSepolia,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

type Step = "idle" | "sign" | "attest" | "mint" | "fund";
const STEP_TEXT: Record<Exclude<Step, "idle">, string> = {
  sign: "Sign the transfer in your wallet…",
  attest: "Circle is attesting the transfer…",
  mint: "Minting on Arc into the Strike treasury…",
  fund: "Moving USDC into Gateway…",
};

/**
 * Deposit from a Circle Gateway balance: USDC held on any supported chain is minted on Arc
 * straight into the treasury in seconds. The minted tx is then credited like any deposit.
 */
export function GatewayDeposit({
  amount,
  disabled,
  onMinted,
  onError,
}: {
  amount: string;
  disabled: boolean;
  onMinted: (txHash: string) => void;
  onError: (message: string) => void;
}) {
  const { address, connector, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [balances, setBalances] = useState<GatewayBalance[] | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [reload, setReload] = useState(0);
  const [fundChain, setFundChain] = useState<GatewayChain>(GATEWAY_CHAINS[1]);
  const treasury = getArcConfig().treasuryAddress as Address;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    gatewayBalances(address)
      .then((b) => !cancelled && setBalances(b))
      .catch(
        (err) =>
          !cancelled &&
          onError(`Could not read your Gateway balance: ${err.message}`),
      );
    return () => {
      cancelled = true;
    };
  }, [address, reload, onError]);

  const units = (() => {
    try {
      return amount ? parseUnits(amount, 6) : BigInt(0);
    } catch {
      return BigInt(0);
    }
  })();
  const total = (balances ?? []).reduce((sum, b) => sum + b.balance, BigInt(0));
  // One burn intent spends from one chain: pick the largest balance that covers amount + fee.
  const source = [...(balances ?? [])]
    .sort((a, b) => (b.balance > a.balance ? 1 : -1))
    .find((b) => b.balance >= units + MAX_FEE);
  const busy = step !== "idle";

  const provider = useCallback(async () => {
    if (!connector || !address) throw new Error("Connect a wallet first");
    return (await connector.getProvider()) as EIP1193Provider;
  }, [connector, address]);

  const deposit = async () => {
    if (!address || !source || units <= BigInt(0)) return;
    try {
      const arcId = getArcConfig().chainId;
      const signer = arcWalletClient(await provider(), address);
      setStep("sign");
      if (chainId !== arcId) await switchChainAsync({ chainId: arcId });
      const mint = await spendToArc({
        signer,
        arcWallet: signer,
        arcClient: arcPublicClient(),
        source: source.chain,
        recipient: treasury,
        amount: units,
        maxFee: MAX_FEE,
        onStep: setStep,
      });
      setReload((n) => n + 1);
      onMinted(mint);
    } catch (err) {
      onError(
        err instanceof Error
          ? ((err as { shortMessage?: string }).shortMessage ??
              err.message.split("\n")[0])
          : String(err),
      );
    } finally {
      setStep("idle");
    }
  };

  const fund = async () => {
    if (!address || units <= BigInt(0)) return;
    try {
      setStep("fund");
      if (chainId !== fundChain.chainId)
        await switchChainAsync({ chainId: fundChain.chainId });
      const viemChain =
        VIEM_CHAINS[fundChain.chainId as keyof typeof VIEM_CHAINS];
      const wallet = viemChain
        ? createWalletClient({
            account: address,
            chain: viemChain,
            transport: custom(await provider()),
          })
        : arcWalletClient(await provider(), address);
      const client = viemChain
        ? createPublicClient({ chain: viemChain, transport: http() })
        : arcPublicClient();
      await depositToGateway(wallet, client, fundChain, units);
      setReload((n) => n + 1);
    } catch (err) {
      onError(
        err instanceof Error
          ? ((err as { shortMessage?: string }).shortMessage ??
              err.message.split("\n")[0])
          : String(err),
      );
    } finally {
      setStep("idle");
    }
  };

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-2xl bg-surface px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-subtle">Gateway balance</span>
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            aria-label="Refresh Gateway balance"
            className="text-faint hover:text-ink"
          >
            <ArrowsClockwise size={14} />
          </button>
        </div>
        <div className="mt-0.5 font-jet text-xl font-semibold">
          {balances ? formatUnits(total, 6) : "…"} USDC
        </div>
        {balances && total > BigInt(0) && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 font-jet text-[12px] text-muted">
            {balances
              .filter((b) => b.balance > BigInt(0))
              .map((b) => (
                <span key={b.chain.key}>
                  {b.chain.name} {formatUnits(b.balance, 6)}
                </span>
              ))}
          </div>
        )}
      </div>

      {busy && (
        <p
          role="status"
          className="flex items-center gap-2 font-jet text-[13px] text-muted"
        >
          <CircleNotch size={16} className="animate-spin text-up" />
          {STEP_TEXT[step as Exclude<Step, "idle">]}
        </p>
      )}

      <Button
        size="lg"
        className="w-full"
        onClick={deposit}
        disabled={disabled || busy || !source || units <= BigInt(0)}
      >
        {units <= BigInt(0)
          ? "Enter an amount"
          : source
            ? `Deposit ${amount} USDC from ${source.chain.name}`
            : "Not enough in Gateway"}
      </Button>

      <details className="text-[13px]">
        <summary className="cursor-pointer text-subtle">
          Add USDC to Gateway
        </summary>
        <p className="mt-2 text-muted">
          Moves {amount || "the amount"} USDC from your wallet into Circle
          Gateway on the chain you pick. Arc counts at once; other chains count
          once they finalize, about 15 to 20 minutes.
        </p>
        <div className="mt-2 flex gap-2">
          <select
            value={fundChain.key}
            onChange={(e) =>
              setFundChain(
                GATEWAY_CHAINS.find((c) => c.key === e.target.value) ??
                  GATEWAY_CHAINS[1],
              )
            }
            disabled={busy}
            className="h-9 flex-1 rounded-full bg-ink/[0.04] px-3 text-[13px]"
          >
            {GATEWAY_CHAINS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            onClick={fund}
            disabled={disabled || busy || units <= BigInt(0)}
          >
            Add
          </Button>
        </div>
      </details>
    </div>
  );
}
