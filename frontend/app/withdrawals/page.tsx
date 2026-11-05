'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { useWalletClient, useAccount } from 'wagmi';
import { useWallets, type ConnectedWallet } from '@privy-io/react-auth';
import { usePrivyEnabled } from '@/lib/wallet/privy-enabled';
import {
  CheckCircle as CheckCircle2,
  Clock as Clock3,
  ArrowSquareOut as ExternalLink,
  MagnifyingGlass as Search,
  XCircle,
  Copy,
  Check,
  WarningCircle,
  CaretRight as ChevronRight,
  ArrowsClockwise,
} from '@phosphor-icons/react';
import {
  describeWithdrawal,
  explorerLinkForHash,
  hasOpenWithdrawals,
  isChainTxHash,
  type WithdrawalTone,
  type WithdrawalViewModel,
} from '@/lib/withdrawals/status';
import {
  WITHDRAWAL_READ_AUTH_HEADER,
  READ_AUTH_REFRESH_AFTER_MS,
  buildWithdrawalReadAuthMessage,
} from '@/lib/withdrawals/readAuth';
import { formatRemaining, windowMinutes } from '@/lib/withdrawals/expiry';
import { formatUsdc, formatWhen, shortHash } from '@/lib/withdrawals/format';

/**
 * Player withdrawal status timeline.
 *
 * Read-only by construction: every request this page makes is a GET. There is
 * no path here that re-submits a stored intent, so refreshing or retrying can
 * never create (or duplicate) a withdrawal request — a new request is only
 * ever made from /trade with a fresh signature and a fresh `signedAt`.
 *
 * The list is server-paged (limit/offset against the ledger, ordered newest
 * first) and scoped by a wallet-signed read proof, so the API can only ever
 * return this wallet's rows. Statuses are shown exactly as the ledger records
 * them; the only derived state is the documented 10-minute signing window
 * (lib/withdrawals/expiry.ts), which explains WHY an untouched pending row
 * will never move — it never claims anything was paid.
 */

type WithdrawalRow = {
  id: number;
  currency: string;
  amount: number | string;
  fee_amount: number | string;
  net_amount: number | string;
  /** Schema allows pending/accepted/rejected/paid_needs_reconciliation;
   * unknown values fall back to a sane view (lib/withdrawals/status.ts). */
  status: string;
  requested_at: string;
  decided_at?: string | null;
  tx_hash?: string | null;
  fee_tx_hash?: string | null;
  signed_at?: number | string | null;
};

type Paging = { limit: number; offset: number; total: number; hasMore: boolean };

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 20_000;

class ReadAuthNeededError extends Error {
  readonly reason: 'rejected' | 'invalid' | 'no_signer';
  constructor(reason: 'rejected' | 'invalid' | 'no_signer') {
    super(`read_auth_${reason}`);
    this.name = 'ReadAuthNeededError';
    this.reason = reason;
  }
}

