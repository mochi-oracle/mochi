// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClerkVoting} from "@mochi/ClerkVoting.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {ClassMix} from "@mochi/ClassMix.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";

contract ClerkVotingSnapshotPoCTest is Test {
    MockUSDG token;
    MochiStaking staking;
    ClerkVoting voting;
    address proposer = address(0xA1);
    address lateStaker = address(0xB2);
    address recipient = address(0xC3);

    function setUp() public {
        token = new MockUSDG();
        staking = new MochiStaking(address(this), token, token, 7 days, 7 days);
        SchemaRegistry schemas = new SchemaRegistry(address(this), 0);
        ClassMix mix = new ClassMix(address(this));
        voting = new ClerkVoting(
            address(this), IMochiStaking(address(staking)), schemas, mix, 10 days, 1 days, 0, 1
        );
        token.mint(proposer, 100);
        token.mint(lateStaker, 200);
        token.mint(recipient, 200);
        vm.prank(proposer); token.approve(address(staking), type(uint256).max);
        vm.prank(lateStaker); token.approve(address(staking), type(uint256).max);
        vm.prank(recipient); token.approve(address(staking), type(uint256).max);
        vm.prank(proposer); staking.stake(100);
        staking.grantRole(staking.LOCKER_ROLE(), address(voting));
    }

    function _propose() private returns (uint256 id) {
        ClerkVoting.ProposalInput memory input;
        input.kind = ClerkVoting.Kind.PROPOSE_SCHEMA;
        input.schemaId = 8;
        input.schemaJsonHash = keccak256("schema");
        input.promptHash = keccak256("prompt");
        vm.warp(block.timestamp + 1);
        vm.prank(proposer);
        id = voting.propose(input);
    }

    function testLateStakeHasNoWeightAndVotesStayWithinSnapshot() public {
        uint256 id = _propose();
        vm.prank(lateStaker); staking.stake(200);
        vm.prank(lateStaker);
        vm.expectRevert(ClerkVoting.NoVotingPower.selector);
        voting.castVote(id, true);
        vm.prank(proposer); voting.castVote(id, true);
        ClerkVoting.Proposal memory p = voting.getProposal(id);
        assertEq(p.totalStakedSnapshot, 100);
        assertLe(p.forVotes + p.againstVotes, p.totalStakedSnapshot);
    }

    function testSameTimestampStakeAsProposalIsExcluded() public {
        vm.warp(block.timestamp + 1);
        vm.prank(lateStaker); staking.stake(200);
        ClerkVoting.ProposalInput memory input;
        input.kind = ClerkVoting.Kind.PROPOSE_SCHEMA;
        input.schemaId = 8;
        input.schemaJsonHash = keccak256("schema");
        input.promptHash = keccak256("prompt");
        vm.prank(proposer);
        uint256 id = voting.propose(input);
        vm.prank(lateStaker);
        vm.expectRevert(ClerkVoting.NoVotingPower.selector);
        voting.castVote(id, true);
        ClerkVoting.Proposal memory p = voting.getProposal(id);
        assertEq(p.totalStakedSnapshot, 100);
        assertEq(staking.stakeAt(lateStaker, p.snapshot), 0);
    }

    function testPostSnapshotUnstakeKeepsWeightAndRecipientCannotVote() public {
        uint256 id = _propose();
        vm.warp(block.timestamp + 1);
        vm.prank(proposer); staking.requestUnstake(60);
        vm.prank(lateStaker); staking.stake(100);
        vm.prank(lateStaker);
        vm.expectRevert(ClerkVoting.NoVotingPower.selector);
        voting.castVote(id, true);
        vm.prank(proposer); voting.castVote(id, true);
        ClerkVoting.Proposal memory p = voting.getProposal(id);
        assertEq(p.forVotes, 100);
        assertLe(p.forVotes + p.againstVotes, p.totalStakedSnapshot);
    }

    function testStakeMovedAfterSnapshotDoesNotGiveRecipientVotingWeight() public {
        uint256 id = _propose();
        uint256 unstakeAt = block.timestamp + 1;
        vm.warp(unstakeAt);
        vm.prank(proposer); staking.requestUnstake(100);
        vm.warp(unstakeAt + staking.cooldown());
        vm.prank(proposer); staking.withdraw();
        vm.prank(recipient); staking.stake(100);
        vm.prank(recipient);
        vm.expectRevert(ClerkVoting.NoVotingPower.selector);
        voting.castVote(id, true);
        vm.prank(proposer); voting.castVote(id, true);
        assertEq(voting.getProposal(id).forVotes, 100);
    }
}
