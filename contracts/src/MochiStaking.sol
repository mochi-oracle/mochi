// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title MochiStaking
/// @notice Stakes MOCHI and streams USDG rewards pro rata through an accumulator.
contract MochiStaking is IMochiStaking, ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;
    uint256 private constant SCALE = 1e18;
    bytes32 public constant LOCKER_ROLE = keccak256("mochi.role.LOCKER");

    IERC20 public immutable mochi;
    IERC20 public immutable usdg;
    uint64 public immutable override cooldown;
    uint64 public immutable override rewardDuration;
    uint256 public override totalStaked;
    uint256 private _rewardPerTokenStored;
    uint256 public override rewardRate;
    uint64 public override periodFinish;
    uint64 public lastUpdateTime;
    uint256 public override undistributed;
    mapping(address => uint256) public override stakeOf;
    mapping(address => Checkpoints.Trace208) private _stakeCheckpoints;
    Checkpoints.Trace208 private _totalStakedCheckpoints;
    mapping(address => uint256) private _pending;
    mapping(address => uint64) private _readyAt;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint64) public override lockedUntil;

    /// @notice Initializes stake/reward tokens, unstake cooldown, and stream duration (normally seven days).
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
        // forge-lint: disable-next-line(block-timestamp)
        // rewardRate is scaled by SCALE (1e18): USDG has 6 decimals, so an unscaled per-second rate for a typical
        // per-verdict fee (thousands of base units over a 7-day stream) would round to 0 and strand the reward.
        uint256 leftover = block.timestamp < periodFinish
            ? uint256(periodFinish - uint64(block.timestamp)) * rewardRate / SCALE
            : 0;
        uint256 distribution = amount + leftover + undistributed;
        rewardRate = distribution * SCALE / rewardDuration;
        // Carry the rounding remainder instead of dropping it.
        undistributed = distribution - rewardRate * rewardDuration / SCALE;
        lastUpdateTime = uint64(block.timestamp);
        periodFinish = uint64(block.timestamp) + rewardDuration;
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

    /// @inheritdoc IMochiStaking
    function rewardPerToken() public view override returns (uint256) {
        uint64 applicable = _lastTimeRewardApplicable();
        if (totalStaked == 0 || applicable <= lastUpdateTime) return _rewardPerTokenStored;
        return _rewardPerTokenStored + (uint256(applicable - lastUpdateTime) * rewardRate / totalStaked);
    }

    /// @inheritdoc IMochiStaking
    function earned(address account) external view override returns (uint256) {
        return rewards[account] + stakeOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / SCALE;
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
        _stakeCheckpoints[account].push(timepoint, stakeOf[account].toUint208());
        _totalStakedCheckpoints.push(timepoint, totalStaked.toUint208());
    }

    function _requirePastTimepoint(uint48 timepoint) private view {
        uint48 currentTimepoint = uint48(block.timestamp);
        if (timepoint >= currentTimepoint) revert FutureLookup(timepoint, currentTimepoint);
    }

    function _checkpoint(address account) private {
        uint64 applicable = _lastTimeRewardApplicable();
        if (applicable > lastUpdateTime) {
            uint256 elapsed = applicable - lastUpdateTime;
            if (totalStaked == 0) undistributed += elapsed * rewardRate / SCALE;
            else _rewardPerTokenStored += elapsed * rewardRate / totalStaked;
            lastUpdateTime = applicable;
        }
        if (account != address(0)) {
            rewards[account] += stakeOf[account] * (_rewardPerTokenStored - userRewardPerTokenPaid[account]) / SCALE;
            userRewardPerTokenPaid[account] = _rewardPerTokenStored;
        }
    }

    function _lastTimeRewardApplicable() private view returns (uint64) {
        // forge-lint: disable-next-line(block-timestamp)
        return uint64(block.timestamp) < periodFinish ? uint64(block.timestamp) : periodFinish;
    }
}
