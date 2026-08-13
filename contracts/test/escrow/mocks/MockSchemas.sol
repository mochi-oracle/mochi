// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

contract MockSchemas {
    mapping(uint32 => uint16) public versions;

    function setLatest(uint32 schemaId, uint16 version) external {
        versions[schemaId] = version;
    }

    function latest(uint32 schemaId) external view returns (uint16) {
        return versions[schemaId];
    }
}
