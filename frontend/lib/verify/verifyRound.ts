import type { Hex } from 'viem';
import { arkiv, entityUrl, flatten, type RawEntity } from '@/lib/arkiv';
import { signedByWallet } from '@/lib/arkivBets';
import { arcPublicClient } from '@/lib/arc/client';
import { explorerAddressUrl, explorerTxUrl, getArcConfig } from '@/lib/arc/config';
import { roundLeaf, type RoundFields } from '@/lib/proofs/leaf';

const OPERATOR = process.env.NEXT_PUBLIC_ARKIV_OPERATOR?.trim().toLowerCase() ?? '';
export const SWARM_GATEWAY = (process.env.NEXT_PUBLIC_SWARM_GATEWAY?.trim() || 'https://api-strike.fastship.studio/swarm').replace(/\/+$/, '');
const BET_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const EPOCH_MS = 600_000;
const COMMIT_AFTER_START_MS = 11 * 60_000;

/** Mirrors `proofs::epoch_of` in the Rust backend: end time in microseconds, 10 minute epochs. */
export const epochOf = (endTimeUs: number) => Math.floor(Math.floor(endTimeUs / 1_000) / EPOCH_MS);

const ABI = [
  { type: 'function', name: 'roundRoots', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'verifyRound',
    stateMutability: 'view',
    inputs: [{ name: 'epoch', type: 'uint256' }, { name: 'leaf', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export type StepId = 'round' | 'bet' | 'epoch' | 'swarm' | 'leaf' | 'arc';
/** skip = nothing to check (not a failure), wait = not committed yet. */
export type StepStatus = 'pending' | 'pass' | 'fail' | 'skip' | 'wait';
export interface Link {
  label: string;
  href: string;
}
export interface Step {
  id: StepId;
  title: string;
  status: StepStatus;
  detail?: string;
  links?: Link[];
}
export interface RoundSummary {
  asset: string;
  direction: string;
  stake: string;
  currency: string;
  strike: string;
  endPrice: string;
  outcome: string;
  payout: string;
  settledAt: number;
  operator: boolean;
}
export interface Report {
  steps: Step[];
  round: RoundSummary | null;
  verdict: { kind: 'running' | 'ok' | 'fail' | 'wait'; text: string };
}

const TITLES: Record<StepId, string> = {
  round: 'Round sealed on Arkiv',
  bet: "Player's own bet",
  epoch: 'Batch on Arkiv',
  swarm: 'Proof file on Swarm',
  leaf: 'Round matches its leaf',
  arc: 'Checked by Arc',
};
const ORDER = Object.keys(TITLES) as StepId[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(1_000 * i);
    }
  }
}

async function query(q: string, limit = 5): Promise<Record<string, string>[]> {
  const res = await retry(() =>
    arkiv<{ data: RawEntity[] }>('arkiv_query', [
      q,
      { select: { key: true, creator: true, attributes: true }, limit: `0x${limit.toString(16)}` },
    ]),
  );
  return res.data.map((r) => flatten(r) as unknown as Record<string, string>);
}

class Stop extends Error {}

/**
 * Checks one round end to end from the browser: Arkiv, Swarm and Arc are read directly,
 * no Strike server is called. `onUpdate` gets a fresh report after every change.
 */
export async function verifyBet(betId: string, onUpdate: (r: Report) => void): Promise<Report> {
  const report: Report = {
    steps: ORDER.map((id) => ({ id, title: TITLES[id], status: 'pending' })),
    round: null,
    verdict: { kind: 'running', text: 'Checking…' },
  };
  const emit = () => onUpdate({ ...report, steps: report.steps.map((s) => ({ ...s })) });
  const set = (id: StepId, status: StepStatus, detail?: string, links?: Link[]) => {
    Object.assign(report.steps.find((s) => s.id === id)!, { status, detail, links });
    emit();
  };
  const end = (kind: Report['verdict']['kind'], text: string) => {
    report.verdict = { kind, text };
    emit();
    return report;
  };
  // a step that cannot pass stops the run; the later rows stay pending-less ("skip")
  const halt = (id: StepId, status: 'fail' | 'wait', detail: string, links?: Link[]): never => {
    set(id, status, detail, links);
    for (const s of report.steps) if (s.status === 'pending') s.status = 'skip';
    throw new Stop(detail);
  };

  try {
    if (!OPERATOR) halt('round', 'fail', 'This site has no Strike operator address set (NEXT_PUBLIC_ARKIV_OPERATOR).');
    if (!BET_ID.test(betId)) halt('round', 'fail', 'That is not a bet id. It looks like bet_1793957410432_4d7014a2300f.');
    emit();

    // 1. the sealed round
    let round: Record<string, string>;
    try {
      const rows = await query(`arkiv.schema = str('strike.rounds') AND $creator = addr(${OPERATOR}) AND betId = str('${betId}')`);
      if (!rows.length) {
        halt('round', 'fail', 'No sealed round with this id on Arkiv. Check the id, or the round may not have settled yet.');
      }
      round = rows[0];
    } catch (err) {
      if (err instanceof Stop) throw err;
      return halt('round', 'fail', `Could not reach Arkiv: ${(err as Error).message}`);
    }
    const settledAt = Number(round.settledAt);
    report.round = {
      asset: round.asset,
      direction: round.direction,
      stake: round.stake,
      currency: round.currency,
      strike: round.strikePrice,
      endPrice: round.endPrice,
      outcome: round.outcome,
      payout: round.payout,
      settledAt,
      operator: round.creator?.toLowerCase() === OPERATOR,
    };
    set(
      'round',
      report.round.operator ? 'pass' : 'fail',
      report.round.operator ? 'Written by the Strike operator.' : 'This entity was NOT written by the Strike operator.',
      [{ label: 'Arkiv entity', href: entityUrl(round.key) }],
    );
    if (!report.round.operator) throw new Stop('not operator');

    // 2. the player's own bet (optional)
    let endTimeMs: number | null = null;
    try {
      const bets = await query(`arkiv.schema = str('strike.bets') AND betId = str('${betId}')`);
      const bet = bets.find((b) => b.wallet?.toLowerCase() === round.wallet?.toLowerCase()) ?? null;
      if (!bet) {
        set('bet', 'skip', 'No bet written by the player. They did not turn on browser keys for this round.');
      } else {
        endTimeMs = Number(bet.endTime) || null;
        const signed = await signedByWallet(bet);
        const early = !endTimeMs || Number(bet.placedAt) <= endTimeMs;
        const same = bet.direction === round.direction && Math.abs(Number(bet.stake) - Number(round.stake)) < 1e-9;
        const ok = signed && early && same;
        set(
          'bet',
          ok ? 'pass' : 'fail',
          ok
            ? 'The wallet signed the browser key, the key wrote this bet before the round ended, and direction and stake match the sealed round.'
            : !signed
              ? 'The wallet did not sign the key that wrote this bet.'
              : !early
                ? 'This bet was written after the round ended.'
                : 'The bet direction or stake differs from the sealed round.',
          [{ label: 'Bet entity', href: entityUrl(bet.key) }],
        );
      }
    } catch (err) {
      set('bet', 'skip', `Could not read the player's bet: ${(err as Error).message}`);
    }

    // 3. the epoch. The sealed round only has settledAt, which can fall just past the end time, so try the epoch before too.
    const candidates = endTimeMs
      ? [epochOf(endTimeMs * 1_000)]
      : [epochOf(settledAt * 1_000), epochOf(settledAt * 1_000) - 1];
    let epoch: Record<string, string> | null = null;
    let n = candidates[0];
    let bundle: { epoch: number; root: string; commit_tx: string; treasury: string; rounds: { round: RoundFields; leaf: Hex; proof: Hex[] }[] } | null = null;
    let entry: { round: RoundFields; leaf: Hex; proof: Hex[] } | undefined;
    for (const c of candidates) {
      let rows: Record<string, string>[];
      try {
        rows = await query(`arkiv.schema = str('strike.epochs') AND $creator = addr(${OPERATOR}) AND epoch = u64(${c})`);
      } catch (err) {
        return halt('epoch', 'fail', `Could not reach Arkiv: ${(err as Error).message}`);
      }
      const e = rows[0];
      if (!e) continue;
      if (!epoch) {
        epoch = e;
        n = c;
      }
      // 4. swarm: find which candidate batch holds this round
      if (!e.swarm) continue;
      try {
        const file = await retry(async () => {
          const res = await fetch(`${SWARM_GATEWAY}/bytes/${e.swarm}`);
          if (!res.ok) throw new Error(`Swarm answered ${res.status}`);
          return res.json();
        });
        const found = file.rounds?.find((r: { round: RoundFields }) => r.round.betId === betId);
        if (found) {
          epoch = e;
          n = c;
          bundle = file;
          entry = found;
          break;
        }
      } catch (err) {
        epoch = e;
        n = c;
        set('epoch', 'pass', `Epoch ${c}, root ${e.root}`, [{ label: 'Epoch entity', href: entityUrl(e.key) }]);
        return halt('swarm', 'fail', `Could not read the proof file: ${(err as Error).message}`, [
          { label: 'Swarm file', href: `${SWARM_GATEWAY}/bytes/${e.swarm}` },
        ]);
      }
    }

    if (!epoch) {
      const commitAt = new Date(n * EPOCH_MS + COMMIT_AFTER_START_MS);
      const when = commitAt.getTime() > Date.now() ? `about ${commitAt.toLocaleTimeString()}` : 'any moment now';
      halt(
        'epoch',
        'wait',
        `Epoch ${n} is not committed yet. The batch commits about 11 minutes after its window starts, so ${when}. Check back then.`,
      );
    }
    const ep = epoch!;
    set('epoch', 'pass', `Epoch ${n}, ${Number(ep.rounds) || "?"} rounds, root ${ep.root}`, [
      { label: 'Epoch entity', href: entityUrl(ep.key) },
      ...(ep.commitTx ? [{ label: 'Commit tx on Arc', href: explorerTxUrl(ep.commitTx) }] : []),
    ]);
    const swarmLink = ep.swarm ? [{ label: 'Swarm file', href: `${SWARM_GATEWAY}/bytes/${ep.swarm}` }] : [];
    if (!bundle || !entry) {
      return halt('swarm', 'fail', ep.swarm ? 'The proof file does not list this round.' : 'The epoch has no Swarm reference.', swarmLink);
    }
    if (bundle.root !== ep.root) halt('swarm', 'fail', 'The root in the Swarm file differs from the root on Arkiv.', swarmLink);
    set('swarm', 'pass', `Found this round among ${bundle.rounds.length}. The file root equals the Arkiv root.`, swarmLink);

    // 5. leaf
    let rebuilt: Hex;
    try {
      rebuilt = roundLeaf(entry.round);
    } catch (err) {
      return halt('leaf', 'fail', `Could not rebuild the leaf: ${(err as Error).message}`);
    }
    const r = entry.round;
    const same =
      rebuilt === entry.leaf &&
      r.asset === round.asset &&
      r.direction === round.direction &&
      r.outcome === round.outcome &&
      r.user.toLowerCase() === round.wallet?.toLowerCase();
    if (!same) {
      halt('leaf', 'fail', rebuilt !== entry.leaf
        ? 'The round fields do not hash to the leaf in the file.'
        : 'The round in the file differs from the one sealed on Arkiv.');
    }
    set('leaf', 'pass', `Rebuilt in your browser: ${rebuilt}`);

    // 6. arc
    const treasury = (getArcConfig().treasuryAddress || bundle.treasury) as Hex;
    const arcLinks = [
      { label: 'Treasury on Arc', href: explorerAddressUrl(treasury) },
      ...(ep.commitTx ? [{ label: 'Commit tx', href: explorerTxUrl(ep.commitTx) }] : []),
    ];
    let onchainRoot: Hex;
    let verified: boolean;
    try {
      const client = arcPublicClient();
      onchainRoot = await retry(() => client.readContract({ address: treasury, abi: ABI, functionName: 'roundRoots', args: [BigInt(n)] }), 4);
      verified = await retry(
        () => client.readContract({ address: treasury, abi: ABI, functionName: 'verifyRound', args: [BigInt(n), rebuilt, entry!.proof] }),
        4,
      );
    } catch (err) {
      return halt('arc', 'fail', `Could not read Arc (its public RPC rate limits, try again in a minute): ${(err as Error).message}`, arcLinks);
    }
    if (onchainRoot !== ep.root) halt('arc', 'fail', `Arc holds a different root for epoch ${n}: ${onchainRoot}`, arcLinks);
    if (!verified) halt('arc', 'fail', 'Arc says this leaf is not in the committed root.', arcLinks);
    set('arc', 'pass', 'roundRoots matches and verifyRound returned true.', arcLinks);

    return end('ok', 'Verified: this round is exactly what was committed on Arc');
  } catch (err) {
    if (!(err instanceof Stop)) return end('fail', `Check failed: ${(err as Error).message}`);
    const bad = report.steps.find((s) => s.status === 'fail');
    const wait = report.steps.find((s) => s.status === 'wait');
    return wait ? end('wait', 'Not committed yet. This round cannot be checked on Arc until its batch lands.') : end('fail', `Not verified: ${bad?.detail ?? err.message}`);
  }
}
