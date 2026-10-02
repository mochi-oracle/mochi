// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// @notice A-M1 regression. With a positive minimum bond, enrollment is permissionless, so juror selection must not
///         depend on enrollments made after a query's seed can be known, and a run of inactive entries must not funnel
///         seats onto the key that follows it.
contract SelectionGrindingPoCTest is Harness {
    address private attacker;
    uint256 private keyNonce;
    MochiTypes.JurorClass[3] private n3Classes =
        [MochiTypes.JurorClass.LARGE_A, MochiTypes.JurorClass.DOC_SPECIALIST, MochiTypes.JurorClass.DISSENTER];
    address[3] private attackerKeys;

    function setUp() public override {
        super.setUp();
        attacker = makeAddr("attacker-operator");
        mochi.transfer(attacker, 500 * BOND);
        vm.prank(attacker);
        mochi.approve(address(registry), type(uint256).max);
    }

    function _enrollAttackerKey(MochiTypes.JurorClass c, bool attest) private returns (address key) {
        uint256 pk = uint256(keccak256(abi.encode("attacker-key", ++keyNonce)));
        key = vm.addr(pk);
        bytes32 digest = registry.enrollmentDigest(attacker, key, MEAS_JUROR, c);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        vm.prank(attacker);
        registry.enrollJuror(key, MEAS_JUROR, c, BOND, abi.encodePacked(r, s, v));
        if (attest) {
            address[] memory keys = new address[](1);
            keys[0] = key;
            vm.prank(vm.addr(attestorPk));
            registry.refreshAttestation(keys, uint64(block.timestamp + 30 days));
        }
    }

    /// @dev Before any query opens: for each N3 class, `dummies` unattested keys followed by one attested attacker key.
    function _stageFunnel(uint256 dummies) private {
        for (uint256 i; i < 3; ++i) {
            for (uint256 d; d < dummies; ++d) _enrollAttackerKey(n3Classes[i], false);
            attackerKeys[i] = _enrollAttackerKey(n3Classes[i], true);
        }
    }

    function _simulateSeal(bytes32 qid) private returns (address[] memory seats) {
        uint256 snap = vm.snapshotState();
        escrow.seal(qid);
        seats = escrow.jurorsOf(qid);
        vm.revertToState(snap);
    }

    /// The audit PoC: once the seal block's hash is public, the attacker appends bonded dummies to each N3 class until
    /// every seat lands on its own key, then seals. Selection must ignore enrollments made after the query opened.
    function testPostSeedEnrollmentCannotSteerSeats() public {
        _stageFunnel(2);
        bytes32 qid = _open(1, 3, keccak256("grind-target"), false);
        vm.roll(uint256(escrow.getQuery(qid).sealBlock) + 1); // the seed is public from here on
        address[] memory honest = _simulateSeal(qid);
        assertFalse(honest[0] == attackerKeys[0] && honest[1] == attackerKeys[1] && honest[2] == attackerKeys[2]);
        uint256 added;
        for (uint256 seat; seat < 3; ++seat) {
            while (_simulateSeal(qid)[seat] != attackerKeys[seat] && added < 40) {
                _enrollAttackerKey(n3Classes[seat], false);
                ++added;
            }
        }
        emit log_named_uint("post-seed dummies enrolled", added);
        address[] memory finalSeats = _simulateSeal(qid);
        bool captured =
            finalSeats[0] == attackerKeys[0] && finalSeats[1] == attackerKeys[1] && finalSeats[2] == attackerKeys[2];
        assertFalse(captured && added != 0, "post-seed dummies steered every N3 seat to the attacker");
        assertEq(keccak256(abi.encode(finalSeats)), keccak256(abi.encode(honest)), "post-seed enrollments moved a seat");
        escrow.seal(qid);
        assertEq(keccak256(abi.encode(escrow.jurorsOf(qid))), keccak256(abi.encode(honest)));
    }

    /// A run of unattested keys enrolled before the open must not hand the seats to the active key that follows it.
    /// The attacker holds one of four active keys per class, so its fair share is about a quarter of the seats.
    function testInactiveRunDoesNotFunnelSeatsToTheNextKey() public {
        _stageFunnel(10);
        uint256 captured;
        uint256 queries = 32;
        for (uint256 i; i < queries; ++i) {
            bytes32 qid = _open(1, 3, keccak256(abi.encode("funnel", i)), false);
            _seal(qid);
            address[] memory seats = escrow.jurorsOf(qid);
            for (uint256 s; s < 3; ++s) if (seats[s] == attackerKeys[s]) ++captured;
        }
        assertLt(captured * 2, queries * 3, "inactive entries funneled most seats to the attacker's key");
    }

    /// Pruning is permissionless, so it must not move a seat either: a pruned pool is a new generation and the query
    /// keeps the generation it snapshotted at open.
    function testPruningAfterSeedDoesNotMoveSeats() public {
        _stageFunnel(4);
        address[] memory doomed = new address[](12);
        for (uint256 i; i < 12; ++i) doomed[i] = _enrollAttackerKey(n3Classes[i % 3], true);
        for (uint256 i; i < 12; ++i) {
            vm.prank(attacker);
            registry.requestExit(doomed[i]);
        }
        bytes32 qid = _open(1, 3, keccak256("prune-target"), false);
        vm.roll(uint256(escrow.getQuery(qid).sealBlock) + 1);
        address[] memory before = _simulateSeal(qid);
        for (uint256 i; i < 3; ++i) registry.prunePool(n3Classes[i]);
        assertEq(keccak256(abi.encode(_simulateSeal(qid))), keccak256(abi.encode(before)));
        // The next query selects from the pruned generation.
        bytes32 next = _open(1, 3, keccak256("after-prune"), false);
        uint256 snapshot = registry.selectionSnapshot(address(escrow), next);
        assertEq(uint24(snapshot), 1); // LARGE_A generation
        _seal(next);
        address[] memory seats = escrow.jurorsOf(next);
        for (uint256 s; s < 3; ++s) assertTrue(registry.isActive(seats[s], MochiTypes.Role.JUROR));
    }
}
