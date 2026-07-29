// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {ISchemaRegistry} from "@mochi/interfaces/ISchemaRegistry.sol";

/// @title SchemaRegistry
/// @notice Stores delayed, versioned extraction schema commitments.
contract SchemaRegistry is ISchemaRegistry, AccessControl {
    error ZeroHash();

    mapping(uint32 => mapping(uint16 => SchemaVersion)) private _versions;
    mapping(uint32 => mapping(uint16 => bool)) private _exists;
    mapping(uint32 => uint16) private _latestProposed;
    uint64 private _activationDelay;

    /// @param admin Initial administrator and governor.
    /// @param activationDelay_ Delay before newly proposed schemas activate.
    constructor(address admin, uint64 activationDelay_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
        _activationDelay = activationDelay_;
    }

    /// @inheritdoc ISchemaRegistry
    function propose(uint32 schemaId, bytes32 schemaJsonHash, bytes32 promptHash, bytes32 tolerancesHash, bytes32 crosscheckHash)
        external override onlyRole(MochiRoles.GOVERNOR_ROLE) returns (uint16 version)
    {
        if (schemaId == 0) revert InvalidSchemaId(schemaId);
        if (schemaJsonHash == bytes32(0) || promptHash == bytes32(0)) revert ZeroHash();
        version = _latestProposed[schemaId] + 1;
        _latestProposed[schemaId] = version;
        uint64 now_ = uint64(block.timestamp);
        uint64 activatesAt = now_ + _activationDelay;
        _versions[schemaId][version] = SchemaVersion(schemaJsonHash, promptHash, tolerancesHash, crosscheckHash, now_, activatesAt, false);
        _exists[schemaId][version] = true;
        emit SchemaProposed(schemaId, version, schemaJsonHash, activatesAt);
    }

    /// @inheritdoc ISchemaRegistry
    function revoke(uint32 schemaId, uint16 version) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        SchemaVersion storage v = _versions[schemaId][version];
        if (!_exists[schemaId][version]) revert UnknownSchema(schemaId, version);
        v.revoked = true;
        emit SchemaRevoked(schemaId, version);
    }

    /// @inheritdoc ISchemaRegistry
    function isActive(uint32 schemaId, uint16 version) public view override returns (bool) {
        SchemaVersion storage v = _versions[schemaId][version];
        uint256 timestamp = block.timestamp;
        return _exists[schemaId][version] && !v.revoked && timestamp >= v.activatesAt;
    }

    /// @inheritdoc ISchemaRegistry
    function latest(uint32 schemaId) external view override returns (uint16) {
        uint16 v = _latestProposed[schemaId];
        while (v != 0) {
            if (isActive(schemaId, v)) return v;
            unchecked { --v; }
        }
        return 0;
    }

    /// @inheritdoc ISchemaRegistry
    function getVersion(uint32 schemaId, uint16 version) external view override returns (SchemaVersion memory) {
        SchemaVersion storage v = _versions[schemaId][version];
        if (!_exists[schemaId][version]) revert UnknownSchema(schemaId, version);
        return v;
    }

    /// @inheritdoc ISchemaRegistry
    function activationDelay() external view override returns (uint64) { return _activationDelay; }

    /// @notice Updates the delay applied to future proposals.
    function setActivationDelay(uint64 activationDelay_) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        _activationDelay = activationDelay_;
    }
}
