// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {IFeedCrosscheck} from "@mochi/interfaces/IFeedCrosscheck.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract Feeds is IFeeds, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IMochiVerdicts public immutable verdicts;
    /// @notice Used to require that a feed verdict came from a standing feed query (PayPath.FEED, opened by a
    ///         FEED_RUNNER). Otherwise anyone could open their own query on the same genuine document with
    ///         requester-chosen params (e.g. a fake consensus EPS) and overwrite derived fields via an equal-asOf update.
    IQueryEscrow public immutable escrow;
    IERC20 public immutable usdg;
    /// @notice Default asOf lead for observation schemas (earnings, reserves, NAV, freeform). Their asOf is a past
    ///         timestamp or a 00:00 UTC date; one day covers a date published in a time zone ahead of UTC plus clock
    ///         skew, and bounds how long one bad verdict can hold a key.
    uint64 public constant OBSERVATION_LEAD = 1 days;
    /// @notice Default asOf lead for scheduled-event schemas (ex-dividend date, split effective date, invoice due
    ///         date), which are announced ahead of time.
    uint64 public constant SCHEDULE_LEAD = 180 days;
    /// @notice Upper bound for any feed's lead: without it one far-future asOf would freeze a key permanently.
    uint64 public constant MAX_LEAD = 366 days;
    address public treasury;
    mapping(bytes32 => Feed) private _feeds;
    mapping(bytes32 => mapping(bytes32 => bool)) private _origins;
    mapping(bytes32 => mapping(bytes32 => Entry)) private _entries;
    mapping(bytes32 => mapping(address => uint64)) public override subscribedUntil;
    mapping(bytes32 => uint64) public override maxLeadOf;
    /// @notice feedId => verdictId => barred from this feed for good: removed by clearEntry, or replaced by another
    ///         verdict recorded in the same second (see update).
    mapping(bytes32 => mapping(bytes32 => bool)) public override isBarred;

    constructor(address admin, IMochiVerdicts verdicts_, IQueryEscrow escrow_, IERC20 usdg_, address treasury_) {
        escrow = escrow_;
        verdicts = verdicts_;
        usdg = usdg_;
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
    }

    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setTreasury(address treasury_) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        treasury = treasury_;
    }

    function register(
        bytes32 feedId,
        uint32 schemaId,
        bytes32[] calldata origins,
        address crosscheck,
        uint256 monthlyFee
    ) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (_feeds[feedId].active) revert FeedExists(feedId);
        _feeds[feedId] = Feed(schemaId, crosscheck, monthlyFee, true);
        for (uint256 i; i < origins.length; ++i) {
            _origins[feedId][origins[i]] = true;
            emit FeedOriginSet(feedId, origins[i], true);
        }
        emit FeedRegistered(feedId, schemaId, crosscheck, monthlyFee);
        bool scheduled = schemaId == uint32(MochiTypes.SchemaId.EX_DIVIDEND)
            || schemaId == uint32(MochiTypes.SchemaId.SPLIT) || schemaId == uint32(MochiTypes.SchemaId.INVOICE);
        _setMaxLead(feedId, scheduled ? SCHEDULE_LEAD : OBSERVATION_LEAD);
    }

    function setMaxLead(bytes32 feedId, uint64 maxLead) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (!_feeds[feedId].active) revert UnknownFeed(feedId);
        _setMaxLead(feedId, maxLead);
    }

    function setOrigin(bytes32 feedId, bytes32 originId, bool allowed)
        external
        override
        onlyRole(MochiRoles.GOVERNOR_ROLE)
    {
        if (!_feeds[feedId].active) revert UnknownFeed(feedId);
        _origins[feedId][originId] = allowed;
        emit FeedOriginSet(feedId, originId, allowed);
    }

    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setCrosscheck(bytes32 feedId, address crosscheck) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (!_feeds[feedId].active) revert UnknownFeed(feedId);
        _feeds[feedId].crosscheck = crosscheck;
    }

    /// @notice GOVERNOR (timelock). Deletes `key`'s entry and bars its verdict from this feed for good, so a correction
    ///         with a lower asOf can be applied (update rejects any lower asOf otherwise) and the removed verdict cannot
    ///         simply be pushed again. Run it in one timelock batch with the update() that applies the replacement, so
    ///         no other eligible verdict for the key can be pushed in between.
    function clearEntry(bytes32 feedId, bytes32 key) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        bytes32 verdictId = _entries[feedId][key].verdictId;
        if (verdictId == 0) revert NoEntryToClear(feedId, key);
        isBarred[feedId][verdictId] = true;
        delete _entries[feedId][key];
        emit EntryCleared(feedId, key, verdictId);
    }

    function update(bytes32 feedId, bytes32 key, bytes32 verdictId, bytes calldata payload)
        external
        override
        nonReentrant
        returns (bool)
    {
        Feed memory f = _feeds[feedId];
        if (!f.active) revert UnknownFeed(feedId);
        if (isBarred[feedId][verdictId]) revert VerdictBarred(verdictId);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        MochiTypes.Verdict memory v = verdicts.getVerdict(verdictId);
        // slither-disable-next-line uninitialized-local -- zero means eligible; the checks below set it
        bytes32 reason;
        if (v.status != uint8(MochiTypes.VerdictStatus.VERDICT)) reason = "STATUS";
        else if (!v.isPublic) reason = "PRIVATE";
        else if (v.provenanceKind != uint8(MochiTypes.ProvenanceKind.FETCHED)) reason = "PROVENANCE";
        else if (!_origins[feedId][v.originId]) reason = "ORIGIN";
        else if (v.schemaId != f.schemaId) reason = "SCHEMA";
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        else if (escrow.getQuery(v.queryId).payPath != MochiTypes.PayPath.FEED) reason = "NOT_FEED_QUERY";
        if (reason != 0) revert VerdictNotEligible(verdictId, reason);
        if (keccak256(payload) != v.payloadHash) revert PayloadMismatch();
        (bytes32 subject, uint64 asOf,) = abi.decode(payload, (bytes32, uint64, bytes));
        if (subject != key) revert KeyMismatch(key, subject);
        // The lead is measured from when the verdict was recorded, not from when someone pushes it: otherwise a verdict
        // whose asOf was out of bounds when recorded would become applicable later, at a moment of anyone's choosing.
        uint64 limit = v.ts + maxLeadOf[feedId];
        if (asOf > limit) revert AsOfTooFarAhead(asOf, limit);
        Entry storage current = _entries[feedId][key];
        bytes32 replaced = current.verdictId;
        if (asOf < current.asOf) revert StaleAsOf(current.asOf, asOf);
        bool sameAsOf = asOf == current.asOf && replaced != 0;
        if (sameAsOf) {
            // A correction must be newer than what it replaces; anything else is a replay that could roll a correction
            // back to the superseded value.
            if (verdictId == replaced) revert VerdictAlreadyApplied(verdictId);
            if (v.ts < current.verdictTs) revert StaleCorrection(current.verdictTs, v.ts);
        }
        // Recorded in the same second (several blocks can share a timestamp), so neither is newer: the other verdict may
        // replace the current one once, and the one it replaces is barred below. n tied verdicts can therefore change
        // the entry at most n - 1 times, and a replaced one never returns.
        // slither-disable-next-line incorrect-equality -- same-second verdict times, not balances
        bool tie = sameAsOf && v.ts == current.verdictTs;
        if (f.crosscheck != address(0)) {
            // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
            try IFeedCrosscheck(f.crosscheck).check(feedId, key, f.schemaId, payload) returns (
                bool ok, bytes32 failReason
            ) {
                if (!ok) {
                    emit CrosscheckFailed(feedId, key, verdictId, failReason);
                    return false;
                }
            } catch {
                emit CrosscheckFailed(feedId, key, verdictId, "CROSSCHECK_REVERT");
                return false;
            }
        }
        if (tie) {
            isBarred[feedId][replaced] = true;
            emit VerdictSuperseded(feedId, key, replaced);
        }
        _entries[feedId][key] = Entry(verdictId, asOf, uint64(block.timestamp), v.ts, payload);
        emit FeedUpdated(feedId, key, verdictId, asOf);
        return true;
    }

    function latest(bytes32 feedId, bytes32 key) external view override returns (Entry memory) {
        // Subscription expiry is intentionally checked against the current block time.
        // forge-lint: disable-next-line(block-timestamp)
        if (msg.sender.code.length > 0 && subscribedUntil[feedId][msg.sender] < block.timestamp) {
            revert NotSubscribed(msg.sender);
        }
        return _entries[feedId][key];
    }

    function subscribe(bytes32 feedId, address consumer, uint16 months_) external override nonReentrant {
        if (months_ == 0) revert ZeroMonths();
        Feed memory f = _feeds[feedId];
        if (!f.active) revert UnknownFeed(feedId);
        uint256 amount = f.monthlyFee * months_;
        usdg.safeTransferFrom(msg.sender, treasury, amount);
        // The extension starts at now unless the current subscription remains active.
        // forge-lint: disable-next-line(block-timestamp)
        uint64 base = subscribedUntil[feedId][consumer] > block.timestamp
            ? subscribedUntil[feedId][consumer]
            : uint64(block.timestamp);
        uint64 until = base + uint64(months_) * 30 days;
        subscribedUntil[feedId][consumer] = until;
        emit Subscribed(feedId, consumer, until, amount);
    }

    function getFeed(bytes32 feedId) external view override returns (Feed memory) {
        return _feeds[feedId];
    }

    function isOriginAllowed(bytes32 feedId, bytes32 originId) external view override returns (bool) {
        return _origins[feedId][originId];
    }

    function _setMaxLead(bytes32 feedId, uint64 maxLead) private {
        if (maxLead > MAX_LEAD) revert MaxLeadTooLong(maxLead);
        maxLeadOf[feedId] = maxLead;
        emit FeedMaxLeadSet(feedId, maxLead);
    }
}
