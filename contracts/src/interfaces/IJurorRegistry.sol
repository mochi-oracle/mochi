// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

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
    event PoolJoined(address indexed key, MochiTypes.JurorClass indexed jurorClass, uint256 generation);

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
    ///         until the ATTESTOR refreshes it, and the key joins its class's selection pool only then (see
    ///         refreshAttestation). Reverts if the measurement is not allowed for JUROR.
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

    /// @notice ATTESTOR sets attestedUntil for each key (after verifying fresh quotes off-chain). A JUROR key that is not
    ///         in its class's current pool joins it (PoolJoined) when the refresh leaves it active: on its first
    ///         refresh after enrollment, or after prunePool dropped it for a reversible reason. Delisted keys are skipped
    ///         (no revert, no event). Reverts NotEnrolled for an unknown key and MeasurementNotAllowed for a key whose
    ///         measurement is not allowed for its role.
    function refreshAttestation(address[] calldata keys, uint64 until) external;

    /// @notice Operator starts the 7-day exit; the key becomes inactive immediately and permanently.
    function requestExit(address key) external;

    /// @notice Operator withdraws the remaining bond once the exit delay has passed since both the exit request and the
    ///         key's last settled seat (`lastServedAt`). The key cannot take a new seat after the exit request, so this
    ///         only extends the wait for a key that requests exit while a round it sits in is still unsettled: its bond
    ///         stays slashable, e.g. for equivocation on that query, for the full delay after the round settles.
    ///         "Settles" means MochiVerdicts.post, which has no deadline of its own: a round stays postable after its
    ///         query deadline until someone calls QueryEscrow.expire, so a late post moves `lastServedAt` (and the hold)
    ///         later. Anyone, including the exiting operator, can cap it by calling expire once the deadline passes;
    ///         expire records no service.
    function withdrawBond(address key) external;

    /// @notice Last time recordService recorded a settled seat (answered or timed out) for `key`; 0 if never.
    function lastServedAt(address key) external view returns (uint64);

    // ── slashing ──

    /// @notice ATTESTOR reports a failed re-attestation while serving: slash 5% and set attestedUntil = 0.
    function reportAttestationFailure(address key) external;

    /// @notice SLASHER (MochiVerdicts) slashes 100% and delists for proven equivocation.
    function slashEquivocation(address key) external;

    /// @notice GOVERNOR delists `key` (any role) permanently, without a slash: it is never active again, attestation
    ///         refreshes skip it, and prunePool drops it. A JUROR's bond stays with its operator, who withdraws it
    ///         through requestExit and withdrawBond. Emits Delisted(key, keccak256("GOVERNANCE")).
    function delist(address key) external;

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
    ///         and returns isActive(intakeKey, INTAKE). The next seal of the query selects from this snapshot.
    /// @dev QueryEscrow calls it in every transaction that draws a randomness ticket, as that transaction's last external
    ///      call: at open (with the intake key, so the escrow, near the EIP-170 limit, opens with a single registry call),
    ///      and again at expansion and reseal (intake key 0, result ignored). A ticket's seed only exists in a later
    ///      block or drand round, so the pools are fixed before the seed of each round can be known, and keys that join
    ///      later wait for the next ticket. Re-snapshotting at expansion and
    ///      reseal lets a round seat a key that joined after the open (e.g. a replacement), instead of reverting
    ///      NoEligibleJuror on a pool that has only the keys it replaced. A call replaces the caller's snapshot for that
    ///      queryId, so a caller must call it only in the transaction that draws the ticket it is for. Anyone may call
    ///      it; snapshots are keyed by caller.
    function openSelection(bytes32 queryId, address intakeKey) external returns (bool intakeKeyActive);

    /// @notice The packed openSelection snapshot of `owner` for `queryId` (0 if none): bit 255 set, and for class c at bit
    ///         48 * c the pool generation (24 bits) then the pool length (24 bits).
    function selectionSnapshot(address owner, bytes32 queryId) external view returns (uint256);

    /// @notice Deterministic selection for seats [fromSeat, toSeat) of the class mix, over `owner`'s snapshot for
    ///         `queryId`. Reverts NoSelectionSnapshot without one.
    /// @dev For each seat s: c = seatClass(s); (g, len) = the snapshot of class c; pool = poolAt(c, g)[0, len). A key is
    ///      eligible if isActive(JUROR), not in `exclude` and not chosen for an earlier seat in this call. For
    ///      attempt = 0..127: i = uint256(keccak256(abi.encode(seed, s, attempt))) % len; take pool[i] if eligible. If
    ///      all 128 draws miss, revert NoEligibleJuror(c) (also when len == 0); there is no fallback scan, so the gas is
    ///      bounded by 128 draws per seat whatever the pool size. Every eligible key is equally likely, whatever the
    ///      inactive entries around it.
    ///      What can move a seat once the seed is known: not the pools, which the snapshot fixes, so enrolling, joining
    ///      (attestation) and pruning cannot. Eligibility is read at seal time. A key that drops out (exit request,
    ///      attestation lapse, revoked approval, disallowed measurement, delisting) only passes the seat it would have
    ///      taken to that seat's next eligible draw, and when that draw names the key holding the class's other seat in
    ///      this call, that seat moves on in turn; every draw still names the same key. An operator withdrawing its own
    ///      keys therefore never gains seats: it can only trade one for the class's other seat, or make a seat revert when
    ///      all 128 draws hit withdrawn, inactive, excluded or already chosen keys. A key that becomes eligible again (a
    ///      refresh after a lapse) gets no more than it would have had by staying active, and a sealer timing seal()
    ///      around another key's expiry gets at most that one-seat redraw.
    function selectJurors(
        address owner,
        bytes32 queryId,
        bytes32 seed,
        uint8 fromSeat,
        uint8 toSeat,
        address[] calldata exclude
    ) external view returns (address[] memory jurors);

    /// @notice Anyone: starts the next pool generation of `jurorClass` with the keys of the current one that can still
    ///         serve. Drops keys that requested exit or were delisted (permanent), whose attestation lapsed more than
    ///         ATTESTATION_GRACE ago, whose measurement is no longer allowed for JUROR, or that fail the bond mode's
    ///         admission rule (zero-bond: approval revoked or changed; bonded: no bond). A key dropped for one of the
    ///         reversible reasons rejoins at its next attestation refresh that leaves it active. Order is kept. Existing
    ///         snapshots keep their generation. Reverts NothingToPrune when no key would be dropped. The loop is linear
    ///         in the pool size; since only attested keys join, the attestor bounds it.
    function prunePool(MochiTypes.JurorClass jurorClass) external returns (uint256 kept, uint256 removed);

    /// @notice Whether `key` is in the current pool generation of its class.
    function inPool(address key) external view returns (bool);

    /// @notice Current pool generation of `jurorClass`.
    function poolGeneration(MochiTypes.JurorClass jurorClass) external view returns (uint256);

    /// @notice Keys of `jurorClass`'s pool generation `generation`, in joining order.
    function poolAt(MochiTypes.JurorClass jurorClass, uint256 generation) external view returns (address[] memory);

    function minJurorBond() external view returns (uint256);
    function exitDelay() external view returns (uint64);
    /// @notice Keys of `jurorClass`'s current selection pool (keys that joined on attestation, minus those prunePool
    ///         dropped).
    function jurorsOfClass(MochiTypes.JurorClass jurorClass) external view returns (address[] memory);
    function setClassMix(IClassMix classMix_) external;
    function seatClass(uint8 seat) external view returns (MochiTypes.JurorClass);
}
