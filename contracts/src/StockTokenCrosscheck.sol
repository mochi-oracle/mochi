// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IFeedCrosscheck} from "@mochi/interfaces/IFeedCrosscheck.sol";
import {IStockTokenMultiplier} from "@mochi/interfaces/IStockTokenMultiplier.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract StockTokenCrosscheck is IFeedCrosscheck, AccessControl {
    using SafeCast for uint256;

    /// @notice The multiplier in force at `observedAt`, and the token's effectiveAt() at that moment.
    struct Observation {
        uint64 observedAt;
        uint64 scheduledAt;
        uint128 multiplier;
    }

    mapping(bytes32 => address) private _tokenOf;
    /// token => effectiveAt => multiplier in force before that scheduled change (recorded while it was pending, or
    /// carried over from the last observation taken before it).
    mapping(address => mapping(uint256 => uint256)) private _baseline;
    mapping(address => Observation) private _observed;

    /// @notice Gas each Stock Token read gets when setToken takes the first observation (a cold read through the
    ///         verified Stock's beacon proxy costs well under 20k).
    uint256 public constant TOKEN_READ_GAS = 100_000;

    event BaselineRecorded(bytes32 indexed ticker, address indexed token, uint256 effectiveAt, uint256 multiplier);
    event MultiplierObserved(bytes32 indexed ticker, address indexed token, uint256 multiplier, uint256 effectiveAt);
    /// @notice A GOVERNOR-supplied baseline for a change that no observation covers (see setBaseline).
    event BaselineSet(bytes32 indexed ticker, address indexed token, uint256 effectiveAt, uint256 multiplier);

    error UnknownTicker(bytes32 ticker);
    error NoPendingChange(bytes32 ticker);
    error TokenReadFailed(bytes32 ticker, address token);
    /// @notice setBaseline: `at` is not the token's current effectiveAt(), or that change is not in effect yet.
    error NotEffectiveChange(bytes32 ticker, uint256 at);
    /// @notice setBaseline: a baseline for `at` is recorded or follows from the last observation.
    error BaselineKnown(bytes32 ticker, uint256 at);
    error ZeroMultiplier();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
    }

    /// @notice GOVERNOR. Registers `token` for `ticker` (address(0) unregisters) and takes its first observation in the
    ///         same call, so a change that later takes effect immediately has a baseline. If the token's multiplier
    ///         cannot be read (no code, a revert, or more than TOKEN_READ_GAS) it reverts TokenReadFailed and nothing
    ///         changes. A registered token therefore always has an observation from no later than its registration,
    ///         whatever the transaction's gas limit: a limit too low for the reads reverts too (retry with more gas).
    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setToken(bytes32 ticker, address token) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        _tokenOf[ticker] = token;
        if (token == address(0)) return;
        (bool ok, uint256 at, uint256 cur) = _tryReadMultiplier(token);
        if (!ok) revert TokenReadFailed(ticker, token);
        _observe(ticker, token, at, cur);
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
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        uint256 at = IStockTokenMultiplier(token).effectiveAt();
        // forge-lint: disable-next-line(block-timestamp)
        if (at == 0 || block.timestamp >= at) revert NoPendingChange(ticker);
        if (_baseline[token][at] != 0) return;
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        uint256 cur = IStockTokenMultiplier(token).uiMultiplier();
        _baseline[token][at] = cur;
        emit BaselineRecorded(ticker, token, at, cur);
    }

    /// @notice Permissionless; keepers call it regularly for every registered ticker. Records the multiplier in force
    ///         now. The issuer's one-argument updateMultiplier(m) takes effect in the same block, so recordBaseline()
    ///         never sees it pending; such a change is ratio-checked against the last observation taken before it.
    ///         Before overwriting, a change without a baseline gets one: the current multiplier while it is pending,
    ///         or the previous observation once it is effective (see _observedBaseline for when that is accepted).
    ///         Reads only the registered token, so the caller controls timing but never the recorded values.
    function observeMultiplier(bytes32 ticker) external {
        address token = _tokenOf[ticker];
        if (token == address(0)) revert UnknownTicker(ticker);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        uint256 at = IStockTokenMultiplier(token).effectiveAt();
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        uint256 cur = IStockTokenMultiplier(token).uiMultiplier();
        _observe(ticker, token, at, cur);
    }

    /// @notice GOVERNOR (timelock). Recovery for a multiplier change whose pre-change value no observation covers, e.g.
    ///         a token registered after the change took effect, or one observed while a different change was pending
    ///         (both fail SPLIT checks closed with BASELINE_UNKNOWN). Only for the token's current change `at`, once it
    ///         is in effect (no permissionless path can read the pre-change value any more), and only while no baseline
    ///         is recorded or derivable from the last observation: it never replaces a value the keepers recorded.
    ///         The governor can already repoint `ticker` with setToken, so this adds no trust; take `multiplier` from
    ///         the token's UIMultiplierUpdated event.
    function setBaseline(bytes32 ticker, uint256 at, uint256 multiplier) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        address token = _tokenOf[ticker];
        if (token == address(0)) revert UnknownTicker(ticker);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        uint256 effective = IStockTokenMultiplier(token).effectiveAt();
        // forge-lint: disable-next-line(block-timestamp)
        if (at == 0 || at != effective || block.timestamp < at) revert NotEffectiveChange(ticker, at);
        if (multiplier == 0) revert ZeroMultiplier();
        if (_baseline[token][at] != 0 || _observedBaseline(token, at) != 0) revert BaselineKnown(ticker, at);
        _baseline[token][at] = multiplier;
        emit BaselineSet(ticker, token, at, multiplier);
    }

    /// @notice Recorded pre-change multiplier for `ticker`'s current token and a change effective at `at` (0 if none).
    function baselineOf(bytes32 ticker, uint256 at) external view returns (uint256) {
        return _baseline[_tokenOf[ticker]][at];
    }

    /// @notice Last observation of `ticker`'s current token (all zero if none).
    function observationOf(bytes32 ticker) external view returns (Observation memory) {
        return _observed[_tokenOf[ticker]];
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
                            if (cur == 0) cur = _observedBaseline(token, at);
                            // slither-disable-next-line incorrect-equality -- 0 = no baseline sentinel
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

    /// @dev The last observation is the pre-change multiplier for a change effective at `at` when it was taken before
    ///      `at` and either nothing else was pending then (scheduledAt <= observedAt) or this very change was. If the
    ///      issuer made two immediate changes between observations it is two changes old; the ratio check then fails
    ///      (fail-safe) unless the verdict's ratio equals the compound ratio.
    ///      Several blocks can share one timestamp, so an observation taken in the second `at` itself may precede the
    ///      change: it did exactly when the token's schedule then pointed before `at` (once a change effective at `at`
    ///      exists, effectiveAt() reads `at`, or later if the issuer rescheduled in that second), and nothing could be
    ///      pending then. Without this, a permissionless observeMultiplier() landing in that second before the
    ///      issuer's one-argument updateMultiplier() would overwrite the only usable observation for good.
    function _observedBaseline(address token, uint256 at) private view returns (uint256) {
        Observation memory o = _observed[token];
        // slither-disable-next-line incorrect-equality -- 0 is the never-observed sentinel, not a balance
        if (o.observedAt == 0 || o.observedAt > at) return 0;
        // slither-disable-next-line incorrect-equality -- same-second observation (timestamps, not balances)
        if (o.observedAt == at) return o.scheduledAt < at ? o.multiplier : 0;
        if (o.scheduledAt > o.observedAt && o.scheduledAt != at) return 0;
        return o.multiplier;
    }

    /// @dev Records `cur` and `at` (the token's uiMultiplier() and effectiveAt() now) as `token`'s observation, first
    ///      giving a change without a baseline one (see observeMultiplier). Shared by observeMultiplier and setToken.
    function _observe(bytes32 ticker, address token, uint256 at, uint256 cur) private {
        if (at != 0 && _baseline[token][at] == 0) {
            // forge-lint: disable-next-line(block-timestamp)
            uint256 base = block.timestamp < at ? cur : _observedBaseline(token, at);
            if (base != 0) {
                _baseline[token][at] = base;
                emit BaselineRecorded(ticker, token, at, base);
            }
        }
        _observed[token] = Observation(uint64(block.timestamp), at.toUint64(), cur.toUint128());
        emit MultiplierObserved(ticker, token, cur, at);
    }

    /// @dev setToken's reads of effectiveAt() and uiMultiplier(): each capped at TOKEN_READ_GAS, failures reported
    ///      (ok = false) rather than bubbled. Return data that does not decode as uint256 still reverts.
    function _tryReadMultiplier(address token) private view returns (bool ok, uint256 at, uint256 cur) {
        if (token.code.length == 0) return (false, 0, 0);
        try IStockTokenMultiplier(token).effectiveAt{gas: TOKEN_READ_GAS}() returns (uint256 at_) {
            try IStockTokenMultiplier(token).uiMultiplier{gas: TOKEN_READ_GAS}() returns (uint256 cur_) {
                return (true, at_, cur_);
            } catch {}
        } catch {}
    }

    function _distance(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
