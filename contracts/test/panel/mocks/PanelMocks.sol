// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";

contract MockEscrow {
    mapping(bytes32 => MochiTypes.Query) private queries;
    mapping(bytes32 => bool) public marked;

    function setQuery(bytes32 id, MochiTypes.Query calldata q) external {
        queries[id] = q;
    }

    function getQuery(bytes32 id) external view returns (MochiTypes.Query memory) {
        return queries[id];
    }

    function markEscalated(bytes32 id) external {
        marked[id] = true;
        queries[id].status = MochiTypes.QueryStatus.ESCALATED;
    }
}

contract MockVerdicts {
    uint256 public postCount;
    bytes32 public lastQuery;
    bytes32 public lastAnswer;
    bytes32 public lastPayload;

    function postPanelOutcome(bytes32 q, bytes32 a, bytes32 p) external returns (bytes32) {
        ++postCount;
        lastQuery = q;
        lastAnswer = a;
        lastPayload = p;
        return keccak256(abi.encode(q, a, p));
    }
}

contract MockRandomness {
    function nextTicket() external view returns (uint64) {
        return uint64(block.number) + 1;
    }

    function isExpired(uint64 ticket) external view returns (bool) {
        return block.number > uint256(ticket) + 256;
    }

    function seed(bytes32 context, uint64 sealBlock) external view returns (bytes32) {
        require(block.number > sealBlock, "seed not ready");
        return keccak256(abi.encode(context, sealBlock));
    }
}
