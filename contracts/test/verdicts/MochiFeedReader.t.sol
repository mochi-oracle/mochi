// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {Feeds} from "@mochi/Feeds.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MockVerdicts} from "./mocks/MockVerdicts.sol";
import {MockFeedEscrow} from "./mocks/MockFeedEscrow.sol";
import {MochiFeedReader} from "@mochi/consumer/MochiFeedReader.sol";
import {EarningsBeatMarket} from "@mochi/examples/EarningsBeatMarket.sol";

contract ReaderCaller {
    function earnings(IFeeds feeds, bytes32 feed, bytes32 ticker, uint64 age)
        external view returns (MochiTypes.EarningsBody memory, bytes32, uint64)
    { return MochiFeedReader.readEarnings(feeds, feed, ticker, age); }
}

contract MochiFeedReaderTest is Test {
    bytes32 constant ORIGIN = keccak256("sec.gov");
    bytes32 constant FEED = keccak256("earnings@RHC");
    bytes32 constant TICKER = bytes32("NVDA");
    bytes32 constant PERIOD = bytes32("2026Q3");
    MockUSDG usdg;
    MockVerdicts verdicts;
    Feeds feeds;
    ReaderCaller caller;
    EarningsBeatMarket market;

    function setUp() public {
        usdg = new MockUSDG();
        verdicts = new MockVerdicts();
        MockFeedEscrow escrow = new MockFeedEscrow();
        feeds = new Feeds(address(this), IMochiVerdicts(address(verdicts)), IQueryEscrow(address(escrow)), usdg, address(this));
        bytes32[] memory origins = new bytes32[](1); origins[0] = ORIGIN;
        feeds.register(FEED, 3, origins, address(0), 10);
        caller = new ReaderCaller();
        market = new EarningsBeatMarket(feeds, 1 days);
        usdg.mint(address(this), 100);
        usdg.approve(address(feeds), 100);
    }

    function _update(bytes32 bodyTicker, bytes32 period, int8 beat, uint64 updated)
        private returns (bytes32 verdictId)
    {
        MochiTypes.EarningsBody memory body = MochiTypes.EarningsBody(
            bodyTicker, period, updated, 100, 200, 300, bytes32("USD"), beat, 0
        );
        bytes memory payload = abi.encode(TICKER, updated, abi.encode(body));
        verdictId = keccak256(abi.encode(updated, beat));
        MochiTypes.Verdict memory v;
        v.status = uint8(MochiTypes.VerdictStatus.VERDICT);
        v.isPublic = true;
        v.provenanceKind = uint8(MochiTypes.ProvenanceKind.FETCHED);
        v.originId = ORIGIN;
        v.schemaId = 3;
        v.queryId = keccak256(abi.encode("feed-query", verdictId));
        v.payloadHash = keccak256(payload);
        verdicts.setVerdict(verdictId, v);
        feeds.update(FEED, TICKER, verdictId, payload);
    }

    function testSubscribedReaderAndMarketResolveTypedEarnings() public {
        bytes32 id = _update(TICKER, PERIOD, 1, uint64(block.timestamp));
        feeds.subscribe(FEED, address(caller), 1);
        feeds.subscribe(FEED, address(market), 1);
        (MochiTypes.EarningsBody memory body, bytes32 actualId,) = caller.earnings(feeds, FEED, TICKER, 1 days);
        assertEq(body.beatEps, 1);
        assertEq(actualId, id);
        assertTrue(market.resolve(TICKER, PERIOD));
        assertTrue(market.yes(TICKER, PERIOD));
    }

    function testUnsubscribedConsumerReverts() public {
        _update(TICKER, PERIOD, -1, uint64(block.timestamp));
        vm.expectPartialRevert(IFeeds.NotSubscribed.selector);
        caller.earnings(feeds, FEED, TICKER, 1 days);
        feeds.subscribe(FEED, address(caller), 1);
        vm.expectRevert(MochiFeedReader.NoEntry.selector);
        caller.earnings(feeds, FEED, bytes32("EMPTY"), 1 days);
    }

    function testStaleAndWrongTypedSubjectRevert() public {
        uint64 timestamp = uint64(block.timestamp);
        _update(TICKER, PERIOD, 0, timestamp);
        feeds.subscribe(FEED, address(caller), 1);
        vm.warp(uint256(timestamp) + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.StaleEntry.selector, timestamp));
        caller.earnings(feeds, FEED, TICKER, 1 days);
        _update(bytes32("OTHER"), PERIOD, 0, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.WrongSubject.selector, TICKER, bytes32("OTHER")));
        caller.earnings(feeds, FEED, TICKER, 1 days);
    }
}
