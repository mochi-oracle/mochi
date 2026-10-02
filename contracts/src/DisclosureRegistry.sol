// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title DisclosureRegistry
/// @notice Append-only publication of payer or auditor view-key envelopes for verdicts.
/// @dev Every record is bound to the address that sent it: slots are keyed by (verdictId, recipientKeyHash,
///      discloser), so nobody can squat or pre-empt another party's disclosure. Readers look up the slot of the party
///      they trust, e.g. QueryEscrow.getQuery(verdict.queryId).payer for a USDG-path query, or an address the payer
///      names. The envelope itself stays self-authenticating against the verdict's on-chain answerHash.
contract DisclosureRegistry {
    struct Disclosure {
        bytes32 envelopeHash;
        uint64 disclosedAt;
    }

    mapping(bytes32 => mapping(bytes32 => mapping(address => Disclosure))) private _disclosures;

    event Disclosed(bytes32 indexed verdictId, bytes32 indexed recipientKeyHash, bytes32 envelopeHash, address indexed discloser);

    error ZeroEnvelopeHash();

    /// @notice Records msg.sender's first disclosure for a verdict and recipient key hash; later calls by the same
    ///         sender are no-ops.
    function disclose(bytes32 verdictId, bytes32 recipientKeyHash, bytes32 envelopeHash) external {
        if (envelopeHash == bytes32(0)) revert ZeroEnvelopeHash();
        Disclosure storage d = _disclosures[verdictId][recipientKeyHash][msg.sender];
        if (d.envelopeHash != bytes32(0)) return;
        d.envelopeHash = envelopeHash;
        d.disclosedAt = uint64(block.timestamp);
        emit Disclosed(verdictId, recipientKeyHash, envelopeHash, msg.sender);
    }

    /// @notice `discloser`'s recorded envelope hash and time for a verdict and recipient (zero if none).
    function disclosureOf(bytes32 verdictId, bytes32 recipientKeyHash, address discloser)
        external
        view
        returns (Disclosure memory)
    {
        return _disclosures[verdictId][recipientKeyHash][discloser];
    }

    /// @notice When `discloser` disclosed the verdict to the recipient key (0 if never).
    function disclosedAt(bytes32 verdictId, bytes32 recipientKeyHash, address discloser) external view returns (uint64) {
        return _disclosures[verdictId][recipientKeyHash][discloser].disclosedAt;
    }
}
