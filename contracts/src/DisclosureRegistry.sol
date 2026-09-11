// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title DisclosureRegistry
/// @notice Append-only publication of payer or auditor view-key envelopes for verdicts.
contract DisclosureRegistry {
    mapping(bytes32 => mapping(bytes32 => uint64)) public disclosedAt;
    mapping(bytes32 => mapping(bytes32 => bool)) private _disclosed;
    event Disclosed(bytes32 indexed verdictId, bytes32 indexed recipientKeyHash, bytes32 envelopeHash, address indexed discloser);

    /// @notice Records the first disclosure for a verdict and recipient key hash.
    function disclose(bytes32 verdictId, bytes32 recipientKeyHash, bytes32 envelopeHash) external {
        if (_disclosed[verdictId][recipientKeyHash]) return;
        _disclosed[verdictId][recipientKeyHash] = true;
        disclosedAt[verdictId][recipientKeyHash] = uint64(block.timestamp);
        emit Disclosed(verdictId, recipientKeyHash, envelopeHash, msg.sender);
    }
}
