"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { recordTrade, tradeLock } from "@/lib/markets/marketData";
import {
  GatewayMintError,
  mintPending,
  pendingMint,
  spendToArc,
} from "@/lib/gateway/gateway";
import {
  noFundingReason,
  planFunding,
  useUsdcSources,
} from "@/lib/gateway/usdcSources";
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
const SETTLE_TIMEOUT_MS = 90_000;
const RECEIPT_EVERY_MS = 5_000;
const SETTLE_READ_MS = 700;
/** Long enough for a trade signed at the last moment to show up. */
const QUOTE_GRACE_MS = 20_000;
const SHARES_EVERY_MS = 1_500;
const READ_TRIES = 12;
const never = new Promise<never>(() => undefined);

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Arc's public RPC refuses about half of its reads, so one refusal is not an answer. */
async function persist<T>(read: () => Promise<T>): Promise<T> {
  for (let tries = READ_TRIES; ; tries--) {
    try {
      return await read();
    } catch (err) {
      if (tries <= 1) throw err;
      await wait(SETTLE_READ_MS);
    }
  }
}

/**
 * Arc's public RPC refuses nearly every `eth_getTransactionReceipt` but serves
 * contract reads, so a trade counts as landed the moment the balance moves.
 */
async function sharesMoved(
  holder: Address,
  ticker: string,
  before: bigint,
  stopped: () => boolean,
) {
  while (!stopped()) {
    const now = await readShares(holder, ticker).catch(() => before);
    if (now !== before) return;
    await wait(SHARES_EVERY_MS);
  }
  return never;
}

/** Only here to catch a revert, which never moves the balance. */
async function receiptOf(hash: `0x${string}`, stopped: () => boolean) {
  while (!stopped()) {
    const rcpt = await arcPublicClient()
      .getTransactionReceipt({ hash })
      .catch(() => null);
    if (rcpt?.status === "reverted")
      throw new Error("The trade reverted onchain");
    await wait(RECEIPT_EVERY_MS);
  }
  return never;
}

