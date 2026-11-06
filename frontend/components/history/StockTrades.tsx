"use client";

import React from "react";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react";
import { Badge, Label } from "@/components/ui/kit";
import { StockLogo } from "@/components/markets/MarketBits";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/arc/config";
import {
  positionsOf,
  useStockTrades,
  type StockTrade as Trade,
} from "@/lib/markets/marketData";

const units = (n: number) => n / 1e6;
const money = (n: number, currency: string) =>
  `${currency === "EURC" ? "€" : "$"}${units(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

/** The full log, for History. */
export function StockTrades({ wallet }: { wallet: string }) {
  const { trades, error } = useStockTrades(wallet);
  const holdings = positionsOf(trades ?? []);
  return (
    <section className="rounded-3xl bg-white/70 p-5 ring-1 ring-ink/[0.06] backdrop-blur-xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Label className="mb-0">Stock trades</Label>
        {holdings.length > 0 && (
          <span className="font-jet text-[12px] text-muted">
            You own {holdings.map((p) => `${p.shares} ${p.symbol}`).join(", ")}
          </span>
        )}
      </div>
      <StockTradesTable trades={trades} error={error} />
      <p className="mt-3 font-jet text-[11px] text-faint">
        Test shares on Arc testnet. Read from the{" "}
        <a
          href={explorerAddressUrl(
            process.env.NEXT_PUBLIC_STOCK_MARKET_ADDRESS?.trim() ?? "",
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          market contract
        </a>
        .
      </p>
    </section>
  );
}

export function StockTradesTable({
  trades,
  error,
}: {
  trades: Trade[] | null;
  error: string | null;
}) {
  return (
    <>
      {error ? (
        <p role="alert" className="py-4 text-sm text-down">
          {error}
        </p>
      ) : trades === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-ink/[0.04]" />
      ) : trades.length === 0 ? (
        <p className="py-4 text-sm text-muted">
          No stock trades yet.{" "}
          <Link href="/markets" className="text-up underline">
            Browse markets
          </Link>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line font-jet text-[11px] uppercase tracking-[0.08em] text-faint">
                <th className="pb-3 pr-3 font-medium">Stock</th>
                <th className="pb-3 pr-3 font-medium">Side</th>
                <th className="pb-3 pr-3 text-right font-medium">Shares</th>
                <th className="pb-3 pr-3 text-right font-medium">Price</th>
                <th className="pb-3 pr-3 text-right font-medium">Total</th>
                <th className="pb-3 pr-3 font-medium">When</th>
                <th className="pb-3 pr-3 font-medium">Block</th>
                <th className="pb-3 font-medium">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr
                  key={`${t.txHash}-${t.side}-${t.block}-${t.symbol}`}
                  className="border-b border-line/70"
                >
                  <td className="py-3 pr-3">
                    <Link
                      href={`/markets/${t.symbol}`}
                      className="flex items-center gap-2.5 font-semibold"
                    >
                      <StockLogo ticker={t.symbol} small />
                      {t.symbol}
                    </Link>
                  </td>
                  <td className="py-3 pr-3">
                    <Badge tone={t.side === "buy" ? "up" : "down"}>
                      {t.side === "buy" ? "Bought" : "Sold"}
                    </Badge>
                  </td>
                  <td className="py-3 pr-3 text-right font-jet tabular-nums">
                    {units(t.shares)}
                  </td>
                  <td className="py-3 pr-3 text-right font-jet tabular-nums">
                    {money(t.price, t.currency)}
                  </td>
                  <td className="py-3 pr-3 text-right font-jet font-medium tabular-nums">
                    {money(t.total, t.currency)} {t.currency}
                  </td>
                  <td className="py-3 pr-3 text-muted">
                    {new Date(t.tradedAt * 1000).toLocaleString()}
                  </td>
                  <td className="py-3 pr-3 font-jet text-muted">
                    {t.block || "Confirming"}
                  </td>
                  <td className="py-3">
                    <a
                      href={explorerTxUrl(t.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-jet text-[12px] text-up"
                    >
                      {t.txHash.slice(0, 8)}…{t.txHash.slice(-4)}
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
