/**
 * Unit tests for POST /api/balance/deposit endpoint
 *
 * Task: 4.2 Create POST /api/balance/deposit endpoint
 * Requirements: 1.2, 7.5
 */

import { POST } from '../route';
import { supabaseService } from '@/lib/supabase/serviceClient';
import { verifyArcDepositTx } from '@/lib/balance/verifyArcDepositTx';
import { NextRequest } from 'next/server';
import { calculateFeeAmount } from '@/lib/fees/platformFee';

const TEST_USER = '0x1111111111111111111111111111111111111111';
const TEST_USER_2 = '0x3333333333333333333333333333333333333333';

function netDeposit(amount: number): number {
  return amount - calculateFeeAmount(amount, 'free');
}

jest.mock('@/lib/bans/walletBan', () => ({
  isWalletGloballyBanned: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/supabase/serviceClient', () => ({
  supabaseService: {
    rpc: jest.fn(),
    from: jest.fn((table: string) => {
      const chainMethods: any = {
        select: jest.fn(() => chainMethods),
        eq: jest.fn(() => chainMethods),
        or: jest.fn(() => chainMethods),
        in: jest.fn(() => chainMethods),
        limit: jest.fn(() => chainMethods),
        single: jest.fn(() => Promise.resolve({ data: null, error: null })),
        insert: jest.fn(() => Promise.resolve({ error: null })),
      };
      // Idempotency check: no existing transaction with this hash.
      // The route filters with .eq(...).or(...).limit(1), so the stub has to
      // carry every link in that chain.
      if (table === 'balance_audit_log') {
        const auditChain: any = {
          select: jest.fn(() => auditChain),
          eq: jest.fn(() => auditChain),
          or: jest.fn(() => auditChain),
          limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
          insert: jest.fn(() => Promise.resolve({ error: null })),
          single: jest.fn(() => Promise.resolve({ data: null, error: null })),
        };
        return auditChain;
      }
      // Return null for tier lookup (default tier)
      if (table === 'user_balances') {
        return {
          ...chainMethods,
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              limit: jest.fn(() => ({
                single: jest.fn(() => Promise.resolve({ data: null, error: null })),
              })),
            })),
          })),
        };
      }
      return chainMethods;
    }),
  },
}));

jest.mock('@/lib/balance/verifyArcDepositTx', () => ({
  verifyArcDepositTx: jest.fn().mockResolvedValue(true),
}));

// Mock NextResponse.json to return a proper Response object
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    NextResponse: {
      json: jest.fn((body: any, init?: ResponseInit) => {
        return {
          json: async () => body,
          status: init?.status || 200,
          headers: new Headers(init?.headers),
        };
      }),
    },
  };
});

const INVALID_FORMAT_ERROR =
  'Invalid wallet address format (an Arc address is required)';

