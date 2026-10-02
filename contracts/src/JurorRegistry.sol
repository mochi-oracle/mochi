// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {IClassMix} from "@mochi/interfaces/IClassMix.sol";

/// @title JurorRegistry
/// @notice Registry of attested enclave keys and bonded jurors, with selection and slashing.
contract JurorRegistry is IJurorRegistry, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASHER_ROLE = keccak256("mochi.role.SLASHER");
    bytes32 public constant ATTESTOR_ROLE = MochiRoles.ATTESTOR_ROLE;
    uint64 private constant TIMEOUT_SLASH_INTERVAL = 1 days;
    uint256 private constant BPS = 10_000;
    /// @dev Rehash draws per seat before the exact (enumerating) fallback.
    uint256 private constant MAX_DRAWS = 16;
    uint256 private constant SNAPSHOT_TAKEN = 1 << 255;

    mapping(address => Juror) public jurors;
    mapping(bytes32 => mapping(MochiTypes.Role => bool)) public allowedMeasurement;
    /// @dev Selection pools: class => generation => keys, in enrollment order. Enrollment appends to the current
    ///      generation; prunePool copies the keys that can still serve into the next one. A generation is never
    ///      reordered or shortened, so a (generation, length) snapshot keeps naming exactly the same keys.
    mapping(MochiTypes.JurorClass => mapping(uint256 => address[])) private _pools;
    /// @dev Current pool of every class, 48 bits per class at bit 48 * class: generation (low 24) | length (high 24).
    uint256 private _poolState;
    /// @dev owner (the escrow) => queryId => _poolState as of the owner's openSelection call, | SNAPSHOT_TAKEN.
    mapping(address => mapping(bytes32 => uint256)) private _snapshots;
    /// @inheritdoc IJurorRegistry
    mapping(address => uint64) public override lastServedAt;

    IERC20 public immutable mochi;
    address public slashSink;
    uint256 public minJurorBond;
    // Zero-bond seats require approval of the exact enclave key and operator.
    // This does not make team-operated jurors economically bonded or independent.
    mapping(address => address) public unbondedJurorOperator;
    event UnbondedJurorSet(address indexed key, address indexed operator);
    error UnbondedJurorNotApproved(address key, address operator);
    uint64 public immutable exitDelay;
    IClassMix public classMix;

    error BadSeatRange();
    error PoolFull(MochiTypes.JurorClass jurorClass);

    /// @param admin Initial administrator and governor.
    /// @param mochi_ MOCHI token used for juror bonds.
    /// @param slashSink_ Recipient of slashed bonds.
    /// @param minJurorBond_ Minimum bond required for enrollment.
    /// @param exitDelay_ Delay between exit request and withdrawal.
    constructor(address admin, IERC20 mochi_, address slashSink_, uint256 minJurorBond_, uint64 exitDelay_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
        mochi = mochi_;
        slashSink = slashSink_;
        minJurorBond = minJurorBond_;
        exitDelay = exitDelay_;
    }

    /// @inheritdoc IJurorRegistry
    function enrollJuror(
        address key,
        bytes32 measurement,
        MochiTypes.JurorClass jurorClass,
        uint256 bond,
        bytes calldata keySig
    ) external override nonReentrant {
        if (key == address(0)) revert NotEnrolled(key);
        if (jurors[key].operator != address(0)) revert AlreadyEnrolled(key);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(enrollmentDigest(msg.sender, key, measurement, jurorClass));
        // slither-disable-next-line unused-return -- err is checked; the third value only details err
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, keySig);
        if (err != ECDSA.RecoverError.NoError || signer != key) revert BadKeySignature();
        if (!allowedMeasurement[measurement][MochiTypes.Role.JUROR]) {
            revert MeasurementNotAllowed(measurement, MochiTypes.Role.JUROR);
        }
        if (bond < minJurorBond) revert BondTooLow(bond, minJurorBond);
        if (minJurorBond == 0 && unbondedJurorOperator[key] != msg.sender) revert UnbondedJurorNotApproved(key, msg.sender);
        if (bond != 0) mochi.safeTransferFrom(msg.sender, address(this), bond);
        jurors[key] = Juror(msg.sender, measurement, MochiTypes.Role.JUROR, jurorClass, bond, 0, 0, false, 0, 0, 0);
        uint256 shift = uint256(uint8(jurorClass)) * 48;
        uint256 state = _poolState;
        address[] storage pool = _pools[jurorClass][uint24(state >> shift)];
        pool.push(key);
        uint256 len = pool.length;
        if (len > type(uint24).max) revert PoolFull(jurorClass);
        _poolState = (state & ~(uint256(type(uint24).max) << (shift + 24))) | (len << (shift + 24));
        emit Enrolled(key, msg.sender, MochiTypes.Role.JUROR, jurorClass, measurement, bond);
    }

    /// @inheritdoc IJurorRegistry
    function enrollmentDigest(address operator, address key, bytes32 measurement, MochiTypes.JurorClass jurorClass)
        public
        view
        override
        returns (bytes32)
    {
        return keccak256(abi.encode("mochi.enroll.v1", block.chainid, address(this), operator, key, measurement, jurorClass));
    }

    /// @inheritdoc IJurorRegistry
    function registerServiceKey(address key, address operator, bytes32 measurement, MochiTypes.Role role)
        external override onlyRole(MochiRoles.GOVERNOR_ROLE)
    {
        if (role != MochiTypes.Role.INTAKE && role != MochiTypes.Role.CONSENSUS) revert InvalidRole();
        if (!allowedMeasurement[measurement][role]) revert MeasurementNotAllowed(measurement, role);
        if (jurors[key].operator != address(0)) revert AlreadyEnrolled(key);
        jurors[key] = Juror(operator, measurement, role, MochiTypes.JurorClass.LARGE_A, 0, 0, 0, false, 0, 0, 0);
        emit Enrolled(key, operator, role, MochiTypes.JurorClass.LARGE_A, measurement, 0);
    }

    /// @inheritdoc IJurorRegistry
    function setMeasurement(bytes32 measurement, MochiTypes.Role role, bool allowed)
        external override onlyRole(MochiRoles.GOVERNOR_ROLE)
    {
        allowedMeasurement[measurement][role] = allowed;
        emit MeasurementSet(measurement, role, allowed);
    }

    /// @inheritdoc IJurorRegistry
    function refreshAttestation(address[] calldata keys, uint64 until) external override onlyRole(MochiRoles.ATTESTOR_ROLE) {
        for (uint256 i; i < keys.length; ++i) {
            Juror storage j = jurors[keys[i]];
            if (j.operator == address(0)) revert NotEnrolled(keys[i]);
            if (j.delisted) revert NotEnrolled(keys[i]);
            if (!allowedMeasurement[j.measurement][j.role]) revert MeasurementNotAllowed(j.measurement, j.role);
            j.attestedUntil = until;
            emit AttestationRefreshed(keys[i], until);
        }
    }

    /// @inheritdoc IJurorRegistry
    function requestExit(address key) external override {
        Juror storage j = jurors[key];
        if (j.operator != msg.sender || j.operator == address(0)) revert NotOperator(msg.sender);
        j.exitRequestedAt = uint64(block.timestamp);
        emit ExitRequested(key, uint64(block.timestamp));
    }

    /// @inheritdoc IJurorRegistry
    function withdrawBond(address key) external override nonReentrant {
        Juror storage j = jurors[key];
        if (j.operator != msg.sender || j.operator == address(0)) revert NotOperator(msg.sender);
        if (j.exitRequestedAt == 0) revert ExitNotRequested(key);
        // The delay runs from the later of the exit request and the key's last settled seat, so a key that exits while
        // seated stays slashable (e.g. for equivocation on that query) for the whole delay after the seat settles.
        uint64 servedAt = lastServedAt[key];
        uint64 readyAt = (servedAt > j.exitRequestedAt ? servedAt : j.exitRequestedAt) + exitDelay;
        uint256 timestamp = block.timestamp;
        if (timestamp < readyAt) revert ExitDelayNotElapsed(readyAt);
        uint256 amount = j.bond;
        j.bond = 0;
        j.delisted = true;
        if (amount != 0) mochi.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(key, msg.sender, amount);
    }

    /// @inheritdoc IJurorRegistry
    // aderyn-ignore-next-line(non-reentrant-not-first) the onlyRole check ahead of it makes no external call
    function reportAttestationFailure(address key) external override onlyRole(MochiRoles.ATTESTOR_ROLE) nonReentrant {
        Juror storage j = jurors[key];
        if (j.operator == address(0)) revert NotEnrolled(key);
        uint256 amount = j.bond * 500 / BPS;
        j.attestedUntil = 0;
        _slash(key, j, amount, keccak256("ATTESTATION_FAILURE"));
    }

    /// @inheritdoc IJurorRegistry
    // aderyn-ignore-next-line(non-reentrant-not-first) the onlyRole check ahead of it makes no external call
    function slashEquivocation(address key) external override onlyRole(SLASHER_ROLE) nonReentrant {
        Juror storage j = jurors[key];
        if (j.operator == address(0)) revert NotEnrolled(key);
        uint256 amount = j.bond;
        j.delisted = true;
        _slash(key, j, amount, keccak256("EQUIVOCATION"));
        emit Delisted(key, keccak256("EQUIVOCATION"));
    }

    /// @inheritdoc IJurorRegistry
    function recordService(address[] calldata keys, uint32 timeoutMask) external override onlyRole(SLASHER_ROLE) {
        uint64 now_ = uint64(block.timestamp);
        for (uint256 i; i < keys.length; ++i) {
            Juror storage j = jurors[keys[i]];
            bool timedOut = (uint256(timeoutMask) & (uint256(1) << i)) != 0;
            ++j.served;
            if (timedOut) ++j.timeouts;
            lastServedAt[keys[i]] = now_;
            emit ServiceRecorded(keys[i], timedOut);
        }
    }

    /// @inheritdoc IJurorRegistry
    function slashForTimeouts(address key) external override nonReentrant {
        Juror storage j = jurors[key];
        uint256 timestamp = block.timestamp;
        if (
            j.served < 20 || uint256(j.timeouts) * BPS <= uint256(j.served) * 500
                || timestamp < uint256(j.lastTimeoutSlashAt) + TIMEOUT_SLASH_INTERVAL
        ) revert TimeoutSlashNotAllowed(key);
        uint256 amount = j.bond / 100;
        j.lastTimeoutSlashAt = SafeCast.toUint64(timestamp);
        _slash(key, j, amount, keccak256("TIMEOUTS"));
    }

    /// @inheritdoc IJurorRegistry
    function isActive(address key, MochiTypes.Role role) public view override returns (bool) {
        Juror storage j = jurors[key];
        uint256 timestamp = block.timestamp;
        return j.operator != address(0) && j.role == role && !j.delisted && j.exitRequestedAt == 0
            && j.attestedUntil >= timestamp && allowedMeasurement[j.measurement][role]
            && (role != MochiTypes.Role.JUROR || (minJurorBond == 0 ? unbondedJurorOperator[key] == j.operator : j.bond > 0));
    }

    /// @inheritdoc IJurorRegistry
    function getJuror(address key) external view override returns (Juror memory) { return jurors[key]; }

    /// @inheritdoc IJurorRegistry
    function operatorOf(address key) external view override returns (address) {
        address operator = jurors[key].operator;
        if (operator == address(0)) revert NotEnrolled(key);
        return operator;
    }

    /// @inheritdoc IJurorRegistry
    function openSelection(bytes32 queryId, address intakeKey) external override returns (bool) {
        _snapshots[msg.sender][queryId] = _poolState | SNAPSHOT_TAKEN;
        return isActive(intakeKey, MochiTypes.Role.INTAKE);
    }

    /// @inheritdoc IJurorRegistry
    function selectionSnapshot(address owner, bytes32 queryId) external view override returns (uint256) {
        return _snapshots[owner][queryId];
    }

    /// @inheritdoc IJurorRegistry
    function selectJurors(
        address owner,
        bytes32 queryId,
        bytes32 seed_,
        uint8 fromSeat,
        uint8 toSeat,
        address[] calldata exclude
    ) external view override returns (address[] memory selected) {
        if (fromSeat >= toSeat || toSeat > MochiTypes.MAX_N) revert BadSeatRange();
        uint256 snapshot = _snapshots[owner][queryId];
        if (snapshot == 0) revert NoSelectionSnapshot(owner, queryId);
        selected = new address[](toSeat - fromSeat);
        for (uint8 seat = fromSeat; seat < toSeat; ++seat) {
            MochiTypes.JurorClass class_ = seatClass(seat);
            uint256 word = snapshot >> (uint256(uint8(class_)) * 48);
            selected[seat - fromSeat] =
                _draw(_pools[class_][uint24(word)], uint24(word >> 24), seed_, seat, exclude, selected, class_);
        }
    }

    /// @dev Rejection sampling over the snapshot: draw an index, and if that key cannot take the seat draw a fresh index
    ///      (never probe forward, which would hand every dead entry's share to the next live key). After MAX_DRAWS misses,
    ///      pick uniformly among all eligible keys of the snapshot. Either way each eligible key is equally likely.
    function _draw(
        address[] storage pool,
        uint256 len,
        bytes32 seed_,
        uint8 seat,
        address[] calldata exclude,
        address[] memory chosen,
        MochiTypes.JurorClass class_
    ) private view returns (address) {
        if (len != 0) {
            for (uint256 attempt; attempt < MAX_DRAWS; ++attempt) {
                address candidate = pool[uint256(keccak256(abi.encode(seed_, seat, attempt))) % len];
                if (_eligible(candidate, exclude, chosen)) return candidate;
            }
            uint256 count;
            for (uint256 i; i < len; ++i) {
                if (_eligible(pool[i], exclude, chosen)) ++count;
            }
            if (count != 0) {
                uint256 pick = uint256(keccak256(abi.encode(seed_, seat, MAX_DRAWS))) % count;
                for (uint256 i; i < len; ++i) {
                    address candidate = pool[i];
                    if (!_eligible(candidate, exclude, chosen)) continue;
                    if (pick == 0) return candidate;
                    --pick;
                }
            }
        }
        revert NoEligibleJuror(class_);
    }

    function _eligible(address candidate, address[] calldata exclude, address[] memory chosen)
        private
        view
        returns (bool)
    {
        return isActive(candidate, MochiTypes.Role.JUROR) && !_contains(exclude, candidate)
            && !_containsMemory(chosen, candidate);
    }

    /// @inheritdoc IJurorRegistry
    function prunePool(MochiTypes.JurorClass jurorClass) external override returns (uint256 kept, uint256 removed) {
        uint256 shift = uint256(uint8(jurorClass)) * 48;
        uint256 state = _poolState;
        uint256 gen = uint24(state >> shift);
        if (gen == type(uint24).max) revert PoolFull(jurorClass);
        address[] storage pool = _pools[jurorClass][gen];
        address[] storage next = _pools[jurorClass][gen + 1];
        uint256 len = pool.length;
        for (uint256 i; i < len; ++i) {
            address key = pool[i];
            Juror storage j = jurors[key];
            // Exit and delisting are permanent; attestation lapses and measurement or approval changes are not.
            if (j.delisted || j.exitRequestedAt != 0) continue;
            next.push(key);
        }
        kept = next.length;
        removed = len - kept;
        if (removed == 0) revert NothingToPrune(jurorClass);
        _poolState = (state & ~(uint256(type(uint48).max) << shift)) | ((gen + 1) | (kept << 24)) << shift;
        emit PoolPruned(jurorClass, gen + 1, kept, removed);
    }

    /// @inheritdoc IJurorRegistry
    function poolGeneration(MochiTypes.JurorClass jurorClass) public view override returns (uint256) {
        return uint24(_poolState >> (uint256(uint8(jurorClass)) * 48));
    }

    /// @inheritdoc IJurorRegistry
    function jurorsOfClass(MochiTypes.JurorClass jurorClass) external view override returns (address[] memory) {
        return _pools[jurorClass][poolGeneration(jurorClass)];
    }

    /// @inheritdoc IJurorRegistry
    function poolAt(MochiTypes.JurorClass jurorClass, uint256 generation) external view override returns (address[] memory) {
        return _pools[jurorClass][generation];
    }

    /// @inheritdoc IJurorRegistry
    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setClassMix(IClassMix classMix_) external override onlyRole(MochiRoles.GOVERNOR_ROLE) {
        classMix = classMix_;
    }

    /// @inheritdoc IJurorRegistry
    function seatClass(uint8 seat) public view override returns (MochiTypes.JurorClass) {
        IClassMix configured = classMix;
        if (address(configured) == address(0)) return MochiTypes.seatClass(seat);
        return configured.seatClass(seat);
    }

    /// @notice Approves an exact team-operated seat when the minimum bond is zero.
    function setUnbondedJuror(address key, address operator) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (key == address(0)) revert NotEnrolled(key);
        unbondedJurorOperator[key] = operator; // zero operator revokes approval and active eligibility
        emit UnbondedJurorSet(key, operator);
    }

    /// @notice Sets the minimum bond; zero selects team-approved admission and eligibility.
    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setMinJurorBond(uint256 value) external onlyRole(MochiRoles.GOVERNOR_ROLE) { minJurorBond = value; }

    /// @notice Sets the recipient of future slashes.
    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setSlashSink(address value) external onlyRole(MochiRoles.GOVERNOR_ROLE) { slashSink = value; }

    function _slash(address key, Juror storage j, uint256 amount, bytes32 reason) private {
        if (amount > j.bond) amount = j.bond;
        j.bond -= amount;
        if (amount != 0) mochi.safeTransfer(slashSink, amount);
        emit Slashed(key, amount, reason);
    }

    function _contains(address[] calldata values, address value) private pure returns (bool) {
        for (uint256 i; i < values.length; ++i) if (values[i] == value) return true;
        return false;
    }

    function _containsMemory(address[] memory values, address value) private pure returns (bool) {
        for (uint256 i; i < values.length; ++i) if (values[i] == value) return true;
        return false;
    }
}
