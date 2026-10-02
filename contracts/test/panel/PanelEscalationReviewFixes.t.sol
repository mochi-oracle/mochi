// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PanelEscalation} from "@mochi/PanelEscalation.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {FreezableUSDG, MockEscrow, MockVerdicts, MockRandomness} from "./mocks/PanelMocks.sol";

/// Verdicts stand-in that records the case status PanelEscalation shows while it posts.
contract ObservingVerdicts is MockVerdicts {
    IPanelEscalation.CaseStatus public statusDuringPost;

    function postPanelOutcome(bytes32 q, bytes32 a, bytes32 p) external override returns (bytes32) {
        statusDuringPost = IPanelEscalation(msg.sender).getCase(q).status;
        return _post(q, a, p);
    }
}

/// Escrow stand-in that records the case status PanelEscalation shows when it marks the query escalated.
contract ObservingEscrow is MockEscrow {
    IPanelEscalation.CaseStatus public statusDuringMark;

    function markEscalated(bytes32 id) external override {
        statusDuringMark = IPanelEscalation(msg.sender).getCase(id).status;
        _mark(id);
    }
}

/// Smaller findings of the adversarial review: escalation rights, payout failures, checks-effects-interactions, the
/// same-ticket exit rule, draw rules fixed at the seal, and expiry of an impossible draw without a seed.
contract PanelEscalationReviewFixesTest is Test {
    FreezableUSDG token;
    ObservingEscrow escrow;
    ObservingVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    address payer = address(0xBEEF);
    address runner = address(0xFEED);
    bytes32 query = keccak256("query");
    uint256 constant MIN = 100e6;
    uint256 constant FEE = 9e6;

    function setUp() public {
        token = new FreezableUSDG();
        escrow = new ObservingEscrow();
        verdicts = new ObservingVerdicts();
        rng = new MockRandomness();
        panel = new PanelEscalation(
            address(this),
            token,
            IQueryEscrow(address(escrow)),
            IMochiVerdicts(address(verdicts)),
            IRandomness(address(rng)),
            MIN,
            FEE
        );
        panel.grantRole(MochiRoles.FEED_RUNNER_ROLE, runner);
        for (uint256 i; i < 6; ++i) _stake(_ev(i), MIN);
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? payer : runner;
            token.mint(who, 1_000e6);
            vm.prank(who);
            token.approve(address(panel), type(uint256).max);
        }
        _setQuery(query, MochiTypes.PayPath.USDG);
        vm.roll(block.number + 10);
    }

    function _ev(uint256 i) internal pure returns (address) {
        return address(uint160(0x1000 + i));
    }

    function _stake(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(panel), type(uint256).max);
        vm.prank(who);
        panel.stake(amount);
    }

    function _setQuery(bytes32 id, MochiTypes.PayPath path) internal {
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = true;
        q.payer = payer;
        q.refundTo = payer;
        q.payPath = path;
        escrow.setQuery(id, q);
    }

    function _escalateAndDraw(bytes32 id) internal {
        vm.prank(payer);
        panel.escalate(id);
        vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
        assertTrue(panel.draw(id));
    }

    function _vote(bytes32 id, uint8 pi, bytes32[3] memory answers) internal {
        address[3] memory seats = panel.panelOf(id, pi);
        bytes32 salt = keccak256(abi.encode(id, pi));
        for (uint256 i; i < 3; ++i) {
            vm.prank(seats[i]);
            panel.commit(id, keccak256(abi.encode(id, pi, seats[i], answers[i], keccak256(abi.encode(answers[i])), salt)));
        }
        for (uint256 i; i < 3; ++i) {
            vm.prank(seats[i]);
            panel.reveal(id, answers[i], keccak256(abi.encode(answers[i])), salt);
        }
    }

    /// revealOf shows an evaluator's revealed hashes (zero before the reveal), so off-chain services can accept a
    /// payload only once it matches what was revealed.
    function testRevealOfShowsRevealedHashes() public {
        _escalateAndDraw(query);
        address seat = panel.panelOf(query, 0)[0];
        (bytes32 a0, bytes32 p0) = panel.revealOf(query, 0, seat);
        assertEq(a0, bytes32(0));
        assertEq(p0, bytes32(0));
        _vote(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2))]);
        (bytes32 a1, bytes32 p1) = panel.revealOf(query, 0, seat);
        assertEq(a1, bytes32(uint256(1)));
        assertEq(p1, keccak256(abi.encode(bytes32(uint256(1)))));
    }

    /// FEED_RUNNER_ROLE escalates feed queries (which it pays for), not other payers' HUNG queries.
    function testFeedRunnerEscalatesOnlyFeedQueries() public {
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.Unauthorized.selector, runner));
        vm.prank(runner);
        panel.escalate(query);
        bytes32 feed = keccak256("feed");
        _setQuery(feed, MochiTypes.PayPath.FEED);
        vm.prank(runner);
        panel.escalate(feed);
        assertEq(panel.getCase(feed).payer, runner);
        // The payer itself may still escalate its own query on any path.
        vm.prank(payer);
        panel.escalate(query);
    }

    /// escalate records the case (and seals it) before it calls the escrow; finalize marks the case FINAL before it
    /// posts the verdict and pays out.
    function testStateIsWrittenBeforeExternalCalls() public {
        _escalateAndDraw(query);
        assertEq(uint8(escrow.statusDuringMark()), uint8(IPanelEscalation.CaseStatus.DRAWING));
        _vote(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2))]);
        panel.resolve(query);
        vm.warp(panel.getCase(query).appealDeadline + 1);
        panel.finalize(query);
        assertEq(uint8(verdicts.statusDuringPost()), uint8(IPanelEscalation.CaseStatus.FINAL));
    }

    /// A refusing recipient (frozen address) becomes an owed balance, but a shortfall in the contract's own balance is
    /// never turned into a claim: the payout reverts.
    function testShortfallRevertsInsteadOfBecomingOwed() public {
        _escalateAndDraw(query);
        _vote(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1))]);
        panel.resolve(query);
        vm.warp(panel.getCase(query).appealDeadline + 1);
        uint256 snap = vm.snapshotState();
        deal(address(token), address(panel), FEE / 3 - 1); // something drained the contract
        vm.expectRevert(abi.encodeWithSelector(PanelEscalation.InsufficientBalance.selector, FEE / 3 - 1, FEE / 3 + FEE % 3));
        panel.finalize(query);
        assertEq(panel.totalOwed(), 0);
        vm.revertToState(snap);
        token.setFrozen(panel.panelOf(query, 0)[1], true);
        panel.finalize(query);
        assertEq(panel.totalOwed(), FEE / 3);
    }

    /// Eligibility is "active at the seal": an exit before the seal excludes the evaluator even within the same ticket
    /// (same block), an exit after the seal in the same ticket does not.
    function testSameTicketExitBeforeTheSealExcludesAfterItDoesNot() public {
        bytes32 holder = keccak256("holder");
        _setQuery(holder, MochiTypes.PayPath.USDG);
        vm.prank(payer);
        panel.escalate(holder); // pending: exits below keep their positions
        vm.prank(_ev(0));
        panel.requestUnstake(); // same block as the next seal, before it
        vm.prank(payer);
        panel.escalate(query);
        uint64 nonce = panel.drawStateOf(query).sealNonce;
        vm.prank(_ev(1));
        panel.requestUnstake(); // same block, after it
        assertEq(panel.getCase(query).sealBlock, panel.getCase(holder).sealBlock, "same ticket");
        assertEq(panel.drawStateOf(query).eligible, 5);
        assertLe(panel.memberOf(_ev(0)).exitSeal, nonce, "left before the seal");
        assertGt(panel.memberOf(_ev(1)).exitSeal, nonce, "left after the seal");
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        assertTrue(panel.draw(query));
        address[3] memory seats = panel.panelOf(query, 0);
        for (uint256 i; i < 3; ++i) assertTrue(seats[i] != _ev(0));
    }

    /// The warm-up is read from the seal, not from the live setting: changing it while a draw is pending does not
    /// change that draw.
    function testWarmupIsFixedAtTheSeal() public {
        vm.prank(payer);
        panel.escalate(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        uint256 snap = vm.snapshotState();
        assertTrue(panel.draw(query));
        address[3] memory expected = panel.panelOf(query, 0);
        vm.revertToState(snap);
        panel.setDrawRules(1 days, 64); // nobody would be warm for this draw under the new rule
        assertEq(panel.drawStateOf(query).warmup, 2);
        assertTrue(panel.draw(query));
        address[3] memory got = panel.panelOf(query, 0);
        for (uint256 i; i < 3; ++i) assertEq(got[i], expected[i]);
        vm.expectRevert(PanelEscalation.InvalidParameter.selector);
        panel.setDrawRules(1 days, 65);
    }

    /// A draw that is impossible from its seal (fewer than three eligible) expires at its deadline even if its seed
    /// was never published, and the draw itself refuses at once.
    function testImpossibleDrawExpiresWithoutItsSeed() public {
        for (uint256 i = 2; i < 6; ++i) {
            vm.prank(_ev(i));
            panel.requestUnstake();
        }
        vm.prank(payer);
        panel.escalate(query); // no roll: the seed is not available
        assertEq(panel.drawStateOf(query).eligible, 2);
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);
        vm.warp(panel.getCase(query).drawDeadline + 1);
        uint256 before = token.balanceOf(payer);
        panel.expireDraw(query);
        assertEq(uint8(panel.getCase(query).status), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(token.balanceOf(payer) - before, FEE);
    }

    /// A draw that needs more attempts than one call allows keeps its seed and progress between calls and seats a
    /// panel of eligible evaluators.
    function testDrawSpansCallsAndKeepsItsProgress() public {
        // 600 positions kept for a held draw and ineligible for the case: its draw needs several calls.
        bytes32 holder = keccak256("holder");
        _setQuery(holder, MochiTypes.PayPath.USDG);
        for (uint256 i; i < 600; ++i) _stake(address(uint160(0x9000 + i)), MIN);
        vm.roll(block.number + 5);
        vm.prank(payer);
        panel.escalate(holder);
        for (uint256 i; i < 600; ++i) {
            vm.prank(address(uint160(0x9000 + i)));
            panel.requestUnstake();
        }
        vm.prank(payer);
        panel.escalate(query);
        assertEq(panel.getCase(query).poolSize, 606);
        assertEq(panel.drawStateOf(query).eligible, 6);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        uint256 calls;
        bool seated;
        uint256 progress;
        while (!seated) {
            seated = panel.draw(query);
            ++calls;
            if (seated) break;
            IPanelEscalation.DrawState memory d = panel.drawStateOf(query);
            assertTrue(d.seed != 0, "seed not kept");
            uint256 at = uint256(d.filled) << 128 | d.attempt;
            assertGt(at, progress, "no progress");
            progress = at;
        }
        assertGt(calls, 1, "expected a draw that spans calls");
        address[3] memory seats = panel.panelOf(query, 0);
        for (uint256 i; i < 3; ++i) assertTrue(uint160(seats[i]) >= 0x1000 && uint160(seats[i]) < 0x1006);
    }
}
