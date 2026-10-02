// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Feeds} from "@mochi/Feeds.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {StockTokenCrosscheck} from "@mochi/StockTokenCrosscheck.sol";
import {MockStockToken} from "@mochi/mocks/MockStockToken.sol";
import {MockVerdicts} from "../verdicts/mocks/MockVerdicts.sol";
import {MockFeedEscrow} from "../verdicts/mocks/MockFeedEscrow.sol";
import {MockCrosscheck} from "../verdicts/mocks/MockCrosscheck.sol";

/// Review regressions for Feeds: the asOf lead counts from the verdict's own time, same-second verdicts, the
/// governor's clearEntry, and panel (PANEL_ROUND) verdicts.
contract FeedsProbeTest is Test {
    bytes32 constant ORIGIN = keccak256("sec.gov");
    bytes32 constant SPLITS = keccak256("corp-actions.split@RHC");
    bytes32 constant NAV = keccak256("nav@RHC");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 constant TICKER = "NVDA";
    uint64 constant T0 = 1_800_000_000;
    MockVerdicts verdicts;
    Feeds feeds;

    function setUp() public {
        vm.warp(T0);
        verdicts = new MockVerdicts();
        feeds = new Feeds(address(this), IMochiVerdicts(address(verdicts)), IQueryEscrow(address(new MockFeedEscrow())), new MockUSDG(), address(this));
        bytes32[] memory origins = new bytes32[](1);
        origins[0] = ORIGIN;
        feeds.register(SPLITS, uint32(MochiTypes.SchemaId.SPLIT), origins, address(0), 10);
        feeds.register(NAV, uint32(MochiTypes.SchemaId.NAV), origins, address(0), 10);
    }

    function _split(uint64 effective, uint32 num) private pure returns (bytes memory) {
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(TICKER, effective, num, 1);
        return abi.encode(TICKER, effective, abi.encode(b));
    }

    /// Stores a verdict as MochiVerdicts.post would at the current block time.
    function _verdict(bytes32 id, uint32 schemaId, bytes memory payload) private {
        verdicts.setVerdict(id, _record(id, schemaId, payload));
    }

    /// Stores a verdict as MochiVerdicts.postPanelOutcome would at the current block time: round PANEL_ROUND,
    /// escalated, no jury agreement/evidence fields.
    function _panelVerdict(bytes32 id, uint32 schemaId, bytes memory payload) private {
        MochiTypes.Verdict memory v = _record(id, schemaId, payload);
        v.round = MochiTypes.PANEL_ROUND;
        v.escalated = true;
        v.agreementBps = 0;
        verdicts.setVerdict(id, v);
    }

    function _record(bytes32 id, uint32 schemaId, bytes memory payload) private view returns (MochiTypes.Verdict memory v) {
        v.status = uint8(MochiTypes.VerdictStatus.VERDICT);
        v.isPublic = true;
        v.provenanceKind = uint8(MochiTypes.ProvenanceKind.FETCHED);
        v.originId = ORIGIN;
        v.schemaId = schemaId;
        v.queryId = keccak256(abi.encode("q", id));
        v.round = 1;
        v.agreementBps = 10_000;
        v.payloadHash = keccak256(payload);
        v.ts = uint64(block.timestamp);
    }

    function _current(bytes32 feedId) private returns (IFeeds.Entry memory) {
        vm.prank(address(0x999), address(0x999)); // an EOA reads for free
        return feeds.latest(feedId, TICKER);
    }

    // ───────────────────────── asOf lead ─────────────────────────

    /// Was a time bomb: the lead was measured from the block time of update(), so a verdict whose asOf was out of
    /// bounds when it was recorded (here a mis-dated effective date 300 days out) became applicable 120+ days later,
    /// pushed by anyone at a moment of their choosing, and froze the key until that date. The lead now counts from the
    /// verdict's own ts, so it never becomes applicable, and a genuine later split goes through.
    function testOutOfLeadVerdictNeverBecomesApplicable() public {
        bytes memory bad = _split(T0 + 300 days, 20);
        _verdict("bad", 2, bad);
        bytes memory outOfLead = abi.encodeWithSelector(IFeeds.AsOfTooFarAhead.selector, T0 + 300 days, T0 + 180 days);
        vm.expectRevert(outOfLead);
        feeds.update(SPLITS, TICKER, "bad", bad);
        for (uint256 i; i < 4; ++i) {
            vm.warp(T0 + [uint64(125 days), 180 days, 300 days, 400 days][i]);
            vm.expectRevert(outOfLead);
            feeds.update(SPLITS, TICKER, "bad", bad);
        }
        vm.warp(T0 + 125 days);
        bytes memory good = _split(T0 + 146 days, 2);
        _verdict("good", 2, good);
        assertTrue(feeds.update(SPLITS, TICKER, "good", good));
        assertEq(_current(SPLITS).verdictId, bytes32("good"));
    }

    /// Same for an observation feed (1-day lead): asOf two days past the verdict's time is never admitted.
    function testOutOfLeadObservationVerdictNeverBecomesApplicable() public {
        bytes memory ahead = abi.encode(TICKER, T0 + 2 days, bytes("nav"));
        _verdict("ahead", 5, ahead);
        bytes memory outOfLead = abi.encodeWithSelector(IFeeds.AsOfTooFarAhead.selector, T0 + 2 days, T0 + 1 days);
        vm.expectRevert(outOfLead);
        feeds.update(NAV, TICKER, "ahead", ahead);
        vm.warp(T0 + 2 days);
        vm.expectRevert(outOfLead);
        feeds.update(NAV, TICKER, "ahead", ahead);
    }

    /// Within its lead when recorded, a verdict pushed late still applies (the bound is not "now + lead").
    function testInLeadVerdictPushedLateStillApplies() public {
        bytes memory scheduled = _split(T0 + 170 days, 2);
        _verdict("scheduled", 2, scheduled);
        vm.warp(T0 + 200 days);
        assertTrue(feeds.update(SPLITS, TICKER, "scheduled", scheduled));
        assertEq(_current(SPLITS).asOf, T0 + 170 days);
    }

    /// Raising a feed's lead admits verdicts up to the new lead from their own time, never beyond MAX_LEAD.
    function testRaisedLeadCountsFromTheVerdictTime() public {
        bytes memory far = _split(T0 + 300 days, 2);
        _verdict("far", 2, far);
        vm.warp(T0 + 10 days);
        feeds.setMaxLead(SPLITS, 300 days);
        assertTrue(feeds.update(SPLITS, TICKER, "far", far));
        bytes memory beyond = _split(T0 + 10 days + 367 days, 2);
        _verdict("beyond", 2, beyond);
        feeds.setMaxLead(SPLITS, feeds.MAX_LEAD());
        vm.expectRevert(
            abi.encodeWithSelector(IFeeds.AsOfTooFarAhead.selector, T0 + 10 days + 367 days, T0 + 10 days + 366 days)
        );
        feeds.update(SPLITS, TICKER, "beyond", beyond);
    }

    // ───────────────────────── same-second verdicts ─────────────────────────

    /// Was: first push wins, and the other verdict recorded in the same second could never be applied. Now a tied
    /// verdict replaces the current one once and the replaced one is barred, so n tied verdicts change the entry at
    /// most n - 1 times (no ping-pong) and a strictly newer verdict still corrects as before.
    function testSameSecondVerdictsEachHoldTheEntryAtMostOnce() public {
        bytes memory a = _split(T0 + 10 days, 2);
        bytes memory b = _split(T0 + 10 days, 3);
        bytes memory c = _split(T0 + 10 days, 4);
        _verdict("a", 2, a);
        _verdict("b", 2, b);
        _verdict("c", 2, c);
        assertTrue(feeds.update(SPLITS, TICKER, "b", b));
        vm.expectEmit(true, true, true, true, address(feeds));
        emit IFeeds.VerdictSuperseded(SPLITS, TICKER, "b");
        assertTrue(feeds.update(SPLITS, TICKER, "a", a));
        assertEq(_current(SPLITS).verdictId, bytes32("a"));
        assertTrue(feeds.isBarred(SPLITS, "b"));
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictBarred.selector, bytes32("b")));
        feeds.update(SPLITS, TICKER, "b", b);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictAlreadyApplied.selector, bytes32("a")));
        feeds.update(SPLITS, TICKER, "a", a);
        assertTrue(feeds.update(SPLITS, TICKER, "c", c)); // the third tied verdict, once
        for (uint256 i; i < 2; ++i) {
            bytes32 id = i == 0 ? bytes32("a") : bytes32("b");
            vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictBarred.selector, id));
            feeds.update(SPLITS, TICKER, id, i == 0 ? a : b);
        }
        assertEq(_current(SPLITS).verdictId, bytes32("c"));

        vm.warp(T0 + 1);
        bytes memory d = _split(T0 + 10 days, 5);
        _verdict("d", 2, d);
        assertTrue(feeds.update(SPLITS, TICKER, "d", d)); // newer: a plain correction, nothing barred
        assertFalse(feeds.isBarred(SPLITS, "c"));
        vm.expectRevert(abi.encodeWithSelector(IFeeds.StaleCorrection.selector, T0 + 1, T0));
        feeds.update(SPLITS, TICKER, "c", c);
    }

    /// A tied verdict that fails the crosscheck changes nothing and bars nothing.
    function testSameSecondTieFailingTheCrosscheckBarsNothing() public {
        MockCrosscheck check = new MockCrosscheck();
        feeds.setCrosscheck(SPLITS, address(check));
        bytes memory a = _split(T0 + 10 days, 2);
        bytes memory b = _split(T0 + 10 days, 3);
        _verdict("a", 2, a);
        _verdict("b", 2, b);
        assertTrue(feeds.update(SPLITS, TICKER, "a", a));
        check.set(false, false, "RATIO_MISMATCH");
        assertFalse(feeds.update(SPLITS, TICKER, "b", b));
        assertFalse(feeds.isBarred(SPLITS, "a"));
        assertEq(_current(SPLITS).verdictId, bytes32("a"));
    }

    // ───────────────────────── clearEntry ─────────────────────────

    /// Was: a correction with a lower asOf could never replace a wrong (but in-lead) entry, and nothing could clear it.
    /// The governor's clearEntry removes the entry and bars its verdict, so the correction applies and the removed
    /// verdict cannot be pushed back.
    function testClearEntryLetsALowerAsOfCorrectionApply() public {
        bytes memory wrong = _split(T0 + 170 days, 2); // mis-dated effective date, within the 180-day lead
        _verdict("wrong", 2, wrong);
        assertTrue(feeds.update(SPLITS, TICKER, "wrong", wrong));
        vm.warp(T0 + 1 days);
        bytes memory right = _split(T0 + 20 days, 2);
        _verdict("right", 2, right);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.StaleAsOf.selector, T0 + 170 days, T0 + 20 days));
        feeds.update(SPLITS, TICKER, "right", right);

        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(0xBAD), MochiRoles.GOVERNOR_ROLE)
        );
        feeds.clearEntry(SPLITS, TICKER);
        vm.expectEmit(true, true, true, true, address(feeds));
        emit IFeeds.EntryCleared(SPLITS, TICKER, "wrong");
        feeds.clearEntry(SPLITS, TICKER);
        assertEq(_current(SPLITS).verdictId, bytes32(0));
        assertTrue(feeds.isBarred(SPLITS, "wrong"));
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictBarred.selector, bytes32("wrong")));
        feeds.update(SPLITS, TICKER, "wrong", wrong);
        assertTrue(feeds.update(SPLITS, TICKER, "right", right));
        assertEq(_current(SPLITS).asOf, T0 + 20 days);
        // The bar is per feed: the NAV feed (other schema) is untouched, and clearing an empty key reverts.
        assertFalse(feeds.isBarred(NAV, "wrong"));
        vm.expectRevert(abi.encodeWithSelector(IFeeds.NoEntryToClear.selector, NAV, TICKER));
        feeds.clearEntry(NAV, TICKER);
    }

    // ───────────────────────── panel verdicts ─────────────────────────

    /// A panel outcome (round PANEL_ROUND, escalated, agreementBps 0) is eligible like a jury verdict and follows the
    /// same ordering rules: a later panel verdict corrects an equal asOf, the superseded jury verdict cannot roll it
    /// back, and its lead counts from the panel verdict's own time.
    function testPanelVerdictsFollowTheFeedRules() public {
        bytes memory jury = _split(T0 + 30 days, 2);
        _verdict("jury", 2, jury);
        assertTrue(feeds.update(SPLITS, TICKER, "jury", jury));

        vm.warp(T0 + 3 days); // the panel decided later
        bytes memory panel = _split(T0 + 30 days, 3);
        _panelVerdict("panel", 2, panel);
        assertTrue(feeds.update(SPLITS, TICKER, "panel", panel));
        IFeeds.Entry memory e = _current(SPLITS);
        assertEq(e.verdictId, bytes32("panel"));
        assertEq(e.verdictTs, T0 + 3 days);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.StaleCorrection.selector, T0 + 3 days, T0));
        feeds.update(SPLITS, TICKER, "jury", jury);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictAlreadyApplied.selector, bytes32("panel")));
        feeds.update(SPLITS, TICKER, "panel", panel);

        bytes memory far = _split(T0 + 3 days + 181 days, 2);
        _panelVerdict("panel-far", 2, far);
        vm.warp(T0 + 100 days);
        vm.expectRevert(
            abi.encodeWithSelector(IFeeds.AsOfTooFarAhead.selector, T0 + 3 days + 181 days, T0 + 3 days + 180 days)
        );
        feeds.update(SPLITS, TICKER, "panel-far", far);
    }

    /// A panel verdict and a jury verdict recorded in the same second tie like any two verdicts.
    function testPanelAndJuryVerdictInTheSameSecondTie() public {
        bytes memory jury = _split(T0 + 30 days, 2);
        bytes memory panel = _split(T0 + 30 days, 3);
        _verdict("jury", 2, jury);
        _panelVerdict("panel", 2, panel);
        assertTrue(feeds.update(SPLITS, TICKER, "panel", panel));
        assertTrue(feeds.update(SPLITS, TICKER, "jury", jury));
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictBarred.selector, bytes32("panel")));
        feeds.update(SPLITS, TICKER, "panel", panel);
    }
}

