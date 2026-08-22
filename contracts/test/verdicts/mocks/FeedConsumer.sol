// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {IFeeds} from "@mochi/interfaces/IFeeds.sol";

contract FeedConsumer {
    function latest(IFeeds feeds, bytes32 feedId, bytes32 key) external view returns (IFeeds.Entry memory) {
        return feeds.latest(feedId, key);
    }
}
