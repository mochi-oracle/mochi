// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title IStockTokenMultiplier
/// @notice View surface of a Robinhood Chain Stock Token's UI-multiplier schedule. VERIFIED 2026-09-26 against the
///         verified `Stock` implementation on RHC testnet (0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA, behind the
///         TSLA/AMD/AMZN/NFLX/PLTR beacon proxies; ERC20ScaledUIUpgradeable). Semantics that matter for cross-checks:
///         - `newUIMultiplier()` reads 1e18 (not 0) when nothing was ever scheduled; `effectiveAt()` reads 0 then.
///         - Once `block.timestamp >= effectiveAt()`, `uiMultiplier()` returns the new value; the pre-change multiplier
///           is no longer exposed by any getter (only in the `UIMultiplierUpdated` event).
///         - The issuer's one-argument `updateMultiplier(m)` schedules at `block.timestamp` (effective immediately).
///         All reads go through this interface so only StockTokenCrosscheck changes if a future token version differs.
interface IStockTokenMultiplier {
    /// @notice Multiplier in force now, 1e18 = 1.0 (switches to newUIMultiplier at effectiveAt).
    function uiMultiplier() external view returns (uint256);
    /// @notice Last scheduled multiplier, 1e18 = 1.0 (1e18 if never scheduled; stays set after it takes effect).
    function newUIMultiplier() external view returns (uint256);
    /// @notice Unix seconds when newUIMultiplier takes/took effect (0 if never scheduled).
    function effectiveAt() external view returns (uint256);
}