/// StockTokenCrosscheck: several blocks can share a timestamp, so an observation can land in the same second as, but
/// before, the issuer's one-argument updateMultiplier. It used to be discarded (observedAt >= at), so a permissionless
/// observeMultiplier() in that second destroyed the only usable baseline and the SPLIT check failed BASELINE_UNKNOWN
/// for good.
contract CrosscheckSameSecondGriefTest is Test {
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 constant TICKER = "ACME";
    uint64 constant T0 = 1_800_000_000;
    StockTokenCrosscheck crosscheck;
    MockStockToken token;

    function setUp() public {
        vm.warp(T0);
        crosscheck = new StockTokenCrosscheck(address(this));
        token = new MockStockToken();
        crosscheck.setToken(TICKER, address(token)); // good observation: 1.0 at T0
    }

    function _split(uint32 num, uint64 effective) private pure returns (bytes memory) {
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(TICKER, effective, num, 1);
        return abi.encode(TICKER, effective, abi.encode(b));
    }

    function testControlWithoutGriefPasses() public {
        uint64 t = T0 + 30 days;
        vm.warp(t);
        token.updateMultiplier(2e18, t);
        (bool ok,) = crosscheck.check(0, TICKER, 2, _split(2, t));
        assertTrue(ok);
    }

    function testSameSecondObservationBeforeChangeKeepsTheBaseline() public {
        uint64 t = T0 + 30 days;
        vm.warp(t);
        vm.prank(address(0xBAD));
        crosscheck.observeMultiplier(TICKER); // earlier tx/block in the same second as the issuer's change
        token.updateMultiplier(2e18, t); // issuer's one-argument updateMultiplier: effective now
        (bool ok, bytes32 reason) = crosscheck.check(0, TICKER, 2, _split(2, t));
        assertTrue(ok);
        assertEq(reason, bytes32("OK"));
        (ok, reason) = crosscheck.check(0, TICKER, 2, _split(3, t));
        assertFalse(ok);
        assertEq(reason, bytes32("RATIO_MISMATCH"));
        // The keeper's next observation persists it as the recorded baseline.
        vm.warp(t + 60);
        crosscheck.observeMultiplier(TICKER);
        assertEq(crosscheck.baselineOf(TICKER, t), 1e18);
        (ok,) = crosscheck.check(0, TICKER, 2, _split(2, t));
        assertTrue(ok);
    }

    /// An observation in the same second but after the change (effectiveAt() already reads that second) is the new
    /// multiplier and is never used as the baseline.
    function testSameSecondObservationAfterChangeIsNotABaseline() public {
        StockTokenCrosscheck fresh = new StockTokenCrosscheck(address(this));
        MockStockToken late = new MockStockToken();
        uint64 t = T0 + 30 days;
        vm.warp(t);
        late.updateMultiplier(2e18, t);
        fresh.setToken(TICKER, address(late)); // first observation is post-change: {t, t, 2.0}
        (bool ok, bytes32 reason) = fresh.check(0, TICKER, 2, _split(2, t));
        assertFalse(ok);
        assertEq(reason, bytes32("BASELINE_UNKNOWN"));
    }

    /// Same second, but a different change was pending when observed and is replaced by the immediate one: fails closed.
    function testSameSecondObservationWithALaterChangePendingIsNotABaseline() public {
        uint64 t = T0 + 30 days;
        token.updateMultiplier(4e18, t + 10 days); // pending, later than t
        vm.warp(t);
        crosscheck.observeMultiplier(TICKER); // {t, t + 10 days, 1.0}
        token.updateMultiplier(2e18, t); // the issuer replaces it with an immediate change
        (bool ok, bytes32 reason) = crosscheck.check(0, TICKER, 2, _split(2, t));
        assertFalse(ok);
        assertEq(reason, bytes32("BASELINE_UNKNOWN"));
        // Recovery: the governor supplies the pre-change multiplier from the token's UIMultiplierUpdated event.
        crosscheck.setBaseline(TICKER, t, 1e18);
        (ok,) = crosscheck.check(0, TICKER, 2, _split(2, t));
        assertTrue(ok);
    }
}

