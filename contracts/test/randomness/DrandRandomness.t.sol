// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {DrandRandomness} from "@mochi/DrandRandomness.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";

contract DrandRandomnessTest is Test {
    string private vectors;
    DrandRandomness private drand;
    uint64 private constant GENESIS = 1_692_803_367;

    function setUp() public {
        vectors = vm.readFile("./test/fixtures/drand-vectors.json");
        drand = new DrandRandomness(_bytes("$.quicknet.publicKeyG2"), GENESIS, 3, 2);
    }

    function _bytes(string memory path) private view returns (bytes memory) {
        return vm.parseJsonBytes(vectors, path);
    }

    function testHashToG1MatchesRealBeaconVectors() public view {
        string[3] memory paths = ["$.quicknet.beacons[0]", "$.quicknet.beacons[1]", "$.quicknet.beacons[2]"];
        for (uint256 i; i < paths.length; ++i) {
            bytes32 message = vm.parseJsonBytes32(vectors, string.concat(paths[i], ".message"));
            bytes memory expected = vm.parseJsonBytes(vectors, string.concat(paths[i], ".hashToG1"));
            assertEq(drand.hashToG1(message), expected);
        }
    }

    function testRealQuicknetBeaconsVerifyAndAreIdempotent() public {
        for (uint256 i; i < 3; ++i) {
            string memory path = string.concat("$.quicknet.beacons[", vm.toString(i), "]");
            uint64 round = uint64(vm.parseJsonUint(vectors, string.concat(path, ".round")));
            bytes memory signature = vm.parseJsonBytes(vectors, string.concat(path, ".signature"));
            bytes32 expected = keccak256(signature);
            uint256 beforeGas = gasleft();
            vm.expectEmit(true, false, false, true, address(drand));
            emit DrandRandomness.BeaconPosted(round, expected);
            drand.postBeacon(round, signature);
            console2.log("drand postBeacon gas", round, beforeGas - gasleft());
            assertEq(drand.beaconOf(round), expected);
            vm.recordLogs();
            drand.postBeacon(round, signature);
            assertEq(vm.getRecordedLogs().length, 0);
        }
    }

    function testInvalidSignaturesAreRejected() public {
        bytes memory realSig = _bytes("$.quicknet.beacons[0].signature");
        realSig[127] = bytes1(uint8(realSig[127]) ^ 1);
        vm.expectRevert(abi.encodeWithSelector(DrandRandomness.InvalidBeacon.selector, 1));
        drand.postBeacon(1, realSig);

        realSig = _bytes("$.quicknet.beacons[0].signature");
        vm.expectRevert(abi.encodeWithSelector(DrandRandomness.InvalidBeacon.selector, 2));
        drand.postBeacon(2, realSig);

        bytes memory testSignature = vm.parseJsonBytes(vectors, "$.testKey.rounds[4].signature");
        vm.expectRevert(abi.encodeWithSelector(DrandRandomness.InvalidBeacon.selector, 5));
        drand.postBeacon(5, testSignature);

        vm.expectRevert(abi.encodeWithSelector(DrandRandomness.InvalidBeacon.selector, 8));
        drand.postBeacon(8, new bytes(127));
    }

    function testSeedReadinessAndValue() public {
        uint64 round = uint64(vm.parseJsonUint(vectors, "$.quicknet.beacons[0].round"));
        bytes32 context = keccak256("selection context");
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedNotReady.selector, round, drand.currentRound()));
        drand.seed(context, round);
        bytes memory signature = _bytes("$.quicknet.beacons[0].signature");
        drand.postBeacon(round, signature);
        assertEq(drand.seed(context, round), keccak256(abi.encode(context, keccak256(signature))));
    }

    function testCurrentRoundAndNextTicketBoundaries() public {
        vm.warp(GENESIS - 1);
        assertEq(drand.currentRound(), 0);
        assertEq(drand.nextTicket(), 2);
        vm.warp(GENESIS);
        assertEq(drand.currentRound(), 1);
        assertEq(drand.nextTicket(), 3);
        vm.warp(GENESIS + 2);
        assertEq(drand.currentRound(), 1);
        vm.warp(GENESIS + 3);
        assertEq(drand.currentRound(), 2);
        assertFalse(drand.isExpired(1));
    }

    function testConstructorValidation() public {
        bytes memory pk = _bytes("$.quicknet.publicKeyG2");
        vm.expectRevert(abi.encodeWithSelector(DrandRandomness.InvalidPublicKeyLength.selector, 255));
        new DrandRandomness(new bytes(255), GENESIS, 3, 1);
        vm.expectRevert(DrandRandomness.InvalidPeriod.selector);
        new DrandRandomness(pk, GENESIS, 0, 1);
        vm.expectRevert(DrandRandomness.InvalidLookahead.selector);
        new DrandRandomness(pk, GENESIS, 3, 0);
    }
}
