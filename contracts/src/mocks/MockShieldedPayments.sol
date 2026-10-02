// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IShieldedPayments} from "../interfaces/IShieldedPayments.sol";

/// @notice Test/dev stand-in for the shielded payment pool. Holds USDG deposited via `fund`; a "proof" is valid iff it
///         equals abi.encode(nullifier, amount, recipient, context). Real verification lives in the XPrivacyPool adapter.
contract MockShieldedPayments is IShieldedPayments {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    mapping(bytes32 => bool) public spent;

    error NullifierSpent(bytes32 nullifier);
    error InvalidProof();

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function fund(uint256 amount) external {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    function spend(bytes32 nullifier, uint256 amount, address recipient, bytes32 context, bytes calldata proof)
        external
    {
        if (spent[nullifier]) revert NullifierSpent(nullifier);
        if (keccak256(proof) != keccak256(abi.encode(nullifier, amount, recipient, context))) revert InvalidProof();
        spent[nullifier] = true;
        usdg.safeTransfer(recipient, amount);
    }
}
