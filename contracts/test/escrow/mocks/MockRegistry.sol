// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

contract MockRegistry {
    mapping(address => mapping(uint8 => bool)) public active;
    mapping(address => address) public operators;
    address[9] public preset;

    function setActive(address key, MochiTypes.Role role, bool value) external {
        active[key][uint8(role)] = value;
    }

    function setOperator(address key, address operator) external {
        operators[key] = operator;
    }

    function setPreset(uint8 seat, address key) external {
        preset[seat] = key;
    }

    function isActive(address key, MochiTypes.Role role) external view returns (bool) {
        return active[key][uint8(role)];
    }

    function operatorOf(address key) external view returns (address) {
        return operators[key] == address(0) ? key : operators[key];
    }

    function seatClass(uint8 seat) external pure returns (MochiTypes.JurorClass) {
        return MochiTypes.seatClass(seat);
    }

    function selectJurors(bytes32, uint8 fromSeat, uint8 toSeat, address[] calldata)
        external
        view
        returns (address[] memory out)
    {
        out = new address[](toSeat - fromSeat);
        for (uint8 i = fromSeat; i < toSeat; ++i) {
            out[i - fromSeat] = preset[i];
        }
    }
}
