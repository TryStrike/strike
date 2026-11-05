// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title StrikeTreasury
 * @notice House treasury for the Strike binary options protocol on Arc.
 *
 * Settles only in USDC through Arc's ERC-20 interface (6 decimals). On Arc the
 * native gas token and the ERC-20 are the same balance, so the contract has no
 * payable entry points: mixing 18-decimal native amounts with 6-decimal token
 * amounts is how balances get mis-scaled.
 *
 * Players deposit here (`depositToken`, or a plain ERC-20 transfer that the
 * backend verifies from the Transfer log); the operator pays winnings and
 * withdrawals out after settling off-chain. Every payout emits an event so the
 * ledger can be reconciled against the chain.
 *
 * Two deliberate safety properties:
 *  - `pause()` stops deposits and payouts without needing an upgrade, so a
 *    suspected key compromise can be contained.
 *  - Ownership transfer is two-step: a bad `transferOwnership` address cannot
 *    lock the treasury, because the new owner has to accept.
 */
contract StrikeTreasury {
    address public owner;
    address public pendingOwner;
    bool public paused;

    /// @notice USDC (Arc ERC-20 interface).
    IERC20 public immutable token;

    event Deposited(address indexed user, uint256 amount, uint256 timestamp);
    event Withdrawn(address indexed to, uint256 amount, uint256 timestamp);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyOwner() {
        require(msg.sender == owner, "StrikeTreasury: caller is not the owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "StrikeTreasury: contract is paused");
        _;
    }

    /// @param tokenAddress USDC's ERC-20 interface on Arc.
    constructor(address tokenAddress) {
        require(tokenAddress != address(0), "StrikeTreasury: token is zero");
        owner = msg.sender;
        token = IERC20(tokenAddress);
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// @notice Deposit USDC. Requires an allowance for this contract of at least `amount`.
    function depositToken(uint256 amount) external whenNotPaused {
        require(amount > 0, "StrikeTreasury: amount is zero");
        // Checked rather than assumed: a token returning false instead of
        // reverting would otherwise credit a deposit that never arrived.
        require(
            token.transferFrom(msg.sender, address(this), amount),
            "StrikeTreasury: token transfer failed"
        );
        emit Deposited(msg.sender, amount, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Payouts
    // ---------------------------------------------------------------------

    /// @notice Pay USDC out to a player.
    function withdrawTokenTo(address to, uint256 amount) external onlyOwner whenNotPaused {
        _pay(to, amount);
    }

    /// @notice Pay several players in one transaction.
    function withdrawBatch(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner whenNotPaused {
        require(recipients.length == amounts.length, "StrikeTreasury: length mismatch");
        require(recipients.length > 0, "StrikeTreasury: empty batch");
        for (uint256 i = 0; i < recipients.length; i++) {
            _pay(recipients[i], amounts[i]);
        }
    }

    function _pay(address to, uint256 amount) private {
        require(to != address(0), "StrikeTreasury: recipient is zero");
        require(amount > 0, "StrikeTreasury: amount is zero");
        require(
            token.balanceOf(address(this)) >= amount,
            "StrikeTreasury: insufficient token balance"
        );
        require(token.transfer(to, amount), "StrikeTreasury: token transfer failed");
        emit Withdrawn(to, amount, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getTokenBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    function pause() external onlyOwner {
        require(!paused, "StrikeTreasury: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        require(paused, "StrikeTreasury: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Step one of handing the treasury over; the new owner must accept.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "StrikeTreasury: new owner is zero");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step two: the nominated owner takes control.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "StrikeTreasury: caller is not the pending owner");
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }
}