contract CrosscheckSameSecondFixTest is Test {
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 constant TICKER = "ACME";
    uint64 constant T0 = 1_800_000_000;

    function _split(uint32 num, uint64 effective) private pure returns (bytes memory) {
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(TICKER, effective, num, 1);
        return abi.encode(TICKER, effective, abi.encode(b));
    }

    /// With the fix the pre-change same-second observation is used; a post-change one still is not.
    function testFixUsesSameSecondPreChangeObservationOnly() public {
        vm.warp(T0);
        StockTokenCrosscheck c = new StockTokenCrosscheck(address(this));
        MockStockToken token = new MockStockToken();
        c.setToken(TICKER, address(token));
        uint64 t = T0 + 30 days;
        vm.warp(t);
        c.observeMultiplier(TICKER); // before the change, same second
        token.updateMultiplier(2e18, t);
        (bool ok,) = c.check(0, TICKER, 2, _split(2, t));
        assertTrue(ok);
        (ok,) = c.check(0, TICKER, 2, _split(4, t));
        assertFalse(ok);
        c.observeMultiplier(TICKER); // after the change, same second: records baseline 1.0 then observes 2.0 at t
        assertEq(c.baselineOf(TICKER, t), 1e18);
        // A second immediate change in that same second: the post-change observation (scheduledAt == at) is rejected
        // for it, and the baseline keyed by `t` is already 1.0 (compound) -> 3:1 fails closed.
        token.updateMultiplier(6e18, t);
        (ok,) = c.check(0, TICKER, 2, _split(3, t));
        assertFalse(ok);
    }
}

