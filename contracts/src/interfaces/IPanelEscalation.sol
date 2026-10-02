// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title IPanelEscalation
/// @notice HUNG → 3 staked human evaluators. Commit-reveal of (answerHash, payloadHash); 2-of-3 match posts a panel
///         verdict. One appeal → second panel (disjoint evaluators); first-panel evaluators who voted against the
///         final majority are slashed 10%. Stake is USDG. No identity checks: stake only.
/// @dev Selection. Evaluators with at least minStake and no unstake request form an active pool. Each seal (escalate,
///      appeal, reseal) takes a seal number and a randomness ticket, freezes the pool length, and counts exactly how
///      many evaluators the draw can pick: those active at the seal (an exit before it, even in the same ticket,
///      excludes; an exit after it does not) that became active at least warmupTickets tickets before it, minus the
///      prior panel. A draw only reads positions below the frozen length. A position a pending draw can still pick
///      never moves or changes until that draw ends; a position no pending draw can pick may be pruned, reused or
///      re-activated at any time. Ineligible positions are skipped by rehashing; a draw that runs out of its per-call
///      attempt budget keeps its progress and the next call continues the same sequence, so ineligible positions cost
///      gas, never the draw. A draw with fewer than three eligible evaluators is impossible from the seal and can be
///      expired at its deadline.
interface IPanelEscalation {
    enum CaseStatus {
        NONE,
        DRAWING, // waiting for the draw; after drawDeadline, expireDraw draws if it can and otherwise ends the draw
        COMMIT,
        REVEAL,
        RESOLVED_MAJORITY,
        RESOLVED_NO_MAJORITY,
        APPEALED, // unused (second panel progress is DRAWING/COMMIT/REVEAL with panelIndex = 1)
        FINAL, // terminal; a verdict was posted iff the outcome hashes are nonzero
        DRAW_EXPIRED // terminal for the first panel: nobody drawn by drawDeadline, fee refunded; may be escalated again
    }

    struct Case {
        bytes32 queryId;
        CaseStatus status;
        uint8 panelIndex; // 0 first panel, 1 appeal panel
        uint64 sealBlock; // randomness ticket for the current panel draw
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 appealDeadline;
        address payer; // who escalated (can appeal)
        uint256 fee; // escrowed evaluator fee for the current panel
        bytes32 outcomeAnswerHash;
        bytes32 outcomePayloadHash;
        uint64 drawDeadline; // the current panel must be drawn by then
        uint64 poolSize; // pool length frozen at the seal; only these positions can be drawn
    }

    /// @dev Pool membership. Active iff position != 0 and exitSeal == 0. An inactive member with position != 0 holds a
    ///      kept position: one a pending draw may still pick, or a dead slot waiting to be pruned or reused.
    struct Member {
        uint64 joinTicket; // randomness ticket when the evaluator last became active
        uint64 joinSeal; // sealCount when the evaluator last became active
        uint64 exitSeal; // 0 while active; sealCount + 1 when it last became inactive
        uint64 position; // 1-based index in the pool, 0 when not in the pool
    }

    /// @dev Draw progress of a case's current panel; the rules are fixed at the seal.
    struct DrawState {
        bytes32 seed; // randomness of the current draw, kept once a draw call has read it (0 before)
        uint64 sealNonce; // seal number of the current seal
        uint64 sealTime; // time of the escalation or appeal that opened this draw (a reseal keeps it)
        uint64 expiry; // sealTime + unstakeCooldown at the seal: no panel is seated after it
        uint32 eligible; // evaluators this draw can pick, counted at the seal (the prior panel excluded)
        uint16 warmup; // warmupTickets at the seal
        uint8 filled; // seats chosen so far
        uint256 attempt; // next attempt index for the seat being chosen
    }

    event EvaluatorStaked(address indexed evaluator, uint256 amount);
    event EvaluatorUnstakeRequested(address indexed evaluator, uint64 readyAt);
    event EvaluatorWithdrawn(address indexed evaluator, uint256 amount);
    event Escalated(bytes32 indexed caseId, bytes32 indexed queryId, address payer, uint256 fee);
    event CaseResealed(bytes32 indexed caseId, uint64 sealBlock);
    event PanelDrawn(bytes32 indexed caseId, uint8 panelIndex, address[3] evaluators);
    event Committed(bytes32 indexed caseId, address indexed evaluator);
    event Revealed(bytes32 indexed caseId, address indexed evaluator, bytes32 answerHash, bytes32 payloadHash);
    event Resolved(bytes32 indexed caseId, uint8 panelIndex, bool majority, bytes32 answerHash, bytes32 payloadHash);
    event Appealed(bytes32 indexed caseId, address payer, uint256 fee);
    event Finalized(bytes32 indexed caseId, bool posted);
    event EvaluatorSlashed(address indexed evaluator, uint256 amount);
    event DrawExpired(bytes32 indexed caseId, uint8 panelIndex, uint256 refund);
    event PayoutOwed(address indexed to, uint256 amount);
    /// @notice A draw call used its attempt budget before seating the panel; the next call continues from here.
    event DrawProgress(bytes32 indexed caseId, uint8 filled, uint256 attempt);

    error NotEscalatable(bytes32 queryId);
    error DisclosureNotAllowed(bytes32 queryId);
    error WrongCaseStatus(CaseStatus status);
    error NotPanelist(address caller);
    error AlreadyCommitted();
    error BadReveal();
    error WindowClosed();
    error WindowOpen();
    error NotEnoughEvaluators();
    error StakeTooLow(uint256 stake, uint256 minStake);
    error Unauthorized(address caller);
    error DrawPending();

