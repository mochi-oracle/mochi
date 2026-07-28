// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {MochiTypes} from "../libraries/MochiTypes.sol";

/// @title IQueryEscrow
/// @notice Query lifecycle (open → seal → settle | expand | expire), pricing, and payment paths.
///
/// queryId = keccak256(abi.encode(block.chainid, address(this), msg.sender, prov.docCommit, p.nonce))
///
/// Pricing (snapshotted per seat at open / expand so later price changes never affect an open query):
///   seatFee(seat) = classBase[seatClass(seat)] + classPerK[seatClass(seat)] * tokensK
///   jurorFees(from, to) = Σ seatFee(seat) for seat in [from, to)
///   protocolFee = max(minProtocolFee, jurorFees * protocolFeeBps / 10000)
///   total = jurorFees + protocolFee
///
/// Settlement (called by MochiVerdicts for the current round; only seats added THIS round are paid):
///   - each new seat that answered: claimable[operatorOf(juror)] += seatFee
///   - each new seat that timed out: seatFee refunded
///   - VERDICT: protocolFee → panelReserveBps to panelPool (transfer), remainder to staking via notifyReward
///   - HUNG: protocolFee refunded
/// Refund routing by pay path: USDG / SHIELDED → transfer to refundTo; ANONYMA → back into anonymaFloat;
///   FEED → back into feedBudget.
interface IQueryEscrow {
    event QueryOpened(
        bytes32 indexed queryId,
        MochiTypes.PayPath payPath,
        uint32 schemaId,
        uint16 schemaVersion,
        uint8 n,
        bool isPublic,
        bytes32 docCommit,
        uint256 amount,
        uint64 sealBlock
    );
    event QuerySealed(bytes32 indexed queryId, uint8 round, bytes32 seed, address[] newJurors);
    event QueryResealed(bytes32 indexed queryId, uint8 round, uint64 sealBlock);
    event QueryExpanded(bytes32 indexed queryId, uint8 round, uint8 newN, uint256 amount, uint64 sealBlock);
    event QuerySettled(bytes32 indexed queryId, uint8 round, MochiTypes.VerdictStatus status, uint256 jurorsPaid, uint256 refunded);
    event QueryExpired(bytes32 indexed queryId, uint256 refunded);
    event QueryEscalated(bytes32 indexed queryId);
    event QueryDecidedByPanel(bytes32 indexed queryId);
    event Claimed(address indexed operator, uint256 amount);
    event Refunded(bytes32 indexed queryId, address indexed to, uint256 amount);
    event AnonymaVoucherUsed(bytes32 indexed voucherId, bytes32 indexed queryId, uint8 tier, uint256 amount);
    event AnonymaFloatFunded(address indexed from, uint256 amount);
    event FeedBudgetFunded(address indexed from, uint256 amount);
    event ClassPriceSet(MochiTypes.JurorClass indexed jurorClass, uint256 base, uint256 perK);
    event ProtocolFeeSet(uint16 bps, uint256 minFee);

    error InvalidN(uint8 n);
    error InvalidRefundTo();
    error SchemaNotActive(uint32 schemaId);
    error BadIntakeSignature();
    error BadVoucherSignature();
    error VoucherExpired();
    error VoucherUsed(bytes32 voucherId);
    error VoucherMismatch();
    error InsufficientFloat(uint256 needed, uint256 available);
    error InsufficientFeedBudget(uint256 needed, uint256 available);
    error FeedQueryMustBePublicFetched();
    error QueryExists(bytes32 queryId);
    error UnknownQuery(bytes32 queryId);
    error WrongStatus(bytes32 queryId, MochiTypes.QueryStatus status);
    error WrongRound(uint8 expected, uint8 got);
    error DeadlineNotPassed(uint64 deadline);
    error NotAuthorized(address caller);
    error ZeroTokens();

    // ── pricing ──

    function quote(uint32 schemaId, uint8 n, uint32 tokensK) external view returns (uint256 jurorFees, uint256 protocolFee);
    function quoteExpansion(bytes32 queryId, uint8 newN) external view returns (uint256 jurorFees, uint256 protocolFee);

    // ── open (all revert when paused; all verify `intakeSig` = EIP-712 Provenance by an active INTAKE key;
    //    all require an active schema version (latest), valid n, tokensK >= 1, refundTo != 0, fresh queryId) ──

    /// @notice Pulls `total` USDG from msg.sender.
    function openWithUSDG(MochiTypes.OpenParams calldata p, MochiTypes.Provenance calldata prov, bytes calldata intakeSig)
        external
        returns (bytes32 queryId);

