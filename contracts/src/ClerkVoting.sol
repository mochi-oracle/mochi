// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";
import {ISchemaRegistry} from "@mochi/interfaces/ISchemaRegistry.sol";
import {IClassMix} from "@mochi/interfaces/IClassMix.sol";

/// @title ClerkVoting
/// @notice Stake-weighted proposals for schema lifecycle and nested juror class order.
contract ClerkVoting is AccessControl {
    enum Kind { PROPOSE_SCHEMA, REVOKE_SCHEMA, SET_CLASS_MIX }

    struct ProposalInput {
        Kind kind;
        uint32 schemaId;
        uint16 version;
        bytes32 schemaJsonHash;
        bytes32 promptHash;
        bytes32 tolerancesHash;
        bytes32 crosscheckHash;
        uint8[9] classMix;
    }

    struct Proposal {
        address proposer;
        Kind kind;
        uint64 endTime;
        uint64 eta;
        uint48 snapshot;
        uint256 totalStakedSnapshot;
        uint256 forVotes;
        uint256 againstVotes;
        bool queued;
        bool executed;
        bool cancelled;
        uint32 schemaId;
        uint16 version;
        bytes32 schemaJsonHash;
        bytes32 promptHash;
        bytes32 tolerancesHash;
        bytes32 crosscheckHash;
        uint8[9] classMix;
    }

    IMochiStaking public immutable staking;
    ISchemaRegistry public immutable schemas;
    IClassMix public immutable classMix;
    uint64 public immutable votingPeriod;
    uint64 public immutable executionDelay;
    uint16 public immutable quorumBps;
    uint256 public immutable proposalThreshold;
    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, Kind kind, uint64 endTime, uint256 totalStakedSnapshot);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, uint64 eta);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);

    error BelowProposalThreshold(uint256 stake, uint256 threshold);
    error UnknownProposal(uint256 proposalId);
    error VotingClosed(uint256 proposalId);
    error VotingNotEnded(uint256 proposalId);
    error AlreadyVoted(address voter);
    error ProposalNotSucceeded(uint256 proposalId);
    error QuorumNotReached(uint256 votes, uint256 required);
    error NotProposer(address caller);
    error CannotCancel(uint256 proposalId);
    error NotQueued(uint256 proposalId);
    error TimelockNotElapsed(uint64 eta);
    error AlreadyExecuted(uint256 proposalId);
    error AlreadyQueuedOrCancelled(uint256 proposalId);
    error NoVotingPower();

    /// @notice Deploy with governance targets; grant this contract GOVERNOR and LOCKER roles after deployment.
    constructor(
        address admin,
        IMochiStaking staking_,
        ISchemaRegistry schemas_,
        IClassMix classMix_,
        uint64 votingPeriod_,
        uint64 executionDelay_,
        uint16 quorumBps_,
        uint256 proposalThreshold_
    ) {
        staking = staking_;
        schemas = schemas_;
        classMix = classMix_;
        votingPeriod = votingPeriod_;
        executionDelay = executionDelay_;
        quorumBps = quorumBps_;
        proposalThreshold = proposalThreshold_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Creates a proposal; proposer must hold the threshold stake at creation.
    function propose(ProposalInput calldata input) external returns (uint256 proposalId) {
        uint48 snapshot = uint48(block.timestamp) - 1;
        uint256 stake = staking.stakeAt(msg.sender, snapshot);
        if (stake < proposalThreshold) revert BelowProposalThreshold(stake, proposalThreshold);
        if (input.kind == Kind.PROPOSE_SCHEMA) {
            if (input.schemaId == 0 || input.schemaJsonHash == 0 || input.promptHash == 0) revert ISchemaRegistry.InvalidSchemaId(input.schemaId);
        } else if (input.kind == Kind.REVOKE_SCHEMA) {
            if (input.schemaId == 0 || input.version == 0) revert ISchemaRegistry.InvalidSchemaId(input.schemaId);
        }
        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.proposer = msg.sender;
        p.kind = input.kind;
        p.snapshot = snapshot;
        p.endTime = uint64(block.timestamp) + votingPeriod;
        p.totalStakedSnapshot = staking.totalStakedAt(snapshot);
        p.schemaId = input.schemaId;
        p.version = input.version;
        p.schemaJsonHash = input.schemaJsonHash;
        p.promptHash = input.promptHash;
        p.tolerancesHash = input.tolerancesHash;
        p.crosscheckHash = input.crosscheckHash;
        p.classMix = input.classMix;
        emit ProposalCreated(proposalId, msg.sender, input.kind, p.endTime, p.totalStakedSnapshot);
    }

    /// @notice Casts the caller's stake at the proposal snapshot and locks it through the voting end time.
    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = _proposal(proposalId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= p.endTime || p.cancelled) revert VotingClosed(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(msg.sender);
        uint256 weight = staking.stakeAt(msg.sender, p.snapshot);
        if (weight == 0) revert NoVotingPower();
        hasVoted[proposalId][msg.sender] = true;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;
        staking.lockForVote(msg.sender, p.endTime);
        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @notice Queues a successful proposal for execution after the delay.
    function queue(uint256 proposalId) external {
        Proposal storage p = _proposal(proposalId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.endTime) revert VotingNotEnded(proposalId);
        // Queue once: re-queueing would reset eta and let anyone delay execution indefinitely.
        if (p.queued || p.cancelled) revert AlreadyQueuedOrCancelled(proposalId);
        if (p.forVotes <= p.againstVotes) revert ProposalNotSucceeded(proposalId);
        uint256 required = p.totalStakedSnapshot * quorumBps / 10_000;
        if (p.forVotes + p.againstVotes < required) revert QuorumNotReached(p.forVotes + p.againstVotes, required);
        p.queued = true;
        p.eta = uint64(block.timestamp) + executionDelay;
        emit ProposalQueued(proposalId, p.eta);
    }

    /// @notice Executes a queued schema or class-mix proposal after the execution delay.
    function execute(uint256 proposalId) external {
        Proposal storage p = _proposal(proposalId);
        if (!p.queued) revert NotQueued(proposalId);
        if (p.executed) revert AlreadyExecuted(proposalId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.eta) revert TimelockNotElapsed(p.eta);
        p.executed = true;
        if (p.kind == Kind.PROPOSE_SCHEMA) {
            schemas.propose(p.schemaId, p.schemaJsonHash, p.promptHash, p.tolerancesHash, p.crosscheckHash);
        } else if (p.kind == Kind.REVOKE_SCHEMA) {
            schemas.revoke(p.schemaId, p.version);
        } else {
            classMix.setMix(p.classMix);
        }
        emit ProposalExecuted(proposalId);
    }

    /// @notice Proposer may cancel before voting ends.
    function cancel(uint256 proposalId) external {
        Proposal storage p = _proposal(proposalId);
        if (msg.sender != p.proposer) revert NotProposer(msg.sender);
        // forge-lint: disable-next-line(block-timestamp)
        if (p.cancelled || p.queued || block.timestamp >= p.endTime) revert CannotCancel(proposalId);
        p.cancelled = true;
        emit ProposalCancelled(proposalId);
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) { return _proposal(proposalId); }

    function _proposal(uint256 proposalId) private view returns (Proposal storage p) {
        p = _proposals[proposalId];
        if (proposalId == 0 || proposalId > proposalCount) revert UnknownProposal(proposalId);
        if (p.cancelled) revert CannotCancel(proposalId);
    }
}
