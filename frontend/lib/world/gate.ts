import { create } from "zustand";
import { ensureBalanceSession } from "@/lib/balance/balanceClientHeaders";
import { needsSession, readApiError, type StepUp } from "@/lib/api/errors";

interface Gate {
  human: { tier?: "orb"; done: (ok: boolean) => void } | null;
  stepup: { stepup: StepUp; done: (s: StepUp) => void } | null;
}

export const useGate = create<Gate>(() => ({ human: null, stepup: null }));

export function requireHuman(tier?: "orb"): Promise<boolean> {
  useGate.getState().human?.done(false);
  return new Promise((resolve) =>
    useGate.setState({
      human: {
        tier,
        done: (ok) => {
          useGate.setState({ human: null });
          resolve(ok);
        },
      },
    }),
  );
}

export function approveStepUp(stepup: StepUp): Promise<StepUp> {
  const open = useGate.getState().stepup;
  open?.done({ ...open.stepup, status: "cancelled" });
  return new Promise((resolve) =>
    useGate.setState({
      stepup: {
        stepup,
        done: (s) => {
          useGate.setState({ stepup: null });
          resolve(s);
        },
      },
    }),
  );
}

export async function sendGuarded(
  send: (stepupId?: string) => Promise<Response>,
  { session = true }: { session?: boolean } = {},
): Promise<Response> {
  let stepupId: string | undefined;
  let resigned = !session;
  let verified = false;
  let stepped = false;
  let res = await send();
  for (;;) {
    if (res.ok) return res;
    const err = await readApiError(res.clone());
    if (needsSession(err) && !resigned) {
      resigned = true;
      await ensureBalanceSession();
    } else if ((err.code === "human_required" || err.code === "human_tier_too_low") && !verified) {
      verified = true;
      if (!(await requireHuman(err.code === "human_tier_too_low" ? "orb" : undefined))) return res;
    } else if (err.code === "step_up_required" && err.stepup && !stepped) {
      stepped = true;
      const done = await approveStepUp(err.stepup);
      if (done.status !== "approved") {
        return new Response(
          JSON.stringify({
            code: `stepup_${done.status}`,
            error: `Approval ${done.status}. Nothing happened, no money moved.`,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      stepupId = done.id;
    } else {
      return res;
    }
    res = await send(stepupId);
  }
}
