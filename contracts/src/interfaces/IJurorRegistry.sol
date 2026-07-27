// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {MochiTypes} from "../libraries/MochiTypes.sol";
import {IClassMix} from "./IClassMix.sol";

/// @title IJurorRegistry
/// @notice Enclave signing keys (secp256k1 addresses generated inside TEEs) by role, with attestation freshness,
///         $MOCHI bonds for jurors, deterministic selection, and slashing. No identity checks: attestation + stake only.
interface IJurorRegistry {
    struct Juror {
        address operator; // who enrolled / owns the bond; receives juror fees (via QueryEscrow) and the bond back
        bytes32 measurement; // TEE measurement the key was attested under
        MochiTypes.Role role;
        MochiTypes.JurorClass jurorClass; // meaningful for JUROR only
        uint256 bond; // $MOCHI (18 decimals); 0 for INTAKE / CONSENSUS
        uint64 attestedUntil; // unix seconds
        uint64 exitRequestedAt; // 0 = not exiting
        bool delisted;
        uint32 served; // seats served (answered or timed out)
        uint32 timeouts;
        uint64 lastTimeoutSlashAt;
    }

    event Enrolled(address indexed key, address indexed operator, MochiTypes.Role role, MochiTypes.JurorClass jurorClass, bytes32 measurement, uint256 bond);
    event MeasurementSet(bytes32 indexed measurement, MochiTypes.Role role, bool allowed);
    event AttestationRefreshed(address indexed key, uint64 until);
    event ExitRequested(address indexed key, uint64 at);
    event BondWithdrawn(address indexed key, address indexed operator, uint256 amount);
    event Slashed(address indexed key, uint256 amount, bytes32 reason);
    event Delisted(address indexed key, bytes32 reason);
    event ServiceRecorded(address indexed key, bool timedOut);

    error AlreadyEnrolled(address key);
    error NotEnrolled(address key);
    error MeasurementNotAllowed(bytes32 measurement, MochiTypes.Role role);
    error BondTooLow(uint256 bond, uint256 minBond);
    error InvalidRole();
    error NotOperator(address caller);
    error ExitNotRequested(address key);
    error ExitDelayNotElapsed(uint64 readyAt);
    error NoEligibleJuror(MochiTypes.JurorClass jurorClass);
    error TimeoutSlashNotAllowed(address key);
    error Unauthorized(address caller);
    error BadKeySignature();

    // ── enrollment ──

    /// @notice Operator enrolls a JUROR key; pulls `bond` $MOCHI from msg.sender. attestedUntil starts at 0 (inactive)
    ///         until the ATTESTOR refreshes it. Reverts if the measurement is not allowed for JUROR.
    /// @param keySig Proof of possession: an EIP-191 signature by `key` over
    ///        enrollmentDigest(msg.sender, key, measurement, jurorClass). Without it anyone could front-run the
    ///        enrollment of a published enclave key and squat it.
    function enrollJuror(
        address key,
        bytes32 measurement,
        MochiTypes.JurorClass jurorClass,
        uint256 bond,
        bytes calldata keySig
    ) external;

    /// @notice keccak256(abi.encode("mochi.enroll.v1", block.chainid, address(this), operator, key, measurement, jurorClass)).
    ///         The enclave signs it with `signMessage({ raw: digest })` (EIP-191).
    function enrollmentDigest(address operator, address key, bytes32 measurement, MochiTypes.JurorClass jurorClass)
        external
        view
        returns (bytes32);

    /// @notice GOVERNOR registers an INTAKE or CONSENSUS key (no bond). operator = msg.sender's chosen `operator`.
    function registerServiceKey(address key, address operator, bytes32 measurement, MochiTypes.Role role) external;

    /// @notice GOVERNOR allows / disallows a measurement for a role.
    function setMeasurement(bytes32 measurement, MochiTypes.Role role, bool allowed) external;

    /// @notice ATTESTOR sets attestedUntil for each key (after verifying fresh quotes off-chain).
    function refreshAttestation(address[] calldata keys, uint64 until) external;

    /// @notice Operator starts the 7-day exit; the key becomes inactive immediately.
    function requestExit(address key) external;

    /// @notice Operator withdraws the remaining bond after the exit delay.
    function withdrawBond(address key) external;

    // ── slashing ──

    /// @notice ATTESTOR reports a failed re-attestation while serving: slash 5% and set attestedUntil = 0.
    function reportAttestationFailure(address key) external;

    /// @notice SLASHER (MochiVerdicts) slashes 100% and delists for proven equivocation.
    function slashEquivocation(address key) external;

    /// @notice Anyone: if served >= 20 and timeouts * 10000 / served > 500 (5%), and >= 1 day since the last timeout
    ///         slash, slash 1% of the current bond.
    function slashForTimeouts(address key) external;

    /// @notice SLASHER (MochiVerdicts) records one served seat per key.
    function recordService(address[] calldata keys, uint32 timeoutMask) external;

    // ── views ──

    function isActive(address key, MochiTypes.Role role) external view returns (bool);

    function getJuror(address key) external view returns (Juror memory);

    function operatorOf(address key) external view returns (address);

    /// @notice Deterministic selection for seats [fromSeat, toSeat) of the nested class mix.
    /// @dev For each seat s: c = MochiTypes.seatClass(s); list = all JUROR keys ever enrolled with class c
    ///      (enrollment order); start = uint256(keccak256(abi.encode(seed, s))) % list.length; probe
    ///      start, start+1, ... (mod length) for at most list.length entries and take the first key that isActive(JUROR)
    ///      and is not in `exclude` and not already chosen for an earlier seat in this call. Reverts NoEligibleJuror(c).
    function selectJurors(bytes32 seed, uint8 fromSeat, uint8 toSeat, address[] calldata exclude)
        external
        view
        returns (address[] memory jurors);

    function minJurorBond() external view returns (uint256);
    function exitDelay() external view returns (uint64);
    function jurorsOfClass(MochiTypes.JurorClass jurorClass) external view returns (address[] memory);
    function setClassMix(IClassMix classMix_) external;
    function seatClass(uint8 seat) external view returns (MochiTypes.JurorClass);
}
