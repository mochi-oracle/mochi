// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClerkVoting} from "@mochi/ClerkVoting.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {ClassMix} from "@mochi/ClassMix.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";

contract VotingInvariantActor {
    function approve(MockUSDG token, address staking) external { token.approve(staking, type(uint256).max); }
    function stake(MochiStaking staking_, uint256 amount) external { staking_.stake(amount); }
    function unstake(MochiStaking staking_, uint256 amount) external { staking_.requestUnstake(amount); }
    function propose(ClerkVoting voting_, ClerkVoting.ProposalInput calldata input) external returns (uint256) {
        return voting_.propose(input);
    }
    function vote(ClerkVoting voting_, uint256 proposalId, bool support) external {
        voting_.castVote(proposalId, support);
    }
}

contract ClerkVotingSnapshotHandler {
    MockUSDG public immutable token;
    MochiStaking public immutable staking;
    ClerkVoting public immutable voting;
    VotingInvariantActor[3] public actors;

    constructor(MockUSDG token_, MochiStaking staking_, ClerkVoting voting_) {
        token = token_;
        staking = staking_;
        voting = voting_;
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = new VotingInvariantActor();
            token.mint(address(actors[i]), 1_000_000);
            actors[i].approve(token, address(staking));
        }
        actors[0].stake(staking, 100);
    }

    function stake(uint8 actorSeed, uint96 amountSeed) external {
        VotingInvariantActor actor = actors[actorSeed % 3];
        uint256 amount = uint256(amountSeed % 10_000) + 1;
        try actor.stake(staking, amount) {} catch {}
    }

    function unstake(uint8 actorSeed, uint96 amountSeed) external {
        VotingInvariantActor actor = actors[actorSeed % 3];
        uint256 active = staking.stakeOf(address(actor));
        if (active == 0) return;
        uint256 amount = uint256(amountSeed) % active + 1;
        try actor.unstake(staking, amount) {} catch {}
    }

    function propose(uint8 actorSeed) external {
        // Make all earlier timestamp checkpoints eligible for the proposal's t-1 snapshot.
        vmWarp();
        VotingInvariantActor actor = actors[actorSeed % 3];
        ClerkVoting.ProposalInput memory input;
        input.kind = ClerkVoting.Kind.PROPOSE_SCHEMA;
        input.schemaId = 1;
        input.schemaJsonHash = keccak256("schema");
        input.promptHash = keccak256("prompt");
        try actor.propose(voting, input) {} catch {}
    }

    function vote(uint8 proposalSeed, uint8 actorSeed, bool support) external {
        uint256 count = voting.proposalCount();
        if (count == 0) return;
        uint256 id = uint256(proposalSeed) % count + 1;
        try actors[actorSeed % 3].vote(voting, id, support) {} catch {}
    }

    function warp(uint32 secondsSeed) external {
        VM_WARP.warp(block.timestamp + uint256(secondsSeed % 1 days) + 1);
    }

    function vmWarp() private {
        // Each call is an action in the same EVM test transaction but advances one timestamp second.
        VM_WARP.warp(block.timestamp + 1);
    }

    Vm private constant VM_WARP = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

contract ClerkVotingSnapshotInvariantTest is Test {
    MockUSDG private token;
    MochiStaking private staking;
    ClerkVoting private voting;
    ClerkVotingSnapshotHandler private handler;

    function setUp() public {
        token = new MockUSDG();
        staking = new MochiStaking(address(this), token, token, 7 days, 7 days);
        SchemaRegistry schemas = new SchemaRegistry(address(this), 0);
        ClassMix mix = new ClassMix(address(this));
        voting = new ClerkVoting(address(this), IMochiStaking(address(staking)), schemas, mix, 3 days, 1 days, 0, 1);
        staking.grantRole(staking.LOCKER_ROLE(), address(voting));
        handler = new ClerkVotingSnapshotHandler(token, staking, voting);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_proposalVotesNeverExceedSnapshot() public view {
        for (uint256 id = 1; id <= voting.proposalCount(); ++id) {
            ClerkVoting.Proposal memory p = voting.getProposal(id);
            assertLe(p.forVotes + p.againstVotes, p.totalStakedSnapshot);
        }
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_totalStakedEqualsSumOfActorStake() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) sum += staking.stakeOf(address(handler.actors(i)));
        assertEq(staking.totalStaked(), sum);
    }
}
