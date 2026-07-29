// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {ISchemaRegistry} from "@mochi/interfaces/ISchemaRegistry.sol";

contract SchemaRegistryTest is Test {
    SchemaRegistry private registry;
    address private governor = address(this);
    uint64 private constant DELAY = 1 days;

    function setUp() public { registry = new SchemaRegistry(governor, DELAY); }

    function _propose(uint32 id, bytes32 schemaHash) private returns (uint16) {
        return registry.propose(id, schemaHash, keccak256("prompt"), keccak256("tol"), bytes32(0));
    }

    function testProposeVersionsAndActivation() public {
        uint16 v1 = _propose(1, keccak256("schema1"));
        uint16 v2 = _propose(1, keccak256("schema2"));
        assertEq(v1, 1);
        assertEq(v2, 2);
        assertEq(registry.activationDelay(), DELAY);
        assertFalse(registry.isActive(1, v1));
        assertEq(registry.latest(1), 0);
        vm.warp(block.timestamp + DELAY);
        assertTrue(registry.isActive(1, v1));
        assertTrue(registry.isActive(1, v2));
        assertEq(registry.latest(1), 2);
        ISchemaRegistry.SchemaVersion memory v = registry.getVersion(1, 2);
        assertEq(v.schemaJsonHash, keccak256("schema2"));
    }

    function testLatestSkipsRevokedAndInactive() public {
        _propose(3, keccak256("one"));
        vm.warp(block.timestamp + DELAY);
        registry.revoke(3, 1);
        assertEq(_propose(3, keccak256("two")), 2);
        assertEq(registry.latest(3), 0);
        vm.warp(block.timestamp + DELAY);
        assertEq(registry.latest(3), 2);
        registry.revoke(3, 2);
        assertEq(registry.latest(3), 0);
    }

    function testAccessControlAndDelaySetter() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        _propose(1, keccak256("schema"));
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        registry.setActivationDelay(5);
        registry.setActivationDelay(5);
        assertEq(registry.activationDelay(), 5);
    }

    function testInvalidIdZeroHashesUnknownAndRevocation() public {
        vm.expectRevert(abi.encodeWithSelector(ISchemaRegistry.InvalidSchemaId.selector, 0));
        registry.propose(0, keccak256("s"), keccak256("p"), bytes32(0), bytes32(0));
        vm.expectRevert(SchemaRegistry.ZeroHash.selector);
        registry.propose(1, bytes32(0), keccak256("p"), bytes32(0), bytes32(0));
        vm.expectRevert(SchemaRegistry.ZeroHash.selector);
        registry.propose(1, keccak256("s"), bytes32(0), bytes32(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(ISchemaRegistry.UnknownSchema.selector, 4, 1));
        registry.getVersion(4, 1);
        vm.expectRevert(abi.encodeWithSelector(ISchemaRegistry.UnknownSchema.selector, 4, 1));
        registry.revoke(4, 1);
    }
}
