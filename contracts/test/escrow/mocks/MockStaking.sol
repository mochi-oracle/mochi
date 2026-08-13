// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockStaking {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdg;
    uint256 public notified;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function notifyReward(uint256 amount) external {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        notified += amount;
    }
}
