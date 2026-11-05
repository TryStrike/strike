/**
 * Unit tests for WithdrawModal
 *
 * The modal moves credits out of the house balance back to the player's wallet
 * on Arc, authorised by a signed message.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { WithdrawModal } from '../WithdrawModal';
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

const signMessage = jest.fn().mockResolvedValue('0xsignature');
jest.mock('wagmi', () => ({
  useWalletClient: () => ({ data: { signMessage: (...a: unknown[]) => signMessage(...a) } }),
  useAccount: () => ({ connector: undefined, address: undefined, isConnected: true }),
}));

const withdrawFunds = jest.fn().mockResolvedValue({ txHash: '0xwithdraw' });
const refreshWalletBalance = jest.fn();
const setSelectedCurrency = jest.fn();

const ADDRESS = '0x1111111111111111111111111111111111111111';

function stateWith(overrides: Record<string, unknown> = {}) {
  return {
    address: ADDRESS,
    isConnected: true,
    houseBalance: 10,
    userTier: 'free',
    selectedCurrency: 'BOT',
    setSelectedCurrency,
    withdrawFunds,
    refreshWalletBalance,
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

describe('WithdrawModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    withdrawFunds.mockResolvedValue({ txHash: '0xwithdraw' });
    useState_(stateWith());
  });

  describe('Rendering', () => {
    it('renders nothing when closed', () => {
      render(<WithdrawModal isOpen={false} onClose={onClose} />);
      expect(screen.queryByText('Withdraw BOT')).not.toBeInTheDocument();
    });

    it('titles itself with the selected asset', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      expect(screen.getAllByText('Withdraw BOT').length).toBeGreaterThan(0);
    });

    it('offers both playable assets', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      expect(assetButton('BOT')).toBeInTheDocument();
      expect(assetButton('USDT')).toBeInTheDocument();
    });

    it('shows the house balance', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      expect(screen.getByText(/10\.0000 BOT/)).toBeInTheDocument();
    });

    it('switches the ledger asset', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.click(assetButton('USDT'));
      expect(setSelectedCurrency).toHaveBeenCalledWith('USDT');
    });
  });

  describe('Fee preview', () => {
    it('quotes the free-tier fee', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10' } });

      expect(screen.getByText(/Protocol Fee: 10%/)).toBeInTheDocument();
      expect(screen.getByText(/9\.0000 BOT/)).toBeInTheDocument();
    });

    it('quotes a smaller fee for a vip', () => {
      useState_(stateWith({ userTier: 'vip' }));
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10' } });

      expect(screen.getByText(/Protocol Fee: 8%/)).toBeInTheDocument();
      expect(screen.getByText(/9\.2000 BOT/)).toBeInTheDocument();
    });
  });

  describe('Amount input', () => {
    it('rejects non-numeric input', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'abc' } });
      expect(input.value).toBe('');
    });

    it('fills the input with the whole house balance from Use Max', () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.click(screen.getByText('Use Max'));
      expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('10');
    });
  });

  describe('Validation', () => {
    it('refuses more than the house balance', async () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '9999' } });
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw BOT' }));

      expect(await screen.findByText('Insufficient house balance')).toBeInTheDocument();
      expect(withdrawFunds).not.toHaveBeenCalled();
    });

    it('refuses a zero amount', async () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw BOT' }));

      expect(
        await screen.findByText('Amount must be greater than zero')
      ).toBeInTheDocument();
      expect(withdrawFunds).not.toHaveBeenCalled();
    });

    it('refuses when no wallet is connected', async () => {
      useState_(stateWith({ isConnected: false, address: null }));
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw BOT' }));

      expect(await screen.findByText('Please connect your wallet')).toBeInTheDocument();
    });
  });

  describe('Submitting', () => {
    it('signs an authorization naming the asset and amount, then withdraws', async () => {
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw BOT' }));

      await waitFor(() => expect(signMessage).toHaveBeenCalled());
      const { message } = signMessage.mock.calls[0][0];
      expect(message).toContain(`address:${ADDRESS}`);
      expect(message).toContain('amount:2.00000000');
      expect(message).toContain('currency:BOT');

      await waitFor(() =>
        expect(withdrawFunds).toHaveBeenCalledWith(
          ADDRESS,
          2,
          expect.objectContaining({ signature: '0xsignature' })
        )
      );
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('reports a pending withdrawal awaiting manual approval', async () => {
      withdrawFunds.mockResolvedValueOnce({ status: 'pending' });
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw BOT' }));

      await waitFor(() =>
        expect(mockToast.success).toHaveBeenCalledWith(
          expect.stringContaining('Awaiting manual approval')
        )
      );
    });

    it('surfaces a failure instead of closing', async () => {
      withdrawFunds.mockRejectedValueOnce(new Error('treasury is short'));
      render(<WithdrawModal isOpen onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw BOT' }));

      expect(await screen.findByText('treasury is short')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('closes without withdrawing when Cancel is clicked', () => {
    render(<WithdrawModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(withdrawFunds).not.toHaveBeenCalled();
  });
});
