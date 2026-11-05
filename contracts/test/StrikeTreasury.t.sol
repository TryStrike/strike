// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrikeTreasury} from "../StrikeTreasury.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
}

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool c) internal pure {
        require(c, "assertTrue failed");
    }

    function assertFalse(bool c) internal pure {
        require(!c, "assertFalse failed");
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint) failed");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address) failed");
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "assertEq(bytes32) failed");
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract MockMessenger {
    struct Call {
        uint256 amount;
        uint32 domain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinality;
        address caller;
    }

    Call[] public calls;

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function depositForBurn(uint256 a, uint32 d, bytes32 r, address t, bytes32 dc, uint256 mf, uint32 mfin) external {
        calls.push(Call(a, d, r, t, dc, mf, mfin, msg.sender));
    }
}

contract StrikeTreasuryTest is Test {
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

    StrikeTreasury internal t;
    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockERC20 internal other;
    MockMessenger internal msgr;

    address internal owner = address(0xA11CE);
    address internal operator = address(0xB0B);
    address internal alice = address(0xA1);
    address internal bob = address(0xB2);
    address internal outsider = address(0xDEAD);

    uint128 internal constant PER_TX = 100e6;
    uint128 internal constant PER_DAY = 250e6;
    bytes32 internal constant REF = keccak256("ref");

    function setUp() public {
        vm.warp(10 days);
        usdc = new MockERC20();
        eurc = new MockERC20();
        other = new MockERC20();
        msgr = new MockMessenger();
        t = new StrikeTreasury(address(usdc), address(eurc), address(msgr), owner, operator);
        usdc.mint(address(t), 10_000e6);
        eurc.mint(address(t), 10_000e6);
        other.mint(address(t), 10_000e6);
        vm.startPrank(owner);
        t.setCap(address(usdc), PER_TX, PER_DAY);
        t.setCap(address(eurc), PER_TX, PER_DAY);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- constructor
    function test_ConstructorState() public {
        assertEq(t.owner(), owner);
        assertEq(t.operator(), operator);
        assertEq(address(t.usdc()), address(usdc));
        assertEq(address(t.eurc()), address(eurc));
        assertEq(address(t.tokenMessenger()), address(msgr));
        assertEq(t.pendingOwner(), address(0));
        assertFalse(t.paused());
    }

    function test_ConstructorEmitsEvents() public {
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, false, false, false);
        emit OperatorSet(operator);
        new StrikeTreasury(address(usdc), address(eurc), address(msgr), owner, operator);
    }

    function test_ConstructorZeroAddressReverts() public {
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        new StrikeTreasury(address(0), address(eurc), address(msgr), owner, operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        new StrikeTreasury(address(usdc), address(0), address(msgr), owner, operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        new StrikeTreasury(address(usdc), address(eurc), address(0), owner, operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        new StrikeTreasury(address(usdc), address(eurc), address(msgr), address(0), operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        new StrikeTreasury(address(usdc), address(eurc), address(msgr), owner, address(0));
    }

    function test_ZeroOwnerReverts() public {
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        new StrikeTreasury(address(usdc), address(eurc), address(msgr), address(0), operator);
    }

    function test_OwnerIsOwnerArgNotDeployer() public {
        address deployer = address(0xDE91);
        vm.prank(deployer);
        StrikeTreasury t2 = new StrikeTreasury(address(usdc), address(eurc), address(msgr), owner, operator);
        assertEq(t2.owner(), owner);
        assertTrue(t2.owner() != deployer);
        // the deployer has no owner rights
        vm.prank(deployer);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t2.setCap(address(usdc), 1, 1);
        // the owner does
        vm.prank(owner);
        t2.setCap(address(usdc), 1, 1);
    }

    function test_OwnerAndOperatorMayBeTheSameAddress() public {
        StrikeTreasury t2 = new StrikeTreasury(address(usdc), address(eurc), address(msgr), operator, operator);
        assertEq(t2.owner(), operator);
        assertEq(t2.operator(), operator);
        vm.prank(operator);
        t2.pause();
        vm.prank(operator);
        t2.unpause();
        assertFalse(t2.paused());
    }

    // ---------------------------------------------------------------- payout
    function test_PayoutHappyPathEmitsAndTransfers() public {
        vm.expectEmit(true, true, true, true);
        emit Payout(address(usdc), alice, 40e6, REF);
        vm.prank(operator);
        t.payout(address(usdc), alice, 40e6, REF);
        assertEq(usdc.balanceOf(alice), 40e6);
        assertEq(usdc.balanceOf(address(t)), 10_000e6 - 40e6);
        assertEq(t.remainingToday(address(usdc)), PER_DAY - 40e6);
    }

    function test_PayoutEurcWorks() public {
        vm.prank(operator);
        t.payout(address(eurc), alice, PER_TX, REF);
        assertEq(eurc.balanceOf(alice), PER_TX);
    }

    function test_PayoutAtPerTxCapOk() public {
        vm.prank(operator);
        t.payout(address(usdc), alice, PER_TX, REF);
        assertEq(usdc.balanceOf(alice), PER_TX);
    }

    function test_PayoutOverPerTxReverts() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(PER_TX) + 1, uint256(PER_TX)));
        t.payout(address(usdc), alice, uint256(PER_TX) + 1, REF);
    }

    function test_PayoutOverPerDayReverts() public {
        vm.startPrank(operator);
        t.payout(address(usdc), alice, PER_TX, REF);
        t.payout(address(usdc), alice, PER_TX, REF);
        // 200 used, 50 remaining
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(PER_TX), uint256(50e6)));
        t.payout(address(usdc), alice, PER_TX, REF);
        // exactly remaining is ok
        t.payout(address(usdc), alice, 50e6, REF);
        assertEq(t.remainingToday(address(usdc)), 0);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(1), uint256(0)));
        t.payout(address(usdc), alice, 1, REF);
        vm.stopPrank();
    }

    function test_PerDayCapIsPerToken() public {
        vm.startPrank(operator);
        t.payout(address(usdc), alice, PER_TX, REF);
        t.payout(address(usdc), alice, PER_TX, REF);
        t.payout(address(usdc), alice, 50e6, REF);
        // eurc untouched
        t.payout(address(eurc), alice, PER_TX, REF);
        vm.stopPrank();
        assertEq(t.remainingToday(address(eurc)), PER_DAY - PER_TX);
    }

    function test_CapResetsNextDay() public {
        vm.startPrank(operator);
        t.payout(address(usdc), alice, PER_TX, REF);
        t.payout(address(usdc), alice, PER_TX, REF);
        t.payout(address(usdc), alice, 50e6, REF);
        assertEq(t.remainingToday(address(usdc)), 0);
        vm.warp(block.timestamp + 1 days);
        assertEq(t.remainingToday(address(usdc)), PER_DAY);
        t.payout(address(usdc), alice, PER_TX, REF);
        assertEq(t.remainingToday(address(usdc)), PER_DAY - PER_TX);
        vm.stopPrank();
    }

    function test_NoCapSetPaysNothing() public {
        // fresh treasury: caps default to 0
        vm.prank(owner);
        StrikeTreasury t2 = new StrikeTreasury(address(usdc), address(eurc), address(msgr), owner, operator);
        usdc.mint(address(t2), 1_000e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(1), uint256(0)));
        t2.payout(address(usdc), alice, 1, REF);
        assertEq(t2.remainingToday(address(usdc)), 0);
    }

    function test_PayoutTokenNotAllowedReverts() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.TokenNotAllowed.selector, address(other)));
        t.payout(address(other), alice, 1, REF);
    }

    function test_PayoutZeroAmountReverts() public {
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAmount.selector);
        t.payout(address(usdc), alice, 0, REF);
    }

    function test_PayoutZeroRecipientReverts() public {
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.payout(address(usdc), address(0), 1, REF);
    }

    function test_FailedPayoutDoesNotConsumeCap() public {
        vm.startPrank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.payout(address(usdc), address(0), 10e6, REF);
        vm.stopPrank();
        assertEq(t.remainingToday(address(usdc)), PER_DAY);
    }

    // ---------------------------------------------------------------- payoutBatch
    function _batch(uint256 a, uint256 b, uint256 c)
        internal
        view
        returns (address[] memory to, uint256[] memory amts, bytes32[] memory refs)
    {
        to = new address[](3);
        amts = new uint256[](3);
        refs = new bytes32[](3);
        to[0] = alice;
        to[1] = bob;
        to[2] = alice;
        amts[0] = a;
        amts[1] = b;
        amts[2] = c;
        refs[0] = keccak256("r0");
        refs[1] = keccak256("r1");
        refs[2] = keccak256("r2");
    }

    function test_BatchPaysAndEmitsPerRecipient() public {
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(10e6, 20e6, 30e6);
        for (uint256 i; i < 3; i++) {
            vm.expectEmit(true, true, true, true);
            emit Payout(address(usdc), to[i], amts[i], refs[i]);
        }
        vm.prank(operator);
        t.payoutBatch(address(usdc), to, amts, refs);
        assertEq(usdc.balanceOf(alice), 40e6);
        assertEq(usdc.balanceOf(bob), 20e6);
        assertEq(t.remainingToday(address(usdc)), PER_DAY - 60e6);
    }

    function test_BatchTotalCheckedAgainstPerTx() public {
        // each item under perTx but total 180 > 100
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(60e6, 60e6, 60e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(180e6), uint256(PER_TX)));
        t.payoutBatch(address(usdc), to, amts, refs);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_BatchTotalCheckedAgainstPerDay() public {
        vm.startPrank(operator);
        t.payout(address(usdc), alice, PER_TX, REF);
        t.payout(address(usdc), alice, PER_TX, REF);
        // 50 remaining; batch total 60
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(20e6, 20e6, 20e6);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(60e6), uint256(50e6)));
        t.payoutBatch(address(usdc), to, amts, refs);
        vm.stopPrank();
    }

    function test_BatchLengthMismatchReverts() public {
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(1, 2, 3);
        uint256[] memory shortAmts = new uint256[](2);
        bytes32[] memory shortRefs = new bytes32[](2);
        vm.startPrank(operator);
        vm.expectRevert(StrikeTreasury.LengthMismatch.selector);
        t.payoutBatch(address(usdc), to, shortAmts, refs);
        vm.expectRevert(StrikeTreasury.LengthMismatch.selector);
        t.payoutBatch(address(usdc), to, amts, shortRefs);
        vm.stopPrank();
    }

    function test_BatchEmptyReverts() public {
        address[] memory to = new address[](0);
        uint256[] memory amts = new uint256[](0);
        bytes32[] memory refs = new bytes32[](0);
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.LengthMismatch.selector);
        t.payoutBatch(address(usdc), to, amts, refs);
    }

    function test_BatchTokenNotAllowedAndNoCap() public {
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(1, 2, 3);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.TokenNotAllowed.selector, address(other)));
        t.payoutBatch(address(other), to, amts, refs);

        vm.prank(owner);
        StrikeTreasury t2 = new StrikeTreasury(address(usdc), address(eurc), address(msgr), owner, operator);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(6), uint256(0)));
        t2.payoutBatch(address(usdc), to, amts, refs);
    }

    function test_BatchZeroTotalAndZeroRecipientRevert() public {
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(0, 0, 0);
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAmount.selector);
        t.payoutBatch(address(usdc), to, amts, refs);

        (to, amts, refs) = _batch(1, 2, 3);
        to[1] = address(0);
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.payoutBatch(address(usdc), to, amts, refs);
    }

    // ---------------------------------------------------------------- payoutCrossChain
    function test_CrossChainCallsMessengerWithCorrectArgs() public {
        bytes32 mr = bytes32(uint256(uint160(alice)));
        vm.expectEmit(true, true, true, true);
        emit CrossChainPayout(mr, 6, 50e6, 1e5, REF);
        vm.prank(operator);
        t.payoutCrossChain(mr, 6, 50e6, 1e5, 1000, REF);

        assertEq(msgr.callCount(), 1);
        (
            uint256 amount,
            uint32 domain,
            bytes32 mintRecipient,
            address burnToken,
            bytes32 destCaller,
            uint256 maxFee,
            uint32 minFinality,
            address caller
        ) = msgr.calls(0);
        assertEq(amount, 50e6);
        assertEq(uint256(domain), 6);
        assertEq(mintRecipient, mr);
        assertEq(burnToken, address(usdc));
        assertEq(destCaller, bytes32(0));
        assertEq(maxFee, 1e5);
        assertEq(uint256(minFinality), 1000);
        assertEq(caller, address(t));
        // approval is exactly the amount; mock pulls nothing
        assertEq(usdc.allowance(address(t), address(msgr)), 50e6);
        assertEq(usdc.balanceOf(address(t)), 10_000e6);
    }

    function test_CrossChainCountsAgainstUsdcCaps() public {
        bytes32 mr = bytes32(uint256(1));
        vm.startPrank(operator);
        t.payoutCrossChain(mr, 1, PER_TX, 0, 1000, REF);
        assertEq(t.remainingToday(address(usdc)), PER_DAY - PER_TX);
        t.payout(address(usdc), alice, PER_TX, REF);
        // 200 used -> 50 remaining
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(60e6), uint256(50e6)));
        t.payoutCrossChain(mr, 1, 60e6, 0, 1000, REF);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.CapExceeded.selector, uint256(PER_TX) + 1, uint256(PER_TX)));
        t.payoutCrossChain(mr, 1, uint256(PER_TX) + 1, 0, 1000, REF);
        vm.stopPrank();
        assertEq(msgr.callCount(), 1);
    }

    function test_CrossChainZeroMintRecipientReverts() public {
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.payoutCrossChain(bytes32(0), 1, 1e6, 0, 1000, REF);
    }

    function test_CrossChainZeroAmountReverts() public {
        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.ZeroAmount.selector);
        t.payoutCrossChain(bytes32(uint256(1)), 1, 0, 0, 1000, REF);
    }

    // ---------------------------------------------------------------- rounds
    function _h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_CommitRoundsWriteOnceAndEmits() public {
        bytes32 root = keccak256("root");
        vm.expectEmit(true, false, false, true);
        emit RoundsCommitted(7, root, 4);
        vm.prank(operator);
        t.commitRounds(7, root, 4);
        assertEq(t.roundRoots(7), root);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.RootAlreadyCommitted.selector, uint256(7)));
        t.commitRounds(7, keccak256("other"), 1);
        assertEq(t.roundRoots(7), root);

        // different epoch fine
        vm.prank(operator);
        t.commitRounds(8, keccak256("root8"), 1);
    }

    function test_VerifyRoundMerkle4Leaves() public {
        bytes32[4] memory l = [keccak256("l0"), keccak256("l1"), keccak256("l2"), keccak256("l3")];
        bytes32 p01 = _h(l[0], l[1]);
        bytes32 p23 = _h(l[2], l[3]);
        bytes32 root = _h(p01, p23);
        vm.prank(operator);
        t.commitRounds(1, root, 4);

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l[1];
        proof[1] = p23;
        assertTrue(t.verifyRound(1, l[0], proof));

        proof[0] = l[0];
        assertTrue(t.verifyRound(1, l[1], proof));

        proof[0] = l[3];
        proof[1] = p01;
        assertTrue(t.verifyRound(1, l[2], proof));

        proof[0] = l[2];
        assertTrue(t.verifyRound(1, l[3], proof));
    }

    function test_VerifyRoundWrongLeafFalse() public {
        bytes32[4] memory l = [keccak256("l0"), keccak256("l1"), keccak256("l2"), keccak256("l3")];
        bytes32 p23 = _h(l[2], l[3]);
        vm.prank(operator);
        t.commitRounds(1, _h(_h(l[0], l[1]), p23), 4);

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l[1];
        proof[1] = p23;
        assertFalse(t.verifyRound(1, keccak256("bogus"), proof));
        // right leaf, wrong proof
        proof[0] = l[2];
        assertFalse(t.verifyRound(1, l[0], proof));
    }

    function test_VerifyRoundUncommittedEpochFalse() public {
        bytes32[] memory proof = new bytes32[](0);
        // even a zero leaf with empty proof must not verify against an empty root
        assertFalse(t.verifyRound(99, bytes32(0), proof));
        assertFalse(t.verifyRound(99, keccak256("x"), proof));
    }

    // ---------------------------------------------------------------- pause
    function test_OperatorAndOwnerCanPause() public {
        vm.expectEmit(true, false, false, false);
        emit Paused(operator);
        vm.prank(operator);
        t.pause();
        assertTrue(t.paused());

        vm.prank(owner);
        t.unpause();
        assertFalse(t.paused());

        vm.expectEmit(true, false, false, false);
        emit Paused(owner);
        vm.prank(owner);
        t.pause();
        assertTrue(t.paused());
    }

    function test_OutsiderCannotPause() public {
        vm.prank(outsider);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.pause();
    }

    function test_OnlyOwnerUnpauses() public {
        vm.prank(operator);
        t.pause();

        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.unpause();
        vm.prank(outsider);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.unpause();

        vm.expectEmit(true, false, false, false);
        emit Unpaused(owner);
        vm.prank(owner);
        t.unpause();
        assertFalse(t.paused());
    }

    function test_OperatorActionsRevertWhilePaused() public {
        vm.prank(owner);
        t.pause();
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(1, 2, 3);
        vm.startPrank(operator);
        vm.expectRevert(StrikeTreasury.IsPaused.selector);
        t.payout(address(usdc), alice, 1, REF);
        vm.expectRevert(StrikeTreasury.IsPaused.selector);
        t.payoutBatch(address(usdc), to, amts, refs);
        vm.expectRevert(StrikeTreasury.IsPaused.selector);
        t.payoutCrossChain(bytes32(uint256(1)), 1, 1, 0, 1000, REF);
        vm.expectRevert(StrikeTreasury.IsPaused.selector);
        t.commitRounds(1, keccak256("r"), 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 0);

        // after unpause it works again
        vm.prank(owner);
        t.unpause();
        vm.prank(operator);
        t.payout(address(usdc), alice, 1, REF);
        assertEq(usdc.balanceOf(alice), 1);
    }

    function test_OwnerFunctionsStillWorkWhilePaused() public {
        vm.prank(operator);
        t.pause();
        vm.prank(owner);
        t.setCap(address(usdc), 5, 6);
        vm.prank(owner);
        t.sweep(address(usdc), alice, 1);
        assertEq(usdc.balanceOf(alice), 1);
    }

    // ---------------------------------------------------------------- access control
    function test_OperatorCannotCallOwnerFunctions() public {
        vm.startPrank(operator);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.setCap(address(usdc), 1, 1);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.setOperator(alice);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.sweep(address(usdc), alice, 1);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.transferOwnership(alice);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.unpause();
        vm.stopPrank();
    }

    function test_OutsiderCannotCallAnything() public {
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(1, 2, 3);
        vm.startPrank(outsider);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.setCap(address(usdc), 1, 1);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.payout(address(usdc), alice, 1, REF);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.payoutBatch(address(usdc), to, amts, refs);
        vm.stopPrank();
    }

    function test_OwnerCannotCallOperatorFunctions() public {
        (address[] memory to, uint256[] memory amts, bytes32[] memory refs) = _batch(1, 2, 3);
        vm.startPrank(owner);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.payout(address(usdc), alice, 1, REF);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.payoutBatch(address(usdc), to, amts, refs);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.payoutCrossChain(bytes32(uint256(1)), 1, 1, 0, 1000, REF);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.commitRounds(1, keccak256("r"), 1);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- owner config
    function test_SweepMovesAllowedToken() public {
        vm.expectEmit(true, true, false, true);
        emit Swept(address(eurc), bob, 123e6);
        vm.prank(owner);
        t.sweep(address(eurc), bob, 123e6);
        assertEq(eurc.balanceOf(bob), 123e6);
        assertEq(eurc.balanceOf(address(t)), 10_000e6 - 123e6);
        // sweep is not subject to caps
        vm.prank(owner);
        t.sweep(address(usdc), bob, 5_000e6);
        assertEq(usdc.balanceOf(bob), 5_000e6);
    }

    function test_SweepDisallowedTokenReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.TokenNotAllowed.selector, address(other)));
        t.sweep(address(other), bob, 1);
    }

    function test_SweepZeroRecipientReverts() public {
        vm.prank(owner);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.sweep(address(usdc), address(0), 1);
    }

    function test_SetCapEmitsAndStores() public {
        vm.expectEmit(true, false, false, true);
        emit CapSet(address(usdc), 7, 9);
        vm.prank(owner);
        t.setCap(address(usdc), 7, 9);
        (uint128 perTx, uint128 perDay) = t.caps(address(usdc));
        assertEq(uint256(perTx), 7);
        assertEq(uint256(perDay), 9);
        assertEq(t.remainingToday(address(usdc)), 9);
    }

    function test_SetCapDisallowedTokenReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrikeTreasury.TokenNotAllowed.selector, address(other)));
        t.setCap(address(other), 1, 1);
    }

    function test_SetOperatorEmitsAndSwitches() public {
        vm.expectEmit(true, false, false, false);
        emit OperatorSet(alice);
        vm.prank(owner);
        t.setOperator(alice);
        assertEq(t.operator(), alice);

        vm.prank(operator);
        vm.expectRevert(StrikeTreasury.NotOperator.selector);
        t.payout(address(usdc), bob, 1, REF);
        vm.prank(alice);
        t.payout(address(usdc), bob, 1, REF);
        assertEq(usdc.balanceOf(bob), 1);
    }

    function test_SetOperatorZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.setOperator(address(0));
    }

    // ---------------------------------------------------------------- ownership
    function test_TwoStepOwnership() public {
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferStarted(owner, alice);
        vm.prank(owner);
        t.transferOwnership(alice);
        assertEq(t.pendingOwner(), alice);
        assertEq(t.owner(), owner);

        vm.prank(bob);
        vm.expectRevert(StrikeTreasury.NotPendingOwner.selector);
        t.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(StrikeTreasury.NotPendingOwner.selector);
        t.acceptOwnership();

        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, alice);
        vm.prank(alice);
        t.acceptOwnership();
        assertEq(t.owner(), alice);
        assertEq(t.pendingOwner(), address(0));

        // old owner lost rights
        vm.startPrank(owner);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.setCap(address(usdc), 1, 1);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.transferOwnership(owner);
        vm.expectRevert(StrikeTreasury.NotOwner.selector);
        t.unpause();
        vm.stopPrank();

        // new owner has rights
        vm.prank(alice);
        t.setCap(address(usdc), 1, 1);

        // pending cleared: nobody can accept again
        vm.prank(alice);
        vm.expectRevert(StrikeTreasury.NotPendingOwner.selector);
        t.acceptOwnership();
    }

    function test_AcceptWithNoPendingRevertsForZeroAdjacent() public {
        vm.prank(outsider);
        vm.expectRevert(StrikeTreasury.NotPendingOwner.selector);
        t.acceptOwnership();
    }

    function test_TransferOwnershipZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(StrikeTreasury.ZeroAddress.selector);
        t.transferOwnership(address(0));
    }

    function test_TransferOwnershipCanBeOverwrittenBeforeAccept() public {
        vm.startPrank(owner);
        t.transferOwnership(alice);
        t.transferOwnership(bob);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(StrikeTreasury.NotPendingOwner.selector);
        t.acceptOwnership();
        vm.prank(bob);
        t.acceptOwnership();
        assertEq(t.owner(), bob);
    }
}
