// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockTokenCrosscheck} from "@mochi/StockTokenCrosscheck.sol";
import {MockStockToken} from "@mochi/mocks/MockStockToken.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// Audit contract Low 3 PoC: the issuer's one-argument updateMultiplier(m) takes effect in the same block, so
/// recordBaseline() never sees a pending change and the SPLIT feed stalled on BASELINE_UNKNOWN.
contract StockTokenImmediateSplitTest is Test {
    bytes32 constant TICKER = "ACME";
    uint64 constant T0 = 1_800_000_000;
    StockTokenCrosscheck crosscheck;
    MockStockToken token;

    function setUp() public {
        vm.warp(T0);
        crosscheck = new StockTokenCrosscheck(address(this));
        token = new MockStockToken();
        crosscheck.setToken(TICKER, address(token)); // multiplier 1.0, nothing scheduled
    }

    function _split(uint32 num, uint32 den, uint64 effective) private pure returns (bytes memory) {
        MochiTypes.SplitBody memory b = MochiTypes.SplitBody(TICKER, effective, num, den);
        return abi.encode(TICKER, effective, abi.encode(b));
    }

    function testImmediateSplitIsCheckedAgainstMultiplierObservedAtRegistration() public {
        vm.warp(T0 + 30 days);
        token.updateMultiplier(2e18, block.timestamp); // effective immediately
        (bool ok, bytes32 reason) = crosscheck.check(0, TICKER, 2, _split(2, 1, T0 + 30 days));
        assertTrue(ok);
        bytes32 okReason = "OK";
        assertEq(reason, okReason);
        (ok, reason) = crosscheck.check(0, TICKER, 2, _split(3, 1, T0 + 30 days));
        assertFalse(ok);
        bytes32 mismatch = "RATIO_MISMATCH";
        assertEq(reason, mismatch);
    }
}
