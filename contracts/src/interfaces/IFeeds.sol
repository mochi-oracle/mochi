// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title IFeeds
/// @notice Named feeds → latest typed payload per key. Fail-closed: only public, FETCHED, allow-listed-origin VERDICTs
///         whose payload matches the verdict's payloadHash and passes the crosscheck hook update a key.
interface IFeeds {
    struct Feed {
        uint32 schemaId;
        address crosscheck; // IFeedCrosscheck, or address(0) for none
        uint256 monthlyFee; // USDG per 30 days for a consumer contract
        bool active;
    }

    struct Entry {
        bytes32 verdictId;
        uint64 asOf;
        uint64 updatedAt; // block time of the update call; not a freshness signal
        uint64 verdictTs; // MochiVerdicts ts of verdictId: when the verdict was recorded on-chain
        bytes payload; // abi.encode(bytes32 subjectKey, uint64 asOf, bytes body)
    }

    event FeedRegistered(bytes32 indexed feedId, uint32 schemaId, address crosscheck, uint256 monthlyFee);
    event FeedOriginSet(bytes32 indexed feedId, bytes32 indexed originId, bool allowed);
    event FeedUpdated(bytes32 indexed feedId, bytes32 indexed key, bytes32 indexed verdictId, uint64 asOf);
    event CrosscheckFailed(bytes32 indexed feedId, bytes32 indexed key, bytes32 indexed verdictId, bytes32 reason);
    event Subscribed(bytes32 indexed feedId, address indexed consumer, uint64 until, uint256 paid);
    event FeedMaxLeadSet(bytes32 indexed feedId, uint64 maxLead);
    /// @notice clearEntry removed `key`'s entry; `verdictId` is barred from the feed.
    event EntryCleared(bytes32 indexed feedId, bytes32 indexed key, bytes32 indexed verdictId);
    /// @notice A verdict recorded in the same second replaced `verdictId`, which is now barred from the feed.
    event VerdictSuperseded(bytes32 indexed feedId, bytes32 indexed key, bytes32 indexed verdictId);

    error UnknownFeed(bytes32 feedId);
    error FeedExists(bytes32 feedId);
    error VerdictNotEligible(bytes32 verdictId, bytes32 reason);
    error PayloadMismatch();
    error KeyMismatch(bytes32 expected, bytes32 got);
    error StaleAsOf(uint64 current, uint64 got);
    error AsOfTooFarAhead(uint64 asOf, uint64 limit);
    error VerdictAlreadyApplied(bytes32 verdictId);
    error StaleCorrection(uint64 currentVerdictTs, uint64 verdictTs);
    error MaxLeadTooLong(uint64 maxLead);
    error NotSubscribed(address consumer);
    error ZeroMonths();
    error VerdictBarred(bytes32 verdictId);
    error NoEntryToClear(bytes32 feedId, bytes32 key);

    /// @notice GOVERNOR. Also sets the feed's max asOf lead to the schema default (see Feeds.OBSERVATION_LEAD and
    ///         Feeds.SCHEDULE_LEAD).
    function register(bytes32 feedId, uint32 schemaId, bytes32[] calldata origins, address crosscheck, uint256 monthlyFee)
        external;

    /// @notice GOVERNOR. How far past its verdict's on-chain time (verdict.ts) a payload asOf may lie (at most
    ///         Feeds.MAX_LEAD).
    function setMaxLead(bytes32 feedId, uint64 maxLead) external;

    /// @notice GOVERNOR.
    function setOrigin(bytes32 feedId, bytes32 originId, bool allowed) external;

    /// @notice GOVERNOR.
    function setCrosscheck(bytes32 feedId, address crosscheck) external;

    /// @notice Anyone. Reverts VerdictBarred if isBarred(feedId, verdictId); VerdictNotEligible unless: verdict.status
    ///         == VERDICT (a panel outcome, round PANEL_ROUND, counts like any other), isPublic, provenanceKind ==
    ///         FETCHED, origin allowed for the feed, verdict.schemaId == feed.schemaId, and the verdict's query was opened
    ///         on the FEED pay path (reason "NOT_FEED_QUERY" otherwise — requester-chosen params must never reach a feed).
    ///         Reverts PayloadMismatch unless keccak256(payload) == verdict.payloadHash; KeyMismatch unless the payload's
    ///         first word == key; AsOfTooFarAhead if asOf > verdict.ts + maxLeadOf(feedId) (the verdict's own time, so
    ///         an out-of-lead verdict never becomes applicable later); StaleAsOf if asOf < current entry's asOf. An
    ///         equal asOf is a correction and must come from a newer verdict: VerdictAlreadyApplied if it is the
    ///         current verdict, StaleCorrection if verdict.ts < current entry's verdictTs (so a superseded verdict cannot
    ///         be replayed to roll a correction back). Equal verdict.ts (recorded in the same second): the new verdict
    ///         replaces the current one and the replaced verdict is barred (VerdictSuperseded), so each tied verdict can
    ///         hold the entry at most once. Then, if a crosscheck is set and returns ok == false: emit CrosscheckFailed
    ///         and return false WITHOUT reverting and without changing the entry. Otherwise store and return true.
    function update(bytes32 feedId, bytes32 key, bytes32 verdictId, bytes calldata payload) external returns (bool updated);

    /// @notice GOVERNOR. Deletes `key`'s entry and bars its verdict from the feed (EntryCleared), e.g. so a correction
    ///         with a lower asOf can be applied. Reverts NoEntryToClear if the key has no entry.
    function clearEntry(bytes32 feedId, bytes32 key) external;

    /// @notice True once `verdictId` was removed from `feedId` by clearEntry or replaced by a same-second verdict.
    function isBarred(bytes32 feedId, bytes32 verdictId) external view returns (bool);

    /// @notice Free for EOAs / eth_call (msg.sender has no code); contract callers need subscribedUntil >= now.
    function latest(bytes32 feedId, bytes32 key) external view returns (Entry memory);

    /// @notice Pays monthlyFee * months USDG from msg.sender to the treasury; extends from max(now, current until)
    ///         by months * 30 days.
    function subscribe(bytes32 feedId, address consumer, uint16 months) external;

    function subscribedUntil(bytes32 feedId, address consumer) external view returns (uint64);
    function maxLeadOf(bytes32 feedId) external view returns (uint64);
    function getFeed(bytes32 feedId) external view returns (Feed memory);
    function isOriginAllowed(bytes32 feedId, bytes32 originId) external view returns (bool);
}
