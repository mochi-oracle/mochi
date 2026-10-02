// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PanelEscalation} from "@mochi/PanelEscalation.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {FreezableUSDG, MockEscrow, MockVerdicts, MockRandomness} from "../mocks/PanelMocks.sol";

/// Drand-like: ticket = round(now) + 2, never expires, seed only once the beacon is posted.
contract DrandLike {
    mapping(uint64 => bytes32) public beacon;

    function round() public view returns (uint64) {
        return uint64(block.timestamp / 3) + 1;
    }

    function nextTicket() external view returns (uint64) {
        return round() + 2;
    }

    function isExpired(uint64) external pure returns (bool) {
        return false;
    }

    function post(uint64 r) external {
        beacon[r] = keccak256(abi.encode("beacon", r));
    }

    function seed(bytes32 context, uint64 r) external view returns (bytes32) {
        bytes32 v = beacon[r];
        if (v == 0) revert IRandomness.SeedNotReady(r, round());
        return keccak256(abi.encode(context, v));
    }
}

/// Sybil that the attacker drives from one transaction.
contract Sybil {
    function act(PanelEscalation panel, FreezableUSDG token, uint256 amount) external {
        token.approve(address(panel), amount);
        panel.stake(amount);
        panel.requestUnstake();
    }

    function join(PanelEscalation panel, FreezableUSDG token, uint256 amount) external {
        token.approve(address(panel), amount);
        panel.stake(amount);
    }

    function leave(PanelEscalation panel) external {
        panel.requestUnstake();
    }

    function withdraw(PanelEscalation panel, FreezableUSDG token, address to) external returns (bool ok) {
        (ok,) = address(panel).call(abi.encodeCall(PanelEscalation.withdraw, ()));
        if (ok) token.transfer(to, token.balanceOf(address(this)));
    }
}

