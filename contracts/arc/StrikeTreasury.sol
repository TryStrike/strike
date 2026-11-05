// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title StrikeTreasury
 * @notice House treasury for the Strike binary options protocol on BOT Chain.
 *
 * Holds both playable assets: BOT (the native coin) and USDT (an ERC-20).
 * Players deposit here; the operator pays winnings and withdrawals out after
 * settling off-chain. Every movement emits an event so the ledger can be
 * reconciled against the chain.
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

    /// @notice The ERC-20 the house also settles in (USDT on BOT Chain).
    IERC20 public immutable token;

    event Deposited(address indexed user, address indexed asset, uint256 amount, uint256 timestamp);
    event Withdrawn(address indexed to, address indexed asset, uint256 amount, uint256 timestamp);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    /// @dev address(0) denotes the native coin in events.
    address public constant NATIVE = address(0);

    modifier onlyOwner() {
        require(msg.sender == owner, "StrikeTreasury: caller is not the owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "StrikeTreasury: contract is paused");
        _;
    }

    /// @param tokenAddress The ERC-20 the house settles in alongside the native coin.
    constructor(address tokenAddress) {
        require(tokenAddress != address(0), "StrikeTreasury: token is zero");
        owner = msg.sender;
        token = IERC20(tokenAddress);
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// @notice Deposit the native coin (BOT).
    function deposit() external payable whenNotPaused {
        require(msg.value > 0, "StrikeTreasury: amount is zero");
        emit Deposited(msg.sender, NATIVE, msg.value, block.timestamp);
    }

    /**
     * @notice Deposit the ERC-20 (USDT). Requires an allowance for this
     *         contract of at least `amount`.
     */
    function depositToken(uint256 amount) external whenNotPaused {
        require(amount > 0, "StrikeTreasury: amount is zero");
        // Checked rather than assumed: a token returning false instead of
        // reverting would otherwise credit a deposit that never arrived.
        require(
            token.transferFrom(msg.sender, address(this), amount),
            "StrikeTreasury: token transfer failed"
        );
        emit Deposited(msg.sender, address(token), amount, block.timestamp);
    }

    /// @notice A plain transfer is treated as a native deposit.
    receive() external payable {
        require(!paused, "StrikeTreasury: contract is paused");
        emit Deposited(msg.sender, NATIVE, msg.value, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Payouts
    // ---------------------------------------------------------------------

    /// @notice Pay native coin out to a player.
    function withdrawTo(address payable to, uint256 amount) external onlyOwner whenNotPaused {
        require(to != address(0), "StrikeTreasury: recipient is zero");
        require(amount > 0, "StrikeTreasury: amount is zero");
        require(address(this).balance >= amount, "StrikeTreasury: insufficient balance");

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "StrikeTreasury: native transfer failed");

        emit Withdrawn(to, NATIVE, amount, block.timestamp);
    }

    /// @notice Pay the ERC-20 out to a player.
    function withdrawTokenTo(address to, uint256 amount) external onlyOwner whenNotPaused {
        require(to != address(0), "StrikeTreasury: recipient is zero");
        require(amount > 0, "StrikeTreasury: amount is zero");
        require(
            token.balanceOf(address(this)) >= amount,
            "StrikeTreasury: insufficient token balance"
        );
        require(token.transfer(to, amount), "StrikeTreasury: token transfer failed");

        emit Withdrawn(to, address(token), amount, block.timestamp);
    }

    /// @notice Pay several players in one transaction.
    function withdrawBatch(
        address payable[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner whenNotPaused {
        require(recipients.length == amounts.length, "StrikeTreasury: length mismatch");
        require(recipients.length > 0, "StrikeTreasury: empty batch");

        for (uint256 i = 0; i < recipients.length; i++) {
            address payable to = recipients[i];
            uint256 amount = amounts[i];
            require(to != address(0), "StrikeTreasury: recipient is zero");
            require(amount > 0, "StrikeTreasury: amount is zero");
            require(address(this).balance >= amount, "StrikeTreasury: insufficient balance");

            (bool ok, ) = to.call{value: amount}("");
            require(ok, "StrikeTreasury: native transfer failed");

            emit Withdrawn(to, NATIVE, amount, block.timestamp);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

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
