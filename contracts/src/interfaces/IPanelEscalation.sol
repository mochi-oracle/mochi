// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title IPanelEscalation
/// @notice HUNG → 3 staked human evaluators. Commit-reveal of (answerHash, payloadHash); 2-of-3 match posts a panel
///         verdict. One appeal → second panel (disjoint evaluators); first-panel evaluators who voted against the
///         final majority are slashed 10%. Stake is USDG. No identity checks: stake only.
interface IPanelEscalation {
    enum CaseStatus {
        NONE,
        DRAWING, // waiting for seal block
        COMMIT,
        REVEAL,
        RESOLVED_MAJORITY,
        RESOLVED_NO_MAJORITY,
        APPEALED, // second panel in progress (DRAWING/COMMIT/REVEAL tracked by panelIndex = 1)
        FINAL
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

    // evaluator stake (USDG)
    function stake(uint256 amount) external;
    function requestUnstake() external; // inactive immediately; withdrawable after cooldown if not on an open panel
    function withdraw() external;

    /// @notice Payer (query.payer / refundTo) or FEED_RUNNER. Query must be HUNG and (isPublic || allowPanelDisclosure).
    ///         Pulls panelFee USDG from msg.sender, calls escrow.markEscalated, sets sealBlock. caseId = queryId.
    function escalate(bytes32 queryId) external returns (bytes32 caseId);
    /// @notice Anyone after sealBlock: selects 3 distinct active evaluators (excluding prior panel), opens commit window.
    function draw(bytes32 caseId) external;
    /// @notice Anyone, status DRAWING and the randomness ticket expired: assign a fresh ticket.
    function reseal(bytes32 caseId) external;
    /// @notice commitment = keccak256(abi.encode(caseId, panelIndex, msg.sender, answerHash, payloadHash, salt)).
    function commit(bytes32 caseId, bytes32 commitment) external;
    function reveal(bytes32 caseId, bytes32 answerHash, bytes32 payloadHash, bytes32 salt) external;
    /// @notice Anyone after revealDeadline (or when all 3 revealed). Majority = 2+ identical (answerHash, payloadHash).
    ///         Non-revealers slashed 10%. Opens a 24h appeal window if a majority exists on panel 0.
    function resolve(bytes32 caseId) external;
    /// @notice Payer, within the appeal window after panel 0 resolved with a majority. Pulls panelFee; draws panel 1.
    function appeal(bytes32 caseId) external;
    /// @notice Anyone after the appeal window (panel 0) or after panel 1 resolves. If the final panel has a majority,
    ///         calls verdicts.postPanelOutcome; pays the fee equally to the final majority evaluators; slashes 10% of
    ///         panel-0 evaluators whose reveal differs from the final outcome (only if an appeal happened).
    function finalize(bytes32 caseId) external;

    function getCase(bytes32 caseId) external view returns (Case memory);
    function panelOf(bytes32 caseId, uint8 panelIndex) external view returns (address[3] memory);
    function stakeOf(address evaluator) external view returns (uint256);
    function panelFee() external view returns (uint256);
    function minStake() external view returns (uint256);
}
