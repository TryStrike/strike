/**
 * Canonical X/Twitter share copy for referral links (used from /referrals and /profile).
 */

function getReferralShareTweetText(): string {
  return [
    'THIS PLATFORM IS INSANE.⚡️',
    '',
    'Strike - The first binary options trading dapp where you can trade over 1,010+ crypto, forex, metals, stocks and commodities in 5s-1m time charts.',
    '',
    'Tap my link → We earn 10% on their trading volume. We both run it up. 💸',
    '',
    'Stop watching. Start trading. Try it now: 🔥👇',
  ].join('\n');
}

function getPublicAppOrigin(): string {
  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin;
  }
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://ethglobalmumbai.vercel.app').replace(/\/$/, '');
}

export function referralLandingUrl(referralCode: string): string {
  return `${getPublicAppOrigin()}/?ref=${encodeURIComponent(referralCode.trim())}`;
}

export function openReferralShareOnX(referralLink: string): void {
  if (typeof window === 'undefined') return;
  const text = encodeURIComponent(getReferralShareTweetText());
  window.open(
    `https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(referralLink)}`,
    '_blank',
  );
}
