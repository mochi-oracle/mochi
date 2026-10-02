// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MockMochi18} from "./MochiStakingPrecision.t.sol";

/// The governor dust sweep takes only floored fractions that no account can ever claim.
contract MochiStakingDustTest is Test {
    MockMochi18 mochi;
    MockUSDG usdg;
    MochiStaking staking;
    address[3] stakers = [address(0xA1), address(0xA2), address(0xA3)];
    uint256[3] stakes = [uint256(1e18 + 1), 3e18 + 7, 10_000_000e18];
    address governor = address(0x60F);
    address sink = address(0xD057);
    uint256 time;

    function setUp() public {
        time = 1_800_000_000;
        vm.warp(time);
        mochi = new MockMochi18();
        usdg = new MockUSDG();
        staking = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 7 days, 7 days);
        staking.grantRole(MochiRoles.GOVERNOR_ROLE, governor);
        for (uint256 i; i < 3; ++i) {
            mochi.mint(stakers[i], stakes[i]);
            vm.startPrank(stakers[i]);
            mochi.approve(address(staking), type(uint256).max);
            staking.stake(stakes[i]);
            vm.stopPrank();
        }
        usdg.mint(address(this), 1_000_000e6);
        usdg.approve(address(staking), type(uint256).max);
    }

    /// One week of hourly claims by every staker on a 1,000.000001 USDG stream; returns total claimed.
    function _streamWithHourlyClaims() private returns (uint256 paid) {
        staking.notifyReward(1_000e6 + 1);
        for (uint256 h; h < 7 * 24 + 1; ++h) {
            time += 1 hours;
            vm.warp(time);
            for (uint256 i; i < 3; ++i) {
                vm.prank(stakers[i]);
                paid += staking.claim();
            }
        }
    }

    function testSweepIsGovernorOnly() public {
        _streamWithHourlyClaims();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), MochiRoles.GOVERNOR_ROLE)
        );
        staking.sweepDust(sink); // DEFAULT_ADMIN alone is not enough
        vm.prank(stakers[2]);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stakers[2], MochiRoles.GOVERNOR_ROLE)
        );
        staking.sweepDust(sink);
    }

    function testSweepTakesOnlyDustAndEveryClaimStillPays() public {
        uint256 paid = _streamWithHourlyClaims();
        uint256 dust = staking.dust();
        assertGt(dust, 0); // three odd-sized stakers flooring every hour
        assertLe(dust, 3 * (7 * 24 + 1) + 1); // < 1 base unit per checkpoint
        vm.prank(governor);
        assertEq(staking.sweepDust(sink), dust);
        assertEq(usdg.balanceOf(sink), dust);
        assertEq(staking.dust(), 0);
        // Everyone was just paid through the end of the stream: what remains is exactly the carry plus any new dust.
        for (uint256 i; i < 3; ++i) {
            vm.prank(stakers[i]);
            paid += staking.claim();
            assertEq(staking.earned(stakers[i]), 0);
        }
        uint256 balance = usdg.balanceOf(address(staking));
        assertEq(balance, 1_000e6 + 1 - paid - dust);
        assertLt(balance - staking.undistributed() - staking.dust(), 2);
        // A second sweep cannot reach the carry.
        vm.prank(governor);
        staking.sweepDust(sink);
        assertGe(usdg.balanceOf(address(staking)), staking.undistributed());
    }

    function testDirectTransfersAndStreamingRewardsAreNotDust() public {
        staking.notifyReward(1_000e6);
        time += 3 days;
        vm.warp(time);
        assertTrue(usdg.transfer(address(staking), 5e6));
        assertEq(staking.dust(), 0); // nothing checkpointed yet, and stray transfers are not dust
        vm.prank(governor);
        assertEq(staking.sweepDust(sink), 0);
        uint256 owed;
        for (uint256 i; i < 3; ++i) owed += staking.earned(stakers[i]);
        assertApproxEqAbs(owed, uint256(1_000e6) * 3 / 7, 3);
    }

    /// Same token for stake and reward (as in StakeInvariant): a sweep never reaches staked principal.
    function testSweepNeverReachesPrincipalWhenStakeAndRewardShareAToken() public {
        MochiStaking shared = new MochiStaking(address(this), IERC20(address(usdg)), IERC20(address(usdg)), 1 days, 7 days);
        shared.grantRole(MochiRoles.GOVERNOR_ROLE, governor);
        usdg.mint(stakers[0], 333_333);
        usdg.mint(stakers[1], 777_777);
        vm.prank(stakers[0]);
        usdg.approve(address(shared), type(uint256).max);
        vm.prank(stakers[1]);
        usdg.approve(address(shared), type(uint256).max);
        vm.prank(stakers[0]);
        shared.stake(333_333);
        vm.prank(stakers[1]);
        shared.stake(777_777);
        usdg.approve(address(shared), type(uint256).max);
        shared.notifyReward(1_000_003);
        for (uint256 h; h < 8 * 24; ++h) {
            time += 1 hours;
            vm.warp(time);
            vm.prank(stakers[h % 2]);
            shared.claim();
        }
        vm.prank(governor);
        shared.sweepDust(sink);
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(stakers[i]);
            shared.claim();
            shared.requestUnstake(shared.stakeOf(stakers[i]));
            vm.stopPrank();
        }
        time += 1 days;
        vm.warp(time);
        vm.prank(stakers[0]);
        shared.withdraw();
        vm.prank(stakers[1]);
        shared.withdraw();
        assertEq(shared.totalStaked(), 0);
        assertLt(usdg.balanceOf(address(shared)), 3); // only sub-unit carry and new dust remain
    }
}