/// GOVERNOR recovery for a change no observation covers (StockTokenCrosscheck.setBaseline).
contract CrosscheckSetBaselineTest is Test {
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 constant TICKER = "ACME";
    uint64 constant T0 = 1_800_000_000;
    StockTokenCrosscheck crosscheck;
    MockStockToken token;

    function setUp() public {
        vm.warp(T0);
        crosscheck = new StockTokenCrosscheck(address(this));
        token = new MockStockToken();
    }

    function _split(uint32 num, uint64 effective) private pure returns (bytes memory) {
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(TICKER, effective, num, 1);
        return abi.encode(TICKER, effective, abi.encode(b));
    }

    function _check(uint32 num, uint64 effective) private view returns (bool ok, bytes32 reason) {
        return crosscheck.check(0, TICKER, 2, _split(num, effective));
    }

    /// Registered only after the change took effect: BASELINE_UNKNOWN until the governor supplies the pre-change value.
    function testSetBaselineRecoversAnUnobservedChange() public {
        uint64 t = T0 + 1 days;
        vm.warp(t);
        token.updateMultiplier(2e18, t);
        vm.warp(t + 1 hours);
        crosscheck.setToken(TICKER, address(token));
        (bool ok, bytes32 reason) = _check(2, t);
        assertFalse(ok);
        assertEq(reason, bytes32("BASELINE_UNKNOWN"));

        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(0xBAD), MochiRoles.GOVERNOR_ROLE)
        );
        crosscheck.setBaseline(TICKER, t, 1e18);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.NotEffectiveChange.selector, TICKER, uint256(t - 1)));
        crosscheck.setBaseline(TICKER, t - 1, 1e18); // not the token's current change
        vm.expectRevert(StockTokenCrosscheck.ZeroMultiplier.selector);
        crosscheck.setBaseline(TICKER, t, 0);
        vm.expectEmit(true, true, false, true, address(crosscheck));
        emit StockTokenCrosscheck.BaselineSet(TICKER, address(token), t, 1e18);
        crosscheck.setBaseline(TICKER, t, 1e18);
        assertEq(crosscheck.baselineOf(TICKER, t), 1e18);
        (ok,) = _check(2, t);
        assertTrue(ok);
        (ok,) = _check(3, t);
        assertFalse(ok);
        // Write-once: it never replaces a recorded baseline.
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.BaselineKnown.selector, TICKER, uint256(t)));
        crosscheck.setBaseline(TICKER, t, 2e18);
    }

    /// Not while the change is still pending (recordBaseline covers that), nor when the last observation already
    /// gives the baseline, nor for an unregistered ticker.
    function testSetBaselineOnlyWhenNothingElseCan() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 missing = bytes32("MISSING");
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.UnknownTicker.selector, missing));
        crosscheck.setBaseline(missing, T0, 1e18);
        crosscheck.setToken(TICKER, address(token)); // observes 1.0 at T0
        uint64 t = T0 + 1 days;
        token.updateMultiplier(2e18, t);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.NotEffectiveChange.selector, TICKER, uint256(t)));
        crosscheck.setBaseline(TICKER, t, 5e17); // pending
        vm.warp(t);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.BaselineKnown.selector, TICKER, uint256(t)));
        crosscheck.setBaseline(TICKER, t, 5e17); // the T0 observation is the baseline
        assertEq(crosscheck.baselineOf(TICKER, t), 0);
        (bool ok,) = _check(2, t);
        assertTrue(ok);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.NotEffectiveChange.selector, TICKER, uint256(0)));
        crosscheck.setBaseline(TICKER, 0, 1e18);
    }
}
