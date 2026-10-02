// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// @title MochiFeedReader
/// @notice Typed, age-checked readers for Mochi feed payload bodies.
/// @dev Age is measured from observedAt = min(entry.asOf, entry.verdictTs): the fact's own date or the time its
///      verdict was recorded, whichever is older. Neither can be refreshed by re-posting a verdict or by pushing an
///      old verdict late (Entry.updatedAt can, so it is not used). The third return value is observedAt.
library MochiFeedReader {
    error NoEntry();
    error StaleEntry(uint64 observedAt);
    error WrongSubject(bytes32 expected, bytes32 got);

    function readExDividend(IFeeds feeds, bytes32 feedId, bytes32 ticker, uint64 maxAge)
        internal view returns (MochiTypes.ExDividendBody memory body, bytes32 verdictId, uint64 observedAt)
    {
        (bytes32 id, bytes memory raw, uint64 time) = _latest(feeds, feedId, ticker, maxAge);
        (bytes32 subject,, bytes memory encodedBody) = abi.decode(raw, (bytes32, uint64, bytes));
        _subject(ticker, subject);
        body = abi.decode(encodedBody, (MochiTypes.ExDividendBody));
        _subject(ticker, body.ticker);
        return (body, id, time);
    }

    function readSplit(IFeeds feeds, bytes32 feedId, bytes32 ticker, uint64 maxAge)
        internal view returns (MochiTypes.SplitBody memory body, bytes32 verdictId, uint64 observedAt)
    {
        (bytes32 id, bytes memory raw, uint64 time) = _latest(feeds, feedId, ticker, maxAge);
        (bytes32 subject,, bytes memory encodedBody) = abi.decode(raw, (bytes32, uint64, bytes));
        _subject(ticker, subject);
        body = abi.decode(encodedBody, (MochiTypes.SplitBody));
        _subject(ticker, body.ticker);
        return (body, id, time);
    }

    function readEarnings(IFeeds feeds, bytes32 feedId, bytes32 ticker, uint64 maxAge)
        internal view returns (MochiTypes.EarningsBody memory body, bytes32 verdictId, uint64 observedAt)
    {
        (bytes32 id, bytes memory raw, uint64 time) = _latest(feeds, feedId, ticker, maxAge);
        (bytes32 subject,, bytes memory encodedBody) = abi.decode(raw, (bytes32, uint64, bytes));
        _subject(ticker, subject);
        body = abi.decode(encodedBody, (MochiTypes.EarningsBody));
        _subject(ticker, body.ticker);
        return (body, id, time);
    }

    function readReserve(IFeeds feeds, bytes32 feedId, bytes32 assetSymbol, uint64 maxAge)
        internal view returns (MochiTypes.ReserveAttestationBody memory body, bytes32 verdictId, uint64 observedAt)
    {
        (bytes32 id, bytes memory raw, uint64 time) = _latest(feeds, feedId, assetSymbol, maxAge);
        (bytes32 subject,, bytes memory encodedBody) = abi.decode(raw, (bytes32, uint64, bytes));
        _subject(assetSymbol, subject);
        body = abi.decode(encodedBody, (MochiTypes.ReserveAttestationBody));
        _subject(assetSymbol, body.assetSymbol);
        return (body, id, time);
    }

    function readNav(IFeeds feeds, bytes32 feedId, bytes32 fundId, uint64 maxAge)
        internal view returns (MochiTypes.NavBody memory body, bytes32 verdictId, uint64 observedAt)
    {
        (bytes32 id, bytes memory raw, uint64 time) = _latest(feeds, feedId, fundId, maxAge);
        (bytes32 subject,, bytes memory encodedBody) = abi.decode(raw, (bytes32, uint64, bytes));
        _subject(fundId, subject);
        body = abi.decode(encodedBody, (MochiTypes.NavBody));
        _subject(fundId, body.fundId);
        return (body, id, time);
    }

    function _latest(IFeeds feeds, bytes32 feedId, bytes32 key, uint64 maxAge)
        private view returns (bytes32 verdictId, bytes memory payload, uint64 observedAt)
    {
        IFeeds.Entry memory entry = feeds.latest(feedId, key);
        if (entry.verdictId == bytes32(0)) revert NoEntry();
        verdictId = entry.verdictId;
        observedAt = entry.asOf < entry.verdictTs ? entry.asOf : entry.verdictTs;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > uint256(observedAt) + maxAge) revert StaleEntry(observedAt);
        return (verdictId, entry.payload, observedAt);
    }

    function _subject(bytes32 expected, bytes32 got) private pure {
        if (expected != got) revert WrongSubject(expected, got);
    }
}
