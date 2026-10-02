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
    event PoolPruned(MochiTypes.JurorClass indexed jurorClass, uint256 generation, uint256 kept, uint256 removed);

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
    // aderyn-ignore-next-line(unused-error) in the generated ABI; drop with the next ABI change
    error Unauthorized(address caller);
    error BadKeySignature();
    error NoSelectionSnapshot(address owner, bytes32 queryId);
    error NothingToPrune(MochiTypes.JurorClass jurorClass);

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

    /// @notice Operator starts the 7-day exit; the key becomes inactive immediately and permanently.
    function requestExit(address key) external;

    /// @notice Operator withdraws the remaining bond once the exit delay has passed since both the exit request and the
    ///         key's last settled seat (`lastServedAt`). The key cannot take a new seat after the exit request, so this
    ///         only extends the wait for a key that requests exit while a round it sits in is still unsettled: its bond
    ///         stays slashable, e.g. for equivocation on that query, for the full delay after the round settles.
    function withdrawBond(address key) external;

    /// @notice Last time recordService recorded a settled seat (answered or timed out) for `key`; 0 if never.
    function lastServedAt(address key) external view returns (uint64);

    // ── slashing ──

    /// @notice ATTESTOR reports a failed re-attestation while serving: slash 5% and set attestedUntil = 0.
    function reportAttestationFailure(address key) external;

    /// @notice SLASHER (MochiVerdicts) slashes 100% and delists for proven equivocation.
    function slashEquivocation(address key) external;

    /// @notice Anyone: if served >= 20 and timeouts * 10000 / served > 500 (5%), and >= 1 day since the last timeout
    ///         slash, slash 1% of the current bond.
    function slashForTimeouts(address key) external;

    /// @notice SLASHER (MochiVerdicts) records one served seat per key and sets lastServedAt to now.
    function recordService(address[] calldata keys, uint32 timeoutMask) external;

    // ── views ──

    function isActive(address key, MochiTypes.Role role) external view returns (bool);

    function getJuror(address key) external view returns (Juror memory);

    function operatorOf(address key) external view returns (address);

    // ── selection ──

    /// @notice Records, for (msg.sender, queryId), the current selection pool of every class as (generation, length),
    ///         and returns isActive(intakeKey, INTAKE). Every round of the query selects from this snapshot.
    /// @dev QueryEscrow calls it once, when it opens the query, in the same transaction that draws the first randomness
    ///      ticket, so the pools are fixed before any seed of the query can be known; keys enrolled later never take
    ///      part. Expansion and reseal draw new tickets but keep the snapshot. The intake check rides along so the escrow
    ///      (near the EIP-170 limit) opens with a single registry call. A later call for the same queryId replaces the
    ///      snapshot, so callers must call it only before a query's first ticket. Anyone may call it; snapshots are
    ///      keyed by caller.
    function openSelection(bytes32 queryId, address intakeKey) external returns (bool intakeKeyActive);

    /// @notice The packed openSelection snapshot of `owner` for `queryId` (0 if none): bit 255 set, and for class c at bit
    ///         48 * c the pool generation (24 bits) then the pool length (24 bits).
    function selectionSnapshot(address owner, bytes32 queryId) external view returns (uint256);

    /// @notice Deterministic selection for seats [fromSeat, toSeat) of the class mix, over `owner`'s snapshot for
    ///         `queryId`. Reverts NoSelectionSnapshot without one.
    /// @dev For each seat s: c = seatClass(s); (g, len) = the snapshot of class c; pool = poolAt(c, g)[0, len). A key is
    ///      eligible if isActive(JUROR), not in `exclude` and not chosen for an earlier seat in this call. For
    ///      attempt = 0..15: i = uint256(keccak256(abi.encode(seed, s, attempt))) % len; take pool[i] if eligible. If all
    ///      16 draws miss: count the eligible keys of the pool, pick = uint256(keccak256(abi.encode(seed, s, 16))) % count,
    ///      and take the pick-th eligible key in pool order. Reverts NoEligibleJuror(c) if none is eligible. Every
    ///      eligible key is equally likely, whatever the inactive entries around it, and the pools a snapshot names never
    ///      change, so neither enrolling nor pruning after the seed is known can move a seat.
    function selectJurors(
        address owner,
        bytes32 queryId,
        bytes32 seed,
        uint8 fromSeat,
        uint8 toSeat,
        address[] calldata exclude
    ) external view returns (address[] memory jurors);

    /// @notice Anyone: starts the next pool generation of `jurorClass` with the keys of the current one that can still
    ///         serve, i.e. drops keys that requested exit or were delisted (both permanent). Order is kept. Existing
    ///         snapshots keep their generation. Reverts NothingToPrune when no key would be dropped.
    function prunePool(MochiTypes.JurorClass jurorClass) external returns (uint256 kept, uint256 removed);

    /// @notice Current pool generation of `jurorClass`.
    function poolGeneration(MochiTypes.JurorClass jurorClass) external view returns (uint256);

    /// @notice Keys of `jurorClass`'s pool generation `generation`, in enrollment order.
    function poolAt(MochiTypes.JurorClass jurorClass, uint256 generation) external view returns (address[] memory);

    function minJurorBond() external view returns (uint256);
    function exitDelay() external view returns (uint64);
    /// @notice Keys of `jurorClass`'s current selection pool (enrolled keys, minus those dropped by prunePool).
    function jurorsOfClass(MochiTypes.JurorClass jurorClass) external view returns (address[] memory);
    function setClassMix(IClassMix classMix_) external;
    function seatClass(uint8 seat) external view returns (MochiTypes.JurorClass);
}
