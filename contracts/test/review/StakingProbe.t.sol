// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MockMochi18} from "../escrow/MochiStakingPrecision.t.sol";

// Review probes for MochiStaking: exact conservation with totalStaked reaching 0 and back, extreme magnitudes, hook-token
// reentrancy, and the notify-stretch regression (a dust notifyReward used to restart the whole stream).

/// MochiStaking storage slots (forge inspect MochiStaking storageLayout).
library Slots {
    uint256 constant RPT = 3;
    uint256 constant UNDIST = 6;
    uint256 constant DUST = 7;
    uint256 constant PAID = 13; // userRewardPerTokenPaid
}

/// Extreme-value handler: totalStaked may go to 0 and back, stakes 1 wei..1e30, notifies 1..1e18 base units,
/// warps up to 400 days, governor sweeps at any time.
contract ProbeHandler is CommonBase, StdUtils {
    MochiStaking public immutable staking;
    MockMochi18 public immutable mochi;
    MockUSDG public immutable usdg;
    address[4] public actors = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];
    uint256 public time;
    uint256 public notified;
    uint256 public claimed;
    uint256 public swept;
    uint256 public zeroStakeSegments;

    constructor(MochiStaking s, MockMochi18 m, MockUSDG u) {
        staking = s; mochi = m; usdg = u;
        time = block.timestamp;
        for (uint256 i; i < 4; ++i) {
            mochi.mint(actors[i], 1e31);
            vm.prank(actors[i]);
            mochi.approve(address(staking), type(uint256).max);
        }
        usdg.mint(address(this), type(uint160).max);
        usdg.approve(address(staking), type(uint256).max);
    }

    function _adv(uint256 seed, uint256 max) private {
        time += bound(seed, 0, max);
        vm.warp(time);
        if (staking.totalStaked() == 0) ++zeroStakeSegments;
    }

    function stake(uint8 who, uint256 amount, uint32 dt) external {
        _adv(dt, 3 days);
        // log-uniform-ish: 1 wei .. 1e30
        uint256 exp = bound(amount, 0, 30);
        uint256 a = bound(amount >> 8, 1, 10 ** exp);
        vm.prank(actors[who % 4]);
        staking.stake(a);
    }

    function unstakeAll(uint8 who, uint32 dt) external {
        _adv(dt, 3 days);
        address a = actors[who % 4];
        uint256 s = staking.stakeOf(a);
        if (s == 0) return;
        vm.prank(a);
        staking.requestUnstake(s);
    }

    function unstakeSome(uint8 who, uint256 amount, uint32 dt) external {
        _adv(dt, 3 days);
        address a = actors[who % 4];
        uint256 s = staking.stakeOf(a);
        if (s == 0) return;
        vm.prank(a);
        staking.requestUnstake(bound(amount, 1, s));
    }

    function notifyReward(uint256 amount, uint32 dt) external {
        _adv(dt, 3 days);
        uint256 exp = bound(amount, 0, 18);
        uint256 a = bound(amount >> 8, 1, 10 ** exp);
        staking.notifyReward(a);
        notified += a;
    }

    function claim(uint8 who, uint32 dt) external {
        _adv(dt, 1 days);
        vm.prank(actors[who % 4]);
        claimed += staking.claim();
    }

    function sweep(uint32 dt) external {
        _adv(dt, 1 days);
        swept += staking.sweepDust(address(0xD057));
    }

    function warp(uint32 dt) external {
        _adv(dt, 400 days);
    }

    function actorList() external view returns (address[4] memory) { return actors; }
}

