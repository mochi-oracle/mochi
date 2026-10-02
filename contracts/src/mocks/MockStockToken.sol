// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IStockTokenMultiplier} from "../interfaces/IStockTokenMultiplier.sol";

/// @notice Test-only Stock Token multiplier schedule with the same semantics as Robinhood's ERC20ScaledUIUpgradeable
///         (see IStockTokenMultiplier): uiMultiplier() switches to the scheduled value at effectiveAt, and
///         newUIMultiplier() reads 1e18 when nothing was ever scheduled.
contract MockStockToken is IStockTokenMultiplier {
    uint256 private _multiplier;
    uint256 private _newMultiplier;
    uint256 private _effectiveAt;

    /// @notice Test setter: multiplier before the change, scheduled multiplier, effective time (unchecked).
    function setSchedule(uint256 current, uint256 next, uint256 at) external {
        _multiplier = current;
        _newMultiplier = next;
        _effectiveAt = at;
    }

    /// @notice Same rules as Stock.updateMultiplier(newMultiplier, effectiveAt_).
    function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external {
        // forge-lint: disable-next-line(block-timestamp)
        require(newMultiplier > 0 && effectiveAt_ >= block.timestamp, "bad schedule");
        _multiplier = uiMultiplier();
        _newMultiplier = newMultiplier;
        _effectiveAt = effectiveAt_;
    }

    /// @inheritdoc IStockTokenMultiplier
    function uiMultiplier() public view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= _effectiveAt && _newMultiplier != 0) return _newMultiplier;
        return _multiplier == 0 ? 1e18 : _multiplier;
    }

    /// @inheritdoc IStockTokenMultiplier
    function newUIMultiplier() external view returns (uint256) {
        return _newMultiplier == 0 ? 1e18 : _newMultiplier;
    }

    /// @inheritdoc IStockTokenMultiplier
    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }
}
