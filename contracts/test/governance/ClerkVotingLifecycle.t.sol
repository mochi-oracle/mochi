// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClerkVoting} from "@mochi/ClerkVoting.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {ClassMix} from "@mochi/ClassMix.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";

/// Audit contract Low 2 PoC: ClerkVoting proposals never expired and could execute in either order.
contract ClerkVotingLifecycleTest is Test {
    MockUSDG token;
    MochiStaking staking;
    SchemaRegistry schemas;
    ClassMix classMix;
    ClerkVoting voting;
    address proposer = address(0xA1);
    uint256 time;

    function setUp() public {
        token = new MockUSDG();
        staking = new MochiStaking(address(this), token, token, 7 days, 7 days);
        schemas = new SchemaRegistry(address(this), 24 hours);
        classMix = new ClassMix(address(this));
        voting = new ClerkVoting(address(this), IMochiStaking(address(staking)), schemas, classMix, 3 days, 24 hours, 400, 100);
        schemas.grantRole(MochiRoles.GOVERNOR_ROLE, address(voting));
        classMix.grantRole(MochiRoles.GOVERNOR_ROLE, address(voting));
        staking.grantRole(staking.LOCKER_ROLE(), address(voting));
        token.mint(proposer, 1_000);
        vm.prank(proposer);
        token.approve(address(staking), type(uint256).max);
        vm.prank(proposer);
        staking.stake(100);
        time = block.timestamp;
    }

    function _warp(uint256 to) private {
        time = to;
        vm.warp(to);
    }

    function _mix(uint8[9] memory mix) private pure returns (ClerkVoting.ProposalInput memory x) {
        x.kind = ClerkVoting.Kind.SET_CLASS_MIX;
        x.classMix = mix;
    }

    function _schema(bytes32 tag) private pure returns (ClerkVoting.ProposalInput memory x) {
        x.kind = ClerkVoting.Kind.PROPOSE_SCHEMA;
        x.schemaId = 8;
        x.schemaJsonHash = tag;
        x.promptHash = keccak256("prompt");
    }

    function _passed(ClerkVoting.ProposalInput memory input) private returns (uint256 id) {
        _warp(time + 1);
        vm.prank(proposer);
        id = voting.propose(input);
        vm.prank(proposer);
        voting.castVote(id, true);
    }

    function testPassedProposalExpiresIfNeverQueued() public {
        uint256 id = _passed(_mix([uint8(4), 0, 1, 2, 3, 3, 4, 0, 2]));
        _warp(uint256(voting.getProposal(id).endTime) + 365 days);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.ProposalExpired.selector, id));
        voting.queue(id);
    }

    function testQueuedProposalExpiresIfNeverExecuted() public {
        uint256 id = _passed(_mix([uint8(4), 0, 1, 2, 3, 3, 4, 0, 2]));
        _warp(voting.getProposal(id).endTime);
        voting.queue(id);
        _warp(uint256(voting.getProposal(id).eta) + 365 days);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.ProposalExpired.selector, id));
        voting.execute(id);
        assertEq(uint8(classMix.seatClass(0)), 0); // default mix untouched
    }

    /// Both mixes pass; executing the newer first must make the older one unexecutable instead of overriding it.
    function testOlderClassMixCannotOverrideNewerExecution() public {
        uint256 older = _passed(_mix([uint8(4), 0, 1, 2, 3, 3, 4, 0, 2]));
        uint256 newer = _passed(_mix([uint8(1), 2, 4, 0, 3, 1, 2, 0, 4]));
        _warp(voting.getProposal(newer).endTime);
        voting.queue(older);
        voting.queue(newer);
        _warp(voting.getProposal(newer).eta);
        voting.execute(newer);
        assertEq(uint8(classMix.seatClass(0)), 1);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.SupersededProposal.selector, older, newer));
        voting.execute(older);
        assertEq(uint8(classMix.seatClass(0)), 1);
    }

    /// Same rule for successive versions of one schema: an older proposal cannot become `latest` after a newer one.
    function testOlderSchemaProposalCannotLandAfterNewer() public {
        uint256 older = _passed(_schema(keccak256("schema-a")));
        uint256 newer = _passed(_schema(keccak256("schema-b")));
        _warp(voting.getProposal(newer).endTime);
        voting.queue(older);
        voting.queue(newer);
        _warp(voting.getProposal(newer).eta);
        voting.execute(newer);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.SupersededProposal.selector, older, newer));
        voting.execute(older);
        assertEq(schemas.getVersion(8, 1).schemaJsonHash, keccak256("schema-b"));
    }
}
