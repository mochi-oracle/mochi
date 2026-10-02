// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
pragma abicoder v2;

import {Test} from "forge-std/Test.sol";
import {ClerkVoting} from "@mochi/ClerkVoting.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {ClassMix} from "@mochi/ClassMix.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";

contract ClerkVotingTest is Test {
    MockUSDG token;
    MochiStaking staking;
    SchemaRegistry schemas;
    ClassMix classMix;
    ClerkVoting voting;
    address proposer = address(0xA1);
    address voter = address(0xB2);

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
        token.mint(voter, 1_000);
        vm.prank(proposer); token.approve(address(staking), type(uint256).max);
        vm.prank(voter); token.approve(address(staking), type(uint256).max);
        vm.prank(proposer); staking.stake(100);
        vm.prank(voter); staking.stake(100);
    }

    function _schemaInput() private pure returns (ClerkVoting.ProposalInput memory x) {
        x.kind = ClerkVoting.Kind.PROPOSE_SCHEMA;
        x.schemaId = 8;
        x.schemaJsonHash = keccak256("schema");
        x.promptHash = keccak256("prompt");
        x.tolerancesHash = keccak256("tolerances");
        x.crosscheckHash = keccak256("crosscheck");
    }

    function _input(ClerkVoting.Kind kind) private pure returns (ClerkVoting.ProposalInput memory x) {
        x.kind = kind;
        x.schemaId = 8;
        x.version = 1;
        x.classMix = [uint8(4), 0, 1, 2, 3, 3, 4, 0, 2];
    }

    function _voteYes(uint256 id) private {
        vm.prank(proposer);
        voting.castVote(id, true);
    }

    function _propose(ClerkVoting.ProposalInput memory input) private returns (uint256 id) {
        vm.warp(block.timestamp + 1);
        vm.prank(proposer);
        id = voting.propose(input);
    }

    function _end(uint256 id) private {
        ClerkVoting.Proposal memory p = voting.getProposal(id);
        vm.warp(uint256(p.endTime));
    }

    function _queue(uint256 id) private {
        _end(id);
        voting.queue(id);
    }

    function testSchemaLifecycleActivationAndRevokeLifecycle() public {
        uint256 id = _propose(_schemaInput());
        _voteYes(id);
        uint64 locked = staking.lockedUntil(proposer);
        assertEq(locked, voting.getProposal(id).endTime);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(IMochiStaking.StakeLocked.selector, locked));
        staking.requestUnstake(1);
        _queue(id);
        ClerkVoting.Proposal memory p = voting.getProposal(id);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.TimelockNotElapsed.selector, p.eta));
        voting.execute(id);
        vm.warp(uint256(p.eta));
        voting.execute(id);
        assertEq(schemas.latest(8), 0);
        uint256 activateAt = uint256(schemas.getVersion(8, 1).activatesAt);
        vm.warp(activateAt);
        assertTrue(schemas.isActive(8, 1));

        uint256 revokeId = _propose(_input(ClerkVoting.Kind.REVOKE_SCHEMA));
        vm.prank(voter); voting.castVote(revokeId, true);
        _queue(revokeId);
        ClerkVoting.Proposal memory revoke = voting.getProposal(revokeId);
        vm.warp(uint256(revoke.eta));
        voting.execute(revokeId);
        assertFalse(schemas.isActive(8, 1));
    }

    function testClassMixLifecycleAndDoubleVotePrevention() public {
        uint256 id = _propose(_input(ClerkVoting.Kind.SET_CLASS_MIX));
        _voteYes(id);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.AlreadyVoted.selector, proposer));
        voting.castVote(id, false);
        _queue(id);
        ClerkVoting.Proposal memory p = voting.getProposal(id);
        vm.warp(uint256(p.eta));
        voting.execute(id);
        assertEq(uint8(classMix.seatClass(0)), 4);
    }

    function testThresholdQuorumMajorityAndCancellation() public {
        token.mint(address(0xC3), 5_000);
        vm.prank(address(0xC3)); token.approve(address(staking), type(uint256).max);
        vm.prank(address(0xC3)); staking.stake(5_000);
        vm.prank(address(0xD4));
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.BelowProposalThreshold.selector, 0, 100));
        voting.propose(_schemaInput());

        uint256 quorumId = _propose(_schemaInput());
        _voteYes(quorumId);
        _end(quorumId);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.QuorumNotReached.selector, 100, 208));
        voting.queue(quorumId);

        // A proposer can cancel before the voting end.
        uint256 cancelId = _propose(_schemaInput());
        vm.prank(proposer);
        voting.cancel(cancelId);
        vm.expectRevert();
        voting.getProposal(cancelId);
    }

    function testMajorityFailure() public {
        uint256 id = _propose(_schemaInput());
        _voteYes(id);
        vm.prank(voter); voting.castVote(id, false);
        _end(id);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.ProposalNotSucceeded.selector, id));
        voting.queue(id);
    }

    /// Regression: re-queueing used to reset eta, letting anyone postpone execution forever.
    function testCannotRequeueToDelayExecution() public {
        uint256 id = _propose(_schemaInput());
        _voteYes(id);
        _queue(id);
        uint64 eta = voting.getProposal(id).eta;
        vm.warp(uint256(eta) - 1);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.AlreadyQueuedOrCancelled.selector, id));
        voting.queue(id);
        vm.warp(uint256(eta));
        voting.execute(id);
        assertTrue(voting.getProposal(id).executed);
    }

    function testGraceWindowBoundsQueueAndExecute() public {
        uint256 id = _propose(_input(ClerkVoting.Kind.SET_CLASS_MIX));
        _voteYes(id);
        uint64 grace = voting.GRACE_PERIOD();
        uint256 endTime = voting.getProposal(id).endTime;
        vm.warp(endTime + grace + 1);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.ProposalExpired.selector, id));
        voting.queue(id);
        vm.warp(endTime + grace); // last second of the queue window
        voting.queue(id);
        uint256 eta = voting.getProposal(id).eta;
        vm.warp(eta + grace + 1);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.ProposalExpired.selector, id));
        voting.execute(id);
        vm.warp(eta + grace); // last second of the execution window
        voting.execute(id);
        assertEq(uint8(classMix.seatClass(0)), 4);
    }

    /// Ordering is per target: a newer class-mix proposal supersedes an older one, but a schema revocation is not
    /// blocked by an unrelated, newer schema proposal.
    function testSupersededProposalErrorsAndIndependentTargets() public {
        uint256 propose1 = _propose(_schemaInput());
        _voteYes(propose1);
        _queue(propose1);
        vm.warp(uint256(voting.getProposal(propose1).eta));
        voting.execute(propose1); // schema 8 version 1

        uint256 olderMix = _propose(_input(ClerkVoting.Kind.SET_CLASS_MIX));
        uint256 revokeV1 = _propose(_input(ClerkVoting.Kind.REVOKE_SCHEMA));
        uint256 propose2 = _propose(_schemaInput());
        ClerkVoting.ProposalInput memory mix = _input(ClerkVoting.Kind.SET_CLASS_MIX);
        mix.classMix = [uint8(1), 2, 4, 0, 3, 1, 2, 0, 4];
        uint256 newerMix = _propose(mix);
        uint256[4] memory ids = [olderMix, revokeV1, propose2, newerMix];
        for (uint256 i; i < 4; ++i) _voteYes(ids[i]);
        _end(newerMix);
        for (uint256 i; i < 4; ++i) voting.queue(ids[i]);
        vm.warp(uint256(voting.getProposal(newerMix).eta));

        assertEq(voting.targetOf(olderMix), voting.targetOf(newerMix));
        assertTrue(voting.targetOf(revokeV1) != voting.targetOf(propose2));
        voting.execute(newerMix);
        vm.expectRevert(abi.encodeWithSelector(ClerkVoting.SupersededProposal.selector, olderMix, newerMix));
        voting.execute(olderMix);
        voting.execute(propose2); // schema 8 version 2
        voting.execute(revokeV1); // still revokes version 1
        assertEq(voting.lastExecutedFor(voting.targetOf(propose2)), propose2);
        assertTrue(schemas.getVersion(8, 1).revoked);
        assertFalse(schemas.getVersion(8, 2).revoked);
        assertEq(uint8(classMix.seatClass(0)), 1);
    }
}
