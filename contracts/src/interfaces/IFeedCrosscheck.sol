// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

/// @title IFeedCrosscheck
/// @notice On-chain second source for a feed update. Must be a view and must not revert for well-formed payloads.
interface IFeedCrosscheck {
    /// @return ok false blocks the feed update. @return reason short code (e.g. "EFFECTIVE_AT_MISMATCH").
    function check(bytes32 feedId, bytes32 key, uint32 schemaId, bytes calldata payload)
        external
        view
        returns (bool ok, bytes32 reason);
}