    /// @notice Calls shielded.spend(nullifier, total, address(this), queryId, proof). msg.sender is the relayer.
    function openShielded(
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        bytes calldata intakeSig,
        bytes32 nullifier,
        bytes calldata proof
    ) external returns (bytes32 queryId);

    /// @notice Anonyma path: voucher signed by `anonymaSigner` (EIP-712), unused, unexpired, voucher.docCommit ==
    ///         prov.docCommit, voucher.schemaId == p.schemaId, voucher.n == p.n, total <= voucher.maxAmount.
    ///         Draws `total` from anonymaFloat (Anonyma's prepaid USDG float).
    function openWithVoucher(
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        bytes calldata intakeSig,
        MochiTypes.AnonymaVoucher calldata voucher,
        bytes calldata anonymaSig
    ) external returns (bytes32 queryId);

    /// @notice FEED_RUNNER only; requires p.isPublic and prov.kind == FETCHED; draws from feedBudget.
    function openFeed(MochiTypes.OpenParams calldata p, MochiTypes.Provenance calldata prov, bytes calldata intakeSig)
        external
        returns (bytes32 queryId);

    // ── lifecycle ──

    /// @notice Anyone, status OPEN, randomness ticket ready. seed = randomness.seed(keccak256(abi.encode(queryId,
    ///         docCommit, round)), sealBlock); sealBlock is the randomness ticket for this round.
    ///         appended to the query's juror list; status → SEALED. Reverts WrongStatus if not OPEN; before
    ///         A ticket that is not ready bubbles up the randomness source's SeedNotReady revert (callers retry).
    function seal(bytes32 queryId) external;

    /// @notice Anyone, status OPEN, when the randomness ticket expired: assign a fresh ticket.
    function reseal(bytes32 queryId) external;

    /// @notice Status HUNG, newN valid and > n, before deadline. Round++, prevN = n, n = newN, fees for seats
    ///         [prevN, newN) snapshotted, deadline = now + queryTtl, status → OPEN, new randomness ticket.
    ///         Payment: FEED path → FEED_RUNNER only, from feedBudget; SHIELDED → use expandShielded;
    ///         ANONYMA → use expandWithVoucher; USDG → pulls from msg.sender (anyone may pay).
    function expand(bytes32 queryId, uint8 newN) external;

    function expandShielded(bytes32 queryId, uint8 newN, bytes32 nullifier, bytes calldata proof) external;

    function expandWithVoucher(
        bytes32 queryId,
        uint8 newN,
        MochiTypes.AnonymaVoucher calldata voucher,
        bytes calldata anonymaSig
    ) external;

    /// @notice Only MochiVerdicts. Status SEALED and round == current round. VERDICT → DECIDED, HUNG → HUNG.
    ///         timeoutMask bit i refers to seat i (all seats); only seats in [prevN, n) are paid or refunded here.
    function settle(bytes32 queryId, uint8 round, MochiTypes.VerdictStatus status, uint32 timeoutMask) external;

    /// @notice Anyone, after deadline, status OPEN or SEALED: refunds the current round's unsettled escrow
    ///         (all its seat fees + protocolFee); status → EXPIRED.
    function expire(bytes32 queryId) external;

    /// @notice Only PanelEscalation. HUNG → ESCALATED.
    function markEscalated(bytes32 queryId) external;

    /// @notice Only MochiVerdicts (on panel outcome). ESCALATED → DECIDED.
    function markDecided(bytes32 queryId) external;

    /// @notice Operator withdraws accumulated juror fees.
    function claim() external;

    // ── funding ──

    function fundAnonymaFloat(uint256 amount) external;
    function fundFeedBudget(uint256 amount) external;

    // ── views ──

    function getQuery(bytes32 queryId) external view returns (MochiTypes.Query memory);
    /// @notice All seated jurors in seat order (length == n once sealed for the current round).
    function jurorsOf(bytes32 queryId) external view returns (address[] memory);
    /// @notice n before the current round (0 in round 0).
    function prevNOf(bytes32 queryId) external view returns (uint8);
    function seatFeeOf(bytes32 queryId, uint8 seat) external view returns (uint256);
    function claimable(address operator) external view returns (uint256);
    function anonymaFloat() external view returns (uint256);
    function feedBudget() external view returns (uint256);
    function voucherUsed(bytes32 voucherId) external view returns (bool);
    function computeQueryId(address sender, bytes32 docCommit, uint64 nonce) external view returns (bytes32);
    function domainSeparator() external view returns (bytes32);
}
