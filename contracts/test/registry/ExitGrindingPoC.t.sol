// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiToken} from "@mochi/MochiToken.sol";
import {JurorRegistry} from "@mochi/JurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

/// @notice Review finding 2 regression (bonded mode). Selection used to fall back, after 16 missed draws, to
///         `pick % count` over the eligible keys of the snapshot. Eligibility is read at seal time, so an operator that
///         saw the seed could exit some of its own keys to change `count` and re-map the pick onto another of its keys.
///         With 600 dead keys per class and 3 attacker keys against 3 honest ones (a 50% fair share), exit grinding
///         reached about 68% of N3 seats. Selection now only redraws with a seed-fixed index sequence, so an exit can
///         only hand the exited key's own seat to the next draw.
/// @dev Uses only the registry calls that predate the fix, so the same file measures the old code too.
contract ExitGrindingPoCTest is Test {
    MochiToken private token;
    JurorRegistry private registry;
    address private constant ADMIN = address(0xA11CE);
    address private constant HONEST = address(0xB0B);
    address private constant ATTACKER = address(0xE71);
    bytes32 private constant MEASUREMENT = keccak256("measurement");
    uint256 private constant DEAD_PER_CLASS = 600;
    uint256 private constant QUERIES = 40;
    MochiTypes.JurorClass[3] private n3 =
        [MochiTypes.JurorClass.LARGE_A, MochiTypes.JurorClass.DOC_SPECIALIST, MochiTypes.JurorClass.DISSENTER];
    address[3][3] private attackerKeys;
    uint256 private keyNonce;

    function setUp() public {
        token = new MochiToken(address(this), 10_000_000 ether);
        registry = new JurorRegistry(ADMIN, token, ADMIN, 1 ether, 7 days);
        vm.startPrank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.JUROR, true);
        registry.grantRole(MochiRoles.ATTESTOR_ROLE, address(this));
        vm.stopPrank();
        for (uint256 i; i < 2; ++i) {
            address op = i == 0 ? HONEST : ATTACKER;
            require(token.transfer(op, 100_000 ether));
            vm.prank(op);
            token.approve(address(registry), type(uint256).max);
        }
        uint256 t0 = vm.getBlockTimestamp();
        // Per N3 class: 600 keys that were attested once and lapsed (never pruned), then 3 honest and 3 attacker keys.
        for (uint256 c; c < 3; ++c) {
            address[] memory dead = new address[](DEAD_PER_CLASS);
            for (uint256 d; d < DEAD_PER_CLASS; ++d) dead[d] = _enroll(ATTACKER, n3[c]);
            registry.refreshAttestation(dead, uint64(t0 + 1 hours));
        }
        vm.warp(t0 + 2 hours);
        address[] memory live = new address[](18);
        for (uint256 c; c < 3; ++c) {
            for (uint256 k; k < 3; ++k) live[c * 6 + k] = _enroll(HONEST, n3[c]);
            for (uint256 k; k < 3; ++k) {
                attackerKeys[c][k] = _enroll(ATTACKER, n3[c]);
                live[c * 6 + 3 + k] = attackerKeys[c][k];
            }
        }
        registry.refreshAttestation(live, uint64(t0 + 30 days));
    }

    function _enroll(address operator, MochiTypes.JurorClass c) private returns (address key) {
        uint256 pk = uint256(keccak256(abi.encode("exit-grind-key", ++keyNonce)));
        key = vm.addr(pk);
        bytes32 digest = registry.enrollmentDigest(operator, key, MEASUREMENT, c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        vm.prank(operator);
        registry.enrollJuror(key, MEASUREMENT, c, 1 ether, abi.encodePacked(r, s, v));
    }

    /// 0 = honest key, 1 = attacker key, 2 = the selection reverted.
    function _seat(bytes32 qid, bytes32 seed, uint8 seat) private view returns (uint256) {
        try registry.selectJurors(address(this), qid, seed, seat, seat + 1, new address[](0)) returns (address[] memory s) {
            for (uint256 k; k < 3; ++k) if (s[0] == attackerKeys[seat][k]) return 1;
            return 0;
        } catch {
            return 2;
        }
    }

    /// For each query and N3 seat, the attacker sees the seed and tries every subset of its three keys in that seat's
    /// class to exit before sealing (classes are independent: one seat each). It keeps the best outcome.
    function testExitGrindingDoesNotBeatTheFairShare() public {
        uint256 fair;
        uint256 ground;
        uint256 seated;
        uint256 gains;
        for (uint256 q; q < QUERIES; ++q) {
            bytes32 qid = keccak256(abi.encode("exit-grind-query", q));
            registry.openSelection(qid, address(0));
            bytes32 seed = keccak256(abi.encode("exit-grind-seed", q));
            for (uint8 seat; seat < 3; ++seat) {
                uint256 honestRun = _seat(qid, seed, seat);
                bool best = honestRun == 1;
                for (uint256 subset = 1; subset < 8 && !best; ++subset) {
                    uint256 snap = vm.snapshotState();
                    for (uint256 b; b < 3; ++b) {
                        if (subset & (1 << b) == 0) continue;
                        vm.prank(ATTACKER);
                        registry.requestExit(attackerKeys[seat][b]);
                    }
                    best = _seat(qid, seed, seat) == 1;
                    vm.revertToState(snap);
                }
                if (honestRun != 2) ++seated;
                if (honestRun == 1) ++fair;
                if (best) ++ground;
                if (best && honestRun != 1) ++gains;
            }
        }
        emit log_named_uint("N3 seats filled without grinding", seated);
        emit log_named_uint("attacker seats without exits (fair share ~50%)", fair);
        emit log_named_uint("attacker seats with exit grinding", ground);
        emit log_named_uint("attacker share with grinding, bps of seats filled", seated == 0 ? 0 : ground * 10_000 / seated);
        assertEq(gains, 0, "exiting keys after the seed won a seat");
    }
}
