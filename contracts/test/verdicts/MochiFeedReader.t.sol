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

    function split(IFeeds feeds, bytes32 feed, bytes32 ticker, uint64 age)
        external view returns (MochiTypes.SplitBody memory, bytes32, uint64)
    { return MochiFeedReader.readSplit(feeds, feed, ticker, age); }

    function nav(IFeeds feeds, bytes32 feed, bytes32 fund, uint64 age)
        external view returns (MochiTypes.NavBody memory, bytes32, uint64)
    { return MochiFeedReader.readNav(feeds, feed, fund, age); }
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
        v.ts = uint64(block.timestamp);
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
        _update(bytes32("OTHER"), PERIOD, 0, timestamp + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.WrongSubject.selector, TICKER, bytes32("OTHER")));
        caller.earnings(feeds, FEED, TICKER, 1 days);
    }

    function _push(bytes32 feed, uint32 schemaId, bytes32 id, bytes memory payload) private {
        MochiTypes.Verdict memory v;
        v.status = uint8(MochiTypes.VerdictStatus.VERDICT);
        v.isPublic = true;
        v.provenanceKind = uint8(MochiTypes.ProvenanceKind.FETCHED);
        v.originId = ORIGIN;
        v.schemaId = schemaId;
        v.queryId = keccak256(abi.encode("feed-query", id));
        v.payloadHash = keccak256(payload);
        v.ts = uint64(block.timestamp);
        verdicts.setVerdict(id, v);
        assertTrue(feeds.update(feed, TICKER, id, payload));
    }

    /// A future-dated fact (split effective next month) ages from its verdict; a past-dated observation (NAV as of
    /// two days ago, verified now) ages from its asOf.
    function testAgeIsMeasuredFromTheOlderOfAsOfAndVerdictTime() public {
        uint64 t0 = 1_800_000_000;
        vm.warp(t0);
        bytes32[] memory origins = new bytes32[](1);
        origins[0] = ORIGIN;
        bytes32 splitFeed = keccak256("corp-actions.split@RHC");
        bytes32 navFeed = keccak256("nav@RHC");
        feeds.register(splitFeed, 2, origins, address(0), 10);
        feeds.register(navFeed, 5, origins, address(0), 10);
        usdg.mint(address(this), 20);
        usdg.approve(address(feeds), 20);
        feeds.subscribe(splitFeed, address(caller), 1);
        feeds.subscribe(navFeed, address(caller), 1);

        uint64 effective = t0 + 30 days;
        MochiTypes.SplitBody memory sb = MochiTypes.SplitBody(TICKER, effective, 2, 1);
        _push(splitFeed, 2, keccak256("split"), abi.encode(TICKER, effective, abi.encode(sb)));
        (, , uint64 observedAt) = caller.split(feeds, splitFeed, TICKER, 1 days);
        assertEq(observedAt, t0);
        vm.warp(t0 + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.StaleEntry.selector, t0));
        caller.split(feeds, splitFeed, TICKER, 1 days);

        uint64 asOf = t0 - 1 days; // as of the start of an earlier day
        MochiTypes.NavBody memory nb = MochiTypes.NavBody(TICKER, asOf, 100e8, 0, 0, 0);
        _push(navFeed, 5, keccak256("nav"), abi.encode(TICKER, asOf, abi.encode(nb)));
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.StaleEntry.selector, asOf));
        caller.nav(feeds, navFeed, TICKER, 2 days);
        (, , observedAt) = caller.nav(feeds, navFeed, TICKER, 3 days);
        assertEq(observedAt, asOf);
    }
}
