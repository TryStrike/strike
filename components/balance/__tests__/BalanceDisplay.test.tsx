/**
 * Unit tests for BalanceDisplay component
 *
 * Requirements: 8.1
 *
 * The component reads everything through a single `useStore(selector)`
 * hook, so the tests drive it by swapping the backing state object rather than
 * mocking one hook per field.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BalanceDisplay } from '../BalanceDisplay';
import { useStore } from '@/lib/store';

jest.mock('@/lib/store', () => ({
  useStore: jest.fn(),
}));

const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
};
jest.mock('@/lib/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

// The modals pull in wallet SDKs that are irrelevant to this component's own
// rendering; they are opened by separate tests of their own.
jest.mock('../DepositModal', () => ({ DepositModal: () => null }));
jest.mock('../WithdrawModal', () => ({ WithdrawModal: () => null }));

const fetchBalance = jest.fn().mockResolvedValue(undefined);
const updateBalance = jest.fn();
const toggleAccountType = jest.fn();
const setSelectedCurrency = jest.fn();
const setAddress = jest.fn();
const setIsConnected = jest.fn();

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    houseBalance: 0,
    demoBalance: 10000,
    accountType: 'real',
    network: 'ARC',
    userTier: 'free',
    selectedCurrency: 'BOT',
    isLoading: false,
    address: '0x1234567890abcdef',
    setSelectedCurrency,
    toggleAccountType,
    fetchBalance,
    updateBalance,
    setAddress,
    setIsConnected,
    ...overrides,
  };
}

/** Points the mocked store at `state` for the next render. */
function useState_(state: Record<string, unknown>) {
  (useStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: any) => unknown) => selector(state)
  );
}

describe('BalanceDisplay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useState_(stateWith());
  });

  describe('Balance rendering', () => {
    it('labels the panel as the house balance on a real account', () => {
      render(<BalanceDisplay />);
      expect(screen.getByText('House Balance')).toBeInTheDocument();
    });

    it('labels the panel as practice balance in demo mode', () => {
      useState_(stateWith({ accountType: 'demo' }));
      render(<BalanceDisplay />);
      expect(screen.getByText('Practice Balance')).toBeInTheDocument();
    });

    it('formats the balance to 4 decimal places', () => {
      useState_(stateWith({ houseBalance: 123.456789 }));
      render(<BalanceDisplay />);
      expect(screen.getByText('123.4568')).toBeInTheDocument();
    });

    it('formats a zero balance to 4 decimal places', () => {
      render(<BalanceDisplay />);
      expect(screen.getByText('0.0000')).toBeInTheDocument();
    });

    it('renders a large balance without truncating it', () => {
      useState_(stateWith({ houseBalance: 1234567.891 }));
      render(<BalanceDisplay />);
      expect(screen.getByText('1234567.8910')).toBeInTheDocument();
    });

    it('keeps a small balance visible rather than rounding it away', () => {
      useState_(stateWith({ houseBalance: 0.0001 }));
      render(<BalanceDisplay />);
      expect(screen.getByText('0.0001')).toBeInTheDocument();
    });

    it('shows the demo balance when the account is in demo mode', () => {
      useState_(stateWith({ accountType: 'demo', houseBalance: 5, demoBalance: 250 }));
      render(<BalanceDisplay />);
      expect(screen.getByText('250.0000')).toBeInTheDocument();
      expect(screen.queryByText('5.0000')).not.toBeInTheDocument();
    });
  });

  describe('Refreshing', () => {
    it('fetches the balance for the connected address on mount', async () => {
      render(<BalanceDisplay />);
      await waitFor(() => expect(fetchBalance).toHaveBeenCalledWith('0x1234567890abcdef'));
    });

    it('does not fetch when no wallet is connected', async () => {
      useState_(stateWith({ address: null }));
      render(<BalanceDisplay />);
      await waitFor(() => expect(fetchBalance).not.toHaveBeenCalled());
    });

    it('does not fetch house credits in demo mode', async () => {
      useState_(stateWith({ accountType: 'demo' }));
      render(<BalanceDisplay />);
      await waitFor(() => expect(fetchBalance).not.toHaveBeenCalled());
    });

    it('refetches and confirms when the refresh button is clicked', async () => {
      render(<BalanceDisplay />);
      fetchBalance.mockClear();

      fireEvent.click(screen.getByTitle('Refresh balance'));

      await waitFor(() => expect(fetchBalance).toHaveBeenCalledWith('0x1234567890abcdef'));
      await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Balance refreshed'));
    });

    it('reports a failed refresh instead of silently doing nothing', async () => {
      render(<BalanceDisplay />);
      fetchBalance.mockClear();
      fetchBalance.mockRejectedValueOnce(new Error('network down'));

      fireEvent.click(screen.getByTitle('Refresh balance'));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Failed to refresh balance'));
    });

    it('ignores a refresh click while a fetch is already in flight', () => {
      useState_(stateWith({ isLoading: true }));
      render(<BalanceDisplay />);
      fetchBalance.mockClear();

      fireEvent.click(screen.getByTitle('Refresh balance'));

      expect(fetchBalance).not.toHaveBeenCalled();
    });
  });

  describe('Demo mode', () => {
    it('resets the practice balance back to 10000', () => {
      useState_(stateWith({ accountType: 'demo', demoBalance: 250 }));
      render(<BalanceDisplay />);

      fireEvent.click(screen.getByText('Reset Practice Balance'));

      expect(updateBalance).toHaveBeenCalledWith(10000 - 250, 'add');
    });
  });
});
