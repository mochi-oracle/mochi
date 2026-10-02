// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "@mochi/DisclosureRegistry.sol";

/// Audit contract Low 4 PoC: the (verdictId, recipient) slot was first-write-wins for anyone, so a front-runner
/// could squat it with a junk envelope hash and the payer's genuine disclosure became a silent no-op.
contract DisclosureRegistryTest is Test {
    DisclosureRegistry registry;
    bytes32 constant VERDICT = keccak256("verdict");
    bytes32 constant RECIPIENT = keccak256("auditor-key");
    address payer = address(0xA1);
    address squatter = address(0xBAD);

    function setUp() public {
        registry = new DisclosureRegistry();
    }

    function testSquatterCannotBlockThePayersDisclosure() public {
        vm.prank(squatter);
        registry.disclose(VERDICT, RECIPIENT, keccak256("junk"));
        vm.expectEmit(true, true, true, true, address(registry));
        emit DisclosureRegistry.Disclosed(VERDICT, RECIPIENT, keccak256("envelope"), payer);
        vm.prank(payer);
        registry.disclose(VERDICT, RECIPIENT, keccak256("envelope"));
    }
}
