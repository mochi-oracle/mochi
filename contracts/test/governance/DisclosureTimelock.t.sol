// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "@mochi/DisclosureRegistry.sol";
import {MochiTimelock} from "@mochi/governance/MochiTimelock.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

contract DisclosureTimelockTest is Test {
    function testDisclosureFirstWriteWinsAndIsPermissionless() public {
        DisclosureRegistry disclosures = new DisclosureRegistry();
        bytes32 verdict = keccak256("verdict");
        bytes32 recipient = keccak256("recipient-key");
        vm.prank(address(0xA1));
        disclosures.disclose(verdict, recipient, keccak256("envelope-one"));
        uint64 first = disclosures.disclosedAt(verdict, recipient);
        vm.prank(address(0xB2));
        disclosures.disclose(verdict, recipient, keccak256("envelope-two"));
        assertEq(disclosures.disclosedAt(verdict, recipient), first);
    }

    function testTimelockSchedulesAndExecutesSchemaProposalAfter24Hours() public {
        address[] memory proposers = new address[](1); proposers[0] = address(this);
        address[] memory executors = new address[](1); executors[0] = address(0);
        MochiTimelock timelock = new MochiTimelock(24 hours, proposers, executors, address(this));
        SchemaRegistry schemas = new SchemaRegistry(address(this), 24 hours);
        schemas.grantRole(MochiRoles.GOVERNOR_ROLE, address(timelock));
        bytes memory data = abi.encodeCall(
            SchemaRegistry.propose,
            (uint32(9), keccak256("schema"), keccak256("prompt"), keccak256("tolerances"), bytes32(0))
        );
        bytes32 salt = keccak256("schema-proposal");
        timelock.schedule(address(schemas), 0, data, bytes32(0), salt, 24 hours);
        vm.warp(block.timestamp + 24 hours);
        timelock.execute(address(schemas), 0, data, bytes32(0), salt);
        assertEq(schemas.getVersion(9, 1).schemaJsonHash, keccak256("schema"));
        uint256 activation = uint256(schemas.getVersion(9, 1).activatesAt);
        vm.warp(activation);
        assertTrue(schemas.isActive(9, 1));
    }
}
