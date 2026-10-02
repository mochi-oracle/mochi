// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "@mochi/DisclosureRegistry.sol";
import {MochiTimelock} from "@mochi/governance/MochiTimelock.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

contract DisclosureTimelockTest is Test {
    /// Permissionless, first write wins per discloser, and one party's record never blocks or changes another's.
    function testDisclosureFirstWriteWinsPerDiscloser() public {
        DisclosureRegistry disclosures = new DisclosureRegistry();
        bytes32 verdict = keccak256("verdict");
        bytes32 recipient = keccak256("recipient-key");
        address payer = address(0xA1);
        address other = address(0xB2);
        vm.warp(1_800_000_000);
        vm.prank(other);
        disclosures.disclose(verdict, recipient, keccak256("junk"));
        vm.warp(1_800_000_060);
        vm.prank(payer);
        disclosures.disclose(verdict, recipient, keccak256("envelope-one"));
        vm.warp(1_800_000_120);
        vm.recordLogs();
        vm.prank(payer);
        disclosures.disclose(verdict, recipient, keccak256("envelope-two")); // no-op
        assertEq(vm.getRecordedLogs().length, 0);
        DisclosureRegistry.Disclosure memory d = disclosures.disclosureOf(verdict, recipient, payer);
        assertEq(d.envelopeHash, keccak256("envelope-one"));
        assertEq(d.disclosedAt, 1_800_000_060);
        assertEq(disclosures.disclosedAt(verdict, recipient, payer), 1_800_000_060);
        assertEq(disclosures.disclosureOf(verdict, recipient, other).envelopeHash, keccak256("junk"));
        assertEq(disclosures.disclosedAt(verdict, recipient, address(0xC3)), 0);
        vm.expectRevert(DisclosureRegistry.ZeroEnvelopeHash.selector);
        disclosures.disclose(verdict, keccak256("other-recipient"), bytes32(0));
    }

    function testTimelockSchedulesAndExecutesSchemaProposalAfter60Seconds() public {
        address[] memory proposers = new address[](1); proposers[0] = address(this);
        address[] memory executors = new address[](1); executors[0] = address(0);
        MochiTimelock timelock = new MochiTimelock(60 seconds, proposers, executors, address(this));
        SchemaRegistry schemas = new SchemaRegistry(address(this), 24 hours);
        schemas.grantRole(MochiRoles.GOVERNOR_ROLE, address(timelock));
        bytes memory data = abi.encodeCall(
            SchemaRegistry.propose,
            (uint32(9), keccak256("schema"), keccak256("prompt"), keccak256("tolerances"), bytes32(0))
        );
        bytes32 salt = keccak256("schema-proposal");
        timelock.schedule(address(schemas), 0, data, bytes32(0), salt, 60 seconds);
        vm.expectRevert();
        timelock.execute(address(schemas), 0, data, bytes32(0), salt);
        vm.warp(block.timestamp + 60 seconds);
        timelock.execute(address(schemas), 0, data, bytes32(0), salt);
        assertEq(schemas.getVersion(9, 1).schemaJsonHash, keccak256("schema"));
        uint256 activation = uint256(schemas.getVersion(9, 1).activatesAt);
        vm.warp(activation);
        assertTrue(schemas.isActive(9, 1));
    }
}
