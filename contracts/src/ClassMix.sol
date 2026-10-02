// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IClassMix} from "@mochi/interfaces/IClassMix.sol";

/// @title ClassMix
/// @notice Governor-controlled nested juror class order for N3 through N9.
contract ClassMix is IClassMix, AccessControl {
    uint8[9] private _mix;

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
        _mix = [uint8(0), 2, 4, 1, 3, 0, 2, 1, 4];
    }

    /// @inheritdoc IClassMix
    function seatClass(uint8 seat) external view override returns (MochiTypes.JurorClass) {
        if (seat >= 9) revert InvalidMix();
        return MochiTypes.JurorClass(_mix[seat]);
    }

    /// @inheritdoc IClassMix
    function mix() external view override returns (uint8[9] memory) { return _mix; }

    /// @inheritdoc IClassMix
    function setMix(uint8[9] calldata newMix) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        // slither-disable-next-line uninitialized-local -- all-false bitmap, filled below
        bool[5] memory seen;
        for (uint8 i; i < 9; ++i) {
            uint8 class_ = newMix[i];
            if (class_ > uint8(MochiTypes.JurorClass.DISSENTER)) revert InvalidMix();
            if (i < 3) {
                if (seen[class_]) revert InvalidMix();
                seen[class_] = true;
            } else if (i == 3 || i == 4) {
                if (seen[class_]) revert InvalidMix();
                seen[class_] = true;
            }
            _mix[i] = class_;
        }
        if (!seen[uint8(MochiTypes.JurorClass.DISSENTER)]) revert InvalidMix();
        for (uint8 i; i < 5; ++i) if (!seen[i]) revert InvalidMix();
        emit MixSet(newMix);
    }
}
