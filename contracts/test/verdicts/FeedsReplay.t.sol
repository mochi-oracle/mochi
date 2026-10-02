// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Feeds} from "@mochi/Feeds.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiFeedReader} from "@mochi/consumer/MochiFeedReader.sol";
import {MockVerdicts} from "./mocks/MockVerdicts.sol";
import {MockFeedEscrow} from "./mocks/MockFeedEscrow.sol";

contract EarningsReader {
    function earnings(IFeeds feeds, bytes32 feed, bytes32 ticker, uint64 age)
        external view returns (MochiTypes.EarningsBody memory, bytes32, uint64)
    { return MochiFeedReader.readEarnings(feeds, feed, ticker, age); }
}

/// Audit B-M2 (feed replay) and contract Low 1 (far-future asOf freezes a key) PoCs.
contract FeedsReplayTest is Test {
    bytes32 constant ORIGIN = keccak256("sec.gov");
    bytes32 constant EARNINGS = keccak256("earnings@RHC");
    bytes32 constant NAV = keccak256("nav@RHC");
    bytes32 constant SPLITS = keccak256("corp-actions.split@RHC");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 constant TICKER = bytes32("NVDA");
    uint64 constant T0 = 1_800_000_000;
    MockUSDG usdg;
    MockVerdicts verdicts;
    Feeds feeds;
    EarningsReader reader;

    function setUp() public {
        vm.warp(T0);
        usdg = new MockUSDG();
        verdicts = new MockVerdicts();
        feeds = new Feeds(address(this), IMochiVerdicts(address(verdicts)), IQueryEscrow(address(new MockFeedEscrow())), usdg, address(this));
        bytes32[] memory origins = new bytes32[](1);
        origins[0] = ORIGIN;
        feeds.register(EARNINGS, uint32(MochiTypes.SchemaId.EARNINGS), origins, address(0), 10);
        feeds.register(NAV, uint32(MochiTypes.SchemaId.NAV), origins, address(0), 10);
        feeds.register(SPLITS, uint32(MochiTypes.SchemaId.SPLIT), origins, address(0), 10);
        reader = new EarningsReader();
        usdg.mint(address(this), 100);
        usdg.approve(address(feeds), 100);
        feeds.subscribe(EARNINGS, address(reader), 1);
    }

    function _earnings(int256 eps, uint64 asOf) private pure returns (bytes memory) {
        bytes32 period = "2026Q3";
        bytes32 currency = "USD";
        MochiTypes.EarningsBody memory body = MochiTypes.EarningsBody(TICKER, period, asOf, eps, 0, 0, currency, 1, 0);
        return abi.encode(TICKER, asOf, abi.encode(body));
    }

    /// Stores a verdict as MochiVerdicts would at the current block time.
    function _verdict(bytes32 id, uint32 schemaId, bytes memory payload) private {
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
    }

    /// A correction (same asOf, newer verdict) must not be rolled back by re-posting the superseded verdict.
    function testReplayOfSupersededVerdictCannotRollBackCorrection() public {
        bytes memory wrong = _earnings(100, T0);
        _verdict("wrong", 3, wrong);
        assertTrue(feeds.update(EARNINGS, TICKER, "wrong", wrong));
        vm.warp(T0 + 1 hours);
        bytes memory fixed_ = _earnings(150, T0);
        _verdict("fixed", 3, fixed_);
        assertTrue(feeds.update(EARNINGS, TICKER, "fixed", fixed_));

        vm.expectRevert(abi.encodeWithSelector(IFeeds.StaleCorrection.selector, T0 + 1 hours, T0));
        feeds.update(EARNINGS, TICKER, "wrong", wrong);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictAlreadyApplied.selector, bytes32("fixed")));
        feeds.update(EARNINGS, TICKER, "fixed", fixed_);
        (MochiTypes.EarningsBody memory body, bytes32 id,) = reader.earnings(feeds, EARNINGS, TICKER, 1 days);
        bytes32 fixedId = "fixed";
        assertEq(id, fixedId);
        assertEq(body.epsGaapDilutedE8, 150);
    }

    /// Re-posting the current verdict must not refresh its age: 3-day-old data must fail a 1-day maxAge.
    function testReplayCannotRefreshFreshness() public {
        bytes memory p = _earnings(100, T0);
        _verdict("v", 3, p);
        assertTrue(feeds.update(EARNINGS, TICKER, "v", p));
        vm.warp(T0 + 3 days);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictAlreadyApplied.selector, bytes32("v")));
        feeds.update(EARNINGS, TICKER, "v", p);
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.StaleEntry.selector, T0));
        reader.earnings(feeds, EARNINGS, TICKER, 1 days);
    }

    /// A verdict posted on-chain 3 days ago and pushed to the feed only now is still 3-day-old data.
    function testLateFirstPushOfOldVerdictIsStale() public {
        bytes memory p = _earnings(100, T0);
        _verdict("v", 3, p);
        vm.warp(T0 + 3 days);
        assertTrue(feeds.update(EARNINGS, TICKER, "v", p));
        vm.expectRevert(abi.encodeWithSelector(MochiFeedReader.StaleEntry.selector, T0));
        reader.earnings(feeds, EARNINGS, TICKER, 1 days);
    }

    /// Low 1: an asOf decades ahead used to be stored and then reject every genuine later update with StaleAsOf.
    function testFarFutureAsOfCannotFreezeAKey() public {
        uint64 future = T0 + 100 * 365 days;
        bytes memory bad = abi.encode(TICKER, future, bytes("body"));
        _verdict("nav-bad", 5, bad);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.AsOfTooFarAhead.selector, future, T0 + feeds.OBSERVATION_LEAD()));
        feeds.update(NAV, TICKER, "nav-bad", bad);
        bytes memory splitBad = abi.encode(TICKER, future, bytes("body"));
        _verdict("split-bad", 2, splitBad);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.AsOfTooFarAhead.selector, future, T0 + feeds.SCHEDULE_LEAD()));
        feeds.update(SPLITS, TICKER, "split-bad", splitBad);

        bytes memory good = abi.encode(TICKER, T0, bytes("body"));
        _verdict("nav-good", 5, good);
        assertTrue(feeds.update(NAV, TICKER, "nav-good", good));
        vm.prank(address(0x999), address(0x999));
        bytes32 goodId = "nav-good";
        assertEq(feeds.latest(NAV, TICKER).verdictId, goodId);
    }
}
