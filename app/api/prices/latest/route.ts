import { NextRequest, NextResponse } from 'next/server';
import { PRICE_FEED_IDS } from '@/lib/utils/priceFeed';
import { fetchLatestPrices } from '@/lib/server/marketPrices';

export async function GET(request: NextRequest) {
  const asset = request.nextUrl.searchParams.get('asset');
  const requestedAssets = asset ? [asset] : Object.keys(PRICE_FEED_IDS);
  const prices = await fetchLatestPrices(requestedAssets);
  // Every client polls this once a second; let the CDN serve them all from one
  // response per second instead of each visitor triggering an upstream fetch.
  return NextResponse.json(
    { prices },
    { headers: { 'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=5' } }
  );
}

export async function POST(request: NextRequest) {
  let requestedAssets: string[] = [];
  try {
    const body = await request.json();
    if (Array.isArray(body?.assets)) {
      requestedAssets = body.assets.filter((v: unknown) => typeof v === 'string');
    }
  } catch {
    // ignore invalid JSON and fall back below
  }

  if (requestedAssets.length === 0) requestedAssets = Object.keys(PRICE_FEED_IDS);
  const prices = await fetchLatestPrices(requestedAssets);
  return NextResponse.json({ prices });
}
