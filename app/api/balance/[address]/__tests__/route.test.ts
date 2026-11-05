/**
 * @jest-environment node
 */

/**
 * Unit tests for GET /api/balance/[address]
 *
 * The route sums the balances across any legacy duplicate rows for a wallet,
 * reports the newest updated_at, and reads the tier from the canonical row.
 */

import { GET } from '../route';
import { NextRequest } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';

jest.mock('@/lib/supabase/serviceClient', () => ({
  supabaseService: { from: jest.fn() },
}));

jest.mock('@/lib/bans/walletBan', () => ({
  isWalletGloballyBanned: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/admin/walletAddressVariants', () => ({
  walletAddressSearchVariants: (address: string) => [address.toLowerCase()],
}));

jest.mock('@/lib/wallet/canonicalAddress', () => ({
  canonicalHouseUserAddress: (address: string) => address.toLowerCase(),
}));

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    NextResponse: {
      json: jest.fn((body: any, init?: ResponseInit) => ({
        json: async () => body,
        status: init?.status || 200,
        headers: new Headers(init?.headers),
      })),
    },
  };
});

const VALID = '0x1111111111111111111111111111111111111111';

/**
 * The route makes two queries: the balance rows (resolved by awaiting the
 * chain) and the tier row (resolved via .single()).
 */
function mockQueries(rows: { data: any; error: any }, tier: { data: any; error: any }) {
  (supabase.from as jest.Mock).mockImplementation(() => {
    const chain: any = {};
    for (const method of ['select', 'eq', 'in', 'limit', 'order']) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve(tier));
    chain.maybeSingle = jest.fn(() => Promise.resolve(tier));
    chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  });
}

const call = async (address: string) => {
  const request = new NextRequest(`http://localhost:3000/api/balance/${address}`);
  const response = await GET(request, { params: Promise.resolve({ address }) });
  return { response, json: await response.json() };
};

describe('GET /api/balance/[address]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isWalletGloballyBanned as jest.Mock).mockResolvedValue(false);
  });

  it('returns the balance, timestamp and tier for an existing user', async () => {
    mockQueries(
      {
        data: [{ balance: 10.5, updated_at: '2024-01-15T10:30:00Z', user_address: VALID.toLowerCase() }],
        error: null,
      },
      { data: { user_tier: 'vip' }, error: null }
    );

    const { response, json } = await call(VALID);

    expect(response.status).toBe(200);
    expect(json).toEqual({
      balance: 10.5,
      updatedAt: '2024-01-15T10:30:00Z',
      tier: 'vip',
      globallyBanned: false,
    });
  });

  it('sums legacy duplicate rows and reports the newest timestamp', async () => {
    mockQueries(
      {
        data: [
          { balance: 4, updated_at: '2024-01-10T00:00:00Z', user_address: VALID.toLowerCase() },
          { balance: 6.25, updated_at: '2024-02-01T00:00:00Z', user_address: VALID.toUpperCase() },
        ],
        error: null,
      },
      { data: { user_tier: 'free' }, error: null }
    );

    const { json } = await call(VALID);

    expect(json.balance).toBe(10.25);
    expect(json.updatedAt).toBe('2024-02-01T00:00:00Z');
  });

  it('returns a zero balance when the user has no rows', async () => {
    mockQueries({ data: [], error: null }, { data: null, error: null });

    const { response, json } = await call(VALID);

    expect(response.status).toBe(200);
    expect(json).toEqual({
      balance: 0,
      updatedAt: null,
      tier: 'free',
      globallyBanned: false,
    });
  });

  it('reports a globally banned wallet', async () => {
    (isWalletGloballyBanned as jest.Mock).mockResolvedValue(true);
    mockQueries({ data: [], error: null }, { data: null, error: null });

    const { json } = await call(VALID);

    expect(json.globallyBanned).toBe(true);
  });

  it('rejects an address that is not a wallet address', async () => {
    const { response, json } = await call('not-an-address');

    expect(response.status).toBe(400);
    expect(json.error).toMatch(/Invalid wallet address/);
  });

  it('returns 503 when the database is unreachable', async () => {
    mockQueries(
      { data: null, error: { message: 'connection refused' } },
      { data: null, error: null }
    );

    const { response, json } = await call(VALID);

    expect(response.status).toBe(503);
    expect(json.error).toMatch(/temporarily unavailable/i);
  });

  it('falls back to the free tier when the tier row cannot be read', async () => {
    mockQueries(
      {
        data: [{ balance: 1, updated_at: '2024-01-15T10:30:00Z', user_address: VALID.toLowerCase() }],
        error: null,
      },
      { data: null, error: { message: 'no tier' } }
    );

    const { json } = await call(VALID);

    expect(json.tier).toBe('free');
  });

  it('returns 500 rather than throwing when something unexpected fails', async () => {
    (supabase.from as jest.Mock).mockImplementation(() => {
      throw new Error('boom');
    });

    const { response, json } = await call(VALID);

    expect(response.status).toBe(500);
    expect(json.error).toBeDefined();
  });
});
