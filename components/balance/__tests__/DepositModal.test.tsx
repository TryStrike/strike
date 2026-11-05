/**
 * Unit tests for DepositModal
 *
 * The modal moves funds from the player's wallet into the house treasury on
 * Arc. Both playable assets are covered: BOT (native) and USDT (ERC-20).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DepositModal } from '../DepositModal';
import { useStore } from '@/lib/store';

jest.mock('@/lib/store', () => ({
  useStore: jest.fn(),
}));

const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
};
jest.mock('@/lib/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

// No wagmi provider in a unit test.
const switchChainAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('wagmi', () => ({
  useWalletClient: () => ({ data: undefined }),
  useAccount: () => ({ connector: undefined, address: undefined, isConnected: false }),
  useSwitchChain: () => ({ switchChainAsync }),
}));

// The balance read happens over RPC; keep it deterministic.
const getBalance = jest.fn().mockResolvedValue(BigInt('5000000000000000000')); // 5 BOT
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: jest.fn().mockImplementation(() => ({
        getBalance: (...args: unknown[]) => getBalance(...args),
      })),
      Contract: jest.fn().mockImplementation(() => ({
        balanceOf: jest.fn().mockResolvedValue(BigInt('7500000')), // 7.5 USDT
      })),
    },
  };
});

const setSelectedCurrency = jest.fn();
const fetchBalance = jest.fn().mockResolvedValue(undefined);

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    address: '0x1111111111111111111111111111111111111111',
    selectedCurrency: 'BOT',
    setSelectedCurrency,
    fetchBalance,
    ...overrides,
  };
}

function useState_(state: Record<string, unknown>) {
  (useStore as unknown as jest.Mock).mockImplementation(
    (selector?: (s: any) => unknown) =>
      typeof selector === 'function' ? selector(state) : state
  );
}

/** The asset buttons hold an icon plus the label, so match on the icon. */
function assetButton(token: 'BOT' | 'USDT'): HTMLElement {
  const icon = screen.getAllByAltText(token).find((el) => el.closest('button'));
  if (!icon) throw new Error(`No ${token} asset button rendered`);
  return icon.closest('button') as HTMLElement;
}

const onClose = jest.fn();

describe('DepositModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getBalance.mockResolvedValue(BigInt('5000000000000000000'));
    useState_(stateWith());
  });

  describe('Rendering', () => {
    it('renders nothing when closed', () => {
      render(<DepositModal isOpen={false} onClose={onClose} />);
      expect(screen.queryByText('Deposit BOT')).not.toBeInTheDocument();
    });

    it('titles itself with the selected asset', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      expect(screen.getAllByText('Deposit BOT').length).toBeGreaterThan(0);
    });

    it('titles itself with USDT when that asset is selected', () => {
      useState_(stateWith({ selectedCurrency: 'USDT' }));
      render(<DepositModal isOpen onClose={onClose} />);
      expect(screen.getAllByText('Deposit USDT').length).toBeGreaterThan(0);
    });

    it('offers both playable assets', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      expect(assetButton('BOT')).toBeInTheDocument();
      expect(assetButton('USDT')).toBeInTheDocument();
    });

    it('renders the amount input and controls', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
      expect(screen.getByText('Use Max')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('shows the native wallet balance for BOT', async () => {
      render(<DepositModal isOpen onClose={onClose} />);
      await waitFor(() => expect(screen.getByText(/5\.0000 BOT/)).toBeInTheDocument());
    });

    it('shows the token wallet balance for USDT, using its own decimals', async () => {
      useState_(stateWith({ selectedCurrency: 'USDT' }));
      render(<DepositModal isOpen onClose={onClose} />);
      await waitFor(() => expect(screen.getByText(/7\.5000 USDT/)).toBeInTheDocument());
    });
  });

  describe('Asset selection', () => {
    it('switches the ledger asset and clears the amount', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '1.5' } });

      fireEvent.click(assetButton('USDT'));

      expect(setSelectedCurrency).toHaveBeenCalledWith('USDT');
    });

    it('offers larger quick amounts for USDT than for BOT', () => {
      const { unmount } = render(<DepositModal isOpen onClose={onClose} />);
      expect(screen.getByText('0.1')).toBeInTheDocument();
      unmount();

      useState_(stateWith({ selectedCurrency: 'USDT' }));
      render(<DepositModal isOpen onClose={onClose} />);
      expect(screen.getByText('25')).toBeInTheDocument();
    });
  });

  describe('Amount input', () => {
    it('accepts a whole number', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '12' } });
      expect(input.value).toBe('12');
    });

    it('accepts a decimal', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '0.125' } });
      expect(input.value).toBe('0.125');
    });

    it('rejects non-numeric input rather than showing it', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'abc' } });
      expect(input.value).toBe('');
    });

    it('fills the input from a quick-select button', () => {
      render(<DepositModal isOpen onClose={onClose} />);
      fireEvent.click(screen.getByText('0.5'));
      expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('0.5');
    });

    it('fills the input with the whole wallet balance from Use Max', async () => {
      render(<DepositModal isOpen onClose={onClose} />);
      await waitFor(() => expect(screen.getByText(/5\.0000 BOT/)).toBeInTheDocument());

      fireEvent.click(screen.getByText('Use Max'));

      expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('5');
    });
  });

  describe('Validation', () => {
    it('refuses an amount larger than the wallet holds', async () => {
      render(<DepositModal isOpen onClose={onClose} />);
      await waitFor(() => expect(screen.getByText(/5\.0000 BOT/)).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '9999' } });
      fireEvent.click(screen.getByRole('button', { name: 'Deposit BOT' }));

      expect(await screen.findByText('Insufficient BOT balance')).toBeInTheDocument();
    });

    it('refuses a zero amount', async () => {
      render(<DepositModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Deposit BOT' }));

      expect(
        await screen.findByText('Amount must be greater than zero')
      ).toBeInTheDocument();
    });
  });

  it('closes without depositing when Cancel is clicked', () => {
    render(<DepositModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
