// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MochiToken
/// @notice Fixed-supply Mochi token with EIP-2612 permit approvals.
/// @dev The display `name()` and `symbol()` can be changed by the metadata admin (the governance timelock after
///      launch) so a rebrand never needs a token migration. Balances, supply and the EIP-712 permit domain
///      (name "Mochi", version "1", readable through EIP-5267 `eip712Domain()`) never change.
contract MochiToken is ERC20, ERC20Permit {
    error ZeroDistributor();
    error NotMetadataAdmin();
    error EmptyMetadata();

    /// @notice Emitted when the display name and symbol change.
    event MetadataUpdated(string name, string symbol);
    /// @notice Emitted when the metadata admin changes; `newAdmin == address(0)` freezes the metadata forever.
    event MetadataAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    /// @notice Account allowed to change the display name and symbol; address(0) means frozen.
    address public metadataAdmin;

    string private _displayName;
    string private _displaySymbol;

    /// @param distributor Address receiving the entire fixed supply.
    /// @param supply Initial supply in token base units.
    /// @dev The deployer starts as metadata admin and hands it to the timelock during the ownership handover.
    constructor(address distributor, uint256 supply) ERC20("Mochi", "MOCHI") ERC20Permit("Mochi") {
        if (distributor == address(0)) revert ZeroDistributor();
        _displayName = "Mochi";
        _displaySymbol = "MOCHI";
        metadataAdmin = msg.sender;
        emit MetadataAdminTransferred(address(0), msg.sender);
        _mint(distributor, supply);
    }

    /// @inheritdoc ERC20
    function name() public view override returns (string memory) {
        return _displayName;
    }

    /// @inheritdoc ERC20
    function symbol() public view override returns (string memory) {
        return _displaySymbol;
    }

    /// @notice Change the display name and symbol. Does not touch balances, supply or the permit domain.
    /// @param newName New `name()`; must be non-empty.
    /// @param newSymbol New `symbol()`; must be non-empty.
    function setMetadata(string calldata newName, string calldata newSymbol) external {
        if (msg.sender != metadataAdmin) revert NotMetadataAdmin();
        if (bytes(newName).length == 0 || bytes(newSymbol).length == 0) revert EmptyMetadata();
        _displayName = newName;
        _displaySymbol = newSymbol;
        emit MetadataUpdated(newName, newSymbol);
    }

    /// @notice Hand the metadata admin to `newAdmin`; address(0) freezes the name and symbol forever.
    /// @param newAdmin The next metadata admin.
    function transferMetadataAdmin(address newAdmin) external {
        if (msg.sender != metadataAdmin) revert NotMetadataAdmin();
        emit MetadataAdminTransferred(metadataAdmin, newAdmin);
        metadataAdmin = newAdmin;
    }
}
