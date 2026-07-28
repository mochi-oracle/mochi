// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {MochiTypes} from "../libraries/MochiTypes.sol";

/// @title IMochiVerdicts
/// @notice Verifies and stores verdicts. The orchestrator that calls `post` is an untrusted relay: every check that
///         matters is done here against on-chain state (selected seats, attested keys) and enclave signatures.
interface IMochiVerdicts {
    event VerdictPosted(
        bytes32 indexed verdictId,
        bytes32 indexed queryId,
        uint8 round,
        uint8 status,
        uint16 agreementBps,
        uint32 dissentMask,
        uint32 timeoutMask,
        bytes32 answerHash,
        bytes32 payloadHash,
        bool isPublic
    );
    event PanelVerdictPosted(bytes32 indexed verdictId, bytes32 indexed queryId, bytes32 answerHash, bytes32 payloadHash);
    event EquivocationReported(address indexed juror, bytes32 indexed queryId, address reporter);

    error WrongQueryStatus(bytes32 queryId, MochiTypes.QueryStatus status);
    error WrongRound(uint8 expected, uint8 got);
    error SeatCountMismatch(uint256 expected, uint256 got);
    error SeatJurorMismatch(uint256 seat, address expected, address got);
    error BadJurorSignature(uint256 seat);
    error InactiveJuror(uint256 seat, address juror);
    error TimeoutMaskMismatch(uint32 declared, uint32 derived);
    error BadConsensusSignature();
    error InactiveConsensusKey(address key);
    error InconsistentStatus();
    error InvalidStatus(uint8 status);
    error NotPanel(address caller);
    error NotEquivocation();
    error VerdictExists(bytes32 verdictId);

    /// @notice Post the verdict for the query's current round.
    /// @dev Checks, in order:
    ///  1. q = escrow.getQuery(v.queryId); q.status == SEALED; v.round == q.round.
    ///  2. seats = escrow.jurorsOf(queryId); votes.length == seats.length == q.n; votes[i].juror == seats[i].
    ///  3. For each seat i: sig empty ⇔ bit i of v.timeoutMask set (else TimeoutMaskMismatch). A non-empty sig must
    ///     recover (ECDSA, EIP-712 domain "MochiVerdicts"/"1") to seats[i] over
    ///     JurorAnswer(queryId, q.docCommit, q.schemaId, q.schemaVersion, answerHash, spansRoot, quoteHash), and
    ///     seats[i] must be registry.isActive(JUROR).
    ///  4. consensusSig recovers to a key with registry.isActive(CONSENSUS) over
    ///     VerdictAttestation(v..., votesHash = MochiTypes.hashVotes(votes)).
    ///  5. status ∈ {VERDICT, HUNG}; k = requiredAgree(n); responded = n - popcount(timeoutMask);
    ///     VERDICT ⇒ responded >= k && uint256(agreementBps) * n >= uint256(k) * 10000 - (n - 1) (floor tolerance)
    ///              && payloadHash != 0 && (dissentMask & timeoutMask) == timeoutMask;
    ///     HUNG ⇒ payloadHash == 0 && uint256(agreementBps) * n < uint256(k) * 10000 - (n - 1)
    ///            (the exact negation of the VERDICT threshold; agreementBps is floored).
    ///  6. Store Verdict (attestationRoot = keccak256(abi.encode(quoteHashes in seat order)),
    ///     modelSetHash = keccak256(abi.encode(seats))), emit, escrow.settle(queryId, round, status, timeoutMask),
    ///     registry.recordService(seats[prevN..n), timeoutMask >> prevN).
    function post(MochiTypes.VerdictInput calldata v, MochiTypes.JurorVote[] calldata votes, bytes calldata consensusSig)
        external
        returns (bytes32 verdictId);

    /// @notice Only PanelEscalation, for an ESCALATED query. Stores a VERDICT with round = PANEL_ROUND,
    ///         escalated = true, agreementBps = 0, dissentMask = 0; calls escrow.markDecided.
    function postPanelOutcome(bytes32 queryId, bytes32 answerHash, bytes32 payloadHash) external returns (bytes32 verdictId);

    /// @notice Anyone proves a juror signed two different answerHashes for the same queryId → registry.slashEquivocation.
    function reportEquivocation(
        bytes32 queryId,
        bytes32 docCommit,
        uint32 schemaId,
        uint16 schemaVersion,
        bytes32[3] calldata answerA, // [answerHash, spansRoot, quoteHash]
        bytes calldata sigA,
        bytes32[3] calldata answerB,
        bytes calldata sigB
    ) external;

    function getVerdict(bytes32 verdictId) external view returns (MochiTypes.Verdict memory);
    /// @notice verdictId of the most recent verdict posted for a query (0 if none).
    function latestVerdictOf(bytes32 queryId) external view returns (bytes32);
    /// @notice keccak256(answerJson) == answerHash.
    function verify(bytes32 verdictId, bytes calldata answerJson) external view returns (bool);
    function domainSeparator() external view returns (bytes32);
}