describe('POST /api/balance/deposit', () => {
  const mockRpc = supabaseService.rpc as jest.MockedFunction<typeof supabaseService.rpc>;
  const mockVerifyEvm = verifyArcDepositTx as jest.MockedFunction<typeof verifyArcDepositTx>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEvm.mockResolvedValue(true);
  });

  it('should successfully process a deposit and return new balance', async () => {
    const mockResult = {
      success: true,
      error: null,
      new_balance: 25.5,
    };

    mockRpc.mockResolvedValue({
      data: mockResult,
      error: null,
    } as any);

    const requestBody = {
      userAddress: TEST_USER,
      amount: 10.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      newBalance: 25.5,
    });

    expect(mockRpc).toHaveBeenCalledWith('update_balance_for_deposit', {
      p_user_address: TEST_USER.toLowerCase(),
      p_deposit_amount: netDeposit(10.5),
      p_currency: 'USDC',
      p_transaction_hash: '0xabcdef123456',
    });
  });

  it('should create new user record for first deposit', async () => {
    const mockResult = {
      success: true,
      error: null,
      new_balance: 5.0,
    };

    mockRpc.mockResolvedValue({
      data: mockResult,
      error: null,
    } as any);

    const requestBody = {
      userAddress: TEST_USER_2,
      amount: 5.0,
      txHash: '0xtxhash123',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.newBalance).toBe(5.0);
  });

  it('should return 400 for missing userAddress', async () => {
    const requestBody = {
      amount: 10.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: 'Missing required fields: userAddress, amount, txHash',
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should return 400 for missing amount', async () => {
    const requestBody = {
      userAddress: TEST_USER,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: 'Missing required fields: userAddress, amount, txHash',
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should return 400 for missing txHash', async () => {
    const requestBody = {
      userAddress: TEST_USER,
      amount: 10.5,
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: 'Missing required fields: userAddress, amount, txHash',
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should return 400 for invalid address format', async () => {
    const requestBody = {
      userAddress: 'invalid123',
      amount: 10.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: INVALID_FORMAT_ERROR,
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should return 400 for zero amount', async () => {
    const requestBody = {
      userAddress: TEST_USER,
      amount: 0,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: 'Deposit amount must be greater than zero',
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should return 400 for negative amount', async () => {
    const requestBody = {
      userAddress: TEST_USER,
      amount: -5.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: 'Deposit amount must be greater than zero',
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should return 503 for database connection errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'CONNECTION_ERROR', message: 'Connection failed' },
    } as any);

    const requestBody = {
      userAddress: TEST_USER,
      amount: 10.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json).toEqual({
      error: 'Service temporarily unavailable. Please try again.',
    });
  });

  it('should handle stored procedure errors', async () => {
    const mockResult = {
      success: false,
      error: 'Database constraint violation',
      new_balance: null,
    };

    mockRpc.mockResolvedValue({
      data: mockResult,
      error: null,
    } as any);

    const requestBody = {
      userAddress: TEST_USER,
      amount: 10.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: 'Database constraint violation',
    });
  });

  it('should handle unexpected errors gracefully', async () => {
    mockRpc.mockRejectedValue(new Error('Unexpected error'));

    const requestBody = {
      userAddress: TEST_USER,
      amount: 10.5,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json).toEqual({
      error: 'An error occurred processing your request',
    });
  });

  it('should handle large deposit amounts correctly', async () => {
    const mockResult = {
      success: true,
      error: null,
      new_balance: 1000000.12345678,
    };

    mockRpc.mockResolvedValue({
      data: mockResult,
      error: null,
    } as any);

    const requestBody = {
      userAddress: TEST_USER,
      amount: 999999.12345678,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.newBalance).toBe(1000000.12345678);
  });

  it('should handle small decimal amounts correctly', async () => {
    const mockResult = {
      success: true,
      error: null,
      new_balance: 0.00000001,
    };

    mockRpc.mockResolvedValue({
      data: mockResult,
      error: null,
    } as any);

    const requestBody = {
      userAddress: TEST_USER,
      amount: 0.00000001,
      txHash: '0xabcdef123456',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.newBalance).toBe(0.00000001);
  });

  it('should handle malformed JSON gracefully', async () => {
    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: 'not valid json',
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json).toEqual({
      error: 'An error occurred processing your request',
    });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should verify audit log is created via stored procedure', async () => {
    const mockResult = {
      success: true,
      error: null,
      new_balance: 15.0,
    };

    mockRpc.mockResolvedValue({
      data: mockResult,
      error: null,
    } as any);

    const requestBody = {
      userAddress: TEST_USER,
      amount: 10.0,
      txHash: '0xtxhash789',
    };

    const request = new NextRequest('http://localhost:3000/api/balance/deposit', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    await POST(request);

    expect(mockRpc).toHaveBeenCalledWith('update_balance_for_deposit', {
      p_user_address: TEST_USER.toLowerCase(),
      p_deposit_amount: netDeposit(10.0),
      p_currency: 'USDC',
      p_transaction_hash: '0xtxhash789',
    });
  });
});
