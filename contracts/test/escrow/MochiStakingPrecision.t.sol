// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";

/// @notice 18-decimal stake token (MOCHI's real decimals); MockUSDG is the 6-decimal reward token.
contract MockMochi18 is ERC20 {
    constructor() ERC20("Mock MOCHI", "MOCHI") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Audit A-H1 PoC: with 6-decimal USDG rewards and 18-decimal MOCHI stake, a 1e18-scaled accumulator rounded every
/// checkpoint to zero at realistic stake sizes while `lastUpdateTime` advanced, stranding the whole reward.
contract MochiStakingPrecisionTest is Test {
    uint256 constant STAKE = 10_000_000e18; // 10M MOCHI
    uint256 constant WEEKLY = 1_000e6; // 1,000 USDG
    MockMochi18 mochi;
    MockUSDG usdg;
    MochiStaking staking;
    address alice = address(0xA11CE);
    address poker = address(0xF00D);

    function setUp() public {
        mochi = new MockMochi18();
        usdg = new MockUSDG();
        staking = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 7 days, 7 days);
        mochi.mint(alice, STAKE);
        vm.prank(alice);
        mochi.approve(address(staking), type(uint256).max);
        usdg.mint(address(this), 1_000_000e6);
        usdg.approve(address(staking), type(uint256).max);
    }

    /// Anyone's empty claim() is a checkpoint. Hourly checkpoints used to leave stakers with 0 of 1,000 USDG.
    function testHourlyEmptyClaimsDoNotStrandWeeklyReward() public {
        vm.prank(alice);
        staking.stake(STAKE);
        staking.notifyReward(WEEKLY);
        uint256 time = block.timestamp;
        for (uint256 i; i < 7 * 24; ++i) {
            time += 1 hours;
            vm.warp(time);
            vm.prank(poker);
            staking.claim();
        }
        // Bound: one base unit lost to the 1e18-scaled reward-rate floor plus one to alice's own floor.
        assertApproxEqAbs(staking.earned(alice), WEEKLY, 2);
        vm.prank(alice);
        assertApproxEqAbs(staking.claim(), WEEKLY, 2);
        assertApproxEqAbs(usdg.balanceOf(alice), WEEKLY, 2);
    }

    /// Each VERDICT notifies a small protocol-fee remainder; every notify is a checkpoint.
    function testPerVerdictNotifiesAtLargeStakeAreNotStranded() public {
        vm.prank(alice);
        staking.stake(STAKE);
        uint256 time = block.timestamp;
        uint256 notified;
        for (uint256 i; i < 7 * 24 * 6; ++i) {
            time += 10 minutes;
            vm.warp(time);
            staking.notifyReward(7_500);
            notified += 7_500;
        }
        time += 7 days; // let the final stream finish
        vm.warp(time);
        vm.prank(alice);
        uint256 paid = staking.claim();
        // Bound: alice's single per-claim floor plus the final stream's sub-unit remainder (carried, not lost).
        assertApproxEqAbs(paid + staking.undistributed(), notified, 2);
        assertGt(paid, notified - 2);
    }
}
