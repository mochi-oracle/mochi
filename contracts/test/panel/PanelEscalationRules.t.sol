// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PanelEscalation} from "@mochi/PanelEscalation.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {FreezableUSDG, MockEscrow, MockVerdicts, MockRandomness} from "./mocks/PanelMocks.sol";

/// Selection, deadline and payout rules added for the panel audit findings (B-H1, B-M1 and the lead).
contract PanelEscalationRulesTest is Test {
    FreezableUSDG token;
    MockEscrow escrow;
    MockVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    address payer = address(0xBEEF);
    bytes32 query = keccak256("query");
    uint256 constant MIN = 100e6;
    uint256 constant FEE = 9e6;

    function setUp() public {
        token = new FreezableUSDG();
        escrow = new MockEscrow();
        verdicts = new MockVerdicts();
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
        for (uint256 i; i < 6; ++i) _stake(_ev(i), MIN);
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(panel), type(uint256).max);
        _setQuery(query);
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

    function _setQuery(bytes32 id) internal {
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = true;
        q.payer = payer;
        q.refundTo = payer;
        escrow.setQuery(id, q);
    }

    function _escalate(bytes32 id) internal {
        vm.prank(payer);
        panel.escalate(id);
        vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
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

    function _status(bytes32 id) internal view returns (IPanelEscalation.CaseStatus) {
        return panel.getCase(id).status;
    }

    // ------------------------------------------------------------------ B-H1: the draw is fixed at the seal

    /// Everything anyone can do after the seed is public (exits by every evaluator including the drawn ones, new
    /// stakers, the governor raising minStake and kicking) leaves the drawn panel unchanged.
    function testDrawIsFixedAtTheSeal() public {
        _escalate(query);
        uint256 snap = vm.snapshotState();
        panel.draw(query);
        address[3] memory expected = panel.panelOf(query, 0);
        vm.revertToState(snap);

        for (uint256 i; i < 20; ++i) _stake(address(uint160(0x9000 + i)), MIN);
        panel.setEconomics(MIN + 1, FEE);
        panel.kick(_ev(5));
        for (uint256 i; i < 5; ++i) {
            vm.prank(_ev(i));
            panel.requestUnstake();
        }
        vm.roll(block.number + 50);
        assertEq(panel.poolLength(), 26, "exits keep their positions while a draw is pending");
        assertEq(panel.activeEvaluators(), 20);

        panel.draw(query);
        address[3] memory got = panel.panelOf(query, 0);
        for (uint256 i; i < 3; ++i) assertEq(got[i], expected[i]);
        // The draw ended: no pending draw can pick the kept positions any more, so they are pruned with it.
        assertEq(panel.poolLength(), 20);
        assertEq(panel.prune(10), 0);
        for (uint256 i; i < 20; ++i) {
            address e = panel.pool(i);
            assertEq(uint256(panel.memberOf(e).position), i + 1);
            assertEq(uint256(panel.memberOf(e).exitSeal), 0);
        }
    }

    /// Joins after the seal land past the frozen pool length; a join just before the seal is not yet warm.
    function testOnlyWarmEvaluatorsAreDrawn() public {
        for (uint256 i = 2; i < 6; ++i) {
            vm.prank(_ev(i));
            panel.requestUnstake();
        }
        assertEq(panel.poolLength(), 2, "with no draw pending, exits are removed at once");
        address newcomer = address(0xFE11);
        _stake(newcomer, MIN);
        assertFalse(panel.isDrawable(newcomer));
        _escalate(query); // sealed in the newcomer's block: not warm for this draw
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);
        assertTrue(panel.isDrawable(newcomer));

        vm.warp(panel.getCase(query).drawDeadline);
        vm.expectRevert(IPanelEscalation.WindowOpen.selector);
        panel.expireDraw(query);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);
        panel.expireDraw(query); // the seed is available but the frozen pool cannot fill a panel
        assertEq(uint8(_status(query)), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(panel.pendingDraws(), 0);

        // The first panel never sat, so the case can be escalated again (the query is already ESCALATED).
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.Unauthorized.selector, address(0xCAFE)));
        vm.prank(address(0xCAFE));
        panel.escalate(query);
        uint256 before = token.balanceOf(payer);
        _escalate(query);
        assertEq(before - token.balanceOf(payer), FEE);
        panel.draw(query);
        address[3] memory seats = panel.panelOf(query, 0);
        assertTrue(seats[0] == newcomer || seats[1] == newcomer || seats[2] == newcomer);
        _vote(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1))]);
        panel.resolve(query);
        vm.warp(panel.getCase(query).appealDeadline + 1);
        panel.finalize(query);
        assertEq(verdicts.postCount(), 1);
        assertEq(panel.escrowedCaseFees(), 0);
    }

    function testStakeRules() public {
        token.mint(address(0xA1), MIN);
        vm.prank(address(0xA1));
        token.approve(address(panel), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.StakeTooLow.selector, MIN - 1, MIN));
        vm.prank(address(0xA1));
        panel.stake(MIN - 1);
        vm.prank(_ev(0));
        panel.requestUnstake();
        token.mint(_ev(0), MIN);
        vm.expectRevert(PanelEscalation.NotActive.selector);
        vm.prank(_ev(0));
        panel.stake(MIN);
        // A top-up while active keeps the original join ticket.
        uint64 joined = panel.memberOf(_ev(1)).joinTicket;
        vm.roll(block.number + 5);
        token.mint(_ev(1), 1);
        vm.prank(_ev(1));
        panel.stake(1);
        assertEq(panel.memberOf(_ev(1)).joinTicket, joined);
        assertEq(panel.activeEvaluators(), 5);
    }

    function testKickAndSlashDeactivate() public {
        vm.expectRevert(PanelEscalation.NotActive.selector);
        panel.kick(_ev(0));
        panel.setEconomics(MIN + 1, FEE);
        panel.kick(_ev(0));
        assertEq(panel.activeEvaluators(), 5);
        assertEq(panel.poolLength(), 5);
        panel.setEconomics(MIN, FEE);

        // A non-revealer slashed below minStake leaves the pool; topping up rejoins with a fresh warm-up.
        _escalate(query);
        panel.draw(query);
        address[3] memory seats = panel.panelOf(query, 0);
        vm.warp(panel.getCase(query).revealDeadline + 1);
        panel.resolve(query);
        assertEq(panel.stakeOf(seats[0]), MIN - MIN / 10);
        assertFalse(panel.isDrawable(seats[0]));
        assertEq(panel.memberOf(seats[0]).position, 0);
        _stake(seats[0], MIN / 10);
        assertTrue(panel.memberOf(seats[0]).position != 0);
        assertFalse(panel.isDrawable(seats[0]));
        vm.roll(block.number + 2);
        assertTrue(panel.isDrawable(seats[0]));
    }

    /// An evaluator that leaves after a seal keeps its position and its stake while that draw is pending: nothing it
    /// does can change the draw. Past the draw's expiry no panel is seated; once the draw ends the stake is free.
    function testExitingEvaluatorStakeStaysUntilThePendingDrawEnds() public {
        _escalate(query); // pending until someone draws or expires it
        vm.prank(_ev(0));
        panel.requestUnstake();
        vm.warp(block.timestamp + 7 days + 1); // past the cooldown and the draw's expiry
        vm.expectRevert(IPanelEscalation.DrawPending.selector);
        vm.prank(_ev(0));
        panel.withdraw();
        assertEq(panel.poolLength(), 6, "position kept while the draw is pending");
        vm.expectRevert(IPanelEscalation.WindowClosed.selector);
        panel.draw(query);
        panel.expireDraw(query); // no seed needed past the expiry
        assertEq(uint8(_status(query)), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(panel.poolLength(), 5, "pruned when the draw ends");
        assertEq(panel.memberOf(_ev(0)).position, 0);
        uint256 before = token.balanceOf(_ev(0));
        vm.prank(_ev(0));
        panel.withdraw();
        assertEq(token.balanceOf(_ev(0)) - before, MIN);
        // Restaking rejoins at the end with a fresh warm-up.
        _stake(_ev(0), MIN);
        assertEq(uint256(panel.memberOf(_ev(0)).position), 6);
        assertFalse(panel.isDrawable(_ev(0)));
    }

    /// Past the deadline, a panel the seed can draw is seated rather than expired: whoever sees the seed cannot
    /// discard that panel (and re-escalate for another) by letting the deadline pass.
    function testExpiryDrawsWhenAPanelCanBeDrawn() public {
        _escalate(query);
        uint256 snap = vm.snapshotState();
        panel.draw(query);
        address[3] memory expected = panel.panelOf(query, 0);
        vm.revertToState(snap);
        vm.warp(panel.getCase(query).drawDeadline + 1);
        uint256 payerBefore = token.balanceOf(payer);
        panel.expireDraw(query);
        assertEq(uint8(_status(query)), uint8(IPanelEscalation.CaseStatus.COMMIT));
        address[3] memory got = panel.panelOf(query, 0);
        for (uint256 i; i < 3; ++i) assertEq(got[i], expected[i]);
        assertEq(token.balanceOf(payer), payerBefore, "no refund for a drawn panel");
        assertEq(panel.pendingDraws(), 0);
    }

    /// Without a seed, a draw only expires once its ticket can never be served; before that the randomness error
    /// bubbles (for drand: post the beacon first).
    function testExpiryWaitsForTheSeedUnlessTheTicketIsLost() public {
        vm.prank(payer);
        panel.escalate(query); // no roll: the seed is not available yet
        vm.warp(panel.getCase(query).drawDeadline + 1);
        vm.expectRevert(bytes("seed not ready"));
        panel.expireDraw(query);
        uint64 ticket = panel.getCase(query).sealBlock;
        vm.roll(uint256(ticket) + 257); // the blockhash window passed without a draw
        vm.expectRevert(bytes("seed window missed"));
        panel.draw(query);
        uint256 payerBefore = token.balanceOf(payer);
        panel.expireDraw(query);
        assertEq(uint8(_status(query)), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(token.balanceOf(payer) - payerBefore, FEE);
    }

    /// Pruning works during pending draws, but only on positions no pending draw can pick.
    function testPruneKeepsOnlyPositionsAPendingDrawCanPick() public {
        _escalate(query);
        vm.prank(_ev(0));
        panel.requestUnstake(); // active at the seal: the pending draw may pick it
        assertEq(panel.prune(5), 0);
        assertEq(panel.poolLength(), 6);
        // An evaluator that joins and leaves after the seal was never active at a pending seal: removed at once.
        _stake(address(0xA11), MIN);
        assertEq(panel.poolLength(), 7);
        vm.prank(address(0xA11));
        panel.requestUnstake();
        assertEq(panel.poolLength(), 6);
        assertEq(panel.memberOf(address(0xA11)).position, 0);
        panel.draw(query);
        assertEq(panel.poolLength(), 5, "kept position pruned once the draw ended");
    }

    // ------------------------------------------------------------------ B-M1: bounded draw, deadlines

    /// A pool of 2,000 where nearly every kept position is ineligible. With two eligible evaluators the draw is
    /// impossible from the seal: it reverts at once and the case expires and refunds instead of staying stuck. With six
    /// eligible the draw is possible: each call is bounded and the draw finishes across calls.
    function testDrawCostIsBoundedOnALargePool() public {
        vm.pauseGasMetering();
        for (uint256 i; i < 1_994; ++i) _stake(address(uint160(0x200000 + i)), MIN);
        bytes32 holder = keccak256("holder");
        _setQuery(holder);
        _escalate(holder); // a pending draw keeps the exits below in place
        for (uint256 i; i < 1_994; ++i) {
            vm.prank(address(uint160(0x200000 + i)));
            panel.requestUnstake();
        }
        for (uint256 i = 2; i < 6; ++i) {
            vm.prank(_ev(i));
            panel.requestUnstake();
        }
        vm.roll(block.number + 5);
        _escalate(query); // only _ev(0) and _ev(1) are eligible among 2,000 positions
        vm.resumeGasMetering();
        assertEq(panel.getCase(query).poolSize, 2_000);
        vm.cool(address(panel));
        uint256 before = gasleft();
        (bool ok,) = address(panel).call(abi.encodeCall(PanelEscalation.draw, (query)));
        uint256 used = before - gasleft();
        assertFalse(ok, "two eligible evaluators cannot fill a panel");
        assertLt(used, 1_500_000);
        emit log_named_uint("failed draw gas (cold, 2,000 positions)", used);

        assertEq(panel.drawStateOf(query).eligible, 2);

        // The holder was sealed when only the first six were warm; its exits since then stay eligible for it.
        assertEq(panel.drawStateOf(holder).eligible, 6);
        uint256 calls;
        uint256 maxCall;
        while (panel.getCase(holder).status == IPanelEscalation.CaseStatus.DRAWING) {
            vm.cool(address(panel));
            before = gasleft();
            panel.draw(holder);
            used = before - gasleft();
            if (used > maxCall) maxCall = used;
            ++calls;
        }
        assertLt(maxCall, 1_500_000);
        emit log_named_uint("possible draw over 2,000 positions: calls", calls);
        emit log_named_uint("possible draw over 2,000 positions: max gas per call", maxCall);

        vm.warp(block.timestamp + 1 days + 1);
        panel.expireDraw(query);
        assertEq(uint8(_status(query)), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(panel.pendingDraws(), 0);
        while (panel.prune(500) != 0) {}
        assertEq(panel.poolLength(), 2);
        assertEq(panel.activeEvaluators(), 2);
    }

    function testAppealLapseRefundsAppealFeeAndFirstPanelStands() public {
        _escalate(query);
        panel.draw(query);
        address[3] memory first = panel.panelOf(query, 0);
        for (uint256 i; i < 6; ++i) {
            if (_ev(i) == first[0] || _ev(i) == first[1] || _ev(i) == first[2]) continue;
            vm.prank(_ev(i));
            panel.requestUnstake();
        }
        _vote(query, 0, [bytes32(uint256(4)), bytes32(uint256(4)), bytes32(uint256(5))]);
        panel.resolve(query);
        uint256 payerBefore = token.balanceOf(payer);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);
        vm.warp(panel.getCase(query).drawDeadline + 1);
        vm.expectEmit(true, false, false, true, address(panel));
        emit IPanelEscalation.DrawExpired(query, 1, FEE);
        panel.expireDraw(query);
        IPanelEscalation.Case memory c = panel.getCase(query);
        assertEq(uint8(c.status), uint8(IPanelEscalation.CaseStatus.FINAL));
        assertEq(c.panelIndex, 0);
        assertEq(verdicts.lastAnswer(), bytes32(uint256(4)));
        assertEq(token.balanceOf(payer), payerBefore);
        for (uint256 i; i < 3; ++i) assertEq(panel.openPanels(first[i]), 0);
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.slashedPool(), 0);
    }

    // ------------------------------------------------------------------ the lead: no majority on the appeal panel

    /// The appeal panel splits three ways: the case ends FINAL with zero outcome hashes (a final HUNG), nothing is
    /// posted, both fees follow the existing no-majority rule, and no stake stays locked.
    function testSecondPanelWithoutMajorityEndsAsFinalHung() public {
        _escalate(query);
        panel.draw(query);
        address[3] memory first = panel.panelOf(query, 0);
        _vote(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2))]);
        panel.resolve(query);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        panel.draw(query);
        address[3] memory second = panel.panelOf(query, 1);
        _vote(query, 1, [bytes32(uint256(7)), bytes32(uint256(8)), bytes32(uint256(9))]);
        panel.resolve(query);
        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) before[i] = token.balanceOf(second[i]);
        vm.expectEmit(true, false, false, true, address(panel));
        emit IPanelEscalation.Finalized(query, false);
        panel.finalize(query);
        IPanelEscalation.Case memory c = panel.getCase(query);
        assertEq(uint8(c.status), uint8(IPanelEscalation.CaseStatus.FINAL));
        assertEq(c.outcomeAnswerHash, bytes32(0));
        assertEq(c.outcomePayloadHash, bytes32(0));
        assertEq(verdicts.postCount(), 0);
        for (uint256 i; i < 3; ++i) {
            assertEq(token.balanceOf(second[i]) - before[i], FEE / 3);
            assertEq(panel.openPanels(first[i]), 0);
            assertEq(panel.openPanels(second[i]), 0);
        }
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.slashedPool(), 0);
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.WrongCaseStatus.selector, IPanelEscalation.CaseStatus.FINAL));
        panel.finalize(query);
        // Terminal: the case cannot be escalated again (the query is ESCALATED and the case is not DRAW_EXPIRED).
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.NotEscalatable.selector, query));
        vm.prank(payer);
        panel.escalate(query);
    }

    // ------------------------------------------------------------------ payouts and reveals that could block a case

    function testRefusedPayoutBecomesClaimable() public {
        _escalate(query);
        panel.draw(query);
        address[3] memory seats = panel.panelOf(query, 0);
        token.setFrozen(seats[1], true);
        _vote(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1))]);
        panel.resolve(query);
        vm.warp(panel.getCase(query).appealDeadline + 1);
        panel.finalize(query);
        assertEq(panel.owed(seats[1]), FEE / 3);
        assertEq(panel.totalOwed(), FEE / 3);
        assertEq(panel.reserveBalance(), 0);
        vm.expectRevert(PanelEscalation.ZeroAmount.selector);
        vm.prank(seats[0]);
        panel.claim();
        token.setFrozen(seats[1], false);
        uint256 before = token.balanceOf(seats[1]);
        vm.prank(seats[1]);
        panel.claim();
        assertEq(token.balanceOf(seats[1]) - before, FEE / 3);
        assertEq(panel.totalOwed(), 0);
    }

    function testZeroResultRevealIsRejected() public {
        _escalate(query);
        panel.draw(query);
        address e = panel.panelOf(query, 0)[0];
        bytes32 salt = keccak256("s");
        vm.prank(e);
        panel.commit(query, keccak256(abi.encode(query, uint8(0), e, bytes32(0), bytes32(uint256(1)), salt)));
        vm.warp(panel.getCase(query).commitDeadline + 1);
        vm.expectRevert(IPanelEscalation.BadReveal.selector);
        vm.prank(e);
        panel.reveal(query, bytes32(0), bytes32(uint256(1)), salt);
    }

    // ------------------------------------------------------------------ governance bounds

    function testDrawRuleBounds() public {
        vm.expectRevert(PanelEscalation.InvalidParameter.selector);
        panel.setDrawRules(0, 2);
        vm.expectRevert(PanelEscalation.InvalidParameter.selector);
        panel.setDrawRules(7 days, 2); // must stay below unstakeCooldown
        vm.expectRevert(PanelEscalation.InvalidParameter.selector);
        panel.setDrawRules(1 days, 0);
        vm.expectRevert(PanelEscalation.InvalidParameter.selector);
        panel.setWindows(1 days, 1 days, 1 days, 1 days); // cooldown must exceed drawWindow
        panel.setDrawRules(6 hours, 40);
        assertEq(panel.drawWindow(), 6 hours);
        assertEq(panel.warmupTickets(), 40);
        vm.expectRevert();
        vm.prank(address(0xCAFE));
        panel.setDrawRules(6 hours, 40);
    }
}
