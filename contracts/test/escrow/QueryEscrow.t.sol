// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {QueryEscrow} from "@mochi/QueryEscrow.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {ISchemaRegistry} from "@mochi/interfaces/ISchemaRegistry.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MockShieldedPayments} from "@mochi/mocks/MockShieldedPayments.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";
import {MockSchemas} from "./mocks/MockSchemas.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";
import {MockStaking} from "./mocks/MockStaking.sol";

contract QueryEscrowTest is Test {
    event ReviewProtocolRecipientSet(address indexed previousRecipient, address indexed newRecipient);
    event ReviewProtocolRevenueSettled(bytes32 indexed queryId, address indexed recipient, uint256 amount);
    uint256 constant INTAKE_PK = 0xA11CE;
    uint256 constant ANONYMA_PK = 0xB0B;
    address intake;
    address constant OP0 = address(0x101);
    address constant OP1 = address(0x102);
    address constant OP2 = address(0x103);
    address constant PANEL = address(0x200);
    MockUSDG token;
    MockRegistry registry;
    MockSchemas schemas;
    MockRandomness randomness;
    MockShieldedPayments shielded;
    MockStaking staking;
    QueryEscrow escrow;

    function setUp() public {
        intake = vm.addr(INTAKE_PK);
        token = new MockUSDG();
        registry = new MockRegistry();
        schemas = new MockSchemas();
        randomness = new MockRandomness();
        shielded = new MockShieldedPayments(token);
        staking = new MockStaking(token);
        escrow = new QueryEscrow(
            address(this),
            token,
            IJurorRegistry(address(registry)),
            ISchemaRegistry(address(schemas)),
            IRandomness(address(randomness))
        );
        schemas.setLatest(1, 1);
        registry.setActive(intake, MochiTypes.Role.INTAKE, true);
        registry.setPreset(0, address(0x11));
        registry.setPreset(1, address(0x12));
        registry.setPreset(2, address(0x13));
        registry.setPreset(3, address(0x14));
        registry.setPreset(4, address(0x15));
        registry.setPreset(5, address(0x16));
        registry.setPreset(6, address(0x17));
        registry.setPreset(7, address(0x18));
        registry.setPreset(8, address(0x19));
        registry.setOperator(address(0x11), OP0);
        registry.setOperator(address(0x12), OP1);
        registry.setOperator(address(0x13), OP2);
        for (uint8 i; i < 5; ++i) {
            escrow.setClassPrice(MochiTypes.JurorClass(i), 100_000, 1_000);
        }
        escrow.setStaking(IMochiStaking(address(staking)));
        escrow.setPanel(PANEL);
        escrow.setVerdicts(address(this));
        escrow.setShielded(shielded);
        escrow.setAnonymaSigner(vm.addr(ANONYMA_PK));
        token.mint(address(this), 10_000_000);
        token.approve(address(escrow), type(uint256).max);
        token.approve(address(shielded), type(uint256).max);
    }

    function _prov(bytes32 doc, uint32 tokensK, uint8 kind) internal pure returns (MochiTypes.Provenance memory p) {
        p = MochiTypes.Provenance(doc, kind, bytes32(uint256(9)), 0, tokensK, bytes32(0));
    }

    function _sig(MochiTypes.Provenance memory p) internal view returns (bytes memory sig) {
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), MochiTypes.hashProvenance(p)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(INTAKE_PK, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _voucher(bytes32 id, bytes32 docCommit, uint32 schemaId, uint8 n, uint256 maxAmount, uint64 expiry)
        internal
        view
        returns (MochiTypes.AnonymaVoucher memory v, bytes memory signature)
    {
        v = MochiTypes.AnonymaVoucher(id, docCommit, schemaId, n, maxAmount, 1, expiry);
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), MochiTypes.hashAnonymaVoucher(v)));
        (uint8 v_, bytes32 r, bytes32 s) = vm.sign(ANONYMA_PK, digest);
        signature = abi.encodePacked(r, s, v_);
    }

    function _params(uint8 n, uint64 nonce, address refundTo) internal pure returns (MochiTypes.OpenParams memory p) {
        p = MochiTypes.OpenParams(1, n, false, false, bytes32(0), bytes32(0), refundTo, nonce);
    }

    function _open(uint8 n, uint64 nonce, MochiTypes.PayPath path) internal returns (bytes32 id) {
        if (path == MochiTypes.PayPath.SHIELDED) return _openShielded(n, nonce);
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(100 + nonce)), 2, 0);
        bytes memory sig = _sig(p);
        MochiTypes.OpenParams memory args = _params(n, nonce, address(this));
        if (path == MochiTypes.PayPath.USDG) id = escrow.openWithUSDG(args, p, sig);
    }

    function _openShielded(uint8 n, uint64 nonce) internal returns (bytes32 id) {
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(100 + nonce)), 2, 0);
        bytes memory sig = _sig(p);
        uint256 cost = _quoteTotal(n, 2);
        shielded.fund(cost);
        bytes32 nullifier = bytes32(uint256(1000 + nonce));
        bytes32 context = escrow.computeQueryId(address(this), p.docCommit, nonce);
        bytes memory proof = abi.encode(nullifier, cost, address(escrow), context);
        id = escrow.openShielded(_params(n, nonce, address(this)), p, sig, nullifier, proof);
    }

    function _quoteTotal(uint8 n, uint32 tokensK) internal view returns (uint256) {
        (uint256 a, uint256 b) = escrow.quote(1, n, tokensK);
        return a + b;
    }

    function _seal(bytes32 id) internal {
        MochiTypes.Query memory q = escrow.getQuery(id);
        vm.roll(uint256(q.sealBlock) + 1);
        escrow.seal(id);
    }

    function testQuoteUsesClassMixScalingAndMinimumFee() public {
        escrow.setClassPrice(MochiTypes.JurorClass.LARGE_A, 10, 1);
        escrow.setClassPrice(MochiTypes.JurorClass.DOC_SPECIALIST, 20, 2);
        escrow.setClassPrice(MochiTypes.JurorClass.DISSENTER, 30, 3);
        (uint256 jurors, uint256 fee) = escrow.quote(1, 3, 2);
        assertEq(jurors, 72);
        assertEq(fee, 10_000);
        escrow.setProtocolFee(10_000, 0);
        (, fee) = escrow.quote(1, 3, 2);
        assertEq(fee, 72);
    }

    function testOpenSealVerdictSettlementAndClaim() public {
        assertEq(escrow.reviewProtocolRecipient(), address(0));
        bytes32 id = _open(3, 1, MochiTypes.PayPath.USDG);
        uint256 starting = token.balanceOf(address(escrow));
        assertEq(starting, _quoteTotal(3, 2));
        _seal(id);
        assertEq(escrow.jurorsOf(id).length, 3);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.VERDICT, 4);
        uint256 fee0 = escrow.seatFeeOf(id, 0);
        uint256 fee1 = escrow.seatFeeOf(id, 1);
        uint256 fee2 = escrow.seatFeeOf(id, 2);
        assertEq(escrow.claimable(OP0), fee0);
        assertEq(escrow.claimable(OP1), fee1);
        assertEq(escrow.claimable(OP2), 0);
        MochiTypes.Query memory q = escrow.getQuery(id);
        uint256 panelPart = (q.paid - fee0 - fee1 - fee2) * 2500 / 10_000;
        uint256 totalProtocol = q.paid - fee0 - fee1 - fee2;
        assertEq(token.balanceOf(PANEL), panelPart);
        assertEq(staking.notified(), totalProtocol - panelPart);
        assertEq(token.balanceOf(address(escrow)), fee0 + fee1);
        vm.prank(OP0);
        escrow.claim();
        assertEq(token.balanceOf(OP0), fee0);
        assertEq(escrow.claimable(OP0), 0);
    }

    function testReviewProtocolRecipientIsGovernorControlledAndCanBeReset() public {
        address recipient = address(0x300);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, OP0, MochiRoles.GOVERNOR_ROLE));
        vm.prank(OP0);
        escrow.setReviewProtocolRecipient(recipient);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ReviewProtocolRecipientSet(address(0), recipient);
        escrow.setReviewProtocolRecipient(recipient);
        assertEq(escrow.reviewProtocolRecipient(), recipient);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ReviewProtocolRecipientSet(recipient, address(0));
        escrow.setReviewProtocolRecipient(address(0));
        assertEq(escrow.reviewProtocolRecipient(), address(0));
    }

    function testOptInRoutesOnlyVerdictRemainderAndPreservesTimeoutRefundAndPanelCut() public {
        address recipient = address(0x300);
        escrow.setReviewProtocolRecipient(recipient);
        bytes32 id = _open(3, 101, MochiTypes.PayPath.USDG);
        _seal(id);
        MochiTypes.Query memory q = escrow.getQuery(id);
        uint256 protocol = q.protocolFee;
        uint256 panelCut = protocol * 2500 / 10_000;
        uint256 routed = protocol - panelCut;
        uint256 timeoutRefund = escrow.seatFeeOf(id, 2);
        uint256 payerBefore = token.balanceOf(address(this));

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ReviewProtocolRevenueSettled(id, recipient, routed);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.VERDICT, 4);

        assertEq(token.balanceOf(recipient), routed);
        assertEq(token.balanceOf(PANEL), panelCut);
        assertEq(token.balanceOf(address(this)) - payerBefore, timeoutRefund);
        assertEq(staking.notified(), 0);
        assertEq(escrow.claimable(OP0), escrow.seatFeeOf(id, 0));
        assertEq(escrow.claimable(OP1), escrow.seatFeeOf(id, 1));
        assertEq(escrow.claimable(OP2), 0);
        assertEq(token.balanceOf(address(escrow)), escrow.seatFeeOf(id, 0) + escrow.seatFeeOf(id, 1));
        assertEq(token.balanceOf(recipient) + token.balanceOf(PANEL) + timeoutRefund
            + token.balanceOf(address(escrow)), q.paid);
    }

    function testOptInDoesNotRouteHungProtocolOrTimeoutRefunds() public {
        address recipient = address(0x300);
        escrow.setReviewProtocolRecipient(recipient);
        bytes32 id = _open(3, 102, MochiTypes.PayPath.USDG);
        _seal(id);
        MochiTypes.Query memory q = escrow.getQuery(id);
        uint256 timeoutRefund = escrow.seatFeeOf(id, 2);
        uint256 payerBefore = token.balanceOf(address(this));
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 4);
        assertEq(token.balanceOf(address(this)) - payerBefore, q.protocolFee + timeoutRefund);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(PANEL), 0);
        assertEq(staking.notified(), 0);
        assertEq(escrow.claimable(OP0), escrow.seatFeeOf(id, 0));
        assertEq(escrow.claimable(OP1), escrow.seatFeeOf(id, 1));
        assertEq(token.balanceOf(address(escrow)), escrow.seatFeeOf(id, 0) + escrow.seatFeeOf(id, 1));
    }

    function testOptInDoesNotRouteExpiryRefundsAndResetUsesDefaultStakingPath() public {
        address recipient = address(0x300);
        escrow.setReviewProtocolRecipient(recipient);
        bytes32 expiring = _open(3, 103, MochiTypes.PayPath.USDG);
        uint256 expirePaid = escrow.getQuery(expiring).paid;
        uint256 payerBefore = token.balanceOf(address(this));
        vm.warp(escrow.getQuery(expiring).deadline + 1);
        escrow.expire(expiring);
        assertEq(token.balanceOf(address(this)) - payerBefore, expirePaid);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(staking.notified(), 0);

        escrow.setReviewProtocolRecipient(address(0));
        bytes32 verdict = _open(3, 104, MochiTypes.PayPath.USDG);
        _seal(verdict);
        uint256 protocol = escrow.getQuery(verdict).protocolFee;
        uint256 panelCut = protocol * 2500 / 10_000;
        escrow.settle(verdict, 0, MochiTypes.VerdictStatus.VERDICT, 0);
        assertEq(staking.notified(), protocol - panelCut);
        assertEq(token.balanceOf(PANEL), panelCut);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testDuplicateSettlementAndClaimCannotPayTwice() public {
        bytes32 id = _open(3, 11, MochiTypes.PayPath.USDG);
        _seal(id);
        uint256 protocol = escrow.getQuery(id).protocolFee;
        uint256 payerBefore = token.balanceOf(address(this));

        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 0);
        assertEq(token.balanceOf(address(this)) - payerBefore, protocol);
        uint256 operatorCredit = escrow.claimable(OP0);
        uint256 escrowBalance = token.balanceOf(address(escrow));
        assertGt(operatorCredit, 0);

        vm.expectRevert();
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 0);
        assertEq(token.balanceOf(address(this)) - payerBefore, protocol);
        assertEq(escrow.claimable(OP0), operatorCredit);
        assertEq(token.balanceOf(address(escrow)), escrowBalance);

        vm.prank(OP0);
        escrow.claim();
        uint256 paidToOperator = token.balanceOf(OP0);
        vm.prank(OP0);
        escrow.claim();
        assertEq(token.balanceOf(OP0), paidToOperator);
        assertEq(escrow.claimable(OP0), 0);
    }

    function testDuplicateExpiryCannotRefundTwice() public {
        bytes32 id = _open(3, 12, MochiTypes.PayPath.USDG);
        uint256 paid = escrow.getQuery(id).paid;
        uint256 payerBefore = token.balanceOf(address(this));
        vm.warp(escrow.getQuery(id).deadline + 1);

        escrow.expire(id);
        assertEq(token.balanceOf(address(this)) - payerBefore, paid);
        vm.expectRevert();
        escrow.expire(id);
        assertEq(token.balanceOf(address(this)) - payerBefore, paid);
    }

    function testHUNGThenExpansionPaysOnlyNewSeats() public {
        bytes32 id = _open(3, 2, MochiTypes.PayPath.USDG);
        _seal(id);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 0);
        uint256 oldSeatFee = escrow.seatFeeOf(id, 0);
        assertEq(escrow.claimable(OP0), oldSeatFee);
        (uint256 addFees, uint256 addProtocol) = escrow.quoteExpansion(id, 5);
        escrow.expand(id, 5);
        assertEq(escrow.prevNOf(id), 3);
        assertEq(escrow.seatFeeOf(id, 3) + escrow.seatFeeOf(id, 4), addFees);
        _seal(id);
        escrow.settle(id, 1, MochiTypes.VerdictStatus.VERDICT, 0);
        assertEq(escrow.claimable(address(0x14)), escrow.seatFeeOf(id, 3));
        assertEq(escrow.claimable(address(0x15)), escrow.seatFeeOf(id, 4));
        assertEq(escrow.getQuery(id).protocolFee, 0);
        assertTrue(addProtocol > 0);
    }

    function testShieldedOpenAndRefund() public {
        bytes32 id = _open(3, 3, MochiTypes.PayPath.SHIELDED);
        _seal(id);
        uint256 before = token.balanceOf(address(this));
        MochiTypes.Query memory q = escrow.getQuery(id);
        vm.warp(q.deadline + 1);
        escrow.expire(id);
        assertEq(token.balanceOf(address(this)) - before, q.paid);
    }

    function testVoucherAndFeedOpenAndRefundBudgets() public {
        escrow.setReviewProtocolRecipient(address(0x300));
        uint256 cost = _quoteTotal(3, 2);
        token.approve(address(escrow), type(uint256).max);
        escrow.fundAnonymaFloat(cost);
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(77)), 2, 0);
        MochiTypes.OpenParams memory args = _params(3, 4, address(this));
        MochiTypes.AnonymaVoucher memory v = MochiTypes.AnonymaVoucher(
            bytes32(uint256(5)), p.docCommit, 1, 3, cost, 2, uint64(block.timestamp + 1 days)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), MochiTypes.hashAnonymaVoucher(v)));
        (uint8 vv, bytes32 rr, bytes32 ss) = vm.sign(ANONYMA_PK, digest);
        bytes32 id = escrow.openWithVoucher(args, p, _sig(p), v, abi.encodePacked(rr, ss, vv));
        _seal(id);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 7);
        assertEq(escrow.anonymaFloat(), cost);

        MochiTypes.Provenance memory fetched = _prov(bytes32(uint256(88)), 2, 1);
        MochiTypes.OpenParams memory feedParams = _params(3, 5, address(this));
        feedParams.isPublic = true;
        escrow.grantRole(MochiRoles.FEED_RUNNER_ROLE, address(this));
        escrow.fundFeedBudget(cost);
        bytes32 feedId = escrow.openFeed(feedParams, fetched, _sig(fetched));
        _seal(feedId);
        escrow.settle(feedId, 0, MochiTypes.VerdictStatus.HUNG, 0);
        (, uint256 feedProtocol) = escrow.quote(1, 3, 2);
        assertEq(escrow.feedBudget(), feedProtocol);
        assertEq(token.balanceOf(address(0x300)), 0);
        assertEq(staking.notified(), 0);
    }

    function testPauseBlocksOnlyOpen() public {
        escrow.pause();
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(99)), 2, 0);
        bytes memory signature = _sig(p);
        vm.expectRevert();
        escrow.openWithUSDG(_params(3, 6, address(this)), p, signature);
        escrow.unpause();
        assertTrue(escrow.computeQueryId(address(this), p.docCommit, 6) != bytes32(0));
    }

    function testGuardianPausesButOnlyGovernorUnpauses() public {
        address guardian = makeAddr("guardian");
        escrow.grantRole(MochiRoles.GUARDIAN_ROLE, guardian);
        vm.prank(guardian);
        escrow.pause();
        assertTrue(escrow.paused());
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, MochiRoles.GOVERNOR_ROLE)
        );
        escrow.unpause();
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function testPauseRequiresGuardian() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, MochiRoles.GUARDIAN_ROLE)
        );
        escrow.pause();
    }

    function testOpenRejectsInvalidInputsAndDuplicateNonce() public {
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(71)), 2, 0);
        MochiTypes.OpenParams memory args = _params(3, 71, address(this));
        bytes memory signature = _sig(p);
        args.n = 4;
        vm.expectRevert();
        escrow.openWithUSDG(args, p, signature);
        args = _params(3, 71, address(0));
        vm.expectRevert();
        escrow.openWithUSDG(args, p, signature);
        p.tokensK = 0;
        signature = _sig(p);
        vm.expectRevert();
        escrow.openWithUSDG(_params(3, 71, address(this)), p, signature);
        p.tokensK = 2;
        schemas.setLatest(1, 0);
        signature = _sig(p);
        vm.expectRevert();
        escrow.openWithUSDG(_params(3, 71, address(this)), p, signature);
        schemas.setLatest(1, 1);
        registry.setActive(intake, MochiTypes.Role.INTAKE, false);
        vm.expectRevert();
        escrow.openWithUSDG(_params(3, 71, address(this)), p, signature);
        registry.setActive(intake, MochiTypes.Role.INTAKE, true);
        bytes memory badSignature = hex"1234";
        vm.expectRevert();
        escrow.openWithUSDG(_params(3, 71, address(this)), p, badSignature);
        escrow.openWithUSDG(_params(3, 71, address(this)), p, signature);
        vm.expectRevert();
        escrow.openWithUSDG(_params(3, 71, address(this)), p, signature);
    }

    function testVoucherValidationReplayAndFloatFailures() public {
        uint256 cost = _quoteTotal(3, 2);
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(72)), 2, 0);
        MochiTypes.OpenParams memory args = _params(3, 72, address(this));
        bytes memory intakeSignature = _sig(p);
        (MochiTypes.AnonymaVoucher memory voucher, bytes memory signed) =
            _voucher(bytes32(uint256(72)), p.docCommit, 1, 3, cost, uint64(block.timestamp + 100));
        vm.expectRevert();
        escrow.openWithVoucher(args, p, intakeSignature, voucher, hex"1234");
        (MochiTypes.AnonymaVoucher memory expired, bytes memory expiredSig) =
            _voucher(bytes32(uint256(73)), p.docCommit, 1, 3, cost, uint64(block.timestamp - 1));
        vm.expectRevert();
        escrow.openWithVoucher(args, p, intakeSignature, expired, expiredSig);
        (MochiTypes.AnonymaVoucher memory wrong, bytes memory wrongSig) =
            _voucher(bytes32(uint256(74)), bytes32(uint256(1)), 1, 3, cost, uint64(block.timestamp + 100));
        vm.expectRevert();
        escrow.openWithVoucher(args, p, intakeSignature, wrong, wrongSig);
        vm.expectRevert();
        escrow.openWithVoucher(args, p, intakeSignature, voucher, signed);
        escrow.fundAnonymaFloat(cost);
        bytes32 id = escrow.openWithVoucher(args, p, intakeSignature, voucher, signed);
        assertTrue(escrow.voucherUsed(voucher.voucherId));
        args.nonce++;
        vm.expectRevert();
        escrow.openWithVoucher(args, p, intakeSignature, voucher, signed);
        assertTrue(id != bytes32(0));
    }

    function testFeedRoleVisibilityProvenanceAndBudgetValidation() public {
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(73)), 2, 1);
        MochiTypes.OpenParams memory args = _params(3, 73, address(this));
        args.isPublic = true;
        bytes memory signature = _sig(p);
        vm.expectRevert();
        escrow.openFeed(args, p, signature);
        escrow.grantRole(MochiRoles.FEED_RUNNER_ROLE, address(this));
        args.isPublic = false;
        vm.expectRevert();
        escrow.openFeed(args, p, signature);
        args.isPublic = true;
        p.kind = 0;
        signature = _sig(p);
        vm.expectRevert();
        escrow.openFeed(args, p, signature);
        p.kind = 1;
        signature = _sig(p);
        vm.expectRevert();
        escrow.openFeed(args, p, signature);
        uint256 cost = _quoteTotal(3, 2);
        escrow.fundFeedBudget(cost);
        bytes32 id = escrow.openFeed(args, p, signature);
        assertTrue(id != bytes32(0));
    }

    function testShieldedBadProofAndSpentNullifier() public {
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(74)), 2, 0);
        MochiTypes.OpenParams memory args = _params(3, 74, address(this));
        bytes memory signature = _sig(p);
        uint256 cost = _quoteTotal(3, 2);
        shielded.fund(cost * 2);
        bytes32 nullifier = bytes32(uint256(74));
        bytes32 id = escrow.computeQueryId(address(this), p.docCommit, 74);
        bytes memory proof = abi.encode(nullifier, cost, address(escrow), id);
        vm.expectRevert();
        escrow.openShielded(args, p, signature, nullifier, hex"01");
        escrow.openShielded(args, p, signature, nullifier, proof);
        args.nonce++;
        id = escrow.computeQueryId(address(this), p.docCommit, args.nonce);
        proof = abi.encode(nullifier, cost, address(escrow), id);
        vm.expectRevert();
        escrow.openShielded(args, p, signature, nullifier, proof);
    }

    function testSealWindowResealAndExpire() public {
        bytes32 id = _open(3, 75, MochiTypes.PayPath.USDG);
        MochiTypes.Query memory q = escrow.getQuery(id);
        vm.expectRevert();
        escrow.seal(id);
        vm.roll(uint256(q.sealBlock) + 257);
        escrow.reseal(id);
        q = escrow.getQuery(id);
        vm.roll(uint256(q.sealBlock) + 1);
        escrow.seal(id);
        vm.warp(q.deadline + 1);
        escrow.expire(id);
        assertEq(uint8(escrow.getQuery(id).status), uint8(MochiTypes.QueryStatus.EXPIRED));
    }

    function testShieldedExpansionAndPanelStatusTransitions() public {
        bytes32 id = _open(3, 76, MochiTypes.PayPath.SHIELDED);
        _seal(id);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 0);
        (uint256 addedFees, uint256 addedProtocol) = escrow.quoteExpansion(id, 5);
        uint256 cost = addedFees + addedProtocol;
        shielded.fund(cost);
        bytes32 nullifier = bytes32(uint256(7600));
        bytes memory proof = abi.encode(nullifier, cost, address(escrow), id);
        escrow.expandShielded(id, 5, nullifier, proof);
        _seal(id);
        escrow.settle(id, 1, MochiTypes.VerdictStatus.HUNG, 0);
        vm.expectRevert();
        escrow.markEscalated(id);
        vm.prank(PANEL);
        escrow.markEscalated(id);
        assertEq(uint8(escrow.getQuery(id).status), uint8(MochiTypes.QueryStatus.ESCALATED));
        vm.expectRevert();
        escrow.markDecided(bytes32(uint256(id) + 1));
        escrow.markDecided(id);
        assertEq(uint8(escrow.getQuery(id).status), uint8(MochiTypes.QueryStatus.DECIDED));
    }

    function testVoucherExpansionAndPathRoutedExpiration() public {
        escrow.setReviewProtocolRecipient(address(0x300));
        uint256 initialCost = _quoteTotal(3, 2);
        escrow.fundAnonymaFloat(initialCost);
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(77)), 2, 0);
        MochiTypes.OpenParams memory args = _params(3, 77, address(this));
        (MochiTypes.AnonymaVoucher memory initial, bytes memory initialSig) =
            _voucher(bytes32(uint256(770)), p.docCommit, 1, 3, initialCost, uint64(block.timestamp + 1 days));
        bytes32 id = escrow.openWithVoucher(args, p, _sig(p), initial, initialSig);
        _seal(id);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, 0);
        (uint256 fees, uint256 protocol) = escrow.quoteExpansion(id, 5);
        uint256 expansionCost = fees + protocol;
        escrow.fundAnonymaFloat(expansionCost);
        (MochiTypes.AnonymaVoucher memory expansion, bytes memory expansionSig) =
            _voucher(bytes32(uint256(771)), p.docCommit, 1, 5, expansionCost, uint64(block.timestamp + 1 days));
        escrow.expandWithVoucher(id, 5, expansion, expansionSig);
        assertEq(escrow.prevNOf(id), 3);

        MochiTypes.Provenance memory p2 = _prov(bytes32(uint256(78)), 2, 0);
        uint256 cost2 = _quoteTotal(3, 2);
        escrow.fundAnonymaFloat(cost2);
        (MochiTypes.AnonymaVoucher memory expireVoucher, bytes memory expireSig) =
            _voucher(bytes32(uint256(772)), p2.docCommit, 1, 3, cost2, uint64(block.timestamp + 1 days));
        bytes32 expireId = escrow.openWithVoucher(_params(3, 78, address(this)), p2, _sig(p2), expireVoucher, expireSig);
        uint256 floatBefore = escrow.anonymaFloat();
        vm.warp(escrow.getQuery(expireId).deadline + 1);
        escrow.expire(expireId);
        assertEq(escrow.anonymaFloat(), floatBefore + cost2);
        assertEq(token.balanceOf(address(0x300)), 0);
        assertEq(staking.notified(), 0);
    }

    function testFuzzSettlementConservesEscrow(uint8 sizeSeed, uint32 tokenSeed, uint256 priceSeed, uint32 maskSeed)
        public
    {
        uint8[4] memory sizes = [uint8(3), 5, 7, 9];
        uint8 n = sizes[sizeSeed % 4];
        uint32 tokensK = tokenSeed % 100 + 1;
        uint256 base = bound(priceSeed, 1, 100_000);
        for (uint8 c; c < 5; ++c) {
            escrow.setClassPrice(MochiTypes.JurorClass(c), base + c, c + 1);
        }
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(700 + n)), tokensK, 0);
        uint64 nonce = uint64(700 + n);
        uint256 payerBefore = token.balanceOf(address(this));
        bytes32 id = escrow.openWithUSDG(_params(n, nonce, address(this)), p, _sig(p));
        uint256 paid = escrow.getQuery(id).paid;
        _seal(id);
        uint32 mask = maskSeed & ((uint32(1) << n) - 1);
        escrow.settle(id, 0, MochiTypes.VerdictStatus.HUNG, mask);
        address[] memory selected = escrow.jurorsOf(id);
        uint256 credited;
        for (uint8 i; i < n; ++i) {
            address operator = registry.operatorOf(selected[i]);
            credited += escrow.claimable(operator);
        }
        uint256 refund = token.balanceOf(address(this)) - (payerBefore - paid);
        assertEq(paid, credited + refund);
        assertEq(token.balanceOf(address(escrow)), credited);
    }
}
