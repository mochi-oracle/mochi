// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

contract MockEscrow {
    MochiTypes.Query public query;
    address[] private seats;
    uint8 public prevN;
    bytes32 public settledQuery;
    uint8 public settledRound;
    MochiTypes.VerdictStatus public settledStatus;
    uint32 public settledMask;
    bytes32 public decidedQuery;

    function setQuery(MochiTypes.Query calldata q, address[] calldata jurors, uint8 previous) external {
        query = q;
        seats = jurors;
        prevN = previous;
    }

    function getQuery(bytes32) external view returns (MochiTypes.Query memory) {
        return query;
    }

    function jurorsOf(bytes32) external view returns (address[] memory) {
        return seats;
    }

    function prevNOf(bytes32) external view returns (uint8) {
        return prevN;
    }

    function settle(bytes32 id, uint8 r, MochiTypes.VerdictStatus s, uint32 m) external {
        settledQuery = id;
        settledRound = r;
        settledStatus = s;
        settledMask = m;
    }

    function markDecided(bytes32 id) external {
        decidedQuery = id;
    }
}
