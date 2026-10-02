// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

/// @title MochiStaking
/// @notice Stakes MOCHI and streams USDG rewards pro rata through an accumulator.
/// @dev Reward accounting is exact up to flooring, and every floored fraction is tracked:
///      notified == claimed + Σ earned + undistributed + dust + unstreamed, where each term is a floor of an exact
///      scaled value. `dust` is the sum of fractions that no account can ever claim (per-account credit floors and
///      accumulator floors); only it can be swept.
contract MochiStaking is IMochiStaking, ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;
    /// @dev `rewardRate` and the undistributed carry are USDG base units scaled by SCALE.
    uint256 private constant SCALE = 1e18;
    /// @dev Reward-per-token scale (USDG base units per MOCHI wei). USDG has 6 decimals and MOCHI 18, so with a 1e18
    ///      scale a checkpoint over ~10M MOCHI rounded to zero while `lastUpdateTime` advanced, stranding the stream.
    ///      At 1e36 a checkpoint floors away less than totalStaked / 1e36 base units, and that remainder goes to dust.
    uint256 private constant PRECISION = SCALE * SCALE;
    bytes32 public constant LOCKER_ROLE = keccak256("mochi.role.LOCKER");

    event DustSwept(address indexed to, uint256 amount);

    IERC20 public immutable mochi;
    IERC20 public immutable usdg;
    uint64 public immutable override cooldown;
    uint64 public immutable override rewardDuration;
    uint256 public override totalStaked;
    uint256 private _rewardPerTokenStored; // PRECISION-scaled
    uint256 public override rewardRate; // SCALE-scaled USDG per second
    uint64 public override periodFinish;
    uint64 public lastUpdateTime;
    uint256 private _undistributedScaled; // SCALE-scaled; streamed while nothing was staked, plus rate truncation
    uint256 private _dustScaled; // PRECISION-scaled; floored fractions that no account can claim
    mapping(address => uint256) public override stakeOf;
    mapping(address => Checkpoints.Trace208) private _stakeCheckpoints;
    Checkpoints.Trace208 private _totalStakedCheckpoints;
    mapping(address => uint256) private _pending;
    mapping(address => uint64) private _readyAt;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint64) public override lockedUntil;

    /// @notice Initializes stake/reward tokens, unstake cooldown, and stream duration (normally seven days).
    ///         GOVERNOR_ROLE (dust sweep only) is not granted here; DEFAULT_ADMIN grants it when a sweep is wanted.
    constructor(address admin, IERC20 mochi_, IERC20 usdg_, uint64 cooldown_, uint64 rewardDuration_) {
        if (rewardDuration_ == 0) revert InvalidRewardDuration();
        mochi = mochi_;
        usdg = usdg_;
        cooldown = cooldown_;
        rewardDuration = rewardDuration_;
        lastUpdateTime = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc IMochiStaking
    function stake(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _checkpoint(msg.sender);
        totalStaked += amount;
        stakeOf[msg.sender] += amount;
        _writeStakeCheckpoints(msg.sender);
        mochi.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @inheritdoc IMochiStaking
    function requestUnstake(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint64 until = lockedUntil[msg.sender];
        // forge-lint: disable-next-line(block-timestamp)
        if (until != 0 && block.timestamp <= until) revert StakeLocked(until);
        uint256 active = stakeOf[msg.sender];
        if (amount > active) revert InsufficientStake(amount, active);
        _checkpoint(msg.sender);
        stakeOf[msg.sender] = active - amount;
        totalStaked -= amount;
        _writeStakeCheckpoints(msg.sender);
        _pending[msg.sender] += amount;
        uint64 readyAt = uint64(block.timestamp) + cooldown;
        _readyAt[msg.sender] = readyAt;
        emit UnstakeRequested(msg.sender, amount, readyAt);
    }

    /// @inheritdoc IMochiStaking
    function withdraw() external override nonReentrant {
        uint256 amount = _pending[msg.sender];
        uint64 readyAt = _readyAt[msg.sender];
        if (amount == 0) revert NothingPending();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < readyAt) revert CooldownActive(readyAt);
        _pending[msg.sender] = 0;
        _readyAt[msg.sender] = 0;
        mochi.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @inheritdoc IMochiStaking
    function notifyReward(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _checkpoint(address(0));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        // Everything is SCALE-scaled (USDG has 6 decimals, so an unscaled per-second rate for a per-verdict fee would
        // round to 0): the unstreamed rest of the current period, the new amount and the carry are re-streamed
        // exactly, and the rate's truncation remainder (< duration / 1e18 base units) is carried again.
        // forge-lint: disable-next-line(block-timestamp)
        uint256 remaining = block.timestamp < periodFinish ? uint256(periodFinish - uint64(block.timestamp)) : 0;
        uint256 leftover = remaining * rewardRate;
        uint256 added = amount * SCALE + _undistributedScaled;
        uint256 distribution = added + leftover;
        // notifyReward is permissionless (QueryEscrow and the Feeds treasury both call it), so a notify must not cheaply
        // push the rewards already streaming further out. The new finish is the reward-weighted mean of the current
        // finish (for the leftover) and now + rewardDuration (for the new amount and the carry), floored: a dust notify
        // moves it by less than a second, i.e. not at all, and a notify as large as the leftover moves it at most
        // halfway to now + rewardDuration, at the cost of paying stakers that much. It never moves earlier, and without
        // an active stream it is now + rewardDuration. duration >= min(remaining, rewardDuration) >= 1.
        // slither-disable-next-line divide-before-multiply -- floored to whole seconds; a weighted mean, not a share
        uint256 duration = (leftover * remaining + added * rewardDuration) / distribution;
        // slither-disable-next-line divide-before-multiply -- remainder kept in _undistributedScaled; exact
        uint256 rate = distribution / duration;
        rewardRate = rate;
        _undistributedScaled = distribution - rate * duration;
        lastUpdateTime = uint64(block.timestamp);
        periodFinish = (block.timestamp + duration).toUint64();
        emit RewardNotified(msg.sender, amount);
    }

    /// @inheritdoc IMochiStaking
    function lockForVote(address account, uint64 until) external override {
        if (!hasRole(LOCKER_ROLE, msg.sender)) revert Unauthorized(msg.sender);
        if (until > lockedUntil[account]) lockedUntil[account] = until;
        emit VoteLocked(account, lockedUntil[account]);
    }

    /// @inheritdoc IMochiStaking
    function claim() external override nonReentrant returns (uint256 amount) {
        _checkpoint(msg.sender);
        amount = rewards[msg.sender];
        rewards[msg.sender] = 0;
        if (amount != 0) usdg.safeTransfer(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount);
    }

    /// @notice GOVERNOR. Sends the whole USDG base units of `dust` to `to`. Dust is only ever the floored fractions
    ///         that no account can claim, so a sweep never touches accrued, streaming or undistributed rewards.
    function sweepDust(address to) external nonReentrant onlyRole(MochiRoles.GOVERNOR_ROLE) returns (uint256 amount) {
        // slither-disable-next-line divide-before-multiply -- sweeps whole units; the rest stays in dust
        amount = _dustScaled / PRECISION;
        _dustScaled -= amount * PRECISION;
        if (amount != 0) usdg.safeTransfer(to, amount);
        emit DustSwept(to, amount);
    }

    /// @notice Whole USDG base units floored away so far and claimable by no account (sweepable).
    function dust() external view returns (uint256) {
        return _dustScaled / PRECISION;
    }

    /// @inheritdoc IMochiStaking
    function undistributed() external view override returns (uint256) {
        return _undistributedScaled / SCALE;
    }

    /// @inheritdoc IMochiStaking
    function rewardPerToken() public view override returns (uint256) {
        uint64 applicable = _lastTimeRewardApplicable();
        if (totalStaked == 0 || applicable <= lastUpdateTime) return _rewardPerTokenStored;
        return _rewardPerTokenStored + uint256(applicable - lastUpdateTime) * rewardRate * SCALE / totalStaked;
    }

    /// @inheritdoc IMochiStaking
    function earned(address account) external view override returns (uint256) {
        return rewards[account] + stakeOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / PRECISION;
    }

    /// @inheritdoc IMochiStaking
    function pendingUnstake(address account) external view override returns (uint256 amount, uint64 readyAt) {
        return (_pending[account], _readyAt[account]);
    }

    /// @inheritdoc IMochiStaking
    function stakeAt(address account, uint48 timepoint) external view override returns (uint256) {
        _requirePastTimepoint(timepoint);
        return _stakeCheckpoints[account].upperLookupRecent(timepoint);
    }

    /// @inheritdoc IMochiStaking
    function totalStakedAt(uint48 timepoint) external view override returns (uint256) {
        _requirePastTimepoint(timepoint);
        return _totalStakedCheckpoints.upperLookupRecent(timepoint);
    }

    function _writeStakeCheckpoints(address account) private {
        uint48 timepoint = uint48(block.timestamp);
        // slither-disable-next-line unused-return -- push returns the previous and new values; not needed
        _stakeCheckpoints[account].push(timepoint, stakeOf[account].toUint208());
        // slither-disable-next-line unused-return -- push returns the previous and new values; not needed
        _totalStakedCheckpoints.push(timepoint, totalStaked.toUint208());
    }

    function _requirePastTimepoint(uint48 timepoint) private view {
        uint48 currentTimepoint = uint48(block.timestamp);
        if (timepoint >= currentTimepoint) revert FutureLookup(timepoint, currentTimepoint);
    }

    function _checkpoint(address account) private {
        uint64 applicable = _lastTimeRewardApplicable();
        if (applicable > lastUpdateTime) {
            uint256 streamed = uint256(applicable - lastUpdateTime) * rewardRate; // SCALE-scaled
            uint256 staked = totalStaked;
            if (staked == 0) {
                _undistributedScaled += streamed;
            } else {
                uint256 scaled = streamed * SCALE; // PRECISION-scaled
                // slither-disable-next-line divide-before-multiply -- floored remainder is added to dust
                uint256 increment = scaled / staked;
                _rewardPerTokenStored += increment;
                _dustScaled += scaled - increment * staked;
            }
            lastUpdateTime = applicable;
        }
        if (account != address(0)) {
            uint256 accrued = stakeOf[account] * (_rewardPerTokenStored - userRewardPerTokenPaid[account]);
            if (accrued != 0) {
                // slither-disable-next-line divide-before-multiply -- floored remainder is added to dust
                uint256 credit = accrued / PRECISION;
                rewards[account] += credit;
                _dustScaled += accrued - credit * PRECISION;
            }
            userRewardPerTokenPaid[account] = _rewardPerTokenStored;
        }
    }

    function _lastTimeRewardApplicable() private view returns (uint64) {
        // forge-lint: disable-next-line(block-timestamp)
        return uint64(block.timestamp) < periodFinish ? uint64(block.timestamp) : periodFinish;
    }
}
