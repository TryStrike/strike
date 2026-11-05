import { NextRequest } from 'next/server';

import { POST } from '../route';
import { supabaseService } from '@/lib/supabase/serviceClient';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';
import { calculateFeeAmount, getFeePercentLabel } from '@/lib/fees/platformFee';

const TEST_USER = '0x1111111111111111111111111111111111111111';

jest.mock('@/lib/balance/balanceApiGuard', () => ({
  assertBalanceApiAuthorized: jest.fn(() => null),
}));

jest.mock('@/lib/bans/walletBan', () => ({
  isWalletGloballyBanned: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/utils/address', () => ({
  isValidAddress: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/admin/walletAddressVariants', () => ({
  walletAddressSearchVariants: jest.fn((address: string) => [address, address.toLowerCase()]),
}));

jest.mock('@/lib/wallet/canonicalAddress', () => ({
  canonicalHouseUserAddress: jest.fn((address: string) => address.toLowerCase()),
}));

jest.mock('@/lib/fees/platformFee', () => ({
  calculateFeeAmount: jest.fn((amount: number) => Number((amount * 0.1).toFixed(8))),
  getFeePercentLabel: jest.fn(() => '10%'),
}));

jest.mock('@/lib/supabase/serviceClient', () => ({
  supabaseService: {
    from: jest.fn(),
    rpc: jest.fn(),
  },
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

type QueryResult = { data?: any; error?: any; count?: number | null };

type FromMockState = {
  userBalances?: QueryResult;
  depositAudit?: QueryResult;
  withdrawalAudit?: QueryResult;
  pendingAmounts?: QueryResult;
  withdrawalAuditCount?: QueryResult;
  pendingCount?: QueryResult;
  pendingInsert?: QueryResult;
  feeAuditInsert?: QueryResult;
};

const mockFrom = supabaseService.from as jest.MockedFunction<typeof supabaseService.from>;
const mockRpc = supabaseService.rpc as jest.MockedFunction<typeof supabaseService.rpc>;
const mockAssertBalanceApiAuthorized = assertBalanceApiAuthorized as jest.MockedFunction<typeof assertBalanceApiAuthorized>;
const mockIsWalletGloballyBanned = isWalletGloballyBanned as jest.MockedFunction<typeof isWalletGloballyBanned>;
const mockCalculateFeeAmount = calculateFeeAmount as jest.MockedFunction<typeof calculateFeeAmount>;
const mockGetFeePercentLabel = getFeePercentLabel as jest.MockedFunction<typeof getFeePercentLabel>;

function buildRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/balance/withdraw', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function mockSupabaseFrom(state: FromMockState) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_balances') {
      return {
        select: () => ({
          in: () => ({
            eq: async () => ({
              data: state.userBalances?.data ?? [],
              error: state.userBalances?.error ?? null,
            }),
          }),
        }),
      } as any;
    }

    if (table === 'balance_audit_log') {
      return {
        select: (_columns: string, options?: { count?: 'exact'; head?: boolean }) => {
          if (options?.count === 'exact' && options?.head) {
            return {
              eq: () => ({
                in: async () => ({
                  count: state.withdrawalAuditCount?.count ?? 0,
                  error: state.withdrawalAuditCount?.error ?? null,
                }),
              }),
            };
          }

          return {
            in: () => ({
              eq: () => ({
                eq: async (_field: string, operationType: string) => ({
                  data:
                    operationType === 'deposit'
                      ? state.depositAudit?.data ?? []
                      : state.withdrawalAudit?.data ?? [],
                  error:
                    operationType === 'deposit'
                      ? state.depositAudit?.error ?? null
                      : state.withdrawalAudit?.error ?? null,
                }),
              }),
            }),
          };
        },
        insert: () =>
          Promise.resolve({
            data: state.feeAuditInsert?.data ?? null,
            error: state.feeAuditInsert?.error ?? null,
          }),
      } as any;
    }

    if (table === 'withdrawal_requests') {
      return {
        select: (_columns: string, options?: { count?: 'exact'; head?: boolean }) => {
          if (options?.count === 'exact' && options?.head) {
            return {
              eq: () => ({
                in: async () => ({
                  count: state.pendingCount?.count ?? 0,
                  error: state.pendingCount?.error ?? null,
                }),
              }),
            };
          }

          return {
            in: () => ({
              eq: () => ({
                in: async () => ({
                  data: state.pendingAmounts?.data ?? [],
                  error: state.pendingAmounts?.error ?? null,
                }),
              }),
            }),
          };
        },
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: state.pendingInsert?.data ?? { id: 99 },
              error: state.pendingInsert?.error ?? null,
            }),
          }),
        }),
      } as any;
    }

    throw new Error(`Unexpected table mock: ${table}`);
  });
}

