// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BlockhashRandomness} from "@mochi/BlockhashRandomness.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";

contract BlockhashRandomnessTest is Test {
    BlockhashRandomness private randomness;

    function setUp() public { randomness = new BlockhashRandomness(3); }

    function testDelayValidationAndGetter() public {
        assertEq(randomness.sealDelay(), 3);
        assertEq(randomness.nextTicket(), uint64(block.number + 3));
        assertFalse(randomness.isExpired(uint64(block.number)));
        vm.expectRevert();
        new BlockhashRandomness(0);
    }

    function testExpiredAt257BlocksAndErrorSelectorsStable() public {
        uint64 ticket = uint64(block.number);
        assertEq(IRandomness.SeedNotReady.selector, bytes4(0x484e3916));
        assertEq(IRandomness.SeedWindowMissed.selector, bytes4(0x76a607dd));
        vm.roll(uint256(ticket) + 256);
        assertFalse(randomness.isExpired(ticket));
        vm.roll(uint256(ticket) + 257);
        assertTrue(randomness.isExpired(ticket));
    }

    function testSeedNotReady() public {
        uint64 sealBlock = uint64(block.number);
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedNotReady.selector, sealBlock, block.number));
        randomness.seed(bytes32(uint256(1)), sealBlock);
    }

    function testSeedWorksThroughWindowAndIsContextBound() public {
        uint64 sealBlock = uint64(block.number);
        bytes32 bh = keccak256("seal");
        vm.setBlockhash(sealBlock, bh);
        bytes32 context = keccak256("context");
        for (uint256 offset = 1; offset <= 256; ++offset) {
            vm.roll(uint256(sealBlock) + offset);
            bytes32 expected = keccak256(abi.encode(context, bh));
            assertEq(randomness.seed(context, sealBlock), expected);
        }
        assertNotEq(randomness.seed(context, sealBlock), randomness.seed(bytes32(uint256(99)), sealBlock));
    }

    function testSeedMissesWindowAndZeroHash() public {
        uint64 sealBlock = uint64(block.number);
        vm.setBlockhash(sealBlock, keccak256("seal"));
        vm.roll(uint256(sealBlock) + 257);
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedWindowMissed.selector, sealBlock, block.number));
        randomness.seed(bytes32(0), sealBlock);

        uint64 emptyBlock = uint64(block.number);
        vm.setBlockhash(emptyBlock, bytes32(0));
        vm.roll(uint256(emptyBlock) + 1);
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedWindowMissed.selector, emptyBlock, block.number));
        randomness.seed(bytes32(0), emptyBlock);
    }
}
