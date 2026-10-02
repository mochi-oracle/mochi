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

/// Proofs of concept for the panel audit findings. Each test fails on the pre-fix contract and passes after the fix.
/// They only call functions that existed before the fix (new ones through low-level calls), so they compile against both.
contract PanelEscalationAuditPoC is Test {
    FreezableUSDG token;
    MockEscrow escrow;
    MockVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    address payer = address(0xBEEF);
    address[6] honest =
        [address(0x101), address(0x102), address(0x103), address(0x104), address(0x105), address(0x106)];
    bytes32 query = keccak256("query");
    uint256 constant MIN = 100e6;
    uint256 constant FEE = 9e6;
    uint8 constant DRAW_EXPIRED = 8;

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
        for (uint256 i; i < honest.length; ++i) _stakeFrom(honest[i], MIN);
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(panel), type(uint256).max);
        _setQuery(query);
        // Honest evaluators staked well before anything is escalated.
        vm.roll(block.number + 20);
        vm.warp(block.timestamp + 1 hours);
    }

    function _setQuery(bytes32 id) internal {
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = true;
        q.payer = payer;
        q.refundTo = payer;
        escrow.setQuery(id, q);
    }

    function _stakeFrom(address who, uint256 amount) internal returns (bool ok) {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(panel), type(uint256).max);
        vm.prank(who);
        (ok,) = address(panel).call(abi.encodeCall(PanelEscalation.stake, (amount)));
    }

    function _escalateAndDraw(bytes32 id) internal {
        vm.prank(payer);
        panel.escalate(id);
        vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
        panel.draw(id);
    }

    function _commitReveal(bytes32 id, uint8 pi, bytes32[3] memory answers, bool[3] memory reveals) internal {
        address[3] memory seats = panel.panelOf(id, pi);
        bytes32 salt = keccak256(abi.encode(id, pi));
        for (uint256 i; i < 3; ++i) {
            bytes32 payload = answers[i] == 0 ? bytes32(uint256(7)) : keccak256(abi.encode(answers[i]));
            vm.prank(seats[i]);
            panel.commit(id, keccak256(abi.encode(id, pi, seats[i], answers[i], payload, salt)));
        }
        vm.warp(block.timestamp + 1);
        for (uint256 i; i < 3; ++i) {
            if (!reveals[i]) continue;
            bytes32 payload = answers[i] == 0 ? bytes32(uint256(7)) : keccak256(abi.encode(answers[i]));
            vm.prank(seats[i]);
            (bool ok,) = address(panel).call(abi.encodeCall(PanelEscalation.reveal, (id, answers[i], payload, salt)));
            ok;
        }
    }

    function _expireDraw(bytes32 id) internal returns (bool ok) {
        (ok,) = address(panel).call(abi.encodeWithSignature("expireDraw(bytes32)", id));
    }

    // ---------------------------------------------------------------- B-H1

    /// B-H1: once the seed is public, an attacker simulates the draw offline, adds the right number of 1-wei entries
    /// (inactive entries pass a seat to the next entry) plus two minStake entries, and takes 2 of 3 seats.
    function test_BH1_seedAwareStakingCannotCapturePanelMajority() public {
        uint256 captured;
        uint256 drawsSeen;
        for (uint256 k; k < 5; ++k) {
            bytes32 id = keccak256(abi.encode("case", k));
            _setQuery(id);
            vm.prank(payer);
            panel.escalate(id);
            vm.roll(uint256(panel.getCase(id).sealBlock) + 1); // the seed is public from here on
            (uint256 best, uint256 draws) = _bestAttack(id, k);
            drawsSeen += draws;
            if (best >= 2) ++captured;
        }
        assertGt(drawsSeen, 0, "no draw succeeded");
        assertEq(captured, 0, "attacker captured a panel majority after the seed was public");
    }

    function _bestAttack(bytes32 id, uint256 k) internal returns (uint256 best, uint256 draws) {
        address a1 = address(uint160(uint256(keccak256(abi.encode("attacker-1", k)))));
        address a2 = address(uint160(uint256(keccak256(abi.encode("attacker-2", k)))));
        for (uint256 m; m <= 60; m += 3) {
            uint256 snap = vm.snapshotState();
            _dust(k, m, 0);
            _stakeFrom(a1, MIN);
            _dust(k, m, 1);
            _stakeFrom(a2, MIN);
            (bool ok,) = address(panel).call(abi.encodeCall(PanelEscalation.draw, (id)));
            if (ok) {
                ++draws;
                address[3] memory seats = panel.panelOf(id, 0);
                uint256 mine;
                for (uint256 i; i < 3; ++i) if (seats[i] == a1 || seats[i] == a2) ++mine;
                if (mine > best) best = mine;
            }
            vm.revertToState(snap);
            if (best >= 2) break;
        }
    }

    function _dust(uint256 k, uint256 m, uint256 run) internal {
        for (uint256 i; i < m; ++i) {
            _stakeFrom(address(uint160(uint256(keccak256(abi.encode("dust", k, run, i))))), 1);
        }
    }

    /// B-H1: a stake below minStake must not create an entry at all.
    function test_BH1_dustStakeIsRejected() public {
        token.mint(address(0xD057), 1);
        vm.prank(address(0xD057));
        token.approve(address(panel), 1);
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.StakeTooLow.selector, uint256(1), MIN));
        vm.prank(address(0xD057));
        panel.stake(1);
    }

    // ---------------------------------------------------------------- B-M1

    /// B-M1: ~10k 1-wei stakers made `draw` walk the whole list (> 30M gas), so no panel could be drawn.
    function test_BM1_dustStakersCannotPushDrawPastBlockGas() public {
        vm.pauseGasMetering(); // the 10k stakes are setup, not what is measured
        for (uint256 i; i < 10_000; ++i) _stakeFrom(address(uint160(0x100000 + i)), 1);
        vm.resumeGasMetering();
        vm.prank(payer);
        panel.escalate(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        vm.cool(address(panel)); // `draw` is its own transaction: its storage reads are cold
        uint256 before = gasleft();
        (bool ok,) = address(panel).call{gas: 30_000_000}(abi.encodeCall(PanelEscalation.draw, (query)));
        uint256 used = before - gasleft();
        assertTrue(ok, "draw did not fit in 30M gas");
        assertLt(used, 3_000_000, "draw cost is not bounded");
    }

    /// B-M1: a case that cannot be drawn had no deadline: the payer's fee stayed escrowed forever.
    function test_BM1_undrawableCaseExpiresAndRefundsTheFee() public {
        for (uint256 i = 2; i < 6; ++i) {
            vm.prank(honest[i]);
            panel.requestUnstake();
        }
        uint256 payerBefore = token.balanceOf(payer);
        vm.prank(payer);
        panel.escalate(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);
        vm.warp(block.timestamp + 365 days);
        assertTrue(_expireDraw(query), "an undrawable case cannot be ended");
        assertEq(token.balanceOf(payer), payerBefore, "panel fee not refunded");
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(uint8(panel.getCase(query).status), DRAW_EXPIRED);
    }

    /// B-M1: an appeal that cannot be drawn locked the first panel's stake forever (still locked after 365 days).
    function test_BM1_undrawableAppealReleasesPanelZeroStake() public {
        _escalateAndDraw(query);
        address[3] memory first = panel.panelOf(query, 0);
        for (uint256 i; i < honest.length; ++i) {
            if (honest[i] == first[0] || honest[i] == first[1] || honest[i] == first[2]) continue;
            vm.prank(honest[i]);
            panel.requestUnstake(); // nobody is left for a disjoint appeal panel
        }
        _commitReveal(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(2))], [true, true, true]);
        panel.resolve(query);
        uint256 payerBefore = token.balanceOf(payer);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(uint256(panel.getCase(query).sealBlock) + 1);
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);

        vm.warp(block.timestamp + 365 days);
        vm.prank(first[0]);
        panel.requestUnstake();
        vm.warp(block.timestamp + 8 days);
        _expireDraw(query);
        vm.prank(first[0]);
        (bool ok,) = address(panel).call(abi.encodeCall(PanelEscalation.withdraw, ()));
        assertTrue(ok, "first-panel stake is still locked");
        assertEq(token.balanceOf(payer), payerBefore, "appeal fee not refunded");
        assertEq(panel.escrowedCaseFees(), 0);
    }

    // ---------------------------------------------------------------- cases that could never finalize

    /// Two colluding panelists reveal a zero answer hash. MochiVerdicts refuses a zero result, so `finalize` reverted
    /// forever and the honest third panelist's stake stayed locked.
    function test_zeroHashMajorityCannotBrickTheCase() public {
        _escalateAndDraw(query);
        address honestSeat = panel.panelOf(query, 0)[2];
        _commitReveal(query, 0, [bytes32(0), bytes32(0), bytes32(uint256(3))], [true, true, true]);
        vm.warp(panel.getCase(query).revealDeadline + 1);
        panel.resolve(query);
        vm.warp(block.timestamp + 2 days);
        (bool finalized,) = address(panel).call(abi.encodeCall(PanelEscalation.finalize, (query)));
        assertTrue(finalized, "case cannot be finalized");
        vm.prank(honestSeat);
        panel.requestUnstake();
        vm.warp(block.timestamp + 8 days);
        vm.prank(honestSeat);
        (bool ok,) = address(panel).call(abi.encodeCall(PanelEscalation.withdraw, ()));
        assertTrue(ok, "honest panelist's stake is locked");
    }

    /// A payout recipient the token issuer has frozen made every `finalize` revert, locking all three panelists.
    function test_frozenRecipientCannotBrickFinalize() public {
        _escalateAndDraw(query);
        address[3] memory seats = panel.panelOf(query, 0);
        token.setFrozen(seats[0], true);
        _commitReveal(query, 0, [bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1))], [true, true, true]);
        panel.resolve(query);
        vm.warp(panel.getCase(query).appealDeadline + 1);
        (bool finalized,) = address(panel).call(abi.encodeCall(PanelEscalation.finalize, (query)));
        assertTrue(finalized, "a frozen recipient blocks finalize");
        vm.prank(seats[1]);
        panel.requestUnstake();
        vm.warp(block.timestamp + 8 days);
        vm.prank(seats[1]);
        (bool ok,) = address(panel).call(abi.encodeCall(PanelEscalation.withdraw, ()));
        assertTrue(ok, "panelist stake is locked");
    }
}
