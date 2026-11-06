"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  erc20Abi,
  formatUnits,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  type Address,
  type EIP1193Provider,
} from "viem";
import { useAccount, useSwitchChain } from "wagmi";
import { bridging } from "@/lib/bridge/bridging";
import { tradeLock } from "@/lib/markets/marketData";
import { spendToArc } from "@/lib/gateway/gateway";
import { planFunding, useUsdcSources } from "@/lib/gateway/usdcSources";
import { CircleNotch } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { Button, Segmented } from "@/components/ui/kit";
import { arcPublicClient, arcWalletClient } from "@/lib/arc/client";
import { explorerTxUrl, getArcConfig } from "@/lib/arc/config";

const MARKET = (process.env.NEXT_PUBLIC_STOCK_MARKET_ADDRESS?.trim() ||
  "") as Address;
const marketAbi = parseAbi([
  "function buy(address token, string symbol, uint256 amountIn, uint256 price, uint256 deadline, bytes signature) returns (uint256)",
  "function sell(address token, string symbol, uint256 sharesIn, uint256 price, uint256 deadline, bytes signature) returns (uint256)",
  "function shares(bytes32 symbol, address holder) view returns (uint256)",
]);

type Currency = "USDC" | "EURC";
const SIGN: Record<Currency, string> = { USDC: "$", EURC: "€" };

interface Quote {
  symbol: string;
  token: Address;
  price: string;
  deadline: number;
  signature: `0x${string}`;
}

