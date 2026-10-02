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

/// Worst case from the review: 300 positions, 297 of them kept by a pending draw and ineligible for every later draw,
/// three eligible evaluators. Before the fix 2 of 150 draws succeeded (the rest gave up after 64 attempts per seat).
/// Every draw must now be seated, each call within the per-call bound.
contract WorstGas is Test {
    uint256 constant CALL_GAS_BOUND = 1_500_000;

    function test_worstDrawGas() public {
        FreezableUSDG token = new FreezableUSDG();
        MockEscrow escrow = new MockEscrow();
        PanelEscalation panel = new PanelEscalation(address(this), token, IQueryEscrow(address(escrow)),
            IMochiVerdicts(address(new MockVerdicts())), IRandomness(address(new MockRandomness())), 100e6, 9e6);
        token.mint(address(0xBEEF), 1e15);
        vm.prank(address(0xBEEF));
        token.approve(address(panel), type(uint256).max);
        vm.pauseGasMetering();
        for (uint256 i; i < 300; ++i) {
            address a = address(uint160(0x5000 + i));
            token.mint(a, 100e6);
            vm.startPrank(a);
            token.approve(address(panel), type(uint256).max);
            panel.stake(100e6);
            vm.stopPrank();
        }
        vm.roll(block.number + 10);
        MochiTypes.Query memory q;
        q.status = MochiTypes.QueryStatus.HUNG;
        q.isPublic = true;
        q.payer = address(0xBEEF);
        q.refundTo = address(0xBEEF);
        bytes32 holder = keccak256("holder");
        escrow.setQuery(holder, q);
        vm.prank(address(0xBEEF));
        panel.escalate(holder);
        for (uint256 i = 3; i < 300; ++i) {
            vm.prank(address(uint160(0x5000 + i)));
            panel.requestUnstake();
        }
        vm.roll(block.number + 10);
        vm.resumeGasMetering();
        uint256 maxCall;
        uint256 maxTotal;
        uint256 maxCalls;
        uint256 oks;
        for (uint256 c; c < 150; ++c) {
            bytes32 id = keccak256(abi.encode("w", c));
            escrow.setQuery(id, q);
            vm.prank(address(0xBEEF));
            panel.escalate(id);
            vm.roll(uint256(panel.getCase(id).sealBlock) + 1);
            uint256 snap = vm.snapshotState();
            uint256 total;
            uint256 calls;
            bool ok = true;
            while (ok && calls < 100 && panel.getCase(id).status == IPanelEscalation.CaseStatus.DRAWING) {
                vm.cool(address(panel));
                uint256 g = gasleft();
                (ok,) = address(panel).call{gas: 30_000_000}(abi.encodeWithSignature("draw(bytes32)", id));
                uint256 used = g - gasleft();
                total += used;
                ++calls;
                if (used > maxCall) maxCall = used;
            }
            if (panel.getCase(id).status == IPanelEscalation.CaseStatus.COMMIT) {
                ++oks;
                if (total > maxTotal) maxTotal = total;
                if (calls > maxCalls) maxCalls = calls;
            }
            vm.revertToState(snap);
        }
        console.log("successful draws", oks);
        console.log("max gas per draw call", maxCall);
        console.log("max calls for one draw", maxCalls);
        console.log("max total gas for one draw", maxTotal);
        assertEq(oks, 150, "a possible draw was not seated");
        assertLt(maxCall, CALL_GAS_BOUND);
    }
}
