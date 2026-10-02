// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IRandomness} from "@mochi/interfaces/IRandomness.sol";

/// @title BlockhashRandomness
/// @notice Derives juror-selection seeds from an available recent block hash.
contract BlockhashRandomness is IRandomness {
    uint64 private immutable _sealDelay;

    /// @param sealDelay_ Number of blocks callers wait before using a seal block.
    constructor(uint64 sealDelay_) {
        require(sealDelay_ >= 1, "seal delay must be positive");
        _sealDelay = sealDelay_;
    }

    /// @notice Delay, in blocks, used when creating the next blockhash ticket.
    function sealDelay() external view returns (uint64) {
        return _sealDelay;
    }

    /// @inheritdoc IRandomness
    function nextTicket() external view override returns (uint64) {
        return uint64(block.number) + _sealDelay;
    }

    /// @inheritdoc IRandomness
    function isExpired(uint64 ticket) external view override returns (bool) {
        return block.number > uint256(ticket) + 256;
    }

    /// @inheritdoc IRandomness
    function seed(bytes32 context, uint64 ticket) external view override returns (bytes32) {
        if (block.number <= ticket) revert SeedNotReady(ticket, block.number);
        if (block.number > uint256(ticket) + 256) revert SeedWindowMissed(ticket, block.number);
        bytes32 bh = blockhash(ticket);
        if (bh == bytes32(0)) revert SeedWindowMissed(ticket, block.number);
        return keccak256(abi.encode(context, bh));
    }
}
