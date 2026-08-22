// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// @notice Returns a Query whose payPath is FEED unless marked otherwise.
contract MockFeedEscrow {
    mapping(bytes32 => bool) public nonFeed;

    function setNonFeed(bytes32 queryId, bool value) external {
        nonFeed[queryId] = value;
    }

    function getQuery(bytes32 queryId) external view returns (MochiTypes.Query memory q) {
        q.payPath = nonFeed[queryId] ? MochiTypes.PayPath.USDG : MochiTypes.PayPath.FEED;
    }
}
