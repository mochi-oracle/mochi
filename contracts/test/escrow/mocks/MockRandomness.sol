// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

contract MockRandomness {
    function nextTicket() external view returns (uint64) {
        return uint64(block.number) + 1;
    }

    function isExpired(uint64 ticket) external view returns (bool) {
        return block.number > uint256(ticket) + 256;
    }

    function seed(bytes32 context, uint64 sealBlock) external view returns (bytes32) {
        require(block.number > sealBlock, "SeedNotReady");
        return keccak256(abi.encode(context, sealBlock));
    }
}