/// @notice Exact reward conservation, solvency and sweep-then-claim drain under extreme values (handler above). Actions
///         only take valid steps, so any revert is a failure (runs and depth come from foundry.toml).
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract StakingProbeInvariantTest is Test {
    MockMochi18 mochi;
    MockUSDG usdg;
    MochiStaking staking;
    ProbeHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        mochi = new MockMochi18();
        usdg = new MockUSDG();
        staking = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 7 days, 7 days);
        handler = new ProbeHandler(staking, mochi, usdg);
        staking.grantRole(MochiRoles.GOVERNOR_ROLE, address(handler));
        targetContract(address(handler));
    }

    function _load(uint256 slot) private view returns (uint256) {
        return uint256(vm.load(address(staking), bytes32(slot)));
    }

    function _paid(address a) private view returns (uint256) {
        return uint256(vm.load(address(staking), keccak256(abi.encode(a, Slots.PAID))));
    }

    /// Exact conservation in 1e36 units, no tolerance:
    /// notified == claimed + swept + Σ rewards + Σ stake·(rpt − paid) + undistributed + dust + rest of the stream.
    function invariant_exactConservation() public view {
        uint256 rpt = _load(Slots.RPT);
        uint256 lhs = handler.notified() * 1e36;
        uint256 rhs = (handler.claimed() + handler.swept()) * 1e36 + _load(Slots.UNDIST) * 1e18 + _load(Slots.DUST);
        address[4] memory a = handler.actorList();
        for (uint256 i; i < 4; ++i) {
            rhs += staking.rewards(a[i]) * 1e36 + staking.stakeOf(a[i]) * (rpt - _paid(a[i]));
        }
        uint64 finish = staking.periodFinish();
        uint64 last = staking.lastUpdateTime();
        if (finish > last) rhs += uint256(finish - last) * staking.rewardRate() * 1e18;
        assertEq(lhs, rhs, "exact accounting broken");
    }

    /// Everything anyone can claim, plus dust and carry, is backed by the balance.
    function invariant_solvent() public view {
        uint256 owed = staking.dust() + staking.undistributed();
        address[4] memory a = handler.actorList();
        for (uint256 i; i < 4; ++i) owed += staking.earned(a[i]);
        uint64 finish = staking.periodFinish();
        if (finish > block.timestamp) owed += (finish - block.timestamp) * staking.rewardRate() / 1e18;
        assertGe(usdg.balanceOf(address(staking)), owed, "insolvent");
        assertEq(usdg.balanceOf(address(staking)), handler.notified() - handler.claimed() - handler.swept());
    }

    /// Drain check: finish the stream, sweep first, then every actor's claim must still pay in full.
    function invariant_sweepThenEveryoneClaims() public {
        uint256 snap = vm.snapshotState();
        vm.warp(uint256(staking.periodFinish()) + 1 + block.timestamp);
        vm.prank(address(handler));
        staking.sweepDust(address(0xD057));
        address[4] memory a = handler.actorList();
        for (uint256 i; i < 4; ++i) {
            uint256 e = staking.earned(a[i]);
            vm.prank(a[i]);
            assertEq(staking.claim(), e);
        }
        vm.prank(address(handler));
        staking.sweepDust(address(0xD057));
        // Left: the carry (re-streamed by the next notify) plus sub-unit fractions.
        assertLe(usdg.balanceOf(address(staking)), staking.undistributed() + 2);
        vm.revertToState(snap);
    }
}

/// USDG stand-in with a transfer hook to probe reentrancy assumptions.
contract HookUSDG is ERC20 {
    address public hook;
    constructor() ERC20("Hook USDG", "hUSDG") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setHook(address h) external { hook = h; }
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hook != address(0) && (to == hook || from == hook)) Reenter(hook).onHook();
    }
}

interface Reenter { function onHook() external; }

contract Reenterer is Reenter {
    MochiStaking public staking;
    uint8 public mode;
    bytes public lastRevert;
    constructor(MochiStaking s) { staking = s; }
    function setMode(uint8 m) external { mode = m; }
    function doClaim() external { staking.claim(); }
    function doStake(IERC20 t, uint256 a) external { t.approve(address(staking), a); staking.stake(a); }
    function doNotify(IERC20 t, uint256 a) external { t.approve(address(staking), a); staking.notifyReward(a); }
    function onHook() external {
        if (mode == 1) staking.claim();
        else if (mode == 2) staking.notifyReward(1);
        else if (mode == 3) staking.stake(1);
    }
}

