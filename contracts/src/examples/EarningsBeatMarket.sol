// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiFeedReader} from "@mochi/consumer/MochiFeedReader.sol";

/// @title EarningsBeatMarket
/// @notice Minimal binary market resolved from a subscribed `earnings@RHC` feed entry.
/// @dev This contract must hold an active Feeds subscription for `earnings@RHC` before calling resolve.
contract EarningsBeatMarket {
    bytes32 public constant EARNINGS_FEED = keccak256("earnings@RHC");
    IFeeds public immutable feeds;
    uint64 public immutable maxAge;
    mapping(bytes32 => mapping(bytes32 => bool)) public resolved;
    mapping(bytes32 => mapping(bytes32 => bool)) public yes;

    error WrongPeriod(bytes32 expected, bytes32 got);
    error NotResolvable(int8 beatEps);
    error AlreadyResolved(bytes32 ticker, bytes32 period);

    constructor(IFeeds feeds_, uint64 maxAge_) { feeds = feeds_; maxAge = maxAge_; }

    /// @notice Resolves YES for beatEps=1; NO for -1 or 0. Feed subscription is checked by Feeds.latest.
    function resolve(bytes32 ticker, bytes32 period) external returns (bool outcome) {
        if (resolved[ticker][period]) revert AlreadyResolved(ticker, period);
        (MochiTypes.EarningsBody memory body,,) = MochiFeedReader.readEarnings(feeds, EARNINGS_FEED, ticker, maxAge);
        if (body.period != period) revert WrongPeriod(period, body.period);
        if (body.beatEps == 2) revert NotResolvable(body.beatEps);
        outcome = body.beatEps == 1;
        if (body.beatEps != 1 && body.beatEps != 0 && body.beatEps != -1) revert NotResolvable(body.beatEps);
        resolved[ticker][period] = true;
        yes[ticker][period] = outcome;
    }
}
