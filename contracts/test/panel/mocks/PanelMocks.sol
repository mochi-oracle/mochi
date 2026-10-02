// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";

contract MockEscrow {
    mapping(bytes32 => MochiTypes.Query) private queries;
    mapping(bytes32 => bool) public marked;

    function setQuery(bytes32 id, MochiTypes.Query calldata q) external {
        queries[id] = q;
    }

    function getQuery(bytes32 id) external view returns (MochiTypes.Query memory) {
        return queries[id];
    }

    function markEscalated(bytes32 id) external virtual {
        _mark(id);
    }

    function _mark(bytes32 id) internal {
        require(queries[id].status == MochiTypes.QueryStatus.HUNG, "not hung");
        marked[id] = true;
        queries[id].status = MochiTypes.QueryStatus.ESCALATED;
    }
}

/// @dev Mirrors the checks MochiVerdicts.postPanelOutcome makes before it records a panel verdict.
contract MockVerdicts {
    uint256 public postCount;
    bytes32 public lastQuery;
    bytes32 public lastAnswer;
    bytes32 public lastPayload;
    mapping(bytes32 => bool) public posted;

    function postPanelOutcome(bytes32 q, bytes32 a, bytes32 p) external virtual returns (bytes32) {
        return _post(q, a, p);
    }

    function _post(bytes32 q, bytes32 a, bytes32 p) internal returns (bytes32) {
        require(a != 0 && p != 0, "zero panel result");
        require(!posted[q], "verdict exists");
        posted[q] = true;
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

    /// Like BlockhashRandomness: available for 256 blocks after the ticket, then gone for good.
    function seed(bytes32 context, uint64 sealBlock) external view returns (bytes32) {
        require(block.number > sealBlock, "seed not ready");
        require(block.number <= uint256(sealBlock) + 256, "seed window missed");
        return keccak256(abi.encode(context, sealBlock));
    }
}

/// @dev USDG stand-in whose issuer can freeze addresses, as regulated stablecoins can: transfers to a frozen address revert.
contract FreezableUSDG is MockUSDG {
    mapping(address => bool) public frozen;

    function setFrozen(address account, bool value) external {
        frozen[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to], "frozen");
        super._update(from, to, value);
    }
}
