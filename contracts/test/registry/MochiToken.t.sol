// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiToken} from "@mochi/MochiToken.sol";

contract MochiTokenTest is Test {
    uint256 private constant SUPPLY = 1_000 ether;
    uint256 private constant OWNER_PK = 0xA11CE;
    address private owner;
    MochiToken private token;

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        token = new MochiToken(owner, SUPPLY);
    }

    function testSupplyAndMetadata() public view {
        assertEq(token.name(), "Mochi");
        assertEq(token.symbol(), "MOCHI");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(owner), SUPPLY);
    }

    function testPermit() public {
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 days;
        bytes32 typeHash = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(typeHash, owner, spender, 17 ether, token.nonces(owner), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        token.permit(owner, spender, 17 ether, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), 17 ether);
        assertEq(token.nonces(owner), 1);
    }

    function testDeployerIsInitialMetadataAdmin() public view {
        assertEq(token.metadataAdmin(), address(this));
    }

    function testSetMetadataByAdmin() public {
        vm.expectEmit(address(token));
        emit MochiToken.MetadataUpdated("Mochi Oracle", "MOCHIO");
        token.setMetadata("Mochi Oracle", "MOCHIO");
        assertEq(token.name(), "Mochi Oracle");
        assertEq(token.symbol(), "MOCHIO");
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(owner), SUPPLY);
    }

    function testSetMetadataRevertsForNonAdmin() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(MochiToken.NotMetadataAdmin.selector);
        token.setMetadata("X", "X");
    }

    function testSetMetadataRejectsEmpty() public {
        vm.expectRevert(MochiToken.EmptyMetadata.selector);
        token.setMetadata("", "MOCHI");
        vm.expectRevert(MochiToken.EmptyMetadata.selector);
        token.setMetadata("Mochi", "");
    }

    function testTransferMetadataAdmin() public {
        address timelock = makeAddr("timelock");
        vm.expectEmit(true, true, false, false, address(token));
        emit MochiToken.MetadataAdminTransferred(address(this), timelock);
        token.transferMetadataAdmin(timelock);
        assertEq(token.metadataAdmin(), timelock);

        vm.expectRevert(MochiToken.NotMetadataAdmin.selector);
        token.setMetadata("Old", "OLD");
        vm.expectRevert(MochiToken.NotMetadataAdmin.selector);
        token.transferMetadataAdmin(address(this));

        vm.prank(timelock);
        token.setMetadata("Mochi Oracle", "MOCHI");
        assertEq(token.name(), "Mochi Oracle");
    }

    function testFreezeMetadata() public {
        token.transferMetadataAdmin(address(0));
        assertEq(token.metadataAdmin(), address(0));
        vm.expectRevert(MochiToken.NotMetadataAdmin.selector);
        token.setMetadata("X", "X");
        vm.prank(address(0));
        vm.expectRevert(MochiToken.EmptyMetadata.selector);
        token.setMetadata("", "");
    }

    function testPermitDomainSurvivesRename() public {
        bytes32 domainBefore = token.DOMAIN_SEPARATOR();
        token.setMetadata("Mochi Oracle", "MOCHIO");
        assertEq(token.DOMAIN_SEPARATOR(), domainBefore);
        (, string memory domainName, string memory version,,,,) = token.eip712Domain();
        assertEq(domainName, "Mochi");
        assertEq(version, "1");
        testPermit();
    }

    function testFuzzSetMetadata(string calldata newName, string calldata newSymbol) public {
        vm.assume(bytes(newName).length > 0 && bytes(newSymbol).length > 0);
        token.setMetadata(newName, newSymbol);
        assertEq(token.name(), newName);
        assertEq(token.symbol(), newSymbol);
    }

    function testZeroAddressReverts() public {
        vm.expectRevert(MochiToken.ZeroDistributor.selector);
        new MochiToken(address(0), SUPPLY);
    }
}