export function StockTrade({
  ticker,
  name,
  price,
  mainnetRoute,
  startSide = "buy",
  ownedShares = null,
  onClose,
}: {
  ticker: string;
  name: string | null;
  price: number | null;
  mainnetRoute: string | null;
  startSide?: "buy" | "sell";
  /** What the page already knows, so this shows before the chain read returns. */
  ownedShares?: number | null;
  onClose: () => void;
}) {
  const { address, connector, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [side, setSide] = useState<"buy" | "sell">(startSide);
  const [currency, setCurrency] = useState<Currency>("USDC");
  const [amount, setAmount] = useState("1");
  const [chainShares, setHeld] = useState<bigint | null>(null);
  const held =
    chainShares ??
    (ownedShares == null ? null : BigInt(Math.round(ownedShares * 1e6)));
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
      .catch((err) => console.warn("[stock] shares read failed", err));
    return () => {
      cancelled = true;
    };
  }, [address, ticker, reads]);

  // The market pays sells out of its own token balance, which can be empty (EURC is).
  const [pool, setPool] = useState<{ key: string; bal: bigint } | null>(null);
  const token = currency === "EURC" ? getArcConfig().eurc : getArcConfig().usdc;
  useEffect(() => {
    if (side !== "sell" || !MARKET) return;
    let cancelled = false;
    arcPublicClient()
      .readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [MARKET],
      })
      .then((bal) => !cancelled && setPool({ key: `${currency}${reads}`, bal }))
      .catch((err) => console.warn("[stock] pool read failed", err));
    return () => {
      cancelled = true;
    };
  }, [side, token, currency, reads]);
  const poolBal =
    side === "sell" && pool?.key === `${currency}${reads}` ? pool.bal : null;

  // A cancelled or unconfirmed Gateway mint leaves a signed attestation to finish.
  const [mintKey, setMintKey] = useState(0);
  const stuck = useMemo(
    () => (address ? pendingMint(address as Address) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, mintKey],
  );

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
  const estPayout =
    side === "sell" && valid ? Math.min(usd, heldValue ?? usd) : 0;
  const poolShort =
    poolBal != null && estPayout > 0 && estPayout > Number(poolBal) / 1e6;

  const failText = (err: unknown) => {
    const e = err as { shortMessage?: string; message?: string };
    if (err instanceof GatewayMintError) return err.message;
    return /rejected|denied/i.test(e.message ?? "")
      ? "You cancelled in your wallet."
      : (e.shortMessage ?? e.message ?? "Trade failed").split("\n")[0];
  };

  const finishMint = async () => {
    if (!address || !connector || !stuck || tradeLock.get()) return;
    tradeLock.set(true);
    setError(null);
    setDone(null);
    setBusy("Finishing your Gateway transfer…");
    try {
      const arcId = getArcConfig().chainId;
      if (chainId !== arcId) await switchChainAsync({ chainId: arcId });
      const tx = await mintPending({
        arcWallet: arcWalletClient(
          (await connector.getProvider()) as EIP1193Provider,
          address as Address,
        ),
        arcClient: arcPublicClient(),
        pending: stuck,
      });
      setDone({
        text: `Minted ${formatUnits(BigInt(stuck.amount), 6)} USDC to your wallet`,
        tx,
      });
    } catch (err) {
      setError(failText(err));
    } finally {
      tradeLock.set(false);
      setBusy(null);
      setMintKey((n) => n + 1);
      refreshSources();
    }
  };

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
    setBusy("Getting ready…");
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
        const arrived = await persist(() =>
          client.readContract({
            address: getArcConfig().usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }),
        );
        if (arrived < need)
          throw new Error(
            `Only ${formatUnits(arrived, 6)} USDC reached Arc. It is safe in your wallet. Lower the amount and try again.`,
          );
      }
      const units = parseUnits(amount, 6);
      if (side === "buy") {
        const allowance = await persist(() =>
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address as Address, MARKET],
          }),
        );
        if (allowance < units) {
          setBusy(`Approve ${currency} once in your wallet…`);
          await wallet.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [MARKET, parseUnits("1000000", 6)],
          });
          const approved = Date.now() + SETTLE_TIMEOUT_MS;
          for (;;) {
            const now = await client
              .readContract({
                address: token,
                abi: erc20Abi,
                functionName: "allowance",
                args: [address as Address, MARKET],
              })
              .catch(() => BigInt(0));
            if (now >= units) break;
            if (Date.now() > approved)
              throw new Error(
                `The ${currency} approval did not land. Try again.`,
              );
            await wait(SETTLE_READ_MS);
          }
        }
      }
      setBusy("Getting the live price…");
      const q = await fetchQuote(ticker, currency);
      const qPrice = BigInt(q.price);
      // Sell takes shares: the USDC amount at the quoted price, capped at what is held.
      const sharesBefore = await persist(() =>
        readShares(address as Address, ticker),
      );
      const wanted = (units * BigInt(1_000_000)) / qPrice;
      const sharesIn =
        side === "sell"
          ? wanted < sharesBefore
            ? wanted
            : sharesBefore
          : BigInt(0);
      if (side === "sell" && sharesIn <= BigInt(0))
        throw new Error(`You hold no ${ticker} to sell`);
      if (side === "sell") {
        const payout = (sharesIn * qPrice) / BigInt(1_000_000);
        const poolNow = await persist(() =>
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [MARKET],
          }),
        );
        if (payout > poolNow)
          throw new Error(
            `The market only holds ${formatUnits(poolNow, 6)} ${currency}, less than the ${formatUnits(payout, 6)} this sale pays. Sell a smaller amount${currency === "EURC" ? " or in USDC" : ""}.`,
          );
      }
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
      let settled = false;
      await Promise.race([
        sharesMoved(address as Address, ticker, sharesBefore, () => settled),
        receiptOf(tx, () => settled),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "The price quote expired before this trade confirmed. Check History, then try again.",
                ),
              ),
            Math.max(q.deadline * 1000 - Date.now(), 0) + QUOTE_GRACE_MS,
          ),
        ),
      ]).finally(() => {
        settled = true;
      });
      const px = Number(qPrice) / 1e6;
      setDone({
        text:
          side === "buy"
            ? `Bought ${formatUnits((units * BigInt(1_000_000)) / qPrice, 6)} ${ticker} at ${SIGN[currency]}${px.toFixed(2)}`
            : `Sold ${formatUnits(sharesIn, 6)} ${ticker} at ${SIGN[currency]}${px.toFixed(2)}`,
        tx,
      });
      refresh();
      recordTrade(address, {
        txHash: tx.toLowerCase(),
        block: 0,
        side,
        symbol: ticker,
        currency,
        total: Number(
          side === "buy" ? units : (sharesIn * qPrice) / BigInt(1_000_000),
        ),
        shares: Number(
          side === "buy" ? (units * BigInt(1_000_000)) / qPrice : sharesIn,
        ),
        price: Number(qPrice),
      });
    } catch (err) {
      setError(failText(err));
    } finally {
      tradeLock.set(false);
      setBusy(null);
      setMintKey((n) => n + 1);
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

      {poolShort && poolBal != null && (
        <p role="alert" className="mt-2 font-jet text-[12px] text-down">
          The market only holds {formatUnits(poolBal, 6)} {currency}, so a sale
          this size cannot pay out.
          {currency === "EURC"
            ? " Sell in USDC instead."
            : " Lower the amount."}
        </p>
      )}
      {stuck && (
        <div className="mt-3 rounded-2xl bg-surface px-3.5 py-2.5 text-[13px]">
          <p className="text-muted">
            An earlier Gateway transfer of{" "}
            {formatUnits(BigInt(stuck.amount), 6)} USDC was signed but not
            minted. Your funds are safe and can be minted now.
          </p>
          <Button
            size="sm"
            className="mt-2"
            variant="secondary"
            onClick={finishMint}
            disabled={!!busy}
          >
            Finish transfer
          </Button>
        </div>
      )}
      {funding === null && sources && (
        <p role="alert" className="mt-2 font-jet text-[12px] text-down">
          {noFundingReason(sources)}.
        </p>
      )}
      {sources?.failed && buyingUsdc && (
        <p className="mt-2 font-jet text-[12px] text-subtle">
          Some balances could not be read.{" "}
          <button className="underline" onClick={refreshSources}>
            Retry
          </button>
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
          poolShort ||
          (buyingUsdc && !sources)
        }
      >
        {!address
          ? "Connect a wallet to trade"
          : funding === null
            ? "Not enough USDC on Arc"
            : side === "buy"
              ? `Buy ${SIGN[currency]}${amount || 0} of ${ticker}`
              : `Sell ${SIGN[currency]}${amount || 0} of ${ticker}`}
      </Button>
    </Modal>
  );
}
