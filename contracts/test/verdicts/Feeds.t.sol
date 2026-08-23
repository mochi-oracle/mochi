// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {Feeds} from "@mochi/Feeds.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MockVerdicts} from "./mocks/MockVerdicts.sol";
import {MockFeedEscrow} from "./mocks/MockFeedEscrow.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MockCrosscheck} from "./mocks/MockCrosscheck.sol";
import {FeedConsumer} from "./mocks/FeedConsumer.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

contract FeedsTest is Test {
    address admin = address(0xA11CE);
    address treasury = address(0xBEEF);
    bytes32 feed = keccak256("feed");
    bytes32 key = keccak256("key");
    bytes32 origin = keccak256("origin");
    Feeds feeds;
    MockUSDG usdg;
    MockVerdicts verdicts;
    MockCrosscheck crosscheck;
    MockFeedEscrow escrow;
    bytes32[] origins;

    function setUp() public {
        usdg = new MockUSDG();
        verdicts = new MockVerdicts();
        crosscheck = new MockCrosscheck();
        escrow = new MockFeedEscrow();
        feeds = new Feeds(admin, IMochiVerdicts(address(verdicts)), IQueryEscrow(address(escrow)), usdg, treasury);
        origins = new bytes32[](1);
        origins[0] = origin;
        vm.prank(admin);
        feeds.register(feed, 2, origins, address(0), 100);
    }

    function _latest(bytes32 feedId, bytes32 subject) internal returns (IFeeds.Entry memory e) {
        vm.prank(address(0x999), address(0x999));
        return feeds.latest(feedId, subject);
    }

    function _verdict(uint8 status, bool pub, uint8 provenance, bytes32 org, uint32 schema, bytes memory payload)
        internal
        pure
        returns (MochiTypes.Verdict memory v)
    {
        v.status = status;
        v.isPublic = pub;
        v.provenanceKind = provenance;
        v.originId = org;
        v.schemaId = schema;
        v.payloadHash = keccak256(payload);
    }

    function _payload(bytes32 subject, uint64 asOf) internal pure returns (bytes memory) {
        return abi.encode(subject, asOf, bytes("body"));
    }

    function _store(bytes32 id, MochiTypes.Verdict memory v) internal {
        verdicts.setVerdict(id, v);
    }

    function _tryUpdate(bytes32 id, bytes memory payload, bytes4 selector) internal {
        (bool ok, bytes memory ret) = address(feeds).call(abi.encodeCall(IFeeds.update, (feed, key, id, payload)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(ret), selector);
    }

    function testEligibilityReasons() public {
        bytes memory p = _payload(key, 100);
        MochiTypes.Verdict memory v = _verdict(0, true, 1, origin, 2, p);
        _store(bytes32(uint256(1)), v);
        _tryUpdate(bytes32(uint256(1)), p, IFeeds.VerdictNotEligible.selector);
        v = _verdict(1, false, 1, origin, 2, p);
        _store(bytes32(uint256(2)), v);
        _tryUpdate(bytes32(uint256(2)), p, IFeeds.VerdictNotEligible.selector);
        v = _verdict(1, true, 0, origin, 2, p);
        _store(bytes32(uint256(3)), v);
        _tryUpdate(bytes32(uint256(3)), p, IFeeds.VerdictNotEligible.selector);
        v = _verdict(1, true, 1, keccak256("blocked"), 2, p);
        _store(bytes32(uint256(4)), v);
        _tryUpdate(bytes32(uint256(4)), p, IFeeds.VerdictNotEligible.selector);
        v = _verdict(1, true, 1, origin, 1, p);
        _store(bytes32(uint256(5)), v);
        _tryUpdate(bytes32(uint256(5)), p, IFeeds.VerdictNotEligible.selector);
    }

    function testPayloadKeyAndAsOfAndEqualCorrection() public {
        bytes memory p = _payload(key, 100);
        MochiTypes.Verdict memory v = _verdict(1, true, 1, origin, 2, p);
        _store(bytes32(uint256(10)), v);
        _tryUpdate(bytes32(uint256(10)), bytes("bad"), IFeeds.PayloadMismatch.selector);
        bytes memory wrong = _payload(keccak256("wrong"), 100);
        v = _verdict(1, true, 1, origin, 2, wrong);
        _store(bytes32(uint256(11)), v);
        _tryUpdate(bytes32(uint256(11)), wrong, IFeeds.KeyMismatch.selector);
        assertTrue(feeds.update(feed, key, bytes32(uint256(10)), p));
        bytes memory old = _payload(key, 99);
        v = _verdict(1, true, 1, origin, 2, old);
        _store(bytes32(uint256(12)), v);
        _tryUpdate(bytes32(uint256(12)), old, IFeeds.StaleAsOf.selector);
        v = _verdict(1, true, 1, origin, 2, p);
        _store(bytes32(uint256(13)), v);
        assertTrue(feeds.update(feed, key, bytes32(uint256(13)), p));
        assertEq(_latest(feed, key).verdictId, bytes32(uint256(13)));
    }

    function testCrosscheckFailRevertSuccessAndPreservesEntry() public {
        vm.prank(admin);
        feeds.setCrosscheck(feed, address(crosscheck));
        bytes memory p = _payload(key, 200);
        MochiTypes.Verdict memory v = _verdict(1, true, 1, origin, 2, p);
        _store(bytes32(uint256(20)), v);
        bytes memory p0 = _payload(key, 100);
        v = _verdict(1, true, 1, origin, 2, p0);
        _store(bytes32(uint256(19)), v);
        assertTrue(feeds.update(feed, key, bytes32(uint256(19)), p0));
        crosscheck.set(false, false, "NO_MATCH");
        vm.expectEmit(true, true, true, true, address(feeds));
        emit IFeeds.CrosscheckFailed(feed, key, bytes32(uint256(20)), "NO_MATCH");
        assertFalse(feeds.update(feed, key, bytes32(uint256(20)), p));
        assertEq(_latest(feed, key).verdictId, bytes32(uint256(19)));
        crosscheck.set(true, true, 0);
        vm.expectEmit(true, true, true, true, address(feeds));
        emit IFeeds.CrosscheckFailed(feed, key, bytes32(uint256(20)), "CROSSCHECK_REVERT");
        assertFalse(feeds.update(feed, key, bytes32(uint256(20)), p));
        assertEq(_latest(feed, key).verdictId, bytes32(uint256(19)));
        crosscheck.set(true, false, 0);
        assertTrue(feeds.update(feed, key, bytes32(uint256(20)), p));
        assertEq(_latest(feed, key).verdictId, bytes32(uint256(20)));
    }

    function testLatestSubscriptionAndSubscribeTransferExpiry() public {
        bytes memory p = _payload(key, 1);
        MochiTypes.Verdict memory v = _verdict(1, true, 1, origin, 2, p);
        _store(bytes32(uint256(30)), v);
        assertTrue(feeds.update(feed, key, bytes32(uint256(30)), p));
        FeedConsumer consumer = new FeedConsumer();
        vm.expectPartialRevert(IFeeds.NotSubscribed.selector);
        consumer.latest(feeds, feed, key);
        usdg.mint(address(this), 1000);
        usdg.approve(address(feeds), 1000);
        feeds.subscribe(feed, address(consumer), 1);
        assertEq(usdg.balanceOf(treasury), 100);
        assertEq(feeds.subscribedUntil(feed, address(consumer)), uint64(block.timestamp + 30 days));
        assertEq(consumer.latest(feeds, feed, key).verdictId, bytes32(uint256(30)));
        vm.warp(block.timestamp + 30 days + 1);
        vm.expectPartialRevert(IFeeds.NotSubscribed.selector);
        consumer.latest(feeds, feed, key);
        assertEq(_latest(feed, key).verdictId, bytes32(uint256(30)));
    }

    function testGovernanceAndZeroMonths() public {
        vm.prank(address(1));
        vm.expectRevert();
        feeds.register(bytes32(uint256(2)), 2, origins, address(0), 0);
        vm.prank(admin);
        vm.expectPartialRevert(IFeeds.FeedExists.selector);
        feeds.register(feed, 2, origins, address(0), 1);
        vm.prank(admin);
        feeds.setOrigin(feed, origin, false);
        assertFalse(feeds.isOriginAllowed(feed, origin));
        vm.prank(admin);
        feeds.setCrosscheck(feed, address(crosscheck));
        assertEq(feeds.getFeed(feed).crosscheck, address(crosscheck));
        vm.expectRevert(IFeeds.ZeroMonths.selector);
        feeds.subscribe(feed, address(this), 0);
        vm.expectPartialRevert(IFeeds.UnknownFeed.selector);
        feeds.subscribe(bytes32(uint256(88)), address(this), 1);
        vm.prank(admin);
        feeds.setTreasury(address(0xCAFE));
        assertEq(feeds.treasury(), address(0xCAFE));
    }

    function testRejectsVerdictFromNonFeedQuery() public {
        bytes memory payload = _payload(key, 100);
        MochiTypes.Verdict memory v = _verdict(1, true, 1, origin, 2, payload);
        v.queryId = keccak256("attacker-query");
        escrow.setNonFeed(v.queryId, true);
        bytes32 id = keccak256("attacker-verdict");
        _store(id, v);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictNotEligible.selector, id, bytes32("NOT_FEED_QUERY")));
        feeds.update(feed, key, id, payload);
    }
}
