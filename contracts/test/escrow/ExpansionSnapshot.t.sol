// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";

/// @notice Review finding 1 regression. A query used to select every round from the pools it snapshotted at open. With
///         one live LARGE_A key at open (the other two leaving), an N5 round went HUNG; a replacement key was enrolled;
///         a stranger paid expand(qid, 7); and the seal then reverted NoEligibleJuror for good (seat 5 needs a second
///         LARGE_A key, and the snapshot only had the leavers). After the deadline, expire refunded the stranger's USDG
///         to the original refundTo and the HUNG status was lost. Expansion and reseal now re-snapshot the pools in the
///         transaction that draws their ticket, so the new round can seat the replacement.
/// @dev Uses only calls that predate the fix, so the same file shows the old behaviour.
contract ExpansionSnapshotTest is Harness {
    address private stranger = makeAddr("stranger");

    function _operator(uint8 c, uint8 j) private pure returns (address) {
        return vm.addr(uint256(keccak256(abi.encode("operator", c, j))));
    }

    function _leave(uint8 c, uint8 j) private {
        vm.prank(_operator(c, j));
        registry.requestExit(vm.addr(jurorPks[c][j]));
    }

    /// Enrolls and attests a fresh LARGE_A key for a new operator.
    function _replacement(string memory label) private returns (address key) {
        uint256 pk = uint256(keccak256(abi.encode("replacement", label)));
        key = vm.addr(pk);
        address operator = makeAddr(string.concat("replacement-operator-", label));
        mochi.transfer(operator, BOND);
        vm.prank(operator);
        mochi.approve(address(registry), BOND);
        bytes32 digest = registry.enrollmentDigest(operator, key, MEAS_JUROR, MochiTypes.JurorClass.LARGE_A);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        vm.prank(operator);
        registry.enrollJuror(key, MEAS_JUROR, MochiTypes.JurorClass.LARGE_A, BOND, abi.encodePacked(r, s, v));
        address[] memory one = new address[](1);
        one[0] = key;
        vm.prank(vm.addr(attestorPk));
        registry.refreshAttestation(one, uint64(block.timestamp + 30 days));
    }

    function _hang(bytes32 qid) private {
        uint8 n = escrow.getQuery(qid).n;
        uint32 all = uint32((uint256(1) << n) - 1);
        bytes32[9] memory answers;
        _post(qid, uint8(MochiTypes.VerdictStatus.HUNG), 0, all, all, bytes32(0), _votes(qid, answers, all));
        assertEq(uint8(escrow.getQuery(qid).status), uint8(MochiTypes.QueryStatus.HUNG));
    }

    function testExpansionSeatsAReplacementEnrolledAfterTheOpen() public {
        _leave(0, 1);
        _leave(0, 2); // LARGE_A has one live key, vm.addr(jurorPks[0][0])
        bytes32 qid = _open(1, 5, keccak256("replacement-target"), false);
        _seal(qid);
        address first = escrow.jurorsOf(qid)[0];
        assertEq(first, vm.addr(jurorPks[0][0]));
        _hang(qid);
        address replacement = _replacement("expand");
        // A stranger pays for the expansion to N7 (seat 5 is LARGE_A).
        (uint256 jf, uint256 pf) = escrow.quoteExpansion(qid, 7);
        usdg.mint(stranger, jf + pf);
        vm.startPrank(stranger);
        usdg.approve(address(escrow), jf + pf);
        escrow.expand(qid, 7);
        vm.stopPrank();
        _seal(qid); // used to revert NoEligibleJuror(LARGE_A) here, and on every reseal after
        address[] memory seats = escrow.jurorsOf(qid);
        assertEq(seats.length, 7);
        assertEq(seats[0], first);
        assertEq(seats[5], replacement);
        assertEq(uint8(escrow.getQuery(qid).status), uint8(MochiTypes.QueryStatus.SEALED));
    }

    /// The same for a round whose seal could not find a juror at all: once a replacement is in, the reseal after the
    /// ticket lapses takes a fresh snapshot.
    function testResealSeatsAReplacementEnrolledAfterTheOpen() public {
        for (uint8 j; j < 3; ++j) _leave(0, j); // no live LARGE_A key at open
        bytes32 qid = _open(1, 3, keccak256("reseal-target"), false);
        uint64 ticket = escrow.getQuery(qid).sealBlock;
        vm.roll(uint256(ticket) + 1);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.NoEligibleJuror.selector, MochiTypes.JurorClass.LARGE_A));
        escrow.seal(qid);
        address replacement = _replacement("reseal");
        vm.roll(uint256(ticket) + 257);
        escrow.reseal(qid);
        _seal(qid);
        assertEq(escrow.jurorsOf(qid)[0], replacement);
    }

    /// The re-snapshot happens with the ticket draw, so a key that joins after the expansion (when its seed may already
    /// be known) still cannot take a seat in that round.
    function testKeysJoiningAfterTheExpansionTicketWaitForTheNextOne() public {
        _leave(0, 1);
        _leave(0, 2);
        bytes32 qid = _open(1, 5, keccak256("late-join-target"), false);
        _seal(qid);
        _hang(qid);
        (uint256 jf, uint256 pf) = escrow.quoteExpansion(qid, 7);
        usdg.mint(address(this), jf + pf);
        escrow.expand(qid, 7);
        _replacement("too-late");
        vm.roll(uint256(escrow.getQuery(qid).sealBlock) + 1);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.NoEligibleJuror.selector, MochiTypes.JurorClass.LARGE_A));
        escrow.seal(qid);
    }
}
