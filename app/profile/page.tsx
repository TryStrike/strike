'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { useShallow } from 'zustand/react/shallow';
import { Check, Copy, ShareNetwork } from '@phosphor-icons/react';
import { useStore, useHouseBalance, useWalletAddress, useIsConnected, useUserTier } from '@/lib/store';
import { useToast } from '@/lib/hooks/useToast';
import { openReferralShareOnX, referralLandingUrl } from '@/lib/referral/shareOnX';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';
import { getFeePercentLabel } from '@/lib/fees/platformFee';
import { identityDisplayState, prepareUsernameWrite, readProfile, type ProfileRead } from '@/lib/profile/identity';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';
import { Button, Label } from '@/components/ui/kit';
import { routeSkeleton } from '@/components/states/RouteFallbacks';
import PerformanceSection from '@/components/profile/PerformanceSection';
import IdentityPanel from '@/components/profile/IdentityPanel';
import BalanceTierPanel from '@/components/profile/BalanceTierPanel';
import LedgerPreview from '@/components/profile/LedgerPreview';

const NEXT_TIER: Record<string, { name: string; at: string } | undefined> = {
  free: { name: 'Standard', at: '$50' },
  standard: { name: 'VIP', at: '$500' },
};

export default function ProfilePage() {
  const isConnected = useIsConnected();
  const { status: walletStatus } = useAccount();
  const address = useWalletAddress();
  const houseBalance = useHouseBalance();
  const userTier = useUserTier();
  const {
    isUpdatingUsername,
    referralCode,
    referralCount,
    accountType,
    demoBalance,
    balanceError,
    balanceLoading,
    fetchBalance,
    fetchReferralInfo,
    updateUsername,
  } = useStore(
    useShallow((s) => ({
      isUpdatingUsername: s.isUpdatingUsername,
      referralCode: s.referralCode,
      referralCount: s.referralCount,
      accountType: s.accountType,
      demoBalance: s.demoBalance,
      balanceError: s.error,
      balanceLoading: s.isLoading,
      fetchBalance: s.fetchBalance,
      fetchReferralInfo: s.fetchReferralInfo,
      updateUsername: s.updateUsername,
    }))
  );

  const identityKey = useMemo(() => (address ? canonicalHouseUserAddress(address) : null), [address]);

  const [profileRead, setProfileRead] = useState<ProfileRead | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    if (!identityKey) return;
    let cancelled = false;
    setProfileLoading(true);
    void readProfile(identityKey).then((read) => {
      if (cancelled) return;
      setProfileRead(read);
      setProfileLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [identityKey]);

  const identityState = identityDisplayState(profileRead, profileLoading);
  const storedUsername = profileRead?.kind === 'found' ? profileRead.username : null;

  const handleSaveUsername = useCallback(
    async (stored: string) => {
      const intent = prepareUsernameWrite(identityKey, stored);
      if (!intent.ok) return { outcome: 'rejected' as const, message: intent.error.message };
      if (accountType === 'demo') {
        return { outcome: 'error' as const, message: 'Practice wallets cannot register a public name.' };
      }
      if (!(await updateUsername(intent.address, intent.stored))) {
        return { outcome: 'rejected' as const, message: 'That name is already claimed.' };
      }
      setProfileRead({ kind: 'found', username: intent.stored });
      return { outcome: 'ok' as const, message: null };
    },
    [accountType, identityKey, updateUsername]
  );

  const [balanceLoadedFor, setBalanceLoadedFor] = useState<string | null>(null);
  const [balanceNonce, setBalanceNonce] = useState(0);

  useEffect(() => {
    if (!identityKey || accountType === 'demo') return;
    let cancelled = false;
    void Promise.resolve(fetchBalance(identityKey)).then(() => {
      if (!cancelled) setBalanceLoadedFor(identityKey);
    });
    return () => {
      cancelled = true;
    };
  }, [identityKey, accountType, fetchBalance, balanceNonce]);

  useEffect(() => {
    if (identityKey) void fetchReferralInfo(identityKey);
  }, [identityKey, fetchReferralInfo]);

  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copyCode = useCallback(async () => {
    if (!referralCode) return;
    await navigator.clipboard.writeText(referralCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [referralCode]);

  if (!isConnected) {
    const resolving = walletStatus === 'reconnecting' || walletStatus === 'connecting';
    return (
      <div className="flex h-full w-full flex-col bg-white font-tight text-ink">
        <SiteNav wide right={<WalletConnect />} />
        {resolving ? (
          <div className="flex justify-center">{routeSkeleton('dashboard')}</div>
        ) : (
          <main className="flex flex-1 items-center justify-center px-6">
            <div className="max-w-sm text-center">
              <h1 className="text-[22px] font-semibold tracking-tight">Connect to see your profile</h1>
              <p className="mt-2 text-sm text-muted">Your name, balance, record and referrals live here.</p>
              <div className="mt-6 flex justify-center">
                <WalletConnect />
              </div>
            </div>
          </main>
        )}
      </div>
    );
  }

  const next = NEXT_TIER[userTier];

  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <SiteNav wide right={<WalletConnect />} />
      <main className="mx-auto max-w-[1000px] space-y-6 px-5 pb-16 pt-8 sm:px-8">
        <header className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <IdentityPanel
            address={address}
            username={storedUsername}
            loadedOnce={identityState !== 'loading'}
            nameUnavailable={identityState === 'unknown'}
            isSaving={isUpdatingUsername}
            readOnly={accountType === 'demo'}
            onSave={handleSaveUsername}
          />
          <BalanceTierPanel
            isConnected={isConnected}
            address={address}
            accountType={accountType}
            balance={houseBalance}
            demoBalance={demoBalance}
            tier={userTier}
            isLoading={balanceLoading}
            error={balanceError}
            loadedOnce={balanceLoadedFor === identityKey}
            onRefresh={() => setBalanceNonce((n) => n + 1)}
          />
        </header>

        <nav className="flex flex-wrap gap-2">
          {[
            ['/history', 'Bet history'],
            ['/withdrawals', 'Withdrawals'],
            ['/referrals', 'Referrals'],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="inline-flex h-9 items-center rounded-full px-4 text-sm font-medium ring-1 ring-ink/[0.08] hover:ring-ink/25"
            >
              {label}
            </Link>
          ))}
        </nav>

        {accountType === 'demo' && (
          <p className="rounded-2xl bg-surface px-4 py-3 text-sm text-muted">
            Practice balance. Demo bets are excluded from the record and from payouts.
          </p>
        )}

        <PerformanceSection wallet={address} accountType={accountType} ensureSession={ensureBalanceSession} />

        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <LedgerPreview wallet={address} ensureSession={ensureBalanceSession} />
          </div>
          <div className="space-y-6 lg:col-span-5">
            <section className="rounded-3xl p-5 ring-1 ring-ink/[0.06]">
              <Label>Tier</Label>
              <p className="text-lg font-semibold capitalize">{userTier}</p>
              <p className="mt-1 text-sm text-muted">
                {getFeePercentLabel(userTier)} fee on deposits and withdrawals.
                {next ? ` Reach ${next.at} to unlock ${next.name}.` : ''}
              </p>
            </section>

            <section className="rounded-3xl p-5 ring-1 ring-ink/[0.06]">
              <Label>Referral code · {referralCount ?? 0} joined</Label>
              <div className="flex items-center justify-between rounded-2xl bg-surface px-4 py-3">
                <span className="font-jet text-base font-semibold tracking-widest">{referralCode || '...'}</span>
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  disabled={!referralCode}
                  aria-label="Copy referral code"
                  className="text-faint"
                >
                  {copied ? <Check size={16} className="text-up" /> : <Copy size={16} />}
                </button>
              </div>
              <Button
                variant="secondary"
                className="mt-3 w-full"
                onClick={() =>
                  referralCode
                    ? openReferralShareOnX(referralLandingUrl(referralCode))
                    : toast.error('Referral code not ready yet')
                }
              >
                <ShareNetwork size={16} /> Share on X
              </Button>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
