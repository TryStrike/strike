// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Circle CCTP V2 (Arc Testnet: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA, domain 26).
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/**
 * @title StrikeTreasury v2
 * @notice House treasury for Strike binary options on Arc, settling in USDC or EURC.
 *
 * Deposits are plain token transfers to this address. The backend credits them
 * from the Transfer log, so there is no deposit function and no approval step.
 *
 * Two keys. The owner (cold) sets the operator, the caps, and can sweep or
 * unpause. The operator (the backend's hot key) can only pay out, under a
 * per-transaction and a per-day cap for each token, and commit round proofs.
 * A leaked operator key can move at most one day's cap, and either key can pause.
 *
 * Every payout carries a `ref` (withdrawal or bet id) so the ledger reconciles
 * against the chain from events alone.
 */
contract StrikeTreasury {
    error NotOwner();
    error NotOperator();
    error NotPendingOwner();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error TokenNotAllowed(address token);
    error LengthMismatch();
    error CapExceeded(uint256 requested, uint256 remaining);
    error TransferFailed();
    error RootAlreadyCommitted(uint256 epoch);

    struct Cap {
        uint128 perTx;
        uint128 perDay;
    }

    struct Spent {
        uint64 day;
        uint192 amount;
    }

    // owner and paused share one slot: every guarded call reads it once.
    address public owner;
    bool public paused;
    address public operator;
    address public pendingOwner;

    IERC20 public immutable usdc;
    IERC20 public immutable eurc;
    ITokenMessengerV2 public immutable tokenMessenger;

    mapping(address token => Cap) public caps;
    mapping(address token => Spent) public spent;
    /// Merkle root of the rounds settled in each epoch, committed by the operator.
    mapping(uint256 epoch => bytes32) public roundRoots;

    event Payout(address indexed token, address indexed to, uint256 amount, bytes32 indexed ref);
    event CrossChainPayout(bytes32 indexed mintRecipient, uint32 indexed domain, uint256 amount, uint256 maxFee, bytes32 indexed ref);
    event RoundsCommitted(uint256 indexed epoch, bytes32 root, uint256 rounds);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event CapSet(address indexed token, uint128 perTx, uint128 perDay);
    event OperatorSet(address indexed operator);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        if (paused) revert IsPaused();
        _;
    }

    constructor(address usdc_, address eurc_, address tokenMessenger_, address operator_) {
        if (usdc_ == address(0) || eurc_ == address(0) || tokenMessenger_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        operator = operator_;
        usdc = IERC20(usdc_);
        eurc = IERC20(eurc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorSet(operator_);
    }

    // ---------------------------------------------------------------------
    // Operator: payouts
    // ---------------------------------------------------------------------

    /// @notice Pay one player. A withdrawal fee is simply not sent: it stays here.
    function payout(address token, address to, uint256 amount, bytes32 ref) external onlyOperator {
        _spend(token, amount);
        _send(token, to, amount);
        emit Payout(token, to, amount, ref);
    }

    /// @notice Pay several players in one transaction. Checked against the caps as one total.
    function payoutBatch(address token, address[] calldata to, uint256[] calldata amounts, bytes32[] calldata refs)
        external
        onlyOperator
    {
        uint256 n = to.length;
        if (n == 0 || amounts.length != n || refs.length != n) revert LengthMismatch();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += amounts[i];
        }
        _spend(token, total);
        for (uint256 i; i < n; ++i) {
            _send(token, to[i], amounts[i]);
            emit Payout(token, to[i], amounts[i], refs[i]);
        }
    }

    /// @notice Pay a player on another chain through CCTP V2. USDC only.
    /// @param minFinalityThreshold 2000 for standard (finalized), 1000 for fast transfer.
    function payoutCrossChain(
        bytes32 mintRecipient,
        uint32 domain,
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes32 ref
    ) external onlyOperator {
        if (mintRecipient == bytes32(0)) revert ZeroAddress();
        _spend(address(usdc), amount);
        // Exact approval per payout: the messenger can never pull more than this one burn.
        if (!usdc.approve(address(tokenMessenger), amount)) revert TransferFailed();
        tokenMessenger.depositForBurn(amount, domain, mintRecipient, address(usdc), bytes32(0), maxFee, minFinalityThreshold);
        emit CrossChainPayout(mintRecipient, domain, amount, maxFee, ref);
    }

    // ---------------------------------------------------------------------
    // Operator: settlement proofs
    // ---------------------------------------------------------------------

    /// @notice Commit the Merkle root of one epoch of settled rounds. Write-once.
    function commitRounds(uint256 epoch, bytes32 root, uint256 rounds) external onlyOperator {
        if (roundRoots[epoch] != bytes32(0)) revert RootAlreadyCommitted(epoch);
        roundRoots[epoch] = root;
        emit RoundsCommitted(epoch, root, rounds);
    }

    /// @notice True when `leaf` is in the committed root of `epoch` (sorted-pair Merkle tree).
    function verifyRound(uint256 epoch, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = roundRoots[epoch];
        if (root == bytes32(0)) return false;
        bytes32 node = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            node = node < sibling
                ? keccak256(abi.encodePacked(node, sibling))
                : keccak256(abi.encodePacked(sibling, node));
        }
        return node == root;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice What the operator can still pay in `token` today.
    function remainingToday(address token) external view returns (uint256) {
        Spent memory s = spent[token];
        uint256 used = s.day == block.timestamp / 1 days ? s.amount : 0;
        uint256 cap = caps[token].perDay;
        return cap > used ? cap - used : 0;
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    function setCap(address token, uint128 perTx, uint128 perDay) external onlyOwner {
        _allowed(token);
        caps[token] = Cap(perTx, perDay);
        emit CapSet(token, perTx, perDay);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Move funds out without caps: fees to the fee wallet, or everything to a new treasury.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        _allowed(token);
        _send(token, to, amount);
        emit Swept(token, to, amount);
    }

    /// @notice Either key can stop payouts at once.
    function pause() external {
        if (msg.sender != owner && msg.sender != operator) revert NotOperator();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Only the owner can resume.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _allowed(address token) private view {
        if (token != address(usdc) && token != address(eurc)) revert TokenNotAllowed(token);
    }

    /// Checks the per-tx and per-day caps and books the spend. A token with no cap set pays nothing.
    function _spend(address token, uint256 amount) private {
        _allowed(token);
        if (amount == 0) revert ZeroAmount();
        Cap memory cap = caps[token];
        if (amount > cap.perTx) revert CapExceeded(amount, cap.perTx);
        uint64 today = uint64(block.timestamp / 1 days);
        Spent memory s = spent[token];
        uint256 used = s.day == today ? s.amount : 0;
        uint256 remaining = cap.perDay > used ? cap.perDay - used : 0;
        if (amount > remaining) revert CapExceeded(amount, remaining);
        spent[token] = Spent(today, uint192(used + amount));
    }

    /// The token reverts on a short balance, so there is no separate balance check.
    function _send(address token, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}
