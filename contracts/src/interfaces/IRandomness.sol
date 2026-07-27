// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title IRandomness
/// @notice Seed source for juror and evaluator selection.
interface IRandomness {
    error SeedNotReady(uint64 ticket, uint256 current);
    error SeedWindowMissed(uint64 ticket, uint256 current);

    /// @notice Ticket for a seed nobody can know at the time of the call.
    function nextTicket() external view returns (uint64);

    /// @notice True when the seed for `ticket` can never become available.
    function isExpired(uint64 ticket) external view returns (bool);

    /// @notice Returns keccak256(abi.encode(context, random value for ticket)).
    /// @dev Reverts with SeedNotReady or SeedWindowMissed when the seed is unavailable.
    function seed(bytes32 context, uint64 ticket) external view returns (bytes32);
}