describe('POST /api/balance/withdraw', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertBalanceApiAuthorized.mockReturnValue(null);
    mockIsWalletGloballyBanned.mockResolvedValue(false);
    mockCalculateFeeAmount.mockImplementation((amount: number) => Number((amount * 0.1).toFixed(8)));
    mockGetFeePercentLabel.mockReturnValue('10%');
    mockSupabaseFrom({
      userBalances: {
        data: [{ balance: 2, status: 'active', user_address: TEST_USER.toLowerCase() }],
      },
      depositAudit: { data: [] },
      withdrawalAudit: { data: [] },
      pendingAmounts: { data: [] },
      withdrawalAuditCount: { count: 0 },
      pendingCount: { count: 0 },
      pendingInsert: { data: { id: 77 } },
      feeAuditInsert: { data: null },
    });
    mockRpc.mockResolvedValue({
      data: { success: true, error: null, new_balance: 1.95 },
      error: null,
    } as any);
  });

  it('returns 400 when userAddress is missing', async () => {
    const response = await POST(buildRequest({ amount: 0.05, currency: 'BOT' }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({ error: 'Missing required fields: userAddress, amount' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid wallet addresses', async () => {
    const { isValidAddress } = jest.requireMock('@/lib/utils/address') as {
      isValidAddress: jest.Mock;
    };
    isValidAddress.mockResolvedValueOnce(false);

    const response = await POST(buildRequest({
      userAddress: 'bad-address',
      amount: 0.05,
      currency: 'BOT',
    }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({ error: 'Invalid wallet address format' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 404 when the user balance record is missing', async () => {
    mockSupabaseFrom({
      userBalances: { data: [] },
    });

    const response = await POST(buildRequest({
      userAddress: TEST_USER,
      amount: 0.05,
      currency: 'BOT',
    }));
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({ error: 'User record not found' });
  });

  it('returns 400 when the house balance is insufficient', async () => {
    mockSupabaseFrom({
      userBalances: {
        data: [{ balance: 0.01, status: 'active', user_address: TEST_USER.toLowerCase() }],
      },
      depositAudit: { data: [] },
      withdrawalAudit: { data: [] },
      pendingAmounts: { data: [] },
      withdrawalAuditCount: { count: 0 },
      pendingCount: { count: 0 },
    });

    const response = await POST(buildRequest({
      userAddress: TEST_USER,
      amount: 0.05,
      currency: 'BOT',
    }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({ error: 'Insufficient house balance in BOT' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('creates a pending request for large real withdrawals', async () => {
    mockSupabaseFrom({
      userBalances: {
        data: [{ balance: 10, status: 'active', user_address: TEST_USER.toLowerCase() }],
      },
      depositAudit: { data: [{ amount: 20 }] },
      withdrawalAudit: { data: [] },
      pendingAmounts: { data: [] },
      withdrawalAuditCount: { count: 0 },
      pendingCount: { count: 0 },
      pendingInsert: { data: { id: 123 } },
    });

    const response = await POST(buildRequest({
      userAddress: TEST_USER,
      amount: 1,
      currency: 'BOT',
      userTier: 'free',
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      status: 'pending',
      requestId: 123,
      newBalance: 10,
      frequencyReview: false,
      withdrawalCount: 1,
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
