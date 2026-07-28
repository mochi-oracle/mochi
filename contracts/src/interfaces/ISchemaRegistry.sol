// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title ISchemaRegistry
/// @notice Versioned task schemas. A proposal activates after the timelock delay (24h). Old versions stay valid for
///         verification. v1 governor = timelocked multisig; a clerk-voting module takes GOVERNOR_ROLE in build step 7.
interface ISchemaRegistry {
    struct SchemaVersion {
        bytes32 schemaJsonHash; // keccak256 of the canonical schema JSON (packages/schemas)
        bytes32 promptHash; // keccak256 of the extraction prompt text
        bytes32 tolerancesHash; // keccak256 of the canonical tolerances JSON
        bytes32 crosscheckHash; // keccak256 of the canonical crosscheck-hooks JSON (0 if none)
        uint64 proposedAt;
        uint64 activatesAt; // proposedAt + activationDelay
        bool revoked;
    }

    event SchemaProposed(uint32 indexed schemaId, uint16 indexed version, bytes32 schemaJsonHash, uint64 activatesAt);
    event SchemaRevoked(uint32 indexed schemaId, uint16 indexed version);

    error UnknownSchema(uint32 schemaId, uint16 version);
    error InvalidSchemaId(uint32 schemaId);

    /// @notice GOVERNOR proposes version (latestProposed + 1) of `schemaId` (1..7 in v1; ids > 7 allowed for future
    ///         schemas). Returns the new version number (versions start at 1).
    function propose(
        uint32 schemaId,
        bytes32 schemaJsonHash,
        bytes32 promptHash,
        bytes32 tolerancesHash,
        bytes32 crosscheckHash
    ) external returns (uint16 version);

    /// @notice GOVERNOR revokes a version (it stops being usable for new queries; existing verdicts stay verifiable).
    function revoke(uint32 schemaId, uint16 version) external;

    /// @notice True if the version exists, is not revoked, and block.timestamp >= activatesAt.
    function isActive(uint32 schemaId, uint16 version) external view returns (bool);

    /// @notice Highest active version, or 0 if none.
    function latest(uint32 schemaId) external view returns (uint16);

    function getVersion(uint32 schemaId, uint16 version) external view returns (SchemaVersion memory);

    function activationDelay() external view returns (uint64);
}