function TonePill({ view }: { view: WithdrawalViewModel }) {
  const Attention =
    view.tone === 'danger' || view.intentExpired ? XCircle
    : view.tone === 'success' ? CheckCircle2
    : view.tone === 'attention' || view.tone === 'unknown' ? WarningCircle
    : Clock3;
  const TONE_PILL: Record<WithdrawalTone, string> = {
    waiting: 'bg-down-soft text-down border-down/30',
    info: 'bg-up-soft text-up border-up/30',
    success: 'bg-up-soft text-up border-up/30',
    danger: 'bg-down-soft text-down border-down/30',
    attention: 'bg-down-soft text-down border-down/30',
    unknown: 'bg-surface text-muted border-line',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase font-black tracking-widest border ${TONE_PILL[view.tone]}`}>
      <Attention className="w-3 h-3" /> {view.label}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          /* clipboard unavailable (http, permissions): value is still visible */
        }
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-[10px] font-mono text-muted hover:text-ink hover:bg-surface transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-up" weight="bold" /> : <Copy className="w-3 h-3" />}
      {copied ? 'copied' : shortHash(value)}
    </button>
  );
}

const STEP_DOT: Record<string, string> = {
  done: 'bg-up border-up/30',
  active: 'bg-down border-down/30 animate-pulse',
  upcoming: 'bg-surface border-line',
  failed: 'bg-down border-down/30',
  attention: 'bg-down border-down/30',
};

function Timeline({ view, requestId }: { view: WithdrawalViewModel; requestId: number }) {
  return (
    <div className="space-y-4">
      <ol className="relative space-y-4 pl-6">
        <span className="absolute left-[7px] top-2 bottom-2 w-px bg-surface" aria-hidden />
        {view.steps.map((step) => (
          <li key={step.key} className="relative">
            <span
              aria-hidden
              className={`absolute -left-6 top-1 h-[15px] w-[15px] rounded-full border ${STEP_DOT[step.state] ?? STEP_DOT.upcoming}`}
            />
            <p className={`text-sm font-bold uppercase tracking-wider ${step.state === 'upcoming' ? 'text-faint' : step.state === 'failed' ? 'text-down' : step.state === 'attention' ? 'text-down' : step.state === 'active' ? 'text-down' : 'text-up'}`}>
              {step.label}
            </p>
            {step.detail && <p className="text-xs text-subtle mt-0.5">{step.detail}</p>}
          </li>
        ))}
      </ol>

      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="text-[10px] uppercase tracking-widest text-subtle font-black">What happens now</p>
        <p className="text-sm text-ink mt-1 leading-relaxed">{view.playerMessage}</p>
        {view.intentExpired && (
          <Link
            href="/trade"
            className="mt-3 inline-flex px-4 py-2 rounded-lg bg-ink text-white text-[10px] font-black uppercase tracking-widest"
          >
            Request a new withdrawal
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[10px] uppercase tracking-widest text-subtle font-black">Request</span>
        <CopyButton value={String(requestId)} label="request id" />
      </div>
    </div>
  );
}

function HashLinks({ view }: { view: WithdrawalViewModel }) {
  const netLink = explorerLinkForHash(view.netTxHash);
  const feeLink = explorerLinkForHash(view.feeTxHash);
  if (!view.netTxHash && !view.feeTxHash) {
    return (
      <p className="text-[11px] text-subtle font-mono">
        {view.kind === 'pending'
          ? view.intentExpired
            ? 'No transaction — the signature window elapsed before anyone could approve, so nothing was ever payable.'
            : 'No transaction yet — the treasury pays out only after manual approval.'
          : view.kind === 'rejected'
            ? 'No transaction — the request was not paid.'
            : 'No transaction hash recorded for this request.'}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {view.netTxHash && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-subtle font-black w-16 shrink-0">Payout tx</span>
          <CopyButton value={view.netTxHash} label="payout transaction hash" />
          {netLink && (
            <a
              href={netLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-black uppercase tracking-widest text-up hover:text-up inline-flex items-center gap-1"
            >
              Explorer <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
      {view.feeTxHash && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-subtle font-black w-16 shrink-0">Fee tx</span>
          <CopyButton value={view.feeTxHash} label="fee transaction hash" />
          {feeLink && (
            <a
              href={feeLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-black uppercase tracking-widest text-muted hover:text-ink inline-flex items-center gap-1"
            >
              Explorer <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

type FilterKey = 'all' | 'open' | 'paid' | 'rejected' | 'review' | 'expired';

function bucketOf(v: WithdrawalViewModel): FilterKey {
  if (v.intentExpired) return 'expired';
  if (!v.terminal) return 'open';
  if (v.kind === 'rejected') return 'rejected';
  if (v.kind === 'paid_needs_reconciliation') return 'review';
  if (v.kind === 'accepted' && v.tone === 'success') return 'paid';
  return 'review';
}

function WithdrawalsPageInner({ privyWallets }: { privyWallets: ConnectedWallet[] }) {
  const address = useStore((s) => s.address);
  const isConnected = useStore((s) => s.isConnected);

  const { data: walletClient } = useWalletClient();
  const { connector } = useAccount();

  const [rows, setRows] = useState<WithdrawalRow[]>([]);
  const [paging, setPaging] = useState<Paging | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authIssue, setAuthIssue] = useState<'rejected' | 'invalid' | 'no_signer' | null>(null);
  const [signingInProgress, setSigningInProgress] = useState(false);
  const [statusFilter, setStatusFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Cached read proof: signing prompts the wallet, so it is signed once per
  // ~9 minutes and reused across refresh/polling. Cleared on any 401.
  const proofCache = useRef<{ value: string; issuedAt: number; forAddress: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    // Address change ⇒ the old proof is for a different wallet; drop it.
    proofCache.current = null;
  }, [address]);

  const signReadAuth = useCallback(async (force = false): Promise<string> => {
    if (!address) throw new ReadAuthNeededError('no_signer');
    const cached = proofCache.current;
    if (!force && cached && cached.forAddress === address && Date.now() - cached.issuedAt < READ_AUTH_REFRESH_AFTER_MS) {
      return cached.value;
    }

    const issuedAt = Date.now();
    const nonce =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(16).slice(2, 34).padEnd(32, '0');
    const message = buildWithdrawalReadAuthMessage(address, issuedAt, nonce);

    let signature: string;
    setSigningInProgress(true);
    try {
      if (walletClient) {
        signature = await walletClient.signMessage({
          account: address as `0x${string}`,
          message,
        });
      } else if (connector) {
        const provider = await connector.getProvider();
        const { ethers } = await import('ethers');
        const signer = await new ethers.BrowserProvider(provider as never).getSigner();
        signature = await signer.signMessage(message);
      } else {
        const privyWallet =
          privyWallets.find((w) => w.type === 'ethereum' && w.address?.toLowerCase() === address.toLowerCase()) ??
          privyWallets.find((w) => w.type === 'ethereum');
        if (!privyWallet?.sign) throw new ReadAuthNeededError('no_signer');
        signature = await privyWallet.sign(message);
      }
    } catch (e) {
      if (e instanceof ReadAuthNeededError) throw e;
      // User rejected the signature request — surface a deliberate retry path.
      throw new ReadAuthNeededError('rejected');
    } finally {
      setSigningInProgress(false);
    }

    const value = JSON.stringify({ address, issuedAt, nonce, signature });
    proofCache.current = { value, issuedAt, forAddress: address };
    return value;
  }, [address, walletClient, connector, privyWallets]);

  const load = useCallback(
    async (mode: 'refresh' | 'more') => {
      if (!address || inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      const offset = mode === 'more' ? rows.length : 0;
      const limit = mode === 'more' ? PAGE_SIZE : Math.max(PAGE_SIZE, rows.length);

      const request = async (forceResign: boolean): Promise<{ res: Response; body: any }> => {
        const proof = await signReadAuth(forceResign);
        const res = await fetch(`/api/withdrawals?limit=${limit}&offset=${offset}`, {
          method: 'GET',
          headers: { [WITHDRAWAL_READ_AUTH_HEADER]: proof },
          cache: 'no-store',
        });
        const body = await res.json().catch(() => null);
        return { res, body };
      };

      try {
        let { res, body } = await request(false);

        // A lapsed/malformed cached proof: re-sign once silently and replay
        // the same read-only GET. An invalid signature is not retryable by
        // re-reading — it needs the deliberate Authorize flow below.
        if (res.status === 401 && body?.code && body.code !== 'read_auth_invalid_signature') {
          ({ res, body } = await request(true));
        }

        if (res.status === 401) {
          proofCache.current = null;
          setAuthIssue(body?.code === 'read_auth_invalid_signature' ? 'invalid' : 'rejected');
          setLoadError(null);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const incoming: WithdrawalRow[] = Array.isArray(body?.withdrawals) ? body.withdrawals : [];
        const pg: Paging = {
          limit: Number(body?.paging?.limit) || PAGE_SIZE,
          offset: Number(body?.paging?.offset) || 0,
          total: Number(body?.paging?.total) || incoming.length,
          hasMore: Boolean(body?.paging?.hasMore),
        };
        setPaging(pg);
        setRows((prev) => {
          if (mode !== 'more') return incoming;
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...incoming.filter((r) => !seen.has(r.id))];
        });
        setLoadError(null);
        setAuthIssue(null);
      } catch (e) {
        if (e instanceof ReadAuthNeededError) {
          proofCache.current = null;
          setAuthIssue(e.reason);
        } else {
          setLoadError('Could not refresh your withdrawal list. Try the Refresh button — reloading this list never creates a new request.');
        }
      } finally {
        inFlight.current = false;
        setRefreshing(false);
        setFirstLoad(false);
      }
    },
    [address, rows.length, signReadAuth]
  );

  const loadMore = useCallback(() => {
    void load('more');
  }, [load]);

  useEffect(() => {
    if (isConnected && address) void load('refresh');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected]);

  // Poll only while at least one request can still move. Terminal rows
  // (paid, rejected, needs-reconciliation, expired signatures) stop the timer;
  // the Refresh button stays available regardless.
  const pollingActive = hasOpenWithdrawals(rows);
  useEffect(() => {
    if (!address || !pollingActive) return;
    const int = setInterval(() => void load('refresh'), POLL_INTERVAL_MS);
    return () => clearInterval(int);
  }, [address, pollingActive, load]);

  // Deep link from the receipt drawer: /withdrawals?request=<id> expands that row.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('request');
    const id = Number(raw);
    if (Number.isFinite(id)) setExpandedId(id);
  }, []);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('request');
    const id = Number(raw);
    if (Number.isFinite(id) && rows.some((r) => r.id === id)) setExpandedId(id);
  }, [rows]);

  const counts = useMemo(() => {
    const acc: Record<FilterKey, number> = { all: rows.length, open: 0, paid: 0, rejected: 0, review: 0, expired: 0 };
    for (const r of rows) acc[bucketOf(describeWithdrawal(r))] += 1;
    return acc;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => (statusFilter === 'all' ? true : bucketOf(describeWithdrawal(r)) === statusFilter))
      .filter((r) => {
        if (!q) return true;
        const tx = String(r.tx_hash || '').toLowerCase();
        const feeTx = String(r.fee_tx_hash || '').toLowerCase();
        const cur = String(r.currency || '').toLowerCase();
        return tx.includes(q) || feeTx.includes(q) || cur.includes(q) || String(r.id).includes(q);
      })
      .sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
  }, [rows, statusFilter, query]);

  if (!isConnected || !address) {
    return (
      <main className="min-h-screen bg-white text-ink flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-black uppercase tracking-widest">Withdrawals</h1>
          <p className="text-subtle text-sm">Connect your wallet to track withdrawal requests.</p>
          <Link href="/trade" className="inline-flex px-4 py-2 rounded-lg bg-ink text-white font-bold text-xs uppercase tracking-wider">
            Go to trade
          </Link>
        </div>
      </main>
    );
  }

  const filterTabs: Array<{ key: FilterKey; label: string; activeClass: string }> = [
    { key: 'all', label: 'All', activeClass: 'bg-ink text-white' },
    { key: 'open', label: 'In progress', activeClass: 'bg-down text-white' },
    { key: 'paid', label: 'Paid', activeClass: 'bg-up text-white' },
    { key: 'rejected', label: 'Rejected', activeClass: 'bg-down text-white' },
    { key: 'review', label: 'Needs review', activeClass: 'bg-down text-white' },
    { key: 'expired', label: 'Expired', activeClass: 'bg-down text-white' },
  ];

  const acceptWindowCopy = `${windowMinutes()}-minute signing window`;

  return (
    <main className="min-h-screen bg-white text-ink px-6 py-12">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-black tracking-tight uppercase">Withdrawal Status</h1>
            <p className="text-subtle text-sm mt-2">
              Every request follows one path: signed intent → manual review → treasury payout on Arc.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load('refresh')}
              disabled={refreshing}
              className="px-4 py-2 text-xs font-black uppercase tracking-widest rounded-lg border border-line bg-surface hover:bg-surface disabled:opacity-50 inline-flex items-center gap-2"
            >
              <ArrowsClockwise className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <Link
              href="/trade"
              className="px-4 py-2 text-xs font-black uppercase tracking-widest rounded-lg border border-line bg-ink text-white"
            >
              Back to trade
            </Link>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 text-xs text-muted leading-relaxed">
          <p>
            <span className="text-muted font-bold uppercase tracking-widest text-[10px]">How long things stay payable. </span>
            Your signature is only acceptable for a {acceptWindowCopy}: an operator must approve the request within{' '}
            {windowMinutes()} minutes of you signing, or the intent expires and nothing moves — your balance is
            untouched and you can request again from the trade screen. Review itself is manual with no fixed queue
            timer; a payout is shown here only once the ledger actually records it. Amounts below are exact USDC
            (6 decimals) after your platform tier fee at request time.
          </p>
        </div>

        {authIssue && (
          <div role="alert" className="rounded-xl border border-up/30 bg-up-soft px-4 py-3 text-sm text-up flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1">
              <p className="font-bold uppercase text-[11px] tracking-widest text-up">Read authorization needed</p>
              <p className="mt-1">
                {authIssue === 'no_signer'
                  ? 'No signer is available for the connected wallet. Reconnect via MetaMask/WalletConnect or log in with Privy, then authorize.'
                  : authIssue === 'invalid'
                    ? 'The read authorization was rejected by the server. Please authorize again with your wallet.'
                    : 'You declined (or the list authorization lapsed). Viewing your withdrawal statuses requires a one-time wallet signature — it only authorizes reading YOUR OWN request history and cannot move funds.'}
              </p>
            </div>
            <button
              onClick={async () => {
                setAuthIssue(null);
                proofCache.current = null;
                await load('refresh');
              }}
              disabled={signingInProgress}
              className="px-4 py-2 rounded-lg bg-up text-white text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              {signingInProgress ? 'Waiting for signature…' : 'Authorize'}
            </button>
          </div>
        )}
        {loadError && (
          <p role="alert" className="rounded-xl border border-down/30 bg-down-soft px-4 py-3 text-sm text-down">
            {loadError}
          </p>
        )}
        {pollingActive && !authIssue && (
          <p className="text-xs text-subtle flex items-center gap-2">
            <Clock3 className="w-3.5 h-3.5 text-down" />
            Live — you have requests still in progress. This list refreshes while they can change.
          </p>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(
            [
              { key: 'open' as const, label: 'In progress', cls: 'border-down/30 bg-down-soft text-down' },
              { key: 'paid' as const, label: 'Paid', cls: 'border-up/30 bg-up-soft text-up' },
              { key: 'rejected' as const, label: 'Rejected', cls: 'border-down/30 bg-down-soft text-down' },
              { key: 'review' as const, label: 'Needs review', cls: 'border-down/30 bg-down-soft text-down' },
              { key: 'expired' as const, label: 'Expired', cls: 'border-down/30 bg-down-soft text-down' },
            ]
          ).map((c) => (
            <button
              key={c.key}
              onClick={() => setStatusFilter(statusFilter === c.key ? 'all' : c.key)}
              className={`rounded-xl border p-4 text-left transition-colors ${c.cls} hover:brightness-110`}
            >
              <p className="text-xs uppercase">{c.label}</p>
              <p className="text-2xl font-black text-ink">{counts[c.key]}</p>
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-line bg-ink/40 overflow-hidden">
          <div className="p-4 border-b border-line bg-surface flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
            <div className="inline-flex rounded-xl border border-line bg-ink/40 p-1 w-full md:w-auto flex-wrap">
              {filterTabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setStatusFilter(t.key)}
                  className={`flex-1 md:flex-none px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-colors ${
                    statusFilter === t.key ? t.activeClass : 'text-muted hover:text-ink'
                  }`}
                >
                  {t.label} ({counts[t.key]})
                </button>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-3 w-full md:flex-1">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search request id / tx hash / asset…"
                  className="w-full bg-ink/40 border border-line rounded-xl pl-10 pr-3 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-line"
                />
              </div>
            </div>
          </div>

          <div className="p-4 space-y-3">
            {firstLoad && !authIssue ? (
              <div className="rounded-xl border border-line bg-surface p-4">
                <p className="text-subtle text-sm animate-pulse">
                  {signingInProgress ? 'Waiting for your wallet signature…' : 'Loading withdrawals…'}
                </p>
              </div>
            ) : authIssue && rows.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface p-6 text-center">
                <p className="text-muted font-bold">History locked until you authorize</p>
                <p className="text-subtle text-sm mt-1">
                  Use the Authorize button above — one wallet signature unlocks read access to your own requests.
                </p>
              </div>
            ) : rows.length === 0 && !loadError ? (
              <div className="rounded-xl border border-line bg-surface p-6 text-center">
                <p className="text-muted font-bold">No withdrawal requests yet</p>
                <p className="text-subtle text-sm mt-1">
                  Requests you submit from the trade screen appear here with their live status.
                </p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface p-6 text-center">
                <p className="text-muted font-bold">No matching withdrawals</p>
                <p className="text-subtle text-sm mt-1">Try clearing filters or search.</p>
                <button
                  onClick={() => {
                    setStatusFilter('all');
                    setQuery('');
                  }}
                  className="mt-4 inline-flex px-4 py-2 rounded-lg bg-ink text-white text-xs font-black uppercase tracking-widest"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              filtered.map((r) => {
                const view = describeWithdrawal(r);
                const expanded = expandedId === r.id;
                return (
                  <div key={r.id} className="rounded-xl border border-line bg-ink/30 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      aria-expanded={expanded}
                      className="w-full p-4 flex items-center gap-3 text-left hover:bg-surface transition-colors"
                    >
                      <ChevronRight className={`w-4 h-4 shrink-0 text-subtle transition-transform ${expanded ? 'rotate-90' : ''}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-sm font-mono text-ink">
                            {formatUsdc(r.amount)} {String(r.currency).toUpperCase()}
                          </span>
                          <span className="text-[11px] text-subtle font-mono">#{r.id}</span>
                        </div>
                        <p className="text-[11px] text-subtle font-mono mt-0.5">
                          Requested {formatWhen(r.requested_at)}
                          {r.decided_at ? ` · decided ${formatWhen(r.decided_at)}` : ''}
                        </p>
                        {view.kind === 'pending' && !view.intentExpired && view.intentRemainingMs != null && (
                          <p className="text-[11px] text-down font-mono mt-0.5">
                            Signature payable for another {formatRemaining(view.intentRemainingMs)}
                          </p>
                        )}
                      </div>
                      <span className="hidden sm:block text-[11px] font-mono text-up">
                        net {formatUsdc(r.net_amount)}
                      </span>
                      {isChainTxHash(r.tx_hash) && (
                        <span className="hidden md:block text-[11px] font-mono text-up">
                          {shortHash(String(r.tx_hash))}
                        </span>
                      )}
                      <TonePill view={view} />
                    </button>

                    {expanded && (
                      <div className="px-4 pb-5 pt-1 md:grid md:grid-cols-2 md:gap-6 border-t border-line">
                        <Timeline view={view} requestId={r.id} />
                        <div className="space-y-4 mt-4 md:mt-0">
                          <div className="grid grid-cols-3 gap-2">
                            <div className="rounded-lg border border-line bg-surface p-2">
                              <p className="text-[10px] uppercase tracking-widest text-faint">Amount</p>
                              <p className="text-sm font-mono">{formatUsdc(r.amount)}</p>
                            </div>
                            <div className="rounded-lg border border-line bg-surface p-2">
                              <p className="text-[10px] uppercase tracking-widest text-faint">Fee</p>
                              <p className="text-sm font-mono text-down">{formatUsdc(r.fee_amount)}</p>
                            </div>
                            <div className="rounded-lg border border-line bg-surface p-2">
                              <p className="text-[10px] uppercase tracking-widest text-faint">You receive</p>
                              <p className="text-sm font-mono text-up">{formatUsdc(r.net_amount)}</p>
                            </div>
                          </div>
                          <p className="text-[10px] text-subtle leading-relaxed">
                            Fee and net are the platform-tier figures frozen into the ledger when you requested —
                            this is the exact USDC (6 decimals) the treasury pays out.
                          </p>
                          <HashLinks view={view} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {!firstLoad && paging?.hasMore && (
              <button
                onClick={loadMore}
                disabled={refreshing}
                className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-[10px] font-black uppercase tracking-widest text-muted hover:bg-surface disabled:opacity-50"
              >
                {refreshing ? 'Loading…' : `Load ${PAGE_SIZE} more (${Math.max(0, (paging.total ?? 0) - rows.length)} older requests)`}
              </button>
            )}
            {!firstLoad && !paging?.hasMore && rows.length > 0 && (
              <p className="text-center text-[10px] uppercase tracking-widest text-faint py-2">
                End of list — {paging?.total ?? rows.length} requests total
              </p>
            )}
          </div>
        </div>

        <p className="text-[11px] text-faint leading-relaxed max-w-3xl">
          Withdrawals are signed intents: you sign off-chain, an operator reviews the request within{' '}
          {windowMinutes()} minutes, and the STRIKE treasury contract pays USDC on Arc. Review is manual — the code
          has no fixed payout timer, so we never promise one. A transaction hash and explorer link appear only after
          the ledger records a real chain hash. Refreshing this page only re-reads the ledger; it never re-submits
          your signature or creates a duplicate request.
        </p>
      </div>
    </main>
  );
}

function WithdrawalsPageWithPrivy() {
  const { wallets } = useWallets();
  return <WithdrawalsPageInner privyWallets={wallets} />;
}

export default function WithdrawalsPage() {
  const privyEnabled = usePrivyEnabled();
  if (!privyEnabled) {
    return <WithdrawalsPageInner privyWallets={[]} />;
  }
  return <WithdrawalsPageWithPrivy />;
}
