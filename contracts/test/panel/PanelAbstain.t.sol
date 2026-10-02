// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PanelEscalation} from "@mochi/PanelEscalation.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {FreezableUSDG, MockEscrow, MockVerdicts, MockRandomness} from "./mocks/PanelMocks.sol";

/// Abstention: a seat that cannot evaluate the case (for example, intake can no longer serve the materials) says so
/// before the commit deadline. Two or more abstentions void the panel without slashing anyone; a lone abstainer is a
/// non-revealer. Also pins the exact fee and slash splits of the shared payout helper.
contract PanelAbstainTest is Test {
    FreezableUSDG token;
    MockEscrow escrow;
    MockVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    address payer = address(0xBEEF);
    bytes32 query = keccak256("abstain-query");
    uint256 constant MIN = 100e6;
    uint256 constant FEE = 9e6;
    bytes32 constant SALT = bytes32(uint256(0x5a17));

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
        for (uint256 i; i < 6; ++i) {
            token.mint(_ev(i), MIN);
            vm.prank(_ev(i));
            token.approve(address(panel), type(uint256).max);
            vm.prank(_ev(i));
            panel.stake(MIN);
        }
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(panel), type(uint256).max);
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = true;
        q.payer = payer;
        q.refundTo = payer;
        escrow.setQuery(query, q);
        vm.roll(block.number + 10);
    }

    function _ev(uint256 i) internal pure returns (address) {
        return address(uint160(0x2000 + i));
    }

    function _escalateAndDraw() internal returns (address[3] memory) {
        vm.prank(payer);
        panel.escalate(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        assertTrue(panel.draw(query));
        return panel.panelOf(query, panel.getCase(query).panelIndex);
    }

    function _appealAndDraw() internal returns (address[3] memory) {
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        assertTrue(panel.draw(query));
        return panel.panelOf(query, 1);
    }

    function _commit(address seat, uint8 pi, bytes32 answer) internal {
        vm.prank(seat);
        panel.commit(query, keccak256(abi.encode(query, pi, seat, answer, keccak256(abi.encode(answer)), SALT)));
    }

    function _reveal(address seat, bytes32 answer) internal {
        vm.prank(seat);
        panel.reveal(query, answer, keccak256(abi.encode(answer)), SALT);
    }

    /// All three seats commit and reveal; the case ends REVEAL with every seat revealed (resolvable at once).
    function _vote(address[3] memory seats, uint8 pi, bytes32[3] memory answers) internal {
        for (uint256 i; i < 3; ++i) {
            _commit(seats[i], pi, answers[i]);
        }
        for (uint256 i; i < 3; ++i) {
            _reveal(seats[i], answers[i]);
        }
    }

    function _abstain(address seat) internal {
        vm.prank(seat);
        panel.abstain(query);
    }

    function _status() internal view returns (IPanelEscalation.CaseStatus) {
        return panel.getCase(query).status;
    }

    function _assertStakes(address[3] memory seats, uint256 stake) internal view {
        for (uint256 i; i < 3; ++i) {
            assertEq(panel.stakeOf(seats[i]), stake, "stake changed");
        }
    }

    // ------------------------------------------------------------------ two of three: the panel is void

    /// Two abstentions void a first panel at once (before any deadline), whatever the third seat did: nobody is
    /// slashed, the fee goes back to the payer, the seats are released and the case is DRAW_EXPIRED, so it can be
    /// escalated again.
    function testTwoAbstentionsVoidTheFirstPanel() public {
        address[3] memory seats = _escalateAndDraw();
        uint256 payerBefore = token.balanceOf(payer);
        _abstain(seats[0]);
        vm.expectEmit(true, true, false, false, address(panel));
        emit IPanelEscalation.Abstained(query, seats[1]);
        _abstain(seats[1]);
        _commit(seats[2], 0, bytes32(uint256(1)));
        // All three seats acted: the case is REVEAL, and the void does not wait for the reveal deadline.
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.REVEAL));
        assertLt(block.timestamp, panel.getCase(query).commitDeadline);
        vm.expectEmit(true, false, false, true, address(panel));
        emit IPanelEscalation.PanelVoided(query, 0, FEE);
        panel.resolve(query);

        IPanelEscalation.Case memory c = panel.getCase(query);
        assertEq(uint8(c.status), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(c.fee, 0);
        assertEq(token.balanceOf(payer), payerBefore + FEE, "fee refunded to the payer");
        _assertStakes(seats, MIN);
        assertEq(panel.slashedPool(), 0);
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.totalStaked(), 6 * MIN);
        for (uint256 i; i < 3; ++i) {
            assertEq(panel.openPanels(seats[i]), 0, "seat released");
            assertEq(panel.panelOf(query, 0)[i], address(0), "void panel dropped");
        }
        assertEq(verdicts.postCount(), 0);

        // Escalated again: a fresh first panel is drawn and the case runs as usual.
        address[3] memory again = _escalateAndDraw();
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.COMMIT));
        _vote(again, 0, [bytes32(uint256(4)), bytes32(uint256(4)), bytes32(uint256(5))]);
        panel.resolve(query);
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.RESOLVED_MAJORITY));
    }

    /// With exactly three evaluators the same seats are drawn again after a void; nothing they did on the void panel
    /// (a commit, a reveal, an abstention) carries over to the new one.
    function testVoidPanelVotesDoNotCarryOver() public {
        for (uint256 i = 3; i < 6; ++i) {
            vm.prank(_ev(i));
            panel.requestUnstake();
        }
        address[3] memory seats = _escalateAndDraw();
        _abstain(seats[0]);
        _abstain(seats[1]);
        _commit(seats[2], 0, bytes32(uint256(9)));
        vm.warp(uint256(panel.getCase(query).commitDeadline) + 1);
        _reveal(seats[2], bytes32(uint256(9)));
        (bytes32 ah,) = panel.revealOf(query, 0, seats[2]);
        assertEq(ah, bytes32(uint256(9)));
        uint256 seat2Before = token.balanceOf(seats[2]);
        panel.resolve(query);
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(token.balanceOf(seats[2]), seat2Before, "a void panel pays nobody");
        _assertStakes(seats, MIN);

        address[3] memory again = _escalateAndDraw();
        for (uint256 i; i < 3; ++i) {
            assertTrue(again[i] == seats[0] || again[i] == seats[1] || again[i] == seats[2]);
            (bytes32 a, bytes32 p) = panel.revealOf(query, 0, again[i]);
            assertEq(a, bytes32(0), "reveal cleared");
            assertEq(p, bytes32(0), "reveal cleared");
        }
        // Every seat can act again: commit, reveal, and a majority resolves and finalizes.
        _vote(again, 0, [bytes32(uint256(7)), bytes32(uint256(7)), bytes32(uint256(8))]);
        panel.resolve(query);
        vm.warp(uint256(panel.getCase(query).appealDeadline) + 1);
        panel.finalize(query);
        assertEq(verdicts.lastAnswer(), bytes32(uint256(7)));
        assertEq(panel.escrowedCaseFees(), 0);
    }

    /// All three seats abstaining is a void panel too.
    function testThreeAbstentionsVoidThePanel() public {
        address[3] memory seats = _escalateAndDraw();
        for (uint256 i; i < 3; ++i) {
            _abstain(seats[i]);
        }
        panel.resolve(query);
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        _assertStakes(seats, MIN);
        assertEq(panel.escrowedCaseFees(), 0);
    }

    /// Two abstentions on the appeal panel: the appeal lapses like an appeal whose draw expired. The appeal fee goes
    /// back to the payer, nobody on either panel is slashed, and the first panel's majority is finalized and paid.
    function testTwoAbstentionsLapseTheAppeal() public {
        address[3] memory first = _escalateAndDraw();
        _vote(first, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2))]);
        panel.resolve(query);
        address[3] memory second = _appealAndDraw();
        uint256 payerBefore = token.balanceOf(payer);
        uint256[3] memory firstBefore;
        for (uint256 i; i < 3; ++i) {
            firstBefore[i] = token.balanceOf(first[i]);
        }

        _abstain(second[0]);
        _commit(second[1], 1, bytes32(uint256(2)));
        _abstain(second[2]);
        vm.expectEmit(true, false, false, true, address(panel));
        emit IPanelEscalation.PanelVoided(query, 1, FEE);
        panel.resolve(query);

        IPanelEscalation.Case memory c = panel.getCase(query);
        assertEq(uint8(c.status), uint8(IPanelEscalation.CaseStatus.FINAL));
        assertEq(c.panelIndex, 0);
        assertEq(verdicts.postCount(), 1);
        assertEq(verdicts.lastAnswer(), bytes32(uint256(1)), "first panel's majority stands");
        assertEq(token.balanceOf(payer), payerBefore + FEE, "appeal fee refunded");
        assertEq(token.balanceOf(first[0]) - firstBefore[0], FEE / 2);
        assertEq(token.balanceOf(first[1]) - firstBefore[1], FEE / 2);
        assertEq(token.balanceOf(first[2]), firstBefore[2]);
        _assertStakes(first, MIN);
        _assertStakes(second, MIN);
        for (uint256 i; i < 3; ++i) {
            assertEq(panel.openPanels(first[i]), 0);
            assertEq(panel.openPanels(second[i]), 0);
        }
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.slashedPool(), 0);
    }

    // ------------------------------------------------------------------ one abstainer: slashed like a non-revealer

    /// A lone abstention cannot be used to dodge a hard case: the abstainer is slashed like any non-revealer, and the
    /// two who voted resolve the case as usual (they share the fee and the slash).
    function testLoneAbstainerIsSlashed() public {
        address[3] memory seats = _escalateAndDraw();
        _abstain(seats[0]);
        _commit(seats[1], 0, bytes32(uint256(3)));
        _commit(seats[2], 0, bytes32(uint256(3)));
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.REVEAL));
        // An abstention is never revealed.
        vm.expectRevert(IPanelEscalation.BadReveal.selector);
        _reveal(seats[0], bytes32(uint256(3)));
        _reveal(seats[1], bytes32(uint256(3)));
        _reveal(seats[2], bytes32(uint256(3)));
        // One abstention does not void the panel, so resolve waits for the reveal deadline.
        vm.expectRevert(IPanelEscalation.WindowOpen.selector);
        panel.resolve(query);
        vm.warp(uint256(panel.getCase(query).revealDeadline) + 1);
        panel.resolve(query);
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.RESOLVED_MAJORITY));
        uint256 slash = MIN / 10;
        assertEq(panel.stakeOf(seats[0]), MIN - slash, "abstainer slashed");
        assertEq(panel.stakeOf(seats[1]), MIN);
        assertEq(panel.stakeOf(seats[2]), MIN);
        uint256 b1 = token.balanceOf(seats[1]);
        uint256 b2 = token.balanceOf(seats[2]);
        vm.warp(uint256(panel.getCase(query).appealDeadline) + 1);
        panel.finalize(query);
        assertEq(token.balanceOf(seats[1]) - b1, FEE / 2 + slash / 2);
        assertEq(token.balanceOf(seats[2]) - b2, FEE / 2 + slash / 2);
        assertEq(panel.slashedPool(), 0);
    }

    // ------------------------------------------------------------------ who may abstain, and when

    function testAbstainRules() public {
        vm.prank(payer);
        panel.escalate(query);
        vm.expectRevert(
            abi.encodeWithSelector(IPanelEscalation.WrongCaseStatus.selector, IPanelEscalation.CaseStatus.DRAWING)
        );
        _abstain(_ev(0));
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        panel.draw(query);
        address[3] memory seats = panel.panelOf(query, 0);

        // Not a seat of the current panel.
        address outsider = address(0xD00D);
        for (uint256 i; i < 6; ++i) {
            if (_ev(i) != seats[0] && _ev(i) != seats[1] && _ev(i) != seats[2]) outsider = _ev(i);
        }
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.NotPanelist.selector, outsider));
        _abstain(outsider);

        // After a commit, and twice.
        _commit(seats[0], 0, bytes32(uint256(1)));
        vm.expectRevert(IPanelEscalation.AlreadyCommitted.selector);
        _abstain(seats[0]);
        _abstain(seats[1]);
        vm.expectRevert(IPanelEscalation.AlreadyCommitted.selector);
        _abstain(seats[1]);
        // An abstainer cannot commit afterwards either.
        vm.expectRevert(IPanelEscalation.AlreadyCommitted.selector);
        _commit(seats[1], 0, bytes32(uint256(1)));

        // After the commit deadline.
        vm.warp(uint256(panel.getCase(query).commitDeadline) + 1);
        vm.expectRevert(IPanelEscalation.WindowClosed.selector);
        _abstain(seats[2]);
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.COMMIT));
    }

    /// Once every seat has acted the case is REVEAL and nobody can abstain any more.
    function testNoAbstentionOnceAllActed() public {
        address[3] memory seats = _escalateAndDraw();
        for (uint256 i; i < 3; ++i) {
            _commit(seats[i], 0, bytes32(uint256(1)));
        }
        assertEq(uint8(_status()), uint8(IPanelEscalation.CaseStatus.REVEAL));
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(IPanelEscalation.AlreadyCommitted.selector);
            _abstain(seats[i]);
        }
    }

    // ------------------------------------------------------------------ exact splits (shared payout helper)

    /// The first majority seat (in seat order) receives the remainder of an uneven split.
    function testMajorityFeeSplitGivesTheRemainderToTheFirstSeat() public {
        uint256 fee = 10_000_001;
        panel.setEconomics(MIN, fee);
        address[3] memory seats = _escalateAndDraw();
        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = token.balanceOf(seats[i]);
        }
        _vote(seats, 0, [bytes32(uint256(6)), bytes32(uint256(5)), bytes32(uint256(6))]);
        panel.resolve(query);
        vm.warp(uint256(panel.getCase(query).appealDeadline) + 1);
        panel.finalize(query);
        assertEq(token.balanceOf(seats[0]) - before[0], fee / 2 + 1);
        assertEq(token.balanceOf(seats[1]), before[1]);
        assertEq(token.balanceOf(seats[2]) - before[2], fee / 2);
        assertEq(panel.escrowedCaseFees(), 0);
    }

    /// Without a majority the fee is split among all revealers (remainder to the first), or refunded if none revealed.
    function testNoMajorityFeeSplitAmongRevealers() public {
        uint256 fee = 10_000_001;
        panel.setEconomics(MIN, fee);
        address[3] memory seats = _escalateAndDraw();
        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = token.balanceOf(seats[i]);
        }
        _vote(seats, 0, [bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))]);
        panel.resolve(query);
        panel.finalize(query);
        assertEq(token.balanceOf(seats[0]) - before[0], fee / 3 + fee % 3);
        assertEq(token.balanceOf(seats[1]) - before[1], fee / 3);
        assertEq(token.balanceOf(seats[2]) - before[2], fee / 3);
        assertEq(verdicts.postCount(), 0);
    }

    /// An appeal that reverses the first panel: the appeal majority gets the appeal fee and the first panel's losers'
    /// slashes; the first-panel seat that matched the final outcome gets the first fee.
    function testAppealReversalSplits() public {
        address[3] memory first = _escalateAndDraw();
        _vote(first, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2))]);
        panel.resolve(query);
        address[3] memory second = _appealAndDraw();
        uint256[3] memory b0;
        uint256[3] memory b1;
        for (uint256 i; i < 3; ++i) {
            b0[i] = token.balanceOf(first[i]);
            b1[i] = token.balanceOf(second[i]);
        }
        _vote(second, 1, [bytes32(uint256(2)), bytes32(uint256(2)), bytes32(uint256(2))]);
        panel.resolve(query);
        panel.finalize(query);
        uint256 slash = MIN / 10;
        assertEq(panel.stakeOf(first[0]), MIN - slash);
        assertEq(panel.stakeOf(first[1]), MIN - slash);
        assertEq(panel.stakeOf(first[2]), MIN);
        assertEq(token.balanceOf(first[2]) - b0[2], FEE, "the first-panel seat that matched gets the first fee");
        assertEq(token.balanceOf(first[0]), b0[0]);
        assertEq(token.balanceOf(first[1]), b0[1]);
        uint256 shared = FEE + 2 * slash;
        assertEq(token.balanceOf(second[0]) - b1[0], shared / 3 + shared % 3);
        assertEq(token.balanceOf(second[1]) - b1[1], shared / 3);
        assertEq(token.balanceOf(second[2]) - b1[2], shared / 3);
        assertEq(verdicts.lastAnswer(), bytes32(uint256(2)));
        assertEq(panel.slashedPool(), 0);
        assertEq(panel.escrowedCaseFees(), 0);
    }
}
