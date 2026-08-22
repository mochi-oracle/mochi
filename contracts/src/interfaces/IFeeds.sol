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
        uint64 updatedAt;
        bytes payload; // abi.encode(bytes32 subjectKey, uint64 asOf, bytes body)
    }

    event FeedRegistered(bytes32 indexed feedId, uint32 schemaId, address crosscheck, uint256 monthlyFee);
    event FeedOriginSet(bytes32 indexed feedId, bytes32 indexed originId, bool allowed);
    event FeedUpdated(bytes32 indexed feedId, bytes32 indexed key, bytes32 indexed verdictId, uint64 asOf);
    event CrosscheckFailed(bytes32 indexed feedId, bytes32 indexed key, bytes32 indexed verdictId, bytes32 reason);
    event Subscribed(bytes32 indexed feedId, address indexed consumer, uint64 until, uint256 paid);

    error UnknownFeed(bytes32 feedId);
    error FeedExists(bytes32 feedId);
    error VerdictNotEligible(bytes32 verdictId, bytes32 reason);
    error PayloadMismatch();
    error KeyMismatch(bytes32 expected, bytes32 got);
    error StaleAsOf(uint64 current, uint64 got);
    error NotSubscribed(address consumer);
    error ZeroMonths();

    /// @notice GOVERNOR.
    function register(bytes32 feedId, uint32 schemaId, bytes32[] calldata origins, address crosscheck, uint256 monthlyFee)
        external;

    /// @notice GOVERNOR.
    function setOrigin(bytes32 feedId, bytes32 originId, bool allowed) external;

    /// @notice GOVERNOR.
    function setCrosscheck(bytes32 feedId, address crosscheck) external;

    /// @notice Anyone. Reverts VerdictNotEligible unless: verdict.status == VERDICT, isPublic, provenanceKind == FETCHED,
    ///         origin allowed for the feed, verdict.schemaId == feed.schemaId, and the verdict's query was opened on the
    ///         FEED pay path (reason "NOT_FEED_QUERY" otherwise — requester-chosen params must never reach a feed). Reverts PayloadMismatch unless
    ///         keccak256(payload) == verdict.payloadHash; KeyMismatch unless the payload's first word == key;
    ///         StaleAsOf if payload asOf < current entry's asOf (equal asOf with a different verdict is allowed
    ///         — a correction). Then, if a crosscheck is set and returns ok == false: emit CrosscheckFailed and return
    ///         false WITHOUT reverting and without changing the entry. Otherwise store and return true.
    function update(bytes32 feedId, bytes32 key, bytes32 verdictId, bytes calldata payload) external returns (bool updated);

    /// @notice Free for EOAs / eth_call (msg.sender has no code); contract callers need subscribedUntil >= now.
    function latest(bytes32 feedId, bytes32 key) external view returns (Entry memory);

    /// @notice Pays monthlyFee * months USDG from msg.sender to the treasury; extends from max(now, current until)
    ///         by months * 30 days.
    function subscribe(bytes32 feedId, address consumer, uint16 months) external;

    function subscribedUntil(bytes32 feedId, address consumer) external view returns (uint64);
    function getFeed(bytes32 feedId) external view returns (Feed memory);
    function isOriginAllowed(bytes32 feedId, bytes32 originId) external view returns (bool);
}
