// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ReceiptAnchor
/// @notice Hourly merkle roots over verdict receipts (packages/receipts `AnchorWindow`). A receipt's inclusion is proven
///         off-chain with a sorted-pair merkle proof against a root recorded here.
contract ReceiptAnchor is AccessControl {
    bytes32 public constant ANCHORER_ROLE = keccak256("mochi.role.ANCHORER");

    struct Anchor {
        uint64 ts;
        uint32 count;
    }

    mapping(bytes32 root => Anchor) public anchors;

    event Anchored(bytes32 indexed root, uint32 count, uint64 ts);

    error AlreadyAnchored(bytes32 root);
    error EmptyRoot();

    constructor(address admin, address anchorer) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHORER_ROLE, anchorer);
    }

    function anchor(bytes32 root, uint32 count) external onlyRole(ANCHORER_ROLE) {
        if (root == bytes32(0)) revert EmptyRoot();
        if (anchors[root].ts != 0) revert AlreadyAnchored(root);
        anchors[root] = Anchor(uint64(block.timestamp), count);
        emit Anchored(root, count, uint64(block.timestamp));
    }

    function isAnchored(bytes32 root) external view returns (bool) {
        return anchors[root].ts != 0;
    }
}
