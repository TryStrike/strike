"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle,
  Circle,
  CircleNotch,
  MinusCircle,
  XCircle,
} from "@phosphor-icons/react";
import { cx } from "@/components/ui/kit";
import { formatPrice } from "@/components/history/historyFormat";
import { useAgentFeed, type Activity } from "@/lib/agent/agentFeed";

const CHECK_EVERY_MS = 5_000;
/** `agent::signal` in the Rust core. It has no reading, and it isn't a fault. */
const MARKET_FLAT = "Market is flat";

/** `no` is a check that did not clear, which is routine. `bad` is a real fault. */
type State = "ok" | "no" | "bad" | "active" | "idle";

const ICON = {
  ok: <CheckCircle size={13} weight="fill" className="text-up" />,
  no: <MinusCircle size={13} weight="fill" className="text-faint" />,
  bad: <XCircle size={13} weight="fill" className="text-down" />,
  active: (
    <CircleNotch size={13} weight="bold" className="animate-spin text-ink" />
  ),
  idle: <Circle size={13} className="text-faint" />,
};

function aiStep({ signal, ai }: Activity): [State, string] {
  if (signal?.skip) {
    const moved = (signal.rangeShare ?? 0) >= signal.needed;
    return ["idle", moved ? signal.skip : "not needed"];
  }
  if (!ai) return ["idle", ""];
  if (ai.status === "running") return ["active", "reviewing"];
  if (ai.status === "off") return ["ok", "off, the rule decides"];
  if (ai.status === "failed") return ["bad", ai.why ?? "failed"];
  const score = Math.round((ai.score ?? 0) * 100);
  const needed = Math.round((ai.needed ?? 0) * 100);
  return [
    ai.status === "pass" ? "ok" : "no",
    `scored ${score}, needs ${needed}, ${ai.ms}ms`,
  ];
}

function rowsOf(activity: Activity, waiting: boolean) {
  const { signal, ai, result } = activity;
  if (!signal) return [];
  const { price, movePct, rangeShare, needed, skip } = signal;
  const measured = price !== null && movePct !== null && rangeShare !== null;
  const cleared = !skip;
  const passed = ai?.status === "pass" || ai?.status === "off";
  const placement: [State, string] =
    result?.outcome === "placed"
      ? ["ok", "placed"]
      : result?.outcome === "proposed"
        ? waiting
          ? ["active", "waiting for your tap"]
          : ["idle", "answered"]
        : result?.outcome === "refused"
          ? ["bad", "refused, see the feed"]
          : ["idle", ""];
  const rows: { label: string; value: string; state: State }[] = [
    {
      label: "Price at check",
      value: price === null ? (skip ?? "") : formatPrice(price),
      state: price !== null ? "ok" : skip === MARKET_FLAT ? "no" : "bad",
    },
    {
      label: "Measured 15s move",
      value: measured ? `${movePct > 0 ? "+" : ""}${movePct.toFixed(3)}%` : "",
      state: measured ? "ok" : "idle",
    },
    {
      label: "Compared to 2 min range",
      value: measured
        ? `${Math.round(rangeShare * 100)}%, needs ${Math.round(needed * 100)}%`
        : "",
      state: !measured ? "idle" : rangeShare >= needed ? "ok" : "no",
    },
    {
      label: "AI review",
      value: aiStep(activity)[1],
      state: aiStep(activity)[0],
    },
    {
      label: "Limits check",
      value:
        cleared && passed
          ? `stake ${signal.stake.toFixed(2)}, room ${signal.room.toFixed(2)}`
          : "",
      state: cleared && passed ? "ok" : "idle",
    },
    { label: "Place bet", value: placement[1], state: placement[0] },
  ];
  return rows;
}

/** The real steps of the check running now, as the server reports them. */
export function LiveActivity() {
  const activity = useAgentFeed((s) => s.activity);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const waiting = useAgentFeed((s) =>
    s.decisions.some((d) => d.verdict === "awaiting"),
  );
  const rows = rowsOf(activity, waiting);
  const at = activity.signal?.at;
  const next = at ? Math.ceil((at + CHECK_EVERY_MS - now) / 1000) : 0;
  return (
    <section className="rounded-2xl bg-surface px-3 py-2">
      <p className="mb-1 flex justify-between font-jet text-[10px] uppercase text-faint">
        <span>Live activity</span>
        <span className="tabular-nums">
          {at && next > 0 ? `next check in ${next}s` : "checking"}
        </span>
      </p>
      {rows.length === 0 && (
        <p className="text-xs text-muted">Waiting for the first check</p>
      )}
      <ol className="space-y-1">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-1.5 text-xs">
            {ICON[row.state]}
            <span
              className={cx(
                row.state === "idle" || row.state === "no"
                  ? "text-faint"
                  : "text-ink",
              )}
            >
              {row.label}
            </span>
            <span className="ml-auto truncate pl-2 font-jet text-[11px] tabular-nums text-muted">
              {row.value}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
