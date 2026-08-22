// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

contract MockVerdicts {
    mapping(bytes32 => MochiTypes.Verdict) private values;

    function setVerdict(bytes32 id, MochiTypes.Verdict calldata v) external {
        values[id] = v;
    }

    function getVerdict(bytes32 id) external view returns (MochiTypes.Verdict memory) {
        return values[id];
    }
}
