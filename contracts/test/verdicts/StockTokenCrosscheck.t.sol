// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {StockTokenCrosscheck} from "@mochi/StockTokenCrosscheck.sol";
import {MockStockToken} from "@mochi/mocks/MockStockToken.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IStockTokenMultiplier} from "@mochi/interfaces/IStockTokenMultiplier.sol";

contract RevertingStockToken {
    function newUIMultiplier() external pure returns (uint256) {
        revert();
    }

    function uiMultiplier() external pure returns (uint256) {
        revert();
    }

    function effectiveAt() external pure returns (uint256) {
        revert();
    }
}

contract StockTokenCrosscheckTest is Test {
    StockTokenCrosscheck crosscheck;
    MockStockToken token;
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 ticker = bytes32("ACME");
    uint64 constant AT = 1_800_000_000;

    function setUp() public {
        crosscheck = new StockTokenCrosscheck(address(this));
        token = new MockStockToken();
        crosscheck.setToken(ticker, address(token));
    }

    function _payload(bytes memory body) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encode(bytes32("ACME"), uint64(AT), body);
    }

    function testSplitOkRatioMismatchDateAndNoPending() public {
        token.setSchedule(1e18, 2e18, AT);
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(ticker, AT, 2, 1);
        (bool ok, bytes32 reason) = crosscheck.check(0, ticker, 2, _payload(abi.encode(b)));
        assertTrue(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("OK"));
        b.ratioNum = 3;
        (ok, reason) = crosscheck.check(0, ticker, 2, _payload(abi.encode(b)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("RATIO_MISMATCH"));
        b.ratioNum = 2;
        b.effectiveDate = AT + 2 days;
        (ok, reason) = crosscheck.check(0, ticker, 2, _payload(abi.encode(b)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("EFFECTIVE_AT_MISMATCH"));
        token.setSchedule(1e18, 0, 0);
        (ok, reason) = crosscheck.check(0, ticker, 2, _payload(abi.encode(b)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("NO_PENDING_CHANGE"));
    }

    function testExDividendEffectAndNoEffect() public {
        MochiTypes.ExDividendBody memory b;
        b.ticker = ticker;
        b.exDate = AT;
        b.multiplierEffectExpected = false;
        (bool ok, bytes32 reason) = crosscheck.check(0, ticker, 1, _payload(abi.encode(b)));
        assertTrue(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("NO_EFFECT_EXPECTED"));
        b.multiplierEffectExpected = true;
        token.setSchedule(1e18, 9e17, AT + 1 days);
        (ok, reason) = crosscheck.check(0, ticker, 1, _payload(abi.encode(b)));
        assertTrue(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("OK"));
        token.setSchedule(1e18, 9e17, 0);
        (ok, reason) = crosscheck.check(0, ticker, 1, _payload(abi.encode(b)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("NO_PENDING_CHANGE"));
        token.setSchedule(1e18, 9e17, AT + 2 days);
        (ok, reason) = crosscheck.check(0, ticker, 1, _payload(abi.encode(b)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("EFFECTIVE_AT_MISMATCH"));
    }

    function testUnknownTickerAndNonApplicableSchema() public view {
        // forge-lint: disable-next-line(unsafe-typecast)
        (bool ok, bytes32 reason) = crosscheck.check(0, bytes32("MISSING"), 2, _payload(abi.encode(uint256(1))));
        assertTrue(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("NO_TOKEN"));
        (ok, reason) = crosscheck.check(0, ticker, 3, _payload(abi.encode(uint256(1))));
        assertTrue(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("NOT_APPLICABLE"));
    }

    function testTokenReadFailureHandled() public {
        crosscheck.setToken(ticker, address(new RevertingStockToken()));
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(ticker, AT, 2, 1);
        (bool ok, bytes32 reason) = crosscheck.check(0, ticker, 2, _payload(abi.encode(b)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("TOKEN_READ_FAILED"));
    }

    function _split(uint256 num, uint256 den) internal view returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return _payload(abi.encode(MochiTypes.SplitBody(ticker, AT, uint32(num), uint32(den))));
    }

    /// Mirrors the verified Stock implementation: defaults, and uiMultiplier() switching at effectiveAt.
    function testMockMatchesRealStockSemantics() public {
        assertEq(token.uiMultiplier(), 1e18);
        assertEq(token.newUIMultiplier(), 1e18);
        assertEq(token.effectiveAt(), 0);
        token.updateMultiplier(2e18, AT);
        assertEq(token.uiMultiplier(), 1e18);
        vm.warp(AT);
        assertEq(token.uiMultiplier(), 2e18);
        assertEq(token.newUIMultiplier(), 2e18);
        vm.expectRevert(bytes("bad schedule"));
        token.updateMultiplier(3e18, AT - 1);
    }

    /// Regression (found against the real RHC testnet Stock Token): a split verdict posted after the split took
    /// effect used to fail RATIO_MISMATCH because uiMultiplier() had already switched to the new value.
    function testSplitAfterEffectiveUsesRecordedBaseline() public {
        token.updateMultiplier(2e18, AT);
        vm.expectEmit(true, true, false, true, address(crosscheck));
        emit StockTokenCrosscheck.BaselineRecorded(ticker, address(token), AT, 1e18);
        vm.prank(address(0xCAFE));
        crosscheck.recordBaseline(ticker);
        assertEq(crosscheck.baselineOf(ticker, AT), 1e18);
        vm.warp(AT + 1 hours);
        (bool ok, bytes32 reason) = crosscheck.check(0, ticker, 2, _split(2, 1));
        assertTrue(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("OK"));
        (ok, reason) = crosscheck.check(0, ticker, 2, _split(3, 1));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("RATIO_MISMATCH"));
    }

    function testSplitAfterEffectiveWithoutBaselineFailsClosed() public {
        token.updateMultiplier(2e18, AT);
        vm.warp(AT);
        (bool ok, bytes32 reason) = crosscheck.check(0, ticker, 2, _split(2, 1));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(reason, bytes32("BASELINE_UNKNOWN"));
    }

    function testRecordBaselineRevertsAndIsFirstWriteWins() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 missing = bytes32("MISSING");
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.UnknownTicker.selector, missing));
        crosscheck.recordBaseline(missing);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.NoPendingChange.selector, ticker));
        crosscheck.recordBaseline(ticker); // never scheduled
        token.updateMultiplier(2e18, AT);
        crosscheck.recordBaseline(ticker);
        vm.recordLogs();
        crosscheck.recordBaseline(ticker); // no-op
        assertEq(vm.getRecordedLogs().length, 0);
        // Re-scheduling the same effectiveAt before it passes does not change the pre-change multiplier.
        token.updateMultiplier(4e18, AT);
        crosscheck.recordBaseline(ticker);
        assertEq(crosscheck.baselineOf(ticker, AT), 1e18);
        vm.warp(AT);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.NoPendingChange.selector, ticker));
        crosscheck.recordBaseline(ticker); // already effective
    }

    /// Immediate change via the issuer's one-argument updateMultiplier: no pending window, so no baseline.
    function testImmediateChangeHasNoBaseline() public {
        token.updateMultiplier(2e18, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.NoPendingChange.selector, ticker));
        crosscheck.recordBaseline(ticker);
    }

    function testFuzzSplitRatioPendingAndAfterEffective(uint32 num, uint32 den, uint64 base) public {
        num = uint32(bound(num, 1, 1000));
        den = uint32(bound(den, 1, 1000));
        uint256 m = bound(base, 1e12, 1e21);
        token.setSchedule(m * den, m * num, AT);
        (bool ok,) = crosscheck.check(0, ticker, 2, _split(num, den));
        assertTrue(ok);
        crosscheck.recordBaseline(ticker);
        vm.warp(AT + 1);
        assertEq(IStockTokenMultiplier(address(token)).uiMultiplier(), m * num);
        (ok,) = crosscheck.check(0, ticker, 2, _split(num, den));
        assertTrue(ok);
        (ok,) = crosscheck.check(0, ticker, 2, _split(uint256(num) + 1, den));
        assertFalse(ok);
    }
}
