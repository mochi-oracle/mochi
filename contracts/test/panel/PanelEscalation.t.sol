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
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MockEscrow, MockVerdicts, MockRandomness} from "./mocks/PanelMocks.sol";

contract PanelEscalationTest is Test {
    MockUSDG token;
    MockEscrow escrow;
    MockVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    address payer = address(0xBEEF);
    address[6] people =
        [address(0x101), address(0x102), address(0x103), address(0x104), address(0x105), address(0x106)];
    bytes32 query = keccak256("query");
    uint256 constant MIN = 100e6;
    uint256 constant FEE = 9e6;

    function setUp() public {
        token = new MockUSDG();
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
        for (uint256 i; i < people.length; ++i) {
            token.mint(people[i], 200e6);
            vm.prank(people[i]);
            token.approve(address(panel), type(uint256).max);
            vm.prank(people[i]);
            panel.stake(MIN);
        }
        token.mint(payer, 100e6);
        vm.prank(payer);
        token.approve(address(panel), type(uint256).max);
        _setQuery(true, false);
    }

    function _setQuery(bool isPublic, bool consent) internal {
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = isPublic;
        q.allowPanelDisclosure = consent;
        q.payer = payer;
        q.refundTo = payer;
        escrow.setQuery(query, q);
    }

    function _escalateAndDraw() internal {
        vm.prank(payer);
        panel.escalate(query);
        vm.roll(block.number + 2);
        panel.draw(query);
    }

    function _vote(uint8 pi, uint8 pattern, bool skipThird) internal {
        address[3] memory seats = panel.panelOf(query, pi);
        bytes32 salt = keccak256(abi.encode(pi, pattern));
        for (uint256 i; i < 3; ++i) {
            if (skipThird && i == 2) continue;
            bytes32 answer = _answer(pattern, i);
            bytes32 payload = keccak256(abi.encode(answer));
            bytes32 commitment = keccak256(abi.encode(query, pi, seats[i], answer, payload, salt));
            vm.prank(seats[i]);
            panel.commit(query, commitment);
        }
        if (skipThird) vm.warp(panel.getCase(query).commitDeadline + 1);
        else vm.warp(block.timestamp + 1);
        for (uint256 i; i < 3; ++i) {
            if (skipThird && i == 2) continue;
            bytes32 answer = _answer(pattern, i);
            bytes32 payload = keccak256(abi.encode(answer));
            vm.prank(seats[i]);
            panel.reveal(query, answer, payload, salt);
        }
    }

    function _answer(uint8 pattern, uint256 i) internal pure returns (bytes32) {
        if (pattern == 3) return bytes32(i + 1);
        return bytes32(uint256(pattern == 0 || i < 2 ? pattern + 1 : pattern + 2));
    }

    function testStakeUnstakeWithdrawalAndOpenPanelLock() public {
        _escalateAndDraw();
        address e = panel.panelOf(query, 0)[0];
        vm.prank(e);
        panel.requestUnstake();
        _vote(0, 0, false);
        panel.resolve(query);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(PanelEscalation.PanelStillOpen.selector);
        vm.prank(e);
        panel.withdraw();
        panel.finalize(query);
        vm.prank(e);
        panel.withdraw();
        assertEq(panel.stakeOf(e), 0);
    }

    function testEscalationDisclosureAndStatusChecks() public {
        _setQuery(false, false);
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.DisclosureNotAllowed.selector, query));
        vm.prank(payer);
        panel.escalate(query);
        _setQuery(false, true);
        vm.prank(payer);
        panel.escalate(query);
        assertTrue(escrow.marked(query));
    }

    function testUnauthorizedEscalationAndNotHung() public {
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.Unauthorized.selector, address(0xCAFE)));
        vm.prank(address(0xCAFE));
        panel.escalate(query);
        _setQuery(true, false);
        MochiTypes.Query memory q = escrow.getQuery(query);
        q.status = MochiTypes.QueryStatus.DECIDED;
        escrow.setQuery(query, q);
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.NotEscalatable.selector, query));
        vm.prank(payer);
        panel.escalate(query);
    }

    function testDrawDistinctAndAppealDrawExcludesPanelZero() public {
        _escalateAndDraw();
        address[3] memory first = panel.panelOf(query, 0);
        assertTrue(first[0] != first[1] && first[0] != first[2] && first[1] != first[2]);
        _vote(0, 2, false);
        panel.resolve(query);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(block.number + 2);
        panel.draw(query);
        address[3] memory second = panel.panelOf(query, 1);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                assertTrue(second[i] != first[j]);
            }
        }
    }

    function testAppealReversalSlashesLoserAndPostsFinalHashes() public {
        _escalateAndDraw();
        address[3] memory first = panel.panelOf(query, 0);
        _vote(0, 2, false);
        panel.resolve(query);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(block.number + 2);
        panel.draw(query);
        address[3] memory second = panel.panelOf(query, 1);
        _vote(1, 1, false);
        panel.resolve(query);
        uint256 losingStakeBefore = panel.stakeOf(first[2]);
        uint256 secondBalanceBefore = token.balanceOf(second[0]);
        panel.finalize(query);
        assertEq(verdicts.postCount(), 1);
        assertEq(verdicts.lastAnswer(), bytes32(uint256(2)));
        assertEq(verdicts.lastPayload(), keccak256(abi.encode(bytes32(uint256(2)))));
        assertEq(panel.stakeOf(first[2]), losingStakeBefore - losingStakeBefore / 10);
        assertGt(token.balanceOf(second[0]), secondBalanceBefore);
        assertEq(uint8(panel.getCase(query).status), uint8(IPanelEscalation.CaseStatus.FINAL));
    }

    function testNonrevealerSlashAndFeeDistributionConservesUsdG() public {
        _escalateAndDraw();
        address[3] memory seats = panel.panelOf(query, 0);
        uint256 beforeStake = panel.stakeOf(seats[2]);
        uint256 payerStart = token.balanceOf(payer);
        _vote(0, 0, true);
        vm.warp(panel.getCase(query).revealDeadline + 1);
        panel.resolve(query);
        vm.warp(panel.getCase(query).appealDeadline + 1);
        panel.finalize(query);
        assertEq(panel.stakeOf(seats[2]), beforeStake - beforeStake / 10);
        assertEq(verdicts.postCount(), 1);
        assertEq(panel.reserveBalance(), 0);
        assertEq(token.balanceOf(payer), payerStart);
        uint256 distributed = token.balanceOf(address(panel)) + token.balanceOf(payer);
        for (uint256 i; i < people.length; ++i) {
            distributed += token.balanceOf(people[i]);
        }
        assertEq(distributed, token.totalSupply());
    }

    function testInsufficientEvaluators() public {
        _escalateAndDraw();
        for (uint256 i = 3; i < 6; ++i) {
            vm.prank(people[i]);
            panel.requestUnstake();
        }
        // Existing first-panel evaluators remain active until request; only three remain, so an appeal has no disjoint panel.
        _vote(0, 0, false);
        panel.resolve(query);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(block.number + 2);
        vm.expectRevert(IPanelEscalation.NotEnoughEvaluators.selector);
        panel.draw(query);
    }

    function testBadRevealAndWindowRules() public {
        _escalateAndDraw();
        address e = panel.panelOf(query, 0)[0];
        bytes32 answer = bytes32(uint256(1));
        bytes32 payload = keccak256(abi.encode(answer));
        bytes32 salt = keccak256("salt");
        vm.prank(e);
        panel.commit(query, keccak256(abi.encode(query, uint8(0), e, answer, payload, salt)));
        vm.warp(panel.getCase(query).commitDeadline + 1);
        vm.expectRevert(IPanelEscalation.WindowOpen.selector);
        panel.resolve(query);
        vm.expectRevert(IPanelEscalation.BadReveal.selector);
        vm.prank(e);
        panel.reveal(query, bytes32(uint256(2)), payload, salt);
        vm.warp(panel.getCase(query).revealDeadline + 1);
        vm.expectRevert(IPanelEscalation.WindowClosed.selector);
        vm.prank(e);
        panel.reveal(query, answer, payload, salt);
        panel.resolve(query);
        panel.finalize(query);
        assertEq(verdicts.postCount(), 0);
    }

    function testNoMajorityReturnsFeesToRevealersWithoutPosting() public {
        _escalateAndDraw();
        _vote(0, 3, false);
        panel.resolve(query);
        panel.finalize(query);
        assertEq(verdicts.postCount(), 0);
        assertEq(uint8(panel.getCase(query).status), uint8(IPanelEscalation.CaseStatus.FINAL));
        assertEq(panel.reserveBalance(), 0);
    }

    function testAppealConfirmingFirstOutcomeDoesNotSlash() public {
        _escalateAndDraw();
        address[3] memory first = panel.panelOf(query, 0);
        _vote(0, 0, false);
        panel.resolve(query);
        vm.prank(payer);
        panel.appeal(query);
        vm.roll(block.number + 2);
        panel.draw(query);
        _vote(1, 0, false);
        panel.resolve(query);
        uint256 stakeBefore = panel.stakeOf(first[2]);
        panel.finalize(query);
        assertEq(panel.stakeOf(first[2]), stakeBefore);
        assertEq(verdicts.postCount(), 1);
        assertEq(panel.reserveBalance(), 0);
    }

    function testReserveWithdrawalCannotTouchLiabilities() public {
        token.mint(address(panel), 12e6);
        panel.withdrawReserve(address(this), 12e6);
        assertEq(token.balanceOf(address(this)), 12e6);
        vm.expectRevert(abi.encodeWithSelector(PanelEscalation.ReserveExceeded.selector, uint256(1), uint256(0)));
        panel.withdrawReserve(address(this), 1);
    }

    function testResealAfterMissedSeedWindow() public {
        vm.prank(payer);
        panel.escalate(query);
        uint64 sealBlock = panel.getCase(query).sealBlock;
        vm.expectRevert(IPanelEscalation.WindowOpen.selector);
        panel.reseal(query);
        vm.roll(uint256(sealBlock) + 257);
        panel.reseal(query);
        uint64 newSeal = panel.getCase(query).sealBlock;
        assertGt(newSeal, sealBlock);
        vm.roll(uint256(newSeal) + 1);
        panel.draw(query);
        assertEq(uint256(panel.getCase(query).status), uint256(IPanelEscalation.CaseStatus.COMMIT));
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.WrongCaseStatus.selector, IPanelEscalation.CaseStatus.COMMIT));
        panel.reseal(query);
    }
}
