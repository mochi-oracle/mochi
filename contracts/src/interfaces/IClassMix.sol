// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {MochiTypes} from "../libraries/MochiTypes.sol";

interface IClassMix {
    event MixSet(uint8[9] mix);
    error InvalidMix();

    function seatClass(uint8 seat) external view returns (MochiTypes.JurorClass);
    function mix() external view returns (uint8[9] memory);
    function setMix(uint8[9] calldata newMix) external;
}
