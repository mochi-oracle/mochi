// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

/// @title IMochiStaking
/// @notice Stake $MOCHI, earn the USDG protocol-fee residual (reward-per-token accumulator, Synthetix-style).
interface IMochiStaking {
    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 readyAt);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardNotified(address indexed from, uint256 amount);
    event RewardClaimed(address indexed account, uint256 amount);
    event VoteLocked(address indexed account, uint64 until);

    error ZeroAmount();
    error InsufficientStake(uint256 requested, uint256 available);
    error CooldownActive(uint64 readyAt);
    error NothingPending();
    error StakeLocked(uint64 until);
    error Unauthorized(address caller);
    error InvalidRewardDuration();
    error FutureLookup(uint48 timepoint, uint48 now);

    function stake(uint256 amount) external;
    /// @notice Moves `amount` from active stake to pending; stops earning immediately; withdrawable after cooldown.
    ///         A new request adds to pending and resets the cooldown.
    function requestUnstake(uint256 amount) external;
    function withdraw() external;
    /// @notice Pulls `amount` USDG from msg.sender and streams it plus any active-period leftover and unstaked
    ///         elapsed rewards over `rewardDuration`. Accrual while totalStaked == 0 is carried in `undistributed`.
    function notifyReward(uint256 amount) external;
    function claim() external returns (uint256);
    function lockForVote(address account, uint64 until) external;

    function earned(address account) external view returns (uint256);
    function stakeOf(address account) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    /// @notice Returns active stake at a past timestamp; the current timestamp is not a past timepoint.
    function stakeAt(address account, uint48 timepoint) external view returns (uint256);
    /// @notice Returns total active stake at a past timestamp; the current timestamp is not a past timepoint.
    function totalStakedAt(uint48 timepoint) external view returns (uint256);
    function rewardPerToken() external view returns (uint256);
    /// @notice USDG per second scaled by 1e18 (so small per-verdict fees don't round to a zero rate).
    function rewardRate() external view returns (uint256);
    function periodFinish() external view returns (uint64);
    function undistributed() external view returns (uint256);
    function lockedUntil(address account) external view returns (uint64);
    function rewardDuration() external view returns (uint64);
    function pendingUnstake(address account) external view returns (uint256 amount, uint64 readyAt);
    function cooldown() external view returns (uint64);
}
