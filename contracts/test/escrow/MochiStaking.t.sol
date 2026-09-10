// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";

contract MochiStakingTest is Test {
    MockUSDG mochi;
    MockUSDG usdg;
    MochiStaking staking;
    address alice = address(0xA);
    address bob = address(0xB);

    function setUp() public {
        mochi = new MockUSDG();
        usdg = new MockUSDG();
        staking = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 3 days, 10);
        mochi.mint(alice, 1_000);
        mochi.mint(bob, 1_000);
        usdg.mint(address(this), 20_000_000);
        usdg.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        mochi.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        mochi.approve(address(staking), type(uint256).max);
    }

    function testSingleStakerEarnsAndClaims() public {
        vm.prank(alice);
        staking.stake(100);
        staking.notifyReward(5_000_000);
        assertEq(staking.earned(alice), 0);
        vm.warp(block.timestamp + 10);
        assertEq(staking.earned(alice), 5_000_000);
        vm.prank(alice);
        assertEq(staking.claim(), 5_000_000);
        assertEq(usdg.balanceOf(alice), 5_000_000);
        assertEq(staking.earned(alice), 0);
    }

    function testMultiStakerProRataRewards() public {
        vm.prank(alice);
        staking.stake(100);
        vm.prank(bob);
        staking.stake(300);
        staking.notifyReward(8_000_000);
        vm.warp(block.timestamp + 10);
        assertEq(staking.earned(alice), 2_000_000);
        assertEq(staking.earned(bob), 6_000_000);
    }

    function testRewardsWaitForFirstStakerThenDistributeOnNextNotify() public {
        uint256 time = block.timestamp + 10;
        staking.notifyReward(4_000_000);
        vm.warp(time);
        vm.prank(alice);
        staking.stake(100);
        assertEq(staking.undistributed(), 4_000_000);
        assertEq(staking.earned(alice), 0);
        staking.notifyReward(6_000_000);
        assertEq(staking.undistributed(), 0);
        time += 10;
        vm.warp(time);
        assertEq(staking.earned(alice), 10_000_000);
    }

    function testUnstakeStopsEarningAndCooldownProtectsWithdrawal() public {
        uint256 time = block.timestamp + 10;
        vm.prank(alice);
        staking.stake(100);
        staking.notifyReward(5_000_000);
        vm.warp(time);
        vm.prank(alice);
        staking.requestUnstake(40);
        staking.notifyReward(6_000_000);
        time += 10;
        vm.warp(time);
        assertEq(staking.earned(alice), 11_000_000);
        (uint256 pending, uint64 readyAt) = staking.pendingUnstake(alice);
        assertEq(pending, 40);
        vm.prank(alice);
        vm.expectRevert();
        staking.withdraw();
        vm.warp(readyAt);
        vm.prank(alice);
        staking.withdraw();
        assertEq(mochi.balanceOf(alice), 940);
        assertEq(staking.stakeOf(alice), 60);
    }

    function testNothingPendingAndInsufficientStake() public {
        vm.prank(alice);
        vm.expectRevert();
        staking.withdraw();
        vm.prank(alice);
        vm.expectRevert();
        staking.requestUnstake(1);
    }

    function testStakeCheckpointsTrackStakeAndUnstakeAtPastTimestamps() public {
        uint48 t1 = uint48(block.timestamp) + 100;
        vm.warp(t1);
        vm.prank(alice);
        staking.stake(100);

        vm.warp(uint256(t1) + 1);
        vm.prank(bob);
        staking.stake(50);
        uint48 t2 = t1 + 1;
        assertEq(staking.stakeAt(alice, t1), 100);
        assertEq(staking.stakeAt(bob, t1), 0);
        assertEq(staking.totalStakedAt(t1), 100);

        uint48 t3 = t2 + 1;
        vm.warp(t3);
        vm.prank(alice);
        staking.requestUnstake(40);
        assertEq(staking.stakeAt(alice, t3 - 1), 100);
        assertEq(staking.totalStakedAt(t3 - 1), 150);

        uint48 t4 = t3 + uint48(staking.cooldown());
        vm.warp(uint256(t3) + 1);
        assertEq(staking.stakeAt(alice, t3), 60);
        assertEq(staking.totalStakedAt(t3), 110);
        vm.warp(t4);
        vm.prank(alice);
        staking.withdraw();
        vm.warp(uint256(t4) + 1);
        assertEq(staking.stakeAt(alice, t4 - 1), 60);
        assertEq(staking.totalStakedAt(t4 - 1), 110);
        assertEq(staking.stakeAt(alice, t4), 60);
        assertEq(staking.totalStakedAt(t4), 110);
    }

    function testCheckpointsRejectCurrentAndFutureTimepoints() public {
        uint48 current = uint48(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IMochiStaking.FutureLookup.selector, current, current));
        staking.stakeAt(alice, current);
        vm.expectRevert(abi.encodeWithSelector(IMochiStaking.FutureLookup.selector, current + 1, current));
        staking.totalStakedAt(current + 1);

        vm.warp(uint256(current) + 1);
        assertEq(staking.stakeAt(alice, current), 0);
        assertEq(staking.totalStakedAt(current), 0);
    }

    function testJustInTimeStakerReceivesOnlyStreamedFirstInterval() public {
        MochiStaking longStream = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 3 days, 7 days);
        usdg.approve(address(longStream), type(uint256).max);
        vm.prank(alice);
        mochi.approve(address(longStream), type(uint256).max);
        vm.prank(bob);
        mochi.approve(address(longStream), type(uint256).max);
        vm.prank(alice);
        longStream.stake(100);
        vm.prank(bob);
        longStream.stake(100);
        longStream.notifyReward(7_000_000);
        uint256 time = block.timestamp + 1;
        vm.warp(time);
        assertLt(longStream.earned(bob), 7_000_000 / 1000);
    }

    function testLeftoverRollsIntoReplacementStream() public {
        vm.prank(alice);
        staking.stake(100);
        staking.notifyReward(1_000);
        uint256 time = block.timestamp + 5;
        vm.warp(time);
        staking.notifyReward(1_000);
        assertEq(staking.rewardRate(), 150e18); // scaled by 1e18
        time += 10;
        vm.warp(time);
        assertEq(staking.earned(alice), 2_000);
    }

    function testVoteLockBlocksUnstakeUntilLockHasPassed() public {
        vm.prank(alice);
        staking.stake(100);
        staking.grantRole(staking.LOCKER_ROLE(), address(this));
        uint64 until = uint64(block.timestamp + 100);
        staking.lockForVote(alice, until);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMochiStaking.StakeLocked.selector, until));
        staking.requestUnstake(1);
        uint256 time = uint256(until) + 1;
        vm.warp(time);
        vm.prank(alice);
        staking.requestUnstake(1);
    }

    /// Regression: with 6-decimal USDG and a 7-day stream, a typical per-verdict protocol fee (7,500 base units)
    /// used to produce rewardRate = 0 and strand the whole reward.
    function testSmallFeeOverSevenDaysIsNotStranded() public {
        MochiStaking weekly = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 7 days, 7 days);
        mochi.mint(alice, 1_000);
        vm.startPrank(alice);
        mochi.approve(address(weekly), 1_000);
        weekly.stake(1_000);
        vm.stopPrank();
        usdg.mint(address(this), 7_500);
        usdg.approve(address(weekly), 7_500);
        weekly.notifyReward(7_500);
        assertGt(weekly.rewardRate(), 0);
        uint256 start = block.timestamp;
        vm.warp(start + 7 days);
        assertApproxEqAbs(weekly.earned(alice), 7_500, 1);
        vm.prank(alice);
        assertApproxEqAbs(weekly.claim(), 7_500, 1);
    }
}
