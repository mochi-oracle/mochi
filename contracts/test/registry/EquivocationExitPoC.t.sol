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

    /// Review finding 4: MochiVerdicts.post has no deadline, so a round stays postable after its query deadline until
    /// someone calls expire, and a late post stamps lastServedAt (and so the exit hold) at the post time.
    function testLatePostMovesTheHoldToThePostTime() public {
        bytes32 qid = _open(1, 3, keccak256("late-post-doc"), false);
        _seal(qid);
        address juror = escrow.jurorsOf(qid)[0];
        address operator = registry.operatorOf(juror);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(operator);
        registry.requestExit(juror);
        uint64 deadline = escrow.getQuery(qid).deadline;
        vm.warp(uint256(deadline) + 3 hours); // nobody expired it
        bytes32[9] memory answers;
        answers[1] = keccak256("agreed");
        answers[2] = keccak256("agreed");
        _post(qid, 2, 6666, 1, 1, bytes32(0), _votes(qid, answers, 1));
        assertEq(registry.lastServedAt(juror), uint256(deadline) + 3 hours);
        vm.warp(t0 + 7 days + 1 hours); // past exit + delay, and past deadline + delay
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSignature("ExitDelayNotElapsed(uint64)", uint64(deadline + 3 hours + 7 days)));
        registry.withdrawBond(juror);
    }

    /// The exiting operator caps its own hold: expire after the deadline records no service, and the late post fails.
    function testExpireAfterTheDeadlineCapsTheHold() public {
        bytes32 qid = _open(1, 3, keccak256("capped-hold-doc"), false);
        _seal(qid);
        address juror = escrow.jurorsOf(qid)[0];
        address operator = registry.operatorOf(juror);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(operator);
        registry.requestExit(juror);
        vm.warp(uint256(escrow.getQuery(qid).deadline) + 1);
        vm.prank(operator);
        escrow.expire(qid);
        bytes32[9] memory answers;
        (MochiTypes.VerdictInput memory v, bytes memory sig) =
            _preparePost(qid, 2, 0, 7, 7, bytes32(0), _votes(qid, answers, 7));
        MochiTypes.JurorVote[] memory votes = _votes(qid, answers, 7);
        vm.expectRevert();
        verdicts.post(v, votes, sig);
        assertEq(registry.lastServedAt(juror), 0);
        vm.warp(t0 + 7 days);
        vm.prank(operator);
        registry.withdrawBond(juror);
        assertEq(registry.getJuror(juror).bond, 0);
    }
}
