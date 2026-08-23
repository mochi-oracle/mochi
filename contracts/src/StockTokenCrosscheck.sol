// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IFeedCrosscheck} from "@mochi/interfaces/IFeedCrosscheck.sol";
import {IStockTokenMultiplier} from "@mochi/interfaces/IStockTokenMultiplier.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract StockTokenCrosscheck is IFeedCrosscheck, AccessControl {
    mapping(bytes32 => address) private _tokenOf;
    /// token => effectiveAt => multiplier in force before that scheduled change (recorded while it was pending).
    mapping(address => mapping(uint256 => uint256)) private _baseline;

    event BaselineRecorded(bytes32 indexed ticker, address indexed token, uint256 effectiveAt, uint256 multiplier);

    error UnknownTicker(bytes32 ticker);
    error NoPendingChange(bytes32 ticker);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
    }

    function setToken(bytes32 ticker, address token) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        _tokenOf[ticker] = token;
    }

    function tokenOf(bytes32 ticker) external view returns (address) {
        return _tokenOf[ticker];
    }

    /// @notice Permissionless. While a multiplier change is pending on `ticker`'s token, records the multiplier in
    ///         force now. Stock Tokens stop exposing the pre-change multiplier once effectiveAt passes (uiMultiplier()
    ///         then returns the new value), so a SPLIT verdict posted after the change is ratio-checked against this
    ///         record. Reads only the registered token, so the caller cannot influence the value; first record wins.
    function recordBaseline(bytes32 ticker) external {
        address token = _tokenOf[ticker];
        if (token == address(0)) revert UnknownTicker(ticker);
        uint256 at = IStockTokenMultiplier(token).effectiveAt();
        // forge-lint: disable-next-line(block-timestamp)
        if (at == 0 || block.timestamp >= at) revert NoPendingChange(ticker);
        if (_baseline[token][at] != 0) return;
        uint256 cur = IStockTokenMultiplier(token).uiMultiplier();
        _baseline[token][at] = cur;
        emit BaselineRecorded(ticker, token, at, cur);
    }

    /// @notice Recorded pre-change multiplier for `ticker`'s current token and a change effective at `at` (0 if none).
    function baselineOf(bytes32 ticker, uint256 at) external view returns (uint256) {
        return _baseline[_tokenOf[ticker]][at];
    }

    // All Stock Token reads are isolated here (ABI verified on RHC testnet; see IStockTokenMultiplier).
    function check(bytes32, bytes32 key, uint32 schemaId, bytes calldata payload)
        external
        view
        override
        returns (bool, bytes32)
    {
        address token = _tokenOf[key];
        if (token == address(0)) return (true, "NO_TOKEN");
        (,, bytes memory body) = abi.decode(payload, (bytes32, uint64, bytes));
        if (schemaId == uint32(MochiTypes.SchemaId.SPLIT)) {
            MochiTypes.SplitBody memory b = abi.decode(body, (MochiTypes.SplitBody));
            try IStockTokenMultiplier(token).newUIMultiplier() returns (uint256 next) {
                try IStockTokenMultiplier(token).uiMultiplier() returns (uint256 cur) {
                    try IStockTokenMultiplier(token).effectiveAt() returns (uint256 at) {
                        if (next == 0 || at == 0) return (false, "NO_PENDING_CHANGE");
                        // After effectiveAt, uiMultiplier() already equals `next`: use the recorded pre-change value.
                        // forge-lint: disable-next-line(block-timestamp)
                        if (block.timestamp >= at) {
                            cur = _baseline[token][at];
                            if (cur == 0) return (false, "BASELINE_UNKNOWN");
                        }
                        if (uint256(next) * b.ratioDen != uint256(cur) * b.ratioNum) return (false, "RATIO_MISMATCH");
                        if (_distance(at, b.effectiveDate) > 1 days) return (false, "EFFECTIVE_AT_MISMATCH");
                        return (true, "OK");
                    } catch {
                        return (false, "TOKEN_READ_FAILED");
                    }
                } catch {
                    return (false, "TOKEN_READ_FAILED");
                }
            } catch {
                return (false, "TOKEN_READ_FAILED");
            }
        }
        if (schemaId == uint32(MochiTypes.SchemaId.EX_DIVIDEND)) {
            MochiTypes.ExDividendBody memory b = abi.decode(body, (MochiTypes.ExDividendBody));
            if (!b.multiplierEffectExpected) return (true, "NO_EFFECT_EXPECTED");
            try IStockTokenMultiplier(token).newUIMultiplier() returns (uint256 next) {
                try IStockTokenMultiplier(token).effectiveAt() returns (uint256 at) {
                    if (next == 0 || at == 0) return (false, "NO_PENDING_CHANGE");
                    if (_distance(at, b.exDate) > 1 days) return (false, "EFFECTIVE_AT_MISMATCH");
                    return (true, "OK");
                } catch {
                    return (false, "TOKEN_READ_FAILED");
                }
            } catch {
                return (false, "TOKEN_READ_FAILED");
            }
        }
        return (true, "NOT_APPLICABLE");
    }

    function _distance(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
