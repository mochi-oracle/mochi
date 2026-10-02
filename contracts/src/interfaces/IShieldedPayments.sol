// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

/// @title IShieldedPayments
/// @notice Adapter over a shielded payment pool (Privacy Pools + relayer). Implemented in src/privacy; a mock lives in src/mocks.
interface IShieldedPayments {
    /// @notice Verifies `proof` for a shielded USDG note, marks `nullifier` spent, and transfers exactly `amount`
    ///         USDG to `recipient`. `context` binds the proof to one use (Mochi passes the queryId).
    /// @dev Must revert on a reused nullifier or an invalid proof.
    function spend(bytes32 nullifier, uint256 amount, address recipient, bytes32 context, bytes calldata proof)
        external;
}