/// Regression tests for the adversarial review of the hardened PanelEscalation. Each started as the reviewer's proof of
/// concept (which passed while the bug existed); the attack steps are kept and the assertions now require the fix.
/// They call `draw` through low-level calls (its return value changed), so they compile against the pre-fix contract
/// too, where they fail.
contract ReviewPoC is Test {
    FreezableUSDG token;
    MockEscrow escrow;
    MockVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    uint256 constant MIN = 2_500e6; // mainnet minStake
    uint256 constant FEE = 25e6; // mainnet panelFee
    uint256 constant CALL_GAS_BOUND = 1_500_000;
    address victim = address(0xB0B);
    address attacker = address(0xA77);

    function _deploy(IRandomness r) internal {
        token = new FreezableUSDG();
        escrow = new MockEscrow();
        verdicts = new MockVerdicts();
        panel = new PanelEscalation(
            address(this), token, IQueryEscrow(address(escrow)), IMochiVerdicts(address(verdicts)), r, MIN, FEE
        );
        token.mint(victim, 1_000e6);
        token.mint(attacker, 1_000e6);
        vm.prank(victim);
        token.approve(address(panel), type(uint256).max);
        vm.prank(attacker);
        token.approve(address(panel), type(uint256).max);
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

    function _query(bytes32 id, address payer) internal {
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = true;
        q.payer = payer;
        q.refundTo = payer;
        escrow.setQuery(id, q);
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

    function _draw(bytes32 id) internal returns (bool ok) {
        (ok,) = address(panel).call(abi.encodeWithSignature("draw(bytes32)", id));
    }

    /// Calls draw (each call its own cold transaction) until the case leaves DRAWING; a draw may span calls.
    function _drawUntilSeated(bytes32 id) internal returns (bool seated, uint256 calls, uint256 maxGas) {
        while (calls < 200 && _status(id) == IPanelEscalation.CaseStatus.DRAWING) {
            vm.cool(address(panel));
            uint256 before = gasleft();
            bool ok = _draw(id);
            uint256 used = before - gasleft();
            ++calls;
            if (used > maxGas) maxGas = used;
            if (!ok) return (false, calls, maxGas);
        }
        seated = _status(id) == IPanelEscalation.CaseStatus.COMMIT;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 1. Kept ("dead") positions plus a pending dummy draw used to make the payer's appeal undrawable, so it lapsed and
    //    the first panel's answer was posted. Positions that were never active at a pending seal now go at once, every
    //    possible draw finishes, and the appeal is seated.
    // ---------------------------------------------------------------------------------------------------------------
    function _deadPositions(uint256 k) internal returns (Sybil[] memory sybils) {
        sybils = new Sybil[](k);
        for (uint256 i; i < k; ++i) {
            sybils[i] = new Sybil();
            token.mint(address(sybils[i]), MIN);
            sybils[i].act(panel, token, MIN);
        }
    }

    function test_deadPositionsCannotLapseAnAppeal() public {
        rng = new MockRandomness();
        _deploy(IRandomness(address(rng)));
        for (uint256 i; i < 6; ++i) _stake(_ev(i), MIN); // the doc's minimum for appeals
        vm.roll(block.number + 10);
        bytes32 v = keccak256("victim-case");
        bytes32 d0 = keccak256("dummy-0");
        bytes32 d1 = keccak256("dummy-1");
        _query(v, victim);
        _query(d0, attacker);
        _query(d1, attacker);

        vm.prank(victim);
        panel.escalate(v);
        vm.roll(uint256(panel.getCase(v).sealBlock) + 1);
        assertTrue(_draw(v));
        _vote(v, 0, [bytes32("X"), bytes32("X"), bytes32("Y")]); // the attacker wants X
        panel.resolve(v);

        // The attack: a dummy draw is pending, K sybils stake and request unstake, a second dummy is sealed.
        vm.prank(attacker);
        panel.escalate(d0);
        Sybil[] memory sybils = _deadPositions(200);
        vm.prank(attacker);
        panel.escalate(d1);
        emit log_named_uint("pool length after 200 sybil stake+unstake", panel.poolLength());
        // No pending draw could pick the sybils (none was sealed while they were active): their positions are gone.
        assertEq(panel.poolLength(), 6, "dead positions stayed in the pool");
        assertEq(panel.getCase(d1).poolSize, 6);

        vm.roll(block.number + 2);
        assertTrue(_draw(d0));
        (bool d1ok,,) = _drawUntilSeated(d1);
        assertTrue(d1ok, "dummy-1 not drawable");
        (bool pruned,) = address(panel).call(abi.encodeCall(PanelEscalation.prune, (1000)));
        assertTrue(pruned, "prune reverted");

        // The payer appeals: the appeal panel is drawn, nothing lapses and nothing is posted yet.
        vm.prank(victim);
        panel.appeal(v);
        assertLt(panel.getCase(v).poolSize, 10);
        vm.roll(uint256(panel.getCase(v).sealBlock) + 1);
        (bool seated,,) = _drawUntilSeated(v);
        assertTrue(seated, "appeal panel not drawn");
        assertEq(panel.getCase(v).panelIndex, 1);
        assertEq(verdicts.postCount(), 0, "appeal lapsed");

        // Sybil capital is not locked by anyone else's draw (their positions went at once).
        vm.warp(block.timestamp + 7 days + 1);
        for (uint256 i; i < sybils.length; ++i) assertTrue(sybils[i].withdraw(panel, token, attacker));
    }

    /// The front-run variant: warm sybils that were active at a pending seal leave just before the appeal is sealed, so
    /// their kept positions sit inside the appeal's frozen pool. They cost the draw gas, never the draw, and their
    /// stake stays locked until the draw that could pick them ends.
    function test_deadPositionsInsideTheAppealPoolOnlyCostGas() public {
        rng = new MockRandomness();
        _deploy(IRandomness(address(rng)));
        for (uint256 i; i < 6; ++i) _stake(_ev(i), MIN);
        vm.roll(block.number + 10);
        bytes32 v = keccak256("victim-case");
        bytes32 d0 = keccak256("dummy-0");
        _query(v, victim);
        _query(d0, attacker);
        vm.prank(victim);
        panel.escalate(v);
        vm.roll(uint256(panel.getCase(v).sealBlock) + 1);
        assertTrue(_draw(v));
        _vote(v, 0, [bytes32("X"), bytes32("X"), bytes32("Y")]);
        panel.resolve(v);

        Sybil[] memory sybils = new Sybil[](200);
        for (uint256 i; i < sybils.length; ++i) {
            sybils[i] = new Sybil();
            token.mint(address(sybils[i]), MIN);
            sybils[i].join(panel, token, MIN);
        }
        vm.roll(block.number + 5); // warm
        vm.prank(attacker);
        panel.escalate(d0); // the sybils are active at this seal: d0 may pick them
        for (uint256 i; i < sybils.length; ++i) sybils[i].leave(panel);
        vm.prank(victim);
        panel.appeal(v); // same block: the appeal's frozen pool holds 200 positions it can never pick
        assertEq(panel.getCase(v).poolSize, 206);
        vm.roll(uint256(panel.getCase(v).sealBlock) + 1);
        (bool seated, uint256 calls, uint256 maxGas) = _drawUntilSeated(v);
        assertTrue(seated, "appeal panel not drawn");
        assertLt(maxGas, CALL_GAS_BOUND);
        emit log_named_uint("appeal draw over 200 dead positions: calls", calls);
        emit log_named_uint("appeal draw over 200 dead positions: max gas per call", maxGas);
        address[3] memory first = panel.panelOf(v, 0);
        address[3] memory second = panel.panelOf(v, 1);
        for (uint256 i; i < 3; ++i) {
            assertTrue(uint160(second[i]) >= 0x1000 && uint160(second[i]) < 0x1006, "appeal seat is not an honest evaluator");
            assertTrue(second[i] != first[0] && second[i] != first[1] && second[i] != first[2]);
        }

        // The sybils' stake stays behind their kept positions while d0 can still pick them.
        vm.warp(block.timestamp + 7 days + 1);
        assertFalse(sybils[0].withdraw(panel, token, attacker), "withdrew while a pending draw could pick it");
        panel.expireDraw(d0); // past its expiry: refunded without a draw
        while (panel.prune(500) != 0) {}
        assertEq(panel.poolLength(), 6);
        for (uint256 i; i < sybils.length; ++i) assertTrue(sybils[i].withdraw(panel, token, attacker));
    }

    /// Share of draws that succeed (6 honest evaluators, 3 on the first panel) as kept positions inside every frozen
    /// pool grow. Before the fix: 40/27/11/5 of 40 appeals at 0/50/100/200 dead positions.
    function test_appealDrawRateVsDeadPositions() public {
        uint256[4] memory ks = [uint256(0), 50, 100, 200];
        for (uint256 j; j < ks.length; ++j) {
            rng = new MockRandomness();
            _deploy(IRandomness(address(rng)));
            for (uint256 i; i < 6; ++i) _stake(_ev(i), MIN);
            Sybil[] memory sybils = new Sybil[](ks[j]);
            for (uint256 i; i < sybils.length; ++i) {
                sybils[i] = new Sybil();
                token.mint(address(sybils[i]), MIN);
                sybils[i].join(panel, token, MIN);
            }
            vm.roll(block.number + 10);
            bytes32 holder = keccak256(abi.encode("holder", j));
            _query(holder, attacker);
            vm.prank(attacker);
            panel.escalate(holder); // never drawn here: the sybils' positions stay kept in every later frozen pool
            for (uint256 i; i < sybils.length; ++i) sybils[i].leave(panel);
            vm.roll(block.number + 5);
            uint256 ok;
            uint256 firsts;
            uint256 maxCalls;
            uint256 maxGas;
            uint256 n = 40;
            for (uint256 c; c < n; ++c) {
                bytes32 id = keccak256(abi.encode("case", j, c));
                _query(id, victim);
                token.mint(victim, 2 * FEE);
                vm.prank(victim);
                panel.escalate(id);
                vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
                (bool f, uint256 calls, uint256 gasUsed) = _drawUntilSeated(id);
                if (calls > maxCalls) maxCalls = calls;
                if (gasUsed > maxGas) maxGas = gasUsed;
                if (!f) continue;
                ++firsts;
                _vote(id, 0, [bytes32("X"), bytes32("X"), bytes32("Y")]);
                panel.resolve(id);
                vm.prank(victim);
                panel.appeal(id);
                vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
                bool a;
                (a, calls, gasUsed) = _drawUntilSeated(id);
                if (calls > maxCalls) maxCalls = calls;
                if (gasUsed > maxGas) maxGas = gasUsed;
                if (a) ++ok;
            }
            console.log("dead positions", ks[j]);
            console.log("  first panels drawn of 40:", firsts);
            console.log("  appeals drawn:", ok);
            console.log("  max draw calls / max gas per call:", maxCalls, maxGas);
            assertEq(firsts, n, "a first panel was not drawn");
            assertEq(ok, n, "an appeal was not drawn");
            assertLt(maxGas, CALL_GAS_BOUND);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 2. After a minStake increase, an under-staked evaluator that was not kicked could, once the seed was public, take
    //    itself out of a pending draw (kick + top-up re-activated it with a fresh join ticket). Re-activating a position
    //    a pending draw may pick now reverts, and the kick alone does not change the draw.
    // ---------------------------------------------------------------------------------------------------------------
    function test_postSeedSelfRemovalCannotChangeThePanel() public {
        rng = new MockRandomness();
        _deploy(IRandomness(address(rng)));
        for (uint256 i; i < 12; ++i) _stake(_ev(i), MIN);
        address e = address(0xEE);
        _stake(e, MIN);
        vm.roll(block.number + 10);
        panel.setEconomics(MIN + 1, FEE); // governance raises minStake; nobody has been kicked yet

        // Find a case whose (public) seed draws e.
        bytes32 id;
        address[3] memory expected;
        for (uint256 c; c < 200; ++c) {
            id = keccak256(abi.encode("c", c));
            _query(id, victim);
            vm.prank(victim);
            panel.escalate(id);
            vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
            uint256 snap = vm.snapshotState();
            assertTrue(_draw(id));
            expected = panel.panelOf(id, 0);
            vm.revertToState(snap);
            if (expected[0] == e || expected[1] == e || expected[2] == e) break;
            assertTrue(_draw(id));
        }
        assertTrue(expected[0] == e || expected[1] == e || expected[2] == e, "no case drew e");

        // Seed is public. e kicks itself (anyone may) and tries to top up: refused while the draw may pick it.
        panel.kick(e);
        token.mint(e, 1);
        vm.prank(e);
        token.approve(address(panel), 1);
        vm.prank(e);
        (bool topUp, bytes memory reason) = address(panel).call(abi.encodeCall(PanelEscalation.stake, (1)));
        assertFalse(topUp, "re-activation of a position a pending draw may pick");
        assertEq(bytes4(reason), IPanelEscalation.DrawPending.selector);
        assertTrue(_draw(id));
        address[3] memory got = panel.panelOf(id, 0);
        for (uint256 i; i < 3; ++i) assertEq(got[i], expected[i], "panel changed after the seed was public");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 3. Drand: isExpired is always false, so a beacon that was never posted kept the case DRAWING forever. Past the
    //    draw's expiry (sealTime + unstakeCooldown) it now ends without a seed.
    // ---------------------------------------------------------------------------------------------------------------
    function test_drandBeaconNeverPostedCannotLockForever() public {
        DrandLike d = new DrandLike();
        vm.warp(1_000_000);
        _deploy(IRandomness(address(d)));
        for (uint256 i; i < 6; ++i) _stake(_ev(i), MIN);
        vm.warp(block.timestamp + 60);
        bytes32 v = keccak256("v");
        _query(v, victim);
        uint256 victimBefore = token.balanceOf(victim);
        vm.prank(victim);
        panel.escalate(v);
        // Past the draw deadline but before the expiry the beacon can still be posted: expiry waits for it.
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert();
        panel.expireDraw(v);
        vm.warp(block.timestamp + 363 days);
        (bool expired,) = address(panel).call(abi.encodeWithSignature("expireDraw(bytes32)", v));
        assertTrue(expired, "case stays DRAWING forever");
        assertEq(uint8(_status(v)), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        assertEq(token.balanceOf(victim), victimBefore, "fee not refunded");
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.pendingDraws(), 0);
        (bool pruned,) = address(panel).call(abi.encodeCall(PanelEscalation.prune, (1)));
        assertTrue(pruned);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // 4. Drand: a draw left pending past the unstake cooldown could be steered by an evaluator that requested unstake
    //    after the seal (withdrawing made its position undrawable). Now its stake stays behind the position while the
    //    draw can pick it, no panel is seated past the expiry, and inside the expiry the draw is the one the seed fixed.
    // ---------------------------------------------------------------------------------------------------------------
    function test_stalePendingDrawCannotChangeAfterWithdraw() public {
        DrandLike d = new DrandLike();
        vm.warp(1_000_000);
        _deploy(IRandomness(address(d)));
        for (uint256 i; i < 8; ++i) _stake(_ev(i), MIN);
        vm.warp(block.timestamp + 60);
        bytes32 id = keccak256(abi.encode("s", uint256(0)));
        _query(id, victim);
        vm.prank(victim);
        panel.escalate(id);
        d.post(panel.getCase(id).sealBlock);
        uint256 snap = vm.snapshotState();
        assertTrue(_draw(id));
        address[3] memory expected = panel.panelOf(id, 0);
        vm.revertToState(snap);
        address leaver = expected[0];
        vm.prank(leaver);
        panel.requestUnstake(); // after the seal: still eligible

        // Inside the expiry the seed's panel is seated, leaver included.
        snap = vm.snapshotState();
        vm.warp(block.timestamp + 6 days);
        assertTrue(_draw(id));
        address[3] memory got = panel.panelOf(id, 0);
        for (uint256 i; i < 3; ++i) assertEq(got[i], expected[i]);
        vm.revertToState(snap);

        // The keeper did not draw within the cooldown: the leaver still cannot withdraw and nothing can be seated.
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(leaver);
        (bool withdrew,) = address(panel).call(abi.encodeCall(PanelEscalation.withdraw, ()));
        assertFalse(withdrew, "withdrew while the pending draw could pick it");
        assertFalse(_draw(id), "a panel was seated after the expiry");
        panel.expireDraw(id);
        assertEq(uint8(_status(id)), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        vm.prank(leaver);
        panel.withdraw();
        assertEq(panel.stakeOf(leaver), 0);
    }
}
