// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

/// @title MochiRoles
/// @notice AccessControl role ids shared by all Mochi contracts. DEFAULT_ADMIN_ROLE and GOVERNOR_ROLE are held by
///         a 24h OZ TimelockController owned by the 2-of-3 multisig; GUARDIAN_ROLE by the multisig directly.
library MochiRoles {
    bytes32 internal constant GOVERNOR_ROLE = keccak256("mochi.role.GOVERNOR");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("mochi.role.GUARDIAN");
    bytes32 internal constant ATTESTOR_ROLE = keccak256("mochi.role.ATTESTOR");
    bytes32 internal constant FEED_RUNNER_ROLE = keccak256("mochi.role.FEED_RUNNER");
}
