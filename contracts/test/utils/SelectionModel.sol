// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// @notice Reference model of IJurorRegistry.selectJurors, written from its interface spec and read through public
///         views only, so the invariant suites can predict every seat and every NoEligibleJuror revert.
library SelectionModel {
    uint256 internal constant MAX_DRAWS = 128;

    /// @dev Returns ok = false (and that seat's class in `failed`) when some seat has no eligible draw; `seats` holds the
    ///      selected keys for seats [fromSeat, toSeat).
    function select(
        IJurorRegistry registry,
        address owner,
        bytes32 queryId,
        bytes32 seed,
        uint8 fromSeat,
        uint8 toSeat,
        address[] memory exclude
    ) internal view returns (bool ok, MochiTypes.JurorClass failed, address[] memory seats) {
        uint256 snapshot = registry.selectionSnapshot(owner, queryId);
        seats = new address[](toSeat - fromSeat);
        for (uint8 s = fromSeat; s < toSeat; ++s) {
            MochiTypes.JurorClass c = registry.seatClass(s);
            uint256 word = snapshot >> (uint256(uint8(c)) * 48);
            address[] memory pool = registry.poolAt(c, uint24(word));
            uint256 len = uint24(word >> 24);
            address pick;
            for (uint256 attempt; attempt < MAX_DRAWS && len != 0; ++attempt) {
                address candidate = pool[uint256(keccak256(abi.encode(seed, s, attempt))) % len];
                if (
                    registry.isActive(candidate, MochiTypes.Role.JUROR) && !contains(exclude, candidate)
                        && !contains(seats, candidate)
                ) {
                    pick = candidate;
                    break;
                }
            }
            if (pick == address(0)) return (false, c, seats);
            seats[s - fromSeat] = pick;
        }
        ok = true;
    }

    function contains(address[] memory values, address value) internal pure returns (bool) {
        for (uint256 i; i < values.length; ++i) if (values[i] == value) return true;
        return false;
    }

    /// keccak256 of the keys every class's snapshot names (poolAt(c, g)[0, len)), to check they never change.
    function snapshotContents(IJurorRegistry registry, address owner, bytes32 queryId) internal view returns (bytes32 h) {
        uint256 snapshot = registry.selectionSnapshot(owner, queryId);
        for (uint8 c; c < 5; ++c) {
            uint256 word = snapshot >> (uint256(c) * 48);
            address[] memory pool = registry.poolAt(MochiTypes.JurorClass(c), uint24(word));
            uint256 len = uint24(word >> 24);
            address[] memory prefix = new address[](len);
            for (uint256 i; i < len; ++i) prefix[i] = pool[i];
            h = keccak256(abi.encode(h, prefix));
        }
    }
}
