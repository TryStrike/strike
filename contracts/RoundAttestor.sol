// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Single file so it pastes into Arc Studio. Context, Ownable (OpenZeppelin v5) and IERC165 are
// vendored flat, IReceiver and ReceiverTemplate come from smartcontractkit/cre-templates.

abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }
}

abstract contract Ownable is Context {
    address private _owner;

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(initialOwner);
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) revert OwnableUnauthorizedAccount(_msgSender());
    }

    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// Receives Chainlink CRE reports from the KeystoneForwarder.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// Official CRE consumer base. Only the forwarder may call `onReport`. Workflow id, author and
/// name checks are optional and off until the owner sets them.
abstract contract ReceiverTemplate is IReceiver, Ownable {
    address private s_forwarderAddress;
    address private s_expectedAuthor;
    bytes10 private s_expectedWorkflowName;
    bytes32 private s_expectedWorkflowId;

    bytes private constant HEX_CHARS = "0123456789abcdef";
    // workflowId (32) + workflowName (10) + workflowOwner (20). The production forwarder appends a
    // 2 byte reportId, so 64 bytes arrive there: the CRE docs say never require exactly 62.
    uint256 private constant METADATA_LENGTH = 62;

    error InvalidForwarderAddress();
    error InvalidSender(address sender, address expected);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error WorkflowNameRequiresAuthorValidation();
    error InvalidMetadataLength(uint256 received, uint256 expected);

    event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
    event ExpectedAuthorUpdated(address indexed previousAuthor, address indexed newAuthor);
    event ExpectedWorkflowNameUpdated(bytes10 indexed previousName, bytes10 indexed newName);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previousId, bytes32 indexed newId);

    constructor(address _forwarderAddress) Ownable(msg.sender) {
        if (_forwarderAddress == address(0)) revert InvalidForwarderAddress();
        s_forwarderAddress = _forwarderAddress;
        emit ForwarderAddressUpdated(address(0), _forwarderAddress);
    }

    function getForwarderAddress() external view returns (address) {
        return s_forwarderAddress;
    }

    function getExpectedAuthor() external view returns (address) {
        return s_expectedAuthor;
    }

    function getExpectedWorkflowName() external view returns (bytes10) {
        return s_expectedWorkflowName;
    }

    function getExpectedWorkflowId() external view returns (bytes32) {
        return s_expectedWorkflowId;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != s_forwarderAddress) revert InvalidSender(msg.sender, s_forwarderAddress);

        if (
            s_expectedWorkflowId != bytes32(0) || s_expectedAuthor != address(0) || s_expectedWorkflowName != bytes10(0)
        ) {
            (bytes32 workflowId, bytes10 workflowName, address workflowOwner) = _decodeMetadata(metadata);
            if (s_expectedWorkflowId != bytes32(0) && workflowId != s_expectedWorkflowId) {
                revert InvalidWorkflowId(workflowId, s_expectedWorkflowId);
            }
            if (s_expectedAuthor != address(0) && workflowOwner != s_expectedAuthor) {
                revert InvalidAuthor(workflowOwner, s_expectedAuthor);
            }
            // Names are bytes10 and unique only per owner, so a name check needs the author check too.
            if (s_expectedWorkflowName != bytes10(0)) {
                if (s_expectedAuthor == address(0)) revert WorkflowNameRequiresAuthorValidation();
                if (workflowName != s_expectedWorkflowName) {
                    revert InvalidWorkflowName(workflowName, s_expectedWorkflowName);
                }
            }
        }

        _processReport(report);
    }

    function setForwarderAddress(address _forwarder) external onlyOwner {
        if (_forwarder == address(0)) revert InvalidForwarderAddress();
        address previousForwarder = s_forwarderAddress;
        s_forwarderAddress = _forwarder;
        emit ForwarderAddressUpdated(previousForwarder, _forwarder);
    }

    function setExpectedAuthor(address _author) external onlyOwner {
        if (_author == address(0) && s_expectedWorkflowName != bytes10(0)) {
            revert WorkflowNameRequiresAuthorValidation();
        }
        address previousAuthor = s_expectedAuthor;
        s_expectedAuthor = _author;
        emit ExpectedAuthorUpdated(previousAuthor, _author);
    }

    /// Stores the first 10 hex chars of sha256(name), the way the forwarder encodes the name.
    function setExpectedWorkflowName(string calldata _name) external onlyOwner {
        bytes10 previousName = s_expectedWorkflowName;
        if (bytes(_name).length == 0) {
            s_expectedWorkflowName = bytes10(0);
            emit ExpectedWorkflowNameUpdated(previousName, bytes10(0));
            return;
        }
        if (s_expectedAuthor == address(0)) revert WorkflowNameRequiresAuthorValidation();
        bytes memory hexString = _bytesToHexString(abi.encodePacked(sha256(bytes(_name))));
        bytes memory first10 = new bytes(10);
        for (uint256 i = 0; i < 10; i++) {
            first10[i] = hexString[i];
        }
        s_expectedWorkflowName = bytes10(first10);
        emit ExpectedWorkflowNameUpdated(previousName, s_expectedWorkflowName);
    }

    function setExpectedWorkflowId(bytes32 _id) external onlyOwner {
        bytes32 previousId = s_expectedWorkflowId;
        s_expectedWorkflowId = _id;
        emit ExpectedWorkflowIdUpdated(previousId, _id);
    }

    function _bytesToHexString(bytes memory data) private pure returns (bytes memory) {
        bytes memory hexString = new bytes(data.length * 2);
        for (uint256 i = 0; i < data.length; i++) {
            hexString[i * 2] = HEX_CHARS[uint8(data[i] >> 4)];
            hexString[i * 2 + 1] = HEX_CHARS[uint8(data[i] & 0x0f)];
        }
        return hexString;
    }

    function _decodeMetadata(bytes memory metadata)
        internal
        pure
        returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    {
        if (metadata.length < METADATA_LENGTH) revert InvalidMetadataLength(metadata.length, METADATA_LENGTH);
        assembly {
            workflowId := mload(add(metadata, 32))
            workflowName := mload(add(metadata, 64))
            workflowOwner := shr(mul(12, 8), mload(add(metadata, 74)))
        }
    }

    function _processReport(bytes calldata report) internal virtual;

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}

