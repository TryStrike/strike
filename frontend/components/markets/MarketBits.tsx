"use client";

import { useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react";
import { cx } from "@/components/ui/kit";
import { bps, usd, type Asset, type Markets } from "@/lib/markets/marketData";

const SESSION_LABEL = {
  pre: "Pre-market",
  open: "Market open",
  post: "After hours",
  closed: "Market closed",
} as const;

export function SessionPill({ session }: { session: Markets["session"] }) {
  const live = session === "open";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
        live ? "bg-up-soft text-up" : "bg-surface text-muted ring-1 ring-line",
      )}
    >
      <span
        className={cx("h-1.5 w-1.5 rounded-full", live ? "bg-up" : "bg-faint")}
      />
      {SESSION_LABEL[session]}
      {!live && <span className="text-faint">· wrappers still trade</span>}
    </span>
  );
}

export function VenueTable({ asset }: { asset: Asset }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {asset.venues.map((v) => (
        <div
          key={v.symbol}
          className={cx(
            "rounded-2xl bg-white px-4 py-3 ring-1",
            v.issuer === asset.best ? "ring-up/40" : "ring-line",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">{v.symbol}</span>
            {v.issuer === asset.best && (
              <span className="rounded-full bg-up-soft px-2 py-0.5 text-[10px] font-semibold text-up">
                Best
              </span>
            )}
          </div>
          <div className="text-xs text-subtle">{v.issuer} · BNB Chain</div>
          {v.price != null ? (
            <>
              <div className="mt-2 font-jet text-[15px] font-medium tabular-nums">
                {usd(v.price)}
              </div>
              <div className="text-xs text-subtle">
                {bps(v.premiumBps)} vs stock
                {v.route.length > 0 && ` · via ${v.route.join(", ")}`}
              </div>
            </>
          ) : (
            <div className="mt-2 text-xs text-down">
              {v.error ?? "No quote"}
            </div>
          )}
          <a
            href={`https://bscscan.com/token/${v.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-ink"
          >
            Token contract <ArrowUpRight size={11} aria-hidden="true" />
          </a>
        </div>
      ))}
    </div>
  );
}

export function StockLogo({
  ticker,
  small,
}: {
  ticker: string;
  small?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const size = small ? "h-7 w-7" : "h-8 w-8";
  if (broken) {
    return (
      <span
        className={cx(
          size,
          "flex shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-muted",
        )}
      >
        {ticker[0]}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/logos/stock-${ticker}-logo.png`}
      alt=""
      ref={(img) => {
        if (img?.complete && !img.naturalWidth) setBroken(true);
      }}
      onError={() => setBroken(true)}
      className={cx(size, "shrink-0 rounded-full bg-surface object-cover")}
    />
  );
}
