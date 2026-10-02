// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";

/// The audit lead "a second panel with no majority leaves the query stuck", against the real QueryEscrow and
/// MochiVerdicts. PanelEscalation ends the case as a terminal final HUNG (nothing escrowed or locked), but QueryEscrow
/// has no transition out of ESCALATED except markDecided (a posted verdict), so the query itself stays ESCALATED.
/// Recording a final HUNG on the query needs a QueryEscrow/MochiVerdicts change; this test pins today's behaviour.
contract PanelFinalHungQueryTest is Harness {
    function _hungUserQuery(bytes32 doc) internal returns (bytes32 qid) {
        qid = _open(7, 3, doc, false);
        _seal(qid);
        bytes32[9] memory a;
        a[0] = keccak256("A");
        a[1] = a[0];
        a[2] = keccak256("B");
        _post(qid, 2, 6666, 4, 0, 0, _votes(qid, a, 0));
    }

    function _vote(bytes32 qid, uint8 pi, bytes32[3] memory answers) internal {
        address[3] memory seats = panel.panelOf(qid, pi);
        bytes32 salt = keccak256(abi.encode(qid, pi));
        for (uint256 i; i < 3; ++i) {
            bytes32 payloadHash = keccak256(abi.encode("payload", answers[i]));
            vm.prank(seats[i]);
            panel.commit(qid, keccak256(abi.encode(qid, pi, seats[i], answers[i], payloadHash, salt)));
        }
        for (uint256 i; i < 3; ++i) {
            vm.prank(seats[i]);
            panel.reveal(qid, answers[i], keccak256(abi.encode("payload", answers[i])), salt);
        }
    }

    function test_finalHungIsTerminalButTheQueryStaysEscalated() public {
        // The harness stakes five evaluators; an appeal needs three more outside the first panel.
        for (uint256 i; i < 3; ++i) {
            address e = vm.addr(uint256(keccak256(abi.encode("extra-panelist", i))));
            usdg.mint(e, 2_500 * USD);
            vm.prank(e);
            usdg.approve(address(panel), type(uint256).max);
            vm.prank(e);
            panel.stake(2_500 * USD);
        }
        bytes32 qid = _hungUserQuery(keccak256("final-hung"));
        bytes32 hungVerdict = verdicts.latestVerdictOf(qid);
        vm.roll(block.number + 5);
        usdg.mint(address(this), 2 * panel.panelFee());
        usdg.approve(address(panel), type(uint256).max);
        panel.escalate(qid);
        vm.roll(uint256(panel.getCase(qid).sealBlock) + 1);
        panel.draw(qid);
        address[3] memory first = panel.panelOf(qid, 0);
        _vote(qid, 0, [keccak256("yes"), keccak256("yes"), keccak256("no")]);
        panel.resolve(qid);
        panel.appeal(qid);
        vm.roll(uint256(panel.getCase(qid).sealBlock) + 1);
        panel.draw(qid);
        address[3] memory second = panel.panelOf(qid, 1);
        _vote(qid, 1, [keccak256("x"), keccak256("y"), keccak256("z")]);
        panel.resolve(qid);
        panel.finalize(qid);

        IPanelEscalation.Case memory c = panel.getCase(qid);
        assertEq(uint256(c.status), uint256(IPanelEscalation.CaseStatus.FINAL));
        assertEq(c.outcomeAnswerHash, bytes32(0), "final HUNG: no outcome");
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.slashedPool(), 0);
        for (uint256 i; i < 3; ++i) {
            assertEq(panel.openPanels(first[i]), 0);
            assertEq(panel.openPanels(second[i]), 0);
        }
        assertEq(verdicts.latestVerdictOf(qid), hungVerdict, "no panel verdict was posted");
        // Needs QueryEscrow support to become a terminal HUNG; nothing on the query side is escrowed meanwhile.
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.ESCALATED));
        vm.expectRevert(abi.encodeWithSelector(IPanelEscalation.NotEscalatable.selector, qid));
        panel.escalate(qid);
    }
}