interface IRoundRoots {
    function roundRoots(uint256 epoch) external view returns (bytes32);
}

/**
 * @title RoundAttestor
 * @notice Chainlink CRE's verdict on each epoch of Strike rounds. The workflow re-settles every
 * round the house committed in `StrikeTreasury.commitRounds` from Binance klines, rebuilds the
 * Merkle root, reads the treasury's USDC, and reports here. One verdict per epoch, never
 * overwritten. Holds no funds and has no power over the treasury.
 */
contract RoundAttestor is ReceiverTemplate {
    uint64 public constant ARC_TESTNET_SELECTOR = 3034092155422581607;

    IRoundRoots public immutable treasury;

    struct Attestation {
        bytes32 root;
        uint32 checked;
        uint32 mismatches;
        uint32 skipped;
        uint128 usdcBalance;
        uint128 liabilities;
        uint64 attestedAt;
    }

    mapping(uint256 epoch => Attestation) public attestations;

    event EpochAttested(uint256 indexed epoch, bytes32 root, uint32 checked, uint32 mismatches, uint32 skipped);
    event HouseMismatch(uint256 indexed epoch, bytes32 houseRoot, bytes32 creRoot, uint32 mismatches);
    event Undercollateralized(uint256 indexed epoch, uint256 usdcBalance, uint256 liabilities);

    error WrongChain(uint64 selector);
    error AlreadyAttested(uint256 epoch);
    error EmptyRoot();
    error ZeroTreasury();

    constructor(address forwarder, address treasury_) ReceiverTemplate(forwarder) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = IRoundRoots(treasury_);
    }

    /// Report: abi.encode(uint64 chainSelector, uint256 epoch, bytes32 root, uint32 checked,
    /// uint32 mismatches, uint32 skipped, uint128 usdcBalance, uint128 liabilities). USDC amounts
    /// use 6 decimals. Signatures don't bind a chain, so the selector in the payload does.
    function _processReport(bytes calldata report) internal override {
        (
            uint64 selector,
            uint256 epoch,
            bytes32 root,
            uint32 checked,
            uint32 mismatches,
            uint32 skipped,
            uint128 usdcBalance,
            uint128 liabilities
        ) = abi.decode(report, (uint64, uint256, bytes32, uint32, uint32, uint32, uint128, uint128));
        if (selector != ARC_TESTNET_SELECTOR) revert WrongChain(selector);
        if (root == bytes32(0)) revert EmptyRoot();
        if (attestations[epoch].root != bytes32(0)) revert AlreadyAttested(epoch);

        attestations[epoch] =
            Attestation(root, checked, mismatches, skipped, usdcBalance, liabilities, uint64(block.timestamp));
        emit EpochAttested(epoch, root, checked, mismatches, skipped);

        bytes32 houseRoot = treasury.roundRoots(epoch);
        if (mismatches > 0 || houseRoot != root) emit HouseMismatch(epoch, houseRoot, root, mismatches);
        if (usdcBalance < liabilities) emit Undercollateralized(epoch, usdcBalance, liabilities);
    }
}