contract StakingProbeTest is Test {
    function _deploy(IERC20 stakeToken, IERC20 rewardToken, uint64 duration) private returns (MochiStaking s) {
        s = new MochiStaking(address(this), stakeToken, rewardToken, 7 days, duration);
        s.grantRole(MochiRoles.GOVERNOR_ROLE, address(this));
    }

    /// Extreme magnitudes: 1 wei .. 1e30 staked, 1 .. 1e24 base units, durations up to 366 days, checkpoints at random
    /// times. No overflow, the staker gets everything streamed to it minus at most 2 base units, and dust stays tiny.
    function testFuzz_extremeMagnitudes(uint256 stakeAmt, uint256 reward, uint64 duration, uint32 dt1, uint32 dt2) public {
        vm.warp(1_800_000_000);
        stakeAmt = bound(stakeAmt, 1, 1e30);
        reward = bound(reward, 1, 1e24);
        duration = uint64(bound(duration, 1, 366 days));
        MockMochi18 mochi = new MockMochi18();
        MockUSDG usdg = new MockUSDG();
        MochiStaking s = _deploy(IERC20(address(mochi)), IERC20(address(usdg)), duration);
        mochi.mint(address(0xA), stakeAmt);
        vm.startPrank(address(0xA));
        mochi.approve(address(s), stakeAmt);
        s.stake(stakeAmt);
        vm.stopPrank();
        usdg.mint(address(this), reward);
        usdg.approve(address(s), reward);
        s.notifyReward(reward);
        vm.warp(block.timestamp + bound(dt1, 0, duration));
        vm.prank(address(0xF00D));
        s.claim(); // bare checkpoint
        vm.warp(block.timestamp + bound(dt2, 0, 2 * uint256(duration)) + duration);
        vm.prank(address(0xA));
        uint256 got = s.claim();
        // Everything streamed is claimable by the sole staker up to the per-claim floor, the accumulator floor and the
        // rate truncation carry (which stays in `undistributed`).
        assertLe(got + s.undistributed() + s.dust(), reward);
        assertGe(got + s.undistributed() + s.dust() + 2, reward);
        assertLe(s.dust(), 2);
        uint256 d = s.dust();
        assertEq(s.sweepDust(address(0xD)), d);
        assertEq(usdg.balanceOf(address(s)), reward - got - d); // carry stays
    }

    /// totalStaked 0 -> non-zero mid-stream: the zero-stake segment is carried, the rest goes to the late staker.
    function testZeroThenNonZeroStake() public {
        vm.warp(1_800_000_000);
        MockMochi18 mochi = new MockMochi18();
        MockUSDG usdg = new MockUSDG();
        MochiStaking s = _deploy(IERC20(address(mochi)), IERC20(address(usdg)), 7 days);
        usdg.mint(address(this), 7_000_000);
        usdg.approve(address(s), type(uint256).max);
        s.notifyReward(7_000_000);
        vm.warp(block.timestamp + 3 days);
        mochi.mint(address(0xA), 1);
        vm.startPrank(address(0xA));
        mochi.approve(address(s), 1);
        s.stake(1); // a single wei of stake receives the whole remaining stream
        vm.stopPrank();
        assertEq(s.undistributed(), 3_000_000);
        vm.warp(1_800_000_000 + 13 days);
        vm.prank(address(0xA));
        uint256 got = s.claim();
        assertApproxEqAbs(got, 4_000_000, 1);
        assertEq(s.sweepDust(address(0xD)), 0);
        assertEq(usdg.balanceOf(address(s)), 7_000_000 - got); // carry is not sweepable, only re-streamed by notifyReward
        assertApproxEqAbs(s.undistributed(), 3_000_000, 1);
    }

    /// A hook token cannot re-enter any mutating entry point (claim, notifyReward, stake).
    function testHookTokenCannotReenter() public {
        vm.warp(1_800_000_000);
        HookUSDG usdg = new HookUSDG();
        MockMochi18 mochi = new MockMochi18();
        MochiStaking s = _deploy(IERC20(address(mochi)), IERC20(address(usdg)), 7 days);
        Reenterer r = new Reenterer(s);
        mochi.mint(address(r), 10e18);
        r.doStake(IERC20(address(mochi)), 10e18);
        usdg.mint(address(this), 1e12);
        usdg.approve(address(s), type(uint256).max);
        s.notifyReward(1e12);
        vm.warp(block.timestamp + 1 days);
        usdg.setHook(address(r));
        for (uint8 m = 1; m <= 3; ++m) {
            r.setMode(m);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            r.doClaim();
        }
        // notifyReward's transferFrom from a hooked sender: re-entry blocked too.
        r.setMode(0);
        usdg.mint(address(r), 1e6);
        r.setMode(1);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        r.doNotify(IERC20(address(usdg)), 1e6);
        r.setMode(0);
        r.doClaim();
        assertGt(usdg.balanceOf(address(r)), 0);
    }

    function _weeklyStream() private returns (MochiStaking s, MockUSDG usdg, uint256 finish) {
        vm.warp(1_800_000_000);
        MockMochi18 mochi = new MockMochi18();
        usdg = new MockUSDG();
        s = _deploy(IERC20(address(mochi)), IERC20(address(usdg)), 7 days);
        mochi.mint(address(0xA), 1e24);
        vm.startPrank(address(0xA));
        mochi.approve(address(s), 1e24);
        s.stake(1e24);
        vm.stopPrank();
        usdg.mint(address(this), 8_000e6);
        usdg.approve(address(s), type(uint256).max);
        s.notifyReward(7_000e6);
        finish = s.periodFinish();
    }

    /// Was: notifyReward(1) by anyone restarted the full rewardDuration over the leftover (the Synthetix trait), and an
    /// hourly poke left only 4,432.53 of 7,000 USDG paid out by the original finish (~63%, 1 - 1/e). The finish is now
    /// the reward-weighted mean of the current finish and now + rewardDuration, so a dust notify never moves it and
    /// the whole stream (plus the pokes) is paid on time.
    function testDustNotifyCannotStretchStream() public {
        (MochiStaking s,, uint256 finish) = _weeklyStream();
        uint256 t = 1_800_000_000;
        for (uint256 h = 1; h < 7 * 24; ++h) {
            t += 1 hours;
            vm.warp(t);
            s.notifyReward(1);
            assertEq(s.periodFinish(), finish, "dust moved the finish");
        }
        vm.warp(finish);
        uint256 e = s.earned(address(0xA));
        emit log_named_decimal_uint("earned by original finish (USDG)", e, 6);
        assertGe(e, 7_000e6);
        assertLe(e, 7_000e6 + 167);
    }

    /// Even a burst of 1,000 one-unit notifies in the stream's last second (several blocks share a timestamp) only
    /// holds back what was left to stream in that second: dust moves the finish only once the leftover is below about
    /// rewardDuration base units (here ~0.012 USDG).
    function testDustBurstInTheLastSecondHoldsBackOnlyThatSecond() public {
        (MochiStaking s,, uint256 finish) = _weeklyStream();
        vm.warp(finish - 1);
        uint256 lastSecond = s.rewardRate() / 1e18;
        for (uint256 i; i < 1_000; ++i) s.notifyReward(1);
        assertGt(s.periodFinish(), finish);
        vm.warp(finish);
        uint256 e = s.earned(address(0xA));
        assertGe(e + lastSecond + 1, 7_000e6);
        // A notify the size of the leftover does move it, at most halfway to now + rewardDuration, and pays for it.
        (MochiStaking s2,, uint256 finish2) = _weeklyStream();
        vm.warp(finish2 - 1 days);
        uint256 leftover = s2.rewardRate() * 1 days / 1e18;
        s2.notifyReward(leftover); // floored to whole base units, so a hair under the scaled leftover
        assertApproxEqAbs(s2.periodFinish(), block.timestamp + (1 days + 7 days) / 2, 1);
        assertLe(s2.periodFinish(), block.timestamp + (1 days + 7 days) / 2);
    }
}
