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

    mapping(address => Juror) public jurors;
    mapping(bytes32 => mapping(MochiTypes.Role => bool)) public allowedMeasurement;
    mapping(MochiTypes.JurorClass => address[]) private _jurorsByClass;

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
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, keySig);
        if (err != ECDSA.RecoverError.NoError || signer != key) revert BadKeySignature();
        if (!allowedMeasurement[measurement][MochiTypes.Role.JUROR]) {
            revert MeasurementNotAllowed(measurement, MochiTypes.Role.JUROR);
        }
        if (bond < minJurorBond) revert BondTooLow(bond, minJurorBond);
        if (minJurorBond == 0 && unbondedJurorOperator[key] != msg.sender) revert UnbondedJurorNotApproved(key, msg.sender);
        if (bond != 0) mochi.safeTransferFrom(msg.sender, address(this), bond);
        jurors[key] = Juror(msg.sender, measurement, MochiTypes.Role.JUROR, jurorClass, bond, 0, 0, false, 0, 0, 0);
        _jurorsByClass[jurorClass].push(key);
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
        uint64 readyAt = j.exitRequestedAt + exitDelay;
        uint256 timestamp = block.timestamp;
        if (timestamp < readyAt) revert ExitDelayNotElapsed(readyAt);
        uint256 amount = j.bond;
        j.bond = 0;
        j.delisted = true;
        if (amount != 0) mochi.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(key, msg.sender, amount);
    }

    /// @inheritdoc IJurorRegistry
    function reportAttestationFailure(address key) external override onlyRole(MochiRoles.ATTESTOR_ROLE) nonReentrant {
        Juror storage j = jurors[key];
        if (j.operator == address(0)) revert NotEnrolled(key);
        uint256 amount = j.bond * 500 / BPS;
        j.attestedUntil = 0;
        _slash(key, j, amount, keccak256("ATTESTATION_FAILURE"));
    }

    /// @inheritdoc IJurorRegistry
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
        for (uint256 i; i < keys.length; ++i) {
            Juror storage j = jurors[keys[i]];
            bool timedOut = (uint256(timeoutMask) & (uint256(1) << i)) != 0;
            ++j.served;
            if (timedOut) ++j.timeouts;
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
    function selectJurors(bytes32 seed_, uint8 fromSeat, uint8 toSeat, address[] calldata exclude)
        external view override returns (address[] memory selected)
    {
        if (fromSeat >= toSeat || toSeat > MochiTypes.MAX_N) revert BadSeatRange();
        selected = new address[](toSeat - fromSeat);
        for (uint8 seat = fromSeat; seat < toSeat; ++seat) {
            MochiTypes.JurorClass class_ = seatClass(seat);
            address[] storage list = _jurorsByClass[class_];
            uint256 len = list.length;
            if (len == 0) revert NoEligibleJuror(class_);
            uint256 start = uint256(keccak256(abi.encode(seed_, seat))) % len;
            bool found;
            for (uint256 i; i < len; ++i) {
                address candidate = list[(start + i) % len];
                if (!isActive(candidate, MochiTypes.Role.JUROR) || _contains(exclude, candidate) || _containsMemory(selected, candidate)) continue;
                selected[seat - fromSeat] = candidate;
                found = true;
                break;
            }
            if (!found) revert NoEligibleJuror(class_);
        }
    }

    /// @inheritdoc IJurorRegistry
    function jurorsOfClass(MochiTypes.JurorClass jurorClass) external view override returns (address[] memory) {
        return _jurorsByClass[jurorClass];
    }

    /// @inheritdoc IJurorRegistry
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
    function setMinJurorBond(uint256 value) external onlyRole(MochiRoles.GOVERNOR_ROLE) { minJurorBond = value; }

    /// @notice Sets the recipient of future slashes.
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