const fetchQuote = async (
  symbol: string,
  currency: Currency,
): Promise<Quote> => {
  const res = await fetch(
    `/api/markets/quote?symbol=${encodeURIComponent(symbol)}&currency=${currency}`,
    { cache: "no-store" },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(body?.error ?? `No price for ${symbol} right now`);
  return body as Quote;
};

const readShares = (holder: Address, symbol: string) =>
  arcPublicClient().readContract({
    address: MARKET,
    abi: marketAbi,
    functionName: "shares",
    args: [keccak256(toBytes(symbol)), holder],
  });

/**
 * Buy or sell test shares of a stock at its live price. Testnet simulation on Arc: the price is a
 * quote signed by Strike, so each trade is one transaction (plus a one-time USDC approval).
 */
export function StockTrade({
  ticker,
  name,
  price,
  mainnetRoute,
  onClose,
}: {
  ticker: string;
  name: string | null;
  price: number | null;
  mainnetRoute: string | null;
  onClose: () => void;
}) {
  const { address, connector, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [currency, setCurrency] = useState<Currency>("USDC");
  const [amount, setAmount] = useState("1");
  const [held, setHeld] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; tx: string } | null>(null);

  // Bumped after each trade so the holdings below re-read from the chain.
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    readShares(address as Address, ticker)
      .then((n) => !cancelled && setHeld(n))
      .catch(() => !cancelled && setHeld(null));
    return () => {
      cancelled = true;
    };
  }, [address, ticker, reads]);

  const usd = Number(amount);
  const valid = Number.isFinite(usd) && usd > 0;
  const buyingUsdc = side === "buy" && currency === "USDC";
  const { sources, refresh: refreshSources } = useUsdcSources(
    address as Address | undefined,
    buyingUsdc,
  );
  const need = valid ? parseUnits(amount, 6) : BigInt(0);
  const funding =
    buyingUsdc && sources && valid ? planFunding(need, sources) : undefined;
  const heldValue = held != null && price ? (Number(held) / 1e6) * price : null;
  const estShares = valid && price ? usd / price : 0;

  const trade = async () => {
    if (!address || !connector || !valid) return;
    if (tradeLock.get()) {
      setError(
        "A wallet request is still open. Answer it in your wallet, or reload the page.",
      );
      return;
    }
    tradeLock.set(true);
    setError(null);
    setDone(null);
    try {
      const arcId = getArcConfig().chainId;
      const client = arcPublicClient();
      if (funding?.kind === "bridge") {
        setBusy(`Bringing USDC from ${funding.chain.name}…`);
        bridging.set(true);
        try {
          await switchChainAsync({
            chainId: funding.chain.chainId as Parameters<
              typeof switchChainAsync
            >[0]["chainId"],
          });
          const { bridgeUsdc } = await import("@/lib/bridge/cctp");
          await bridgeUsdc(
            (await connector.getProvider()) as EIP1193Provider,
            address,
            formatUnits(funding.amount, 6),
            "in",
            () => undefined,
            funding.cctp,
          );
        } finally {
          bridging.set(false);
        }
      }
      if (chainId !== arcId || funding?.kind === "bridge")
        await switchChainAsync({ chainId: arcId });
      const wallet = arcWalletClient(
        (await connector.getProvider()) as EIP1193Provider,
        address as Address,
      );
      if (funding?.kind === "gateway") {
        setBusy(`Bringing USDC from your Gateway balance…`);
        await spendToArc({
          signer: wallet,
          arcWallet: wallet,
          arcClient: client,
          source: funding.chain,
          recipient: address,
          amount: funding.amount,
          maxFee: funding.maxFee,
        });
      }
      if (funding && funding.kind !== "arc") {
        const arrived = await client.readContract({
          address: getArcConfig().usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
        if (arrived < need)
          throw new Error(
            `Only ${formatUnits(arrived, 6)} USDC reached Arc. It is safe in your wallet. Lower the amount and try again.`,
          );
      }
      const token =
        currency === "EURC" ? getArcConfig().eurc : getArcConfig().usdc;
      const units = parseUnits(amount, 6);
      if (side === "buy") {
        const allowance = await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address as Address, MARKET],
        });
        if (allowance < units) {
          setBusy(`Approve ${currency} once in your wallet…`);
          const ap = await wallet.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [MARKET, parseUnits("1000000", 6)],
          });
          await client.waitForTransactionReceipt({ hash: ap });
        }
      }
      setBusy("Getting the live price…");
      const q = await fetchQuote(ticker, currency);
      const qPrice = BigInt(q.price);
      // Sell takes shares: the USDC amount at the quoted price, capped at what is held.
      const sharesIn =
        side === "sell"
          ? [(units * BigInt(1_000_000)) / qPrice, held ?? BigInt(0)].reduce(
              (a, b) => (a < b ? a : b),
            )
          : BigInt(0);
      if (side === "sell" && sharesIn <= BigInt(0))
        throw new Error(`You hold no ${ticker} to sell`);
      setBusy("Confirm in your wallet…");
      const tx = await wallet.writeContract({
        address: MARKET,
        abi: marketAbi,
        functionName: side,
        args: [
          token,
          ticker,
          side === "buy" ? units : sharesIn,
          qPrice,
          BigInt(q.deadline),
          q.signature,
        ],
      });
      setBusy("Settling on Arc…");
      const rcpt = await client.waitForTransactionReceipt({ hash: tx });
      if (rcpt.status !== "success")
        throw new Error("The trade reverted onchain");
      const px = Number(qPrice) / 1e6;
      setDone({
        text:
          side === "buy"
            ? `Bought ${(Number(units) / Number(qPrice)).toFixed(6)} ${ticker} at ${SIGN[currency]}${px.toFixed(2)}`
            : `Sold ${formatUnits(sharesIn, 6)} ${ticker} at ${SIGN[currency]}${px.toFixed(2)}`,
        tx,
      });
      refresh();
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string };
      setError(
        /rejected|denied/i.test(e.message ?? "")
          ? "You cancelled in your wallet."
          : (e.shortMessage ?? e.message ?? "Trade failed").split("\n")[0],
      );
    } finally {
      tradeLock.set(false);
      setBusy(null);
      refreshSources();
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`${ticker} · ${name ?? "Stock"}`}>
      <p className="-mt-4 mb-4 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <span className="rounded-full bg-up-soft px-2 py-0.5 font-jet text-[11px] font-medium text-up">
          Testnet simulation
        </span>
        Live price, test shares, settles on Arc testnet.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 font-jet text-[13px]">
        <div className="rounded-2xl bg-surface px-3.5 py-2.5">
          <div className="text-subtle">Price</div>
          <div className="text-lg font-semibold">
            {price ? `$${price.toFixed(2)}` : "—"}
          </div>
        </div>
        <div className="rounded-2xl bg-surface px-3.5 py-2.5">
          <div className="text-subtle">You own</div>
          <div className="text-lg font-semibold">
            {held == null ? "…" : `${formatUnits(held, 6)}`}
            {heldValue != null && (
              <span className="ml-1 text-xs font-normal text-subtle">
                ≈ ${heldValue.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <Segmented
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
          ]}
          value={side}
          onChange={(v) => {
            setSide(v as "buy" | "sell");
            setDone(null);
            setError(null);
          }}
          disabled={!!busy}
        />
        <Segmented
          options={[
            { value: "USDC", label: "USDC" },
            { value: "EURC", label: "EURC" },
          ]}
          value={currency}
          onChange={(v) => {
            setCurrency(v as Currency);
            setDone(null);
            setError(null);
          }}
          disabled={!!busy}
        />
      </div>

      <div className="flex h-14 items-center rounded-2xl bg-white px-4 ring-1 ring-inset ring-line focus-within:ring-ink">
        <span className="mr-1 font-jet text-xl text-faint">
          {SIGN[currency]}
        </span>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) =>
            /^\d*\.?\d*$/.test(e.target.value) && setAmount(e.target.value)
          }
          disabled={!!busy}
          aria-label={
            side === "buy"
              ? `${currency} to spend`
              : `${currency} worth to sell`
          }
          className="min-w-0 flex-1 bg-transparent font-jet text-2xl font-semibold outline-none"
        />
        <span className="font-jet text-sm text-faint">{currency}</span>
      </div>
      <p className="mt-2 font-jet text-[12px] text-subtle">
        {side === "buy"
          ? `≈ ${estShares.toFixed(6)} ${ticker}${currency === "EURC" ? " at the live EUR/USD rate" : ""}`
          : `Sells ≈ ${estShares.toFixed(6)} ${ticker}, capped at what you own, paid in ${currency}`}
        {mainnetRoute && ` · on mainnet this routes to ${mainnetRoute}`}
      </p>
      {funding && funding.kind !== "arc" && (
        <p className="mt-2 font-jet text-[12px] text-up">
          {funding.kind === "gateway"
            ? `Uses ${formatUnits(funding.amount, 6)} USDC from your Gateway balance first.`
            : `Brings ${formatUnits(funding.amount, 6)} USDC from ${funding.chain.name} to Arc first, then buys.`}
        </p>
      )}

      {connector?.id === "coinbaseWalletSDK" && (
        <p role="alert" className="mt-4 text-[13px] text-down">
          Coinbase Wallet cannot load transaction signing on Arc testnet.
          Connect MetaMask to trade.
        </p>
      )}
      {busy && (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 font-jet text-[13px] text-muted"
        >
          <CircleNotch size={16} className="animate-spin text-up" /> {busy}
        </p>
      )}
      {done && (
        <p
          role="status"
          className="mt-4 rounded-2xl bg-up-soft px-3.5 py-2.5 text-[13px] text-up"
        >
          {done.text}.{" "}
          <a
            href={explorerTxUrl(done.tx)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on Arc
          </a>
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-2xl bg-down-soft px-3.5 py-2.5 text-[13px] text-down"
        >
          {error}
        </p>
      )}

      <Button
        size="lg"
        className="mt-5 w-full"
        onClick={trade}
        disabled={
          !address ||
          !valid ||
          !!busy ||
          !price ||
          funding === null ||
          (buyingUsdc && !sources)
        }
      >
        {!address
          ? "Connect a wallet to trade"
          : funding === null
            ? "Not enough USDC on any chain"
            : side === "buy"
              ? `Buy ${SIGN[currency]}${amount || 0} of ${ticker}`
              : `Sell ${SIGN[currency]}${amount || 0} of ${ticker}`}
      </Button>
    </Modal>
  );
}