    // evaluator stake (USDG)
    /// @notice Adds stake. The resulting stake must be at least minStake (StakeTooLow). Reverts while an unstake is
    ///         pending. An evaluator that becomes active joins the pool and is drawable after warmupTickets tickets.
    ///         Re-activating a kept position (after a kick or a slash below minStake) reverts DrawPending while a
    ///         pending draw may still pick that position.
    function stake(uint256 amount) external;
    function requestUnstake() external; // leaves the pool for future seals; withdrawable after cooldown if not on an open panel
    /// @notice After the cooldown, with no open panel. Reverts DrawPending while a pending draw may still pick the
    ///         caller's kept position: the stake stays behind it until that draw is seated or expired.
    function withdraw() external;
    /// @notice Anyone: removes an active evaluator whose stake is below minStake (after a minStake increase).
    function kick(address evaluator) external;
    /// @notice Anyone, at any time: examines up to maxEntries kept positions and removes those no pending draw can
    ///         pick.
    function prune(uint256 maxEntries) external returns (uint256 removed);
    /// @notice Pays out USDG owed to the caller because a direct payout transfer failed.
    function claim() external;

    /// @notice Payer (query.payer / refundTo), or FEED_RUNNER for a FEED query. Query must be HUNG (or ESCALATED with
    ///         this case DRAW_EXPIRED) and (isPublic || allowPanelDisclosure). Seals the draw, pulls panelFee USDG from
    ///         msg.sender and calls escrow.markEscalated for a HUNG query. caseId = queryId.
    function escalate(bytes32 queryId) external returns (bytes32 caseId);
    /// @notice Anyone once the seed for sealBlock is available and until the draw's expiry: selects 3 distinct
    ///         eligible evaluators (excluding the prior panel) and opens the commit window. Tries at most DRAW_ATTEMPTS
    ///         positions per call; if the panel is not complete it keeps the progress and returns false (call again).
    ///         The panel does not depend on how the work is split across calls. NotEnoughEvaluators if fewer than
    ///         three evaluators were eligible at the seal; WindowClosed after the expiry.
    function draw(bytes32 caseId) external returns (bool seated);
    /// @notice Anyone, status DRAWING, no draw call has read the seed, and the randomness ticket expired: assign a
    ///         fresh ticket and refreeze the pool. The draw deadline and expiry stay those of the original seal.
    function reseal(bytes32 caseId) external;
    /// @notice Anyone, status DRAWING after drawDeadline. While the draw can still seat a panel (before its expiry, at
    ///         least three eligible evaluators at the seal, and a seed that is read or can still become available) it
    ///         continues the draw like `draw`. Otherwise (provably impossible, seed lost, or past the expiry even with
    ///         no seed) it refunds the current panel fee to the payer: the first panel becomes DRAW_EXPIRED; an appeal
    ///         lapses and the first panel's majority is finalized. Bubbles the randomness error while the seed can
    ///         still become available before the expiry.
    function expireDraw(bytes32 caseId) external;
    /// @notice commitment = keccak256(abi.encode(caseId, panelIndex, msg.sender, answerHash, payloadHash, salt)).
    function commit(bytes32 caseId, bytes32 commitment) external;
    /// @notice answerHash and payloadHash must be nonzero (MochiVerdicts rejects a zero panel result).
    function reveal(bytes32 caseId, bytes32 answerHash, bytes32 payloadHash, bytes32 salt) external;
    /// @notice Anyone after revealDeadline (or when all 3 revealed). Majority = 2+ identical (answerHash, payloadHash).
    ///         Non-revealers slashed 10%. Opens a 24h appeal window if a majority exists on panel 0.
    function resolve(bytes32 caseId) external;
    /// @notice Payer, within the appeal window after panel 0 resolved with a majority. Pulls panelFee; draws panel 1.
    function appeal(bytes32 caseId) external;
    /// @notice Anyone after the appeal window (panel 0) or after panel 1 resolves. If the final panel has a majority,
    ///         calls verdicts.postPanelOutcome; pays the fee equally to the final majority evaluators; slashes 10% of
    ///         panel-0 evaluators whose reveal differs from the final outcome (only if an appeal happened). Without a
    ///         final majority the case ends FINAL with zero outcome hashes (a final HUNG) and nothing is posted.
    function finalize(bytes32 caseId) external;

    function getCase(bytes32 caseId) external view returns (Case memory);
    function panelOf(bytes32 caseId, uint8 panelIndex) external view returns (address[3] memory);
    function stakeOf(address evaluator) external view returns (uint256);
    function panelFee() external view returns (uint256);
    function minStake() external view returns (uint256);
    function pool(uint256 index) external view returns (address);
    function poolLength() external view returns (uint256);
    function memberOf(address evaluator) external view returns (Member memory);
    function drawStateOf(bytes32 caseId) external view returns (DrawState memory);
    /// @notice An evaluator's revealed (answerHash, payloadHash) on a panel; zero until it reveals.
    function revealOf(bytes32 caseId, uint8 panelIndex, address evaluator)
        external
        view
        returns (bytes32 answerHash, bytes32 payloadHash);
    /// @notice Seals made so far (escalations, appeals and reseals); each seal's number is the count after it.
    function sealCount() external view returns (uint64);
    /// @notice Active evaluators: joined with at least minStake and not since deactivated (unstake request, slash below
    ///         minStake, or kick).
    function activeEvaluators() external view returns (uint256);
    /// @notice True if the evaluator is active and would be eligible for a draw sealed now.
    function isDrawable(address evaluator) external view returns (bool);
}
