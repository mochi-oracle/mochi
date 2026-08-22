// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {IFeedCrosscheck} from "@mochi/interfaces/IFeedCrosscheck.sol";

contract MockCrosscheck is IFeedCrosscheck {
    bool public ok = true;
    bool public shouldRevert;
    bytes32 public reason = "MOCK_FAIL";

    function set(bool ok_, bool revert_, bytes32 reason_) external {
        ok = ok_;
        shouldRevert = revert_;
        reason = reason_;
    }

    function check(bytes32, bytes32, uint32, bytes calldata) external view returns (bool, bytes32) {
        if (shouldRevert) revert("fail");
        return (ok, reason);
    }
}
