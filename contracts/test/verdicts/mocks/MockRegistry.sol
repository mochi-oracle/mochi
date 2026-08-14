// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

contract MockRegistry {
    mapping(address => mapping(uint8 => bool)) public active;
    mapping(address => IJurorRegistry.Juror) private jurors;
    address[] public recordedKeys;
    uint32 public recordedMask;
    address public slashed;

    function setActive(address key, MochiTypes.Role role, bool ok) external {
        active[key][uint8(role)] = ok;
    }

    function setOperator(address key, address operator) external {
        jurors[key].operator = operator;
    }

    function isActive(address key, MochiTypes.Role role) external view returns (bool) {
        return active[key][uint8(role)];
    }

    function getJuror(address key) external view returns (IJurorRegistry.Juror memory) {
        return jurors[key];
    }

    function recordService(address[] calldata keys, uint32 timeoutMask) external {
        recordedKeys = keys;
        recordedMask = timeoutMask;
    }

    function slashEquivocation(address key) external {
        slashed = key;
    }
}
