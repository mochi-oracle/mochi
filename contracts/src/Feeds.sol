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
    address public treasury;
    mapping(bytes32 => Feed) private _feeds;
    mapping(bytes32 => mapping(bytes32 => bool)) private _origins;
    mapping(bytes32 => mapping(bytes32 => Entry)) private _entries;
    mapping(bytes32 => mapping(address => uint64)) public override subscribedUntil;

    constructor(address admin, IMochiVerdicts verdicts_, IQueryEscrow escrow_, IERC20 usdg_, address treasury_) {
        escrow = escrow_;
        verdicts = verdicts_;
        usdg = usdg_;
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
    }

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

    function setCrosscheck(bytes32 feedId, address crosscheck) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (!_feeds[feedId].active) revert UnknownFeed(feedId);
        _feeds[feedId].crosscheck = crosscheck;
    }

    function update(bytes32 feedId, bytes32 key, bytes32 verdictId, bytes calldata payload)
        external
        override
        nonReentrant
        returns (bool)
    {
        Feed memory f = _feeds[feedId];
        if (!f.active) revert UnknownFeed(feedId);
        MochiTypes.Verdict memory v = verdicts.getVerdict(verdictId);
        bytes32 reason;
        if (v.status != uint8(MochiTypes.VerdictStatus.VERDICT)) reason = "STATUS";
        else if (!v.isPublic) reason = "PRIVATE";
        else if (v.provenanceKind != uint8(MochiTypes.ProvenanceKind.FETCHED)) reason = "PROVENANCE";
        else if (!_origins[feedId][v.originId]) reason = "ORIGIN";
        else if (v.schemaId != f.schemaId) reason = "SCHEMA";
        else if (escrow.getQuery(v.queryId).payPath != MochiTypes.PayPath.FEED) reason = "NOT_FEED_QUERY";
        if (reason != 0) revert VerdictNotEligible(verdictId, reason);
        if (keccak256(payload) != v.payloadHash) revert PayloadMismatch();
        (bytes32 subject, uint64 asOf,) = abi.decode(payload, (bytes32, uint64, bytes));
        if (subject != key) revert KeyMismatch(key, subject);
        Entry storage current = _entries[feedId][key];
        if (asOf < current.asOf) revert StaleAsOf(current.asOf, asOf);
        if (f.crosscheck != address(0)) {
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
        _entries[feedId][key] = Entry(verdictId, asOf, uint64(block.timestamp), payload);
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
}
