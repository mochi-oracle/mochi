// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {StockTokenCrosscheck} from "@mochi/StockTokenCrosscheck.sol";
import {MockStockToken} from "@mochi/mocks/MockStockToken.sol";

/// A Stock Token whose multiplier reads can be broken one at a time.
contract BrokenStockToken {
    error Paused();

    enum Mode {
        Healthy,
        EffectiveAtReverts,
        UiMultiplierReverts,
        UiMultiplierBurnsGas
    }

    Mode public mode;

    function setMode(Mode m) external {
        mode = m;
    }

    function effectiveAt() external view returns (uint256) {
        if (mode == Mode.EffectiveAtReverts) revert Paused();
        return 0;
    }

    function uiMultiplier() external view returns (uint256 m) {
        if (mode == Mode.UiMultiplierReverts) revert Paused();
        if (mode == Mode.UiMultiplierBurnsGas) {
            while (gasleft() > 0) m++;
        }
        return 1e18;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return 1e18;
    }
}

/// setToken takes the ticker's first observation. It used to do so through `try this.observeMultiplier() {} catch {}`:
/// under EIP-150 the self-call gets at most 63/64 of the remaining gas, so with a tight gas limit the observation ran
/// out of gas inside the try, the catch swallowed it, and setToken still succeeded with nothing observed. That is what
/// an estimated gas limit produces (eth_estimateGas returns the smallest limit at which the call succeeds), and what
/// happened on anvil: no MultiplierObserved event and observationOf() all zero. setToken now observes directly and
/// reverts TokenReadFailed when the token cannot be read, so success always means observed.
contract StockTokenFirstObservationTest is Test {
    uint64 constant T0 = 1_800_000_000;
    address constant GOVERNOR = address(0x60F);
    bytes32 constant TICKER = "ACME";
    StockTokenCrosscheck crosscheck;
    MockStockToken token;

    function setUp() public {
        vm.warp(T0);
        crosscheck = new StockTokenCrosscheck(GOVERNOR);
        token = new MockStockToken();
        token.setSchedule(3e18, 0, 0); // multiplier 3.0, nothing scheduled
    }

    /// The governor's setToken call with exactly `gasLimit` gas; rolled back afterwards unless `keep`.
    function _setToken(address t, uint256 gasLimit, bool keep) private returns (bool ok, bytes memory ret) {
        uint256 snap = vm.snapshotState();
        vm.prank(GOVERNOR);
        (ok, ret) = address(crosscheck).call{gas: gasLimit}(abi.encodeCall(StockTokenCrosscheck.setToken, (TICKER, t)));
        if (!keep) vm.revertToState(snap);
    }

    /// eth_estimateGas-style: binary search for the smallest gas limit at which setToken does not revert.
    function _estimateGas(address t) private returns (uint256 hi) {
        uint256 lo = 0;
        hi = 1_000_000;
        (bool ok,) = _setToken(t, hi, false);
        assertTrue(ok, "setToken reverts even with ample gas");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (ok,) = _setToken(t, mid, false);
            if (ok) hi = mid;
            else lo = mid;
        }
    }

    function _countEvents(Vm.Log[] memory logs, bytes32 topic) private view returns (uint256 n) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(crosscheck) && logs[i].topics[0] == topic) n++;
        }
    }

    function _assertSetTokenAtEstimatedGasObserves(uint256 expectBaselines) private {
        uint256 gasLimit = _estimateGas(address(token));
        emit log_named_uint("estimated setToken gas", gasLimit);
        vm.recordLogs();
        (bool ok,) = _setToken(address(token), gasLimit, true);
        assertTrue(ok, "setToken at the estimated gas limit");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countEvents(logs, StockTokenCrosscheck.MultiplierObserved.selector), 1, "MultiplierObserved");
        assertEq(
            _countEvents(logs, StockTokenCrosscheck.BaselineRecorded.selector), expectBaselines, "BaselineRecorded"
        );
        assertEq(crosscheck.tokenOf(TICKER), address(token));
        StockTokenCrosscheck.Observation memory o = crosscheck.observationOf(TICKER);
        assertEq(o.observedAt, T0, "observationOf(ticker) recorded at registration");
        assertEq(o.multiplier, 3e18);
    }

    /// The anvil symptom: setToken sent with the estimated gas limit succeeds, so it must have observed the token.
    function testSetTokenAtEstimatedGasTakesTheFirstObservation() public {
        _assertSetTokenAtEstimatedGasObserves(0);
        assertEq(crosscheck.observationOf(TICKER).scheduledAt, 0);
    }

    /// Same with a change pending at registration: the observation also records its baseline.
    function testSetTokenAtEstimatedGasRecordsAPendingChangesBaseline() public {
        token.setSchedule(3e18, 6e18, T0 + 1 days);
        _assertSetTokenAtEstimatedGasObserves(1);
        assertEq(crosscheck.baselineOf(TICKER, T0 + 1 days), 3e18);
    }

    /// Whatever the gas limit, a setToken that succeeds has registered the token AND observed it; with too little gas
    /// it reverts and changes nothing. No gas limit leaves a registered token without its first observation.
    function testSetTokenNeverSucceedsWithoutObserving() public {
        uint256 successes;
        for (uint256 gasLimit = 5_000; gasLimit <= 200_000; gasLimit += 500) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = _setToken(address(token), gasLimit, true);
            if (ok) {
                successes++;
                assertEq(crosscheck.tokenOf(TICKER), address(token));
                assertEq(crosscheck.observationOf(TICKER).observedAt, T0, "registered but not observed");
            } else {
                assertEq(crosscheck.tokenOf(TICKER), address(0), "reverted but registered");
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
    }

    // ---- Failure path: a token whose multiplier cannot be read is not registered ----

    function _expectTokenReadFailed(address t) private {
        vm.expectRevert(abi.encodeWithSelector(StockTokenCrosscheck.TokenReadFailed.selector, TICKER, t));
        vm.prank(GOVERNOR);
        crosscheck.setToken(TICKER, t);
    }

    /// Re-pointing a registered ticker at an unreadable token reverts and leaves the old token and its observation.
    function testSetTokenRevertsWhenAMultiplierReadFails() public {
        vm.prank(GOVERNOR);
        crosscheck.setToken(TICKER, address(token));
        BrokenStockToken broken = new BrokenStockToken();
        broken.setMode(BrokenStockToken.Mode.EffectiveAtReverts);
        _expectTokenReadFailed(address(broken));
        broken.setMode(BrokenStockToken.Mode.UiMultiplierReverts);
        _expectTokenReadFailed(address(broken));
        _expectTokenReadFailed(address(0xBEEF)); // no code: a wrong or not yet deployed address
        assertEq(crosscheck.tokenOf(TICKER), address(token));
        assertEq(crosscheck.observationOf(TICKER).multiplier, 3e18);
        broken.setMode(BrokenStockToken.Mode.Healthy);
        vm.prank(GOVERNOR);
        crosscheck.setToken(TICKER, address(broken));
        assertEq(crosscheck.observationOf(TICKER).observedAt, T0);
    }

    /// A read that burns gas is cut off at TOKEN_READ_GAS: setToken reverts TokenReadFailed with most of a generous
    /// gas limit left, instead of handing the token 63/64 of it.
    function testSetTokenCapsEachReadAtTheStipend() public {
        BrokenStockToken burner = new BrokenStockToken();
        burner.setMode(BrokenStockToken.Mode.UiMultiplierBurnsGas);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = _setToken(address(burner), 5_000_000, true);
        uint256 used = before - gasleft();
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(StockTokenCrosscheck.TokenReadFailed.selector, TICKER, address(burner)));
        assertLt(used, 2 * crosscheck.TOKEN_READ_GAS() + 100_000);
        assertEq(crosscheck.tokenOf(TICKER), address(0));
    }

    /// Unregistering reads nothing, so a token that broke after registration can still be removed.
    function testSetTokenZeroUnregistersWithoutReading() public {
        BrokenStockToken t = new BrokenStockToken();
        vm.prank(GOVERNOR);
        crosscheck.setToken(TICKER, address(t));
        t.setMode(BrokenStockToken.Mode.EffectiveAtReverts);
        vm.prank(GOVERNOR);
        crosscheck.setToken(TICKER, address(0));
        assertEq(crosscheck.tokenOf(TICKER), address(0));
    }

    /// observeMultiplier is unchanged: permissionless, plain reads, a failing read bubbles the token's own revert.
    function testObserveMultiplierStillBubblesTheTokensRevert() public {
        BrokenStockToken t = new BrokenStockToken();
        vm.prank(GOVERNOR);
        crosscheck.setToken(TICKER, address(t));
        t.setMode(BrokenStockToken.Mode.UiMultiplierReverts); // breaks after registration (e.g. paused or upgraded)
        vm.expectRevert(BrokenStockToken.Paused.selector);
        vm.prank(address(0xCAFE));
        crosscheck.observeMultiplier(TICKER);
        assertEq(crosscheck.observationOf(TICKER).observedAt, T0, "the registration observation stays");
        t.setMode(BrokenStockToken.Mode.Healthy);
        vm.warp(T0 + 1 hours);
        vm.prank(address(0xCAFE));
        crosscheck.observeMultiplier(TICKER);
        assertEq(crosscheck.observationOf(TICKER).observedAt, T0 + 1 hours);
    }
}
