// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// @notice Equivocation lead: a juror that requests exit while it still holds a seat must stay slashable for the full
///         exit delay after that seat's round settles, so it cannot withdraw before late equivocation evidence lands.
contract EquivocationExitPoCTest is Harness {
    function _answerSig(uint256 pk, bytes32 qid, MochiTypes.Query memory q, bytes32[3] memory a)
        private
        view
        returns (bytes memory)
    {
        bytes32 sh = MochiTypes.hashJurorAnswer(qid, q.docCommit, q.schemaId, q.schemaVersion, a[0], a[1], a[2]);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", verdicts.domainSeparator(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function testExitWhileSeatedKeepsEquivocationSlashReachable() public {
        bytes32 qid = _open(1, 3, keccak256("equivocation-doc"), false);
        _seal(qid);
        MochiTypes.Query memory q = escrow.getQuery(qid);
        address juror = escrow.jurorsOf(qid)[0];
        address operator = registry.operatorOf(juror);
        // While seated, the juror signs two different answers for the query; a colluder keeps one of them.
        bytes32[3] memory answerA = [keccak256("A"), keccak256("spans"), keccak256("quote")];
        bytes32[3] memory answerB = [keccak256("B"), keccak256("spans"), keccak256("quote")];
        bytes memory sigA = _answerSig(_pkFor(juror), qid, q, answerA);
        bytes memory sigB = _answerSig(_pkFor(juror), qid, q, answerB);

        // Read time through the cheatcode: under via_ir a block.timestamp read can be re-evaluated after a warp.
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(operator);
        registry.requestExit(juror);
        // The round settles after the exit request; the exited seat counts as a timeout.
        vm.warp(t0 + 50 minutes);
        bytes32[9] memory answers;
        answers[1] = keccak256("agreed");
        answers[2] = keccak256("agreed");
        _post(qid, 2, 6666, 1, 1, bytes32(0), _votes(qid, answers, 1));

        // The operator tries to withdraw at the first moment the exit delay alone would allow.
        vm.warp(t0 + 7 days);
        vm.prank(operator);
        try registry.withdrawBond(juror) {} catch {}

        // The colluder's copy surfaces within seven days of the seat's settlement; anyone can report it.
        uint256 sinkBefore = mochi.balanceOf(address(this));
        verdicts.reportEquivocation(qid, q.docCommit, q.schemaId, q.schemaVersion, answerA, sigA, answerB, sigB);
        assertEq(mochi.balanceOf(address(this)) - sinkBefore, BOND, "the exited juror escaped the equivocation slash");
        assertEq(registry.getJuror(juror).bond, 0);
    }
}
