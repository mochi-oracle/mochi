// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {ClassMix} from "@mochi/ClassMix.sol";
import {JurorRegistry} from "@mochi/JurorRegistry.sol";
import {MochiToken} from "@mochi/MochiToken.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {QueryEscrow} from "@mochi/QueryEscrow.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {BlockhashRandomness} from "@mochi/BlockhashRandomness.sol";
import {IClassMix} from "@mochi/interfaces/IClassMix.sol";

contract ClassMixTest is Test {
    ClassMix mix;
    JurorRegistry registry;
    QueryEscrow escrow;
    address admin = address(this);

    function setUp() public {
        mix = new ClassMix(admin);
        MochiToken mochi = new MochiToken(admin, 1_000_000 ether);
        registry = new JurorRegistry(admin, mochi, admin, 1 ether, 7 days);
        MockUSDG usdg = new MockUSDG();
        escrow = new QueryEscrow(admin, usdg, registry, new SchemaRegistry(admin, 0), new BlockhashRandomness(1));
    }

    function testDefaultMatchesLegacyOrderAndFeedsPricing() public view {
        for (uint8 i; i < 9; ++i) assertEq(uint8(mix.seatClass(i)), uint8(MochiTypes.seatClass(i)));
        assertEq(uint8(registry.seatClass(2)), uint8(MochiTypes.JurorClass.DISSENTER));
    }

    function testValidMixControlsRegistryAndEscrowPrice() public {
        uint8[9] memory customMix = [uint8(4), 0, 1, 2, 3, 3, 4, 0, 2];
        mix.setMix(customMix);
        registry.setClassMix(IClassMix(address(mix)));
        assertEq(uint8(registry.seatClass(0)), uint8(MochiTypes.JurorClass.DISSENTER));
        for (uint8 c; c < 5; ++c) escrow.setClassPrice(MochiTypes.JurorClass(c), (uint256(c) + 1) * 100, 0);
        (uint256 fees,) = escrow.quote(1, 3, 1);
        assertEq(fees, 800);
    }

    function testInvalidMixesAndAccessControl() public {
        uint8[9] memory invalid = [uint8(0), 0, 4, 1, 2, 3, 0, 1, 4];
        vm.expectRevert(IClassMix.InvalidMix.selector);
        mix.setMix(invalid);
        invalid = [uint8(0), 1, 2, 3, 3, 0, 1, 2, 4];
        vm.expectRevert(IClassMix.InvalidMix.selector);
        mix.setMix(invalid);
        invalid = [uint8(0), 1, 5, 2, 3, 0, 1, 2, 4];
        vm.expectRevert(IClassMix.InvalidMix.selector);
        mix.setMix(invalid);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        mix.setMix([uint8(4), 0, 1, 2, 3, 3, 4, 0, 2]);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.setClassMix(IClassMix(address(mix)));
    }
}
