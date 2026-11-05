'use client';

import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Copy, ShareNetwork } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { useToast } from '@/lib/hooks/useToast';
import { openReferralShareOnX, referralLandingUrl } from '@/lib/referral/shareOnX';
import { shortenAddress, formatJoinedDate } from '@/lib/referral/address';
import { Badge, Button, Label } from '@/components/ui/kit';

export default function ReferralPage() {
  const {
    address,
    isConnected,
    referralCode,
    referralCount,
    referralLeaderboard,
    referralFriends,
    referralTotals,
    referralLoadError,
    fetchReferralLeaderboard,
    fetchReferralInfo,
    fetchReferralFriends,
    setConnectModalOpen,
  } = useStore(
    useShallow((s) => ({
      address: s.address,
      isConnected: s.isConnected,
      referralCode: s.referralCode,
      referralCount: s.referralCount,
      referralLeaderboard: s.referralLeaderboard,
      referralFriends: s.referralFriends,
      referralTotals: s.referralTotals,
      referralLoadError: s.referralLoadError,
      fetchReferralLeaderboard: s.fetchReferralLeaderboard,
      fetchReferralInfo: s.fetchReferralInfo,
      fetchReferralFriends: s.fetchReferralFriends,
      setConnectModalOpen: s.setConnectModalOpen,
    }))
  );
  const toast = useToast();

  useEffect(() => {
    void fetchReferralLeaderboard();
  }, [fetchReferralLeaderboard]);

  useEffect(() => {
    if (!isConnected || !address) return;
    void fetchReferralInfo(address);
    void fetchReferralFriends(address);
  }, [isConnected, address, fetchReferralInfo, fetchReferralFriends]);

  const link = useMemo(() => (referralCode ? referralLandingUrl(referralCode) : ''), [referralCode]);
  const joined = referralTotals?.joined ?? referralCount ?? 0;
  const qualified = referralTotals?.qualified ?? 0;

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <main className="mx-auto max-w-[1000px] space-y-6 px-5 pb-16 pt-8 sm:px-8">
        <header>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">Referrals</h1>
          <p className="mt-1 text-sm text-muted">Earn 10% of the fees on every real-money round your friends play.</p>
        </header>

        {!isConnected ? (
          <section className="flex items-center justify-between gap-4 rounded-3xl bg-surface px-5 py-4">
            <p className="text-sm text-muted">Connect to get your referral link.</p>
            <Button size="sm" onClick={() => setConnectModalOpen(true)}>
              Connect
            </Button>
          </section>
        ) : (
          <section className="rounded-3xl p-5 ring-1 ring-ink/[0.06]">
            <Label>Your link</Label>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-jet text-2xl font-semibold tracking-widest">{referralCode || '...'}</span>
              <span className="min-w-0 flex-1 truncate font-jet text-sm text-subtle">{link}</span>
              <Button variant="secondary" size="sm" disabled={!link} onClick={() => void copy(link, 'Link')}>
                <Copy size={14} /> Copy
              </Button>
              <Button size="sm" disabled={!link} onClick={() => openReferralShareOnX(link)}>
                <ShareNetwork size={14} /> Share on X
              </Button>
            </div>
          </section>
        )}

        <section className="grid grid-cols-3 gap-3">
          <Stat label="Joined" value={String(joined)} />
          <Stat label="Qualified" value={String(qualified)} hint="placed a real bet" />
          <Stat label="Commission" value="10%" hint="of fees" />
        </section>

        {referralLoadError && (
          <p role="status" className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
            {referralLoadError}
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-3xl p-5 ring-1 ring-ink/[0.06]">
            <Label>Your friends</Label>
            {referralFriends.length === 0 ? (
              <p className="py-6 text-center text-sm text-faint">
                {isConnected ? 'Nobody has joined with your code yet.' : 'Connect to see who joined.'}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {referralFriends.map((f) => (
                  <li key={f.address} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="font-jet text-sm">{shortenAddress(f.address)}</span>
                    <span className="flex items-center gap-2 text-xs text-faint">
                      {formatJoinedDate(f.joinedAt)}
                      {f.status === 'qualified' ? <Badge tone="up">{f.realBets} bets</Badge> : <Badge>pending</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-3xl p-5 ring-1 ring-ink/[0.06]">
            <Label>Top referrers</Label>
            {referralLeaderboard.length === 0 ? (
              <p className="py-6 text-center text-sm text-faint">No referrals yet.</p>
            ) : (
              <ol className="divide-y divide-line">
                {referralLeaderboard.slice(0, 5).map((e, i) => (
                  <li key={`${e.user_address}-${i}`} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex items-center gap-3 font-jet text-sm">
                      <span className="w-4 text-faint">{i + 1}</span>
                      {e.user_address}
                    </span>
                    <span className="font-jet text-sm font-semibold">{e.referral_count}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-3xl bg-surface px-5 py-4">
      <p className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className="mt-1 font-jet text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-faint">{hint}</p>}
    </div>
  );
}
