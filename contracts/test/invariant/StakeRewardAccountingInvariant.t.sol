// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MockMochi18} from "../escrow/MochiStakingPrecision.t.sol";

/// @notice Drives MochiStaking with real decimals (18-decimal MOCHI stake, 6-decimal USDG rewards), a 10M MOCHI whale
///         that can leave and come back, an action that unstakes everyone (so totalStaked reaches 0 mid-stream and the
///         carry path runs), frequent checkpoints, and time warps that run streams past their end.
contract RewardAccountingHandler is CommonBase, StdUtils {
    MochiStaking public immutable staking;
    MockMochi18 public immutable mochi;
    MockUSDG public immutable usdg;
    address public constant WHALE = address(0x3A1E); // 10M MOCHI
    address public constant POKER = address(0x90CE); // never stakes; its claim() is a bare checkpoint
    address public constant SINK = address(0xD057);
    uint256 public constant WHALE_STAKE = 10_000_000e18;
    address[3] public actors = [address(0xA1), address(0xA2), address(0xA3)];
    uint256 public time;
    uint256 public notified;
    uint256 public claimed;
    uint256 public swept;
    uint256 public checkpoints;
    /// Calls that found nothing staked while a stream was running (that elapsed segment goes to the carry).
    uint256 public zeroStakeStreaming;
    /// Stakes that brought totalStaked back from 0.
    uint256 public returnsFromZero;

    constructor(MochiStaking staking_, MockMochi18 mochi_, MockUSDG usdg_) {
        staking = staking_;
        mochi = mochi_;
        usdg = usdg_;
        time = block.timestamp;
        for (uint256 i; i < 3; ++i) {
            mochi.mint(actors[i], 1_000_000_000e18);
            vm.prank(actors[i]);
            mochi.approve(address(staking), type(uint256).max);
        }
        mochi.mint(WHALE, WHALE_STAKE);
        vm.startPrank(WHALE);
        mochi.approve(address(staking), type(uint256).max);
        staking.stake(WHALE_STAKE);
        vm.stopPrank();
        usdg.mint(address(this), type(uint128).max);
        usdg.approve(address(staking), type(uint256).max);
    }

    function accounts() external view returns (address[5] memory all) {
        all = [actors[0], actors[1], actors[2], WHALE, POKER];
    }

    function _advance(uint256 seed, uint256 max) private {
        time += bound(seed, 0, max);
        vm.warp(time);
        if (staking.totalStaked() == 0 && staking.periodFinish() > staking.lastUpdateTime() && time > staking.lastUpdateTime()) {
            ++zeroStakeStreaming;
        }
    }

    function _stake(address who, uint256 amount) private {
        if (staking.totalStaked() == 0) ++returnsFromZero;
        vm.prank(who);
        staking.stake(amount);
        ++checkpoints;
    }

    function _unstakeAll(address who) private {
        uint256 active = staking.stakeOf(who);
        if (active == 0) return;
        vm.prank(who);
        staking.requestUnstake(active);
        ++checkpoints;
    }

    function stake(uint8 who, uint256 amount, uint32 dt) external {
        _advance(dt, 1 hours);
        // 1 wei up to 5M MOCHI: odd sizes maximize per-account flooring.
        _stake(actors[who % 3], bound(amount, 1, 5_000_000e18));
    }

    function requestUnstake(uint8 who, uint256 amount, uint32 dt) external {
        _advance(dt, 1 hours);
        address actor = actors[who % 3];
        uint256 active = staking.stakeOf(actor);
        if (active == 0) return;
        vm.prank(actor);
        staking.requestUnstake(bound(amount, 1, active));
        ++checkpoints;
    }

    /// Everyone (whale included) requests to unstake everything: totalStaked becomes 0.
    function exitAll(uint32 dt) external {
        _advance(dt, 1 hours);
        for (uint256 i; i < 3; ++i) _unstakeAll(actors[i]);
        _unstakeAll(WHALE);
    }

    /// While a stream runs, everyone leaves, time passes with nothing staked (that segment goes to the carry), and one
    /// actor stakes again: totalStaked reaches 0 and comes back within one call, whatever the sequence did before.
    function zeroAndBack(uint8 who, uint256 amount, uint32 dt) external {
        if (staking.periodFinish() <= time) {
            staking.notifyReward(1_000e6);
            notified += 1_000e6;
            ++checkpoints;
        }
        for (uint256 i; i < 3; ++i) _unstakeAll(actors[i]);
        _unstakeAll(WHALE);
        time += bound(dt, 1, 1 days);
        vm.warp(time);
        if (staking.periodFinish() > staking.lastUpdateTime()) ++zeroStakeStreaming;
        _stake(actors[who % 3], bound(amount, 1, 5_000_000e18));
    }

    /// The whale comes back with its full stake once its earlier withdrawal is through.
    function whaleReturns(uint32 dt) external {
        _advance(dt, 1 hours);
        (uint256 pending, uint64 readyAt) = staking.pendingUnstake(WHALE);
        if (pending != 0) {
            if (time < readyAt) return;
            vm.prank(WHALE);
            staking.withdraw();
        }
        uint256 idle = mochi.balanceOf(WHALE);
        if (idle == 0) return;
        _stake(WHALE, idle);
    }

    function withdraw(uint8 who, uint32 dt) external {
        _advance(dt, 1 hours);
        address actor = who % 4 == 3 ? WHALE : actors[who % 4];
        (uint256 pending, uint64 readyAt) = staking.pendingUnstake(actor);
        if (pending == 0 || time < readyAt) return;
        vm.prank(actor);
        staking.withdraw();
    }

    /// Per-verdict protocol-fee remainders: 1 base unit up to 1,000 USDG.
    function notifyReward(uint256 amount, uint32 dt) external {
        _advance(dt, 1 hours);
        amount = bound(amount, 1, 1_000e6);
        staking.notifyReward(amount);
        notified += amount;
        ++checkpoints;
    }

    function claim(uint8 who, uint32 dt) external {
        _advance(dt, 1 hours);
        address account = who % 4 == 3 ? WHALE : actors[who % 4];
        vm.prank(account);
        claimed += staking.claim();
        ++checkpoints;
    }

    function poke(uint32 dt) external {
        _advance(dt, 10 minutes);
        vm.prank(POKER);
        claimed += staking.claim();
        ++checkpoints;
    }

    function warp(uint32 dt) external {
        _advance(dt, 10 days);
    }

    function sweepDust(uint32 dt) external {
        _advance(dt, 1 hours);
        swept += staking.sweepDust(SINK);
    }
}

/// @notice Reward accounting with real decimals, exactly (storage) and through the views. Actions only take valid
///         steps, so any revert is a failure (runs and depth come from foundry.toml).
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract StakeRewardAccountingInvariantTest is Test {
    /// Fewer than one base unit is floored away by each view term summed below (5 `earned`, `undistributed`, `dust`,
    /// the unstreamed rest, the not-yet-checkpointed segment, and the view accumulator's floor), so the view identity
    /// notified == claimed + swept + Σ earned + undistributed + dust + unstreamed holds within 10 base units (0.00001
    /// USDG), independent of how many checkpoints ran. The storage-level identity below has no tolerance at all.
    uint256 private constant MAX_VIEW_FLOOR_LOSS = 10;
    uint256 private constant SCALE = 1e18;
    uint256 private constant PRECISION = 1e36;
    // MochiStaking storage slots (forge inspect MochiStaking storageLayout).
    uint256 private constant SLOT_RPT = 3;
    uint256 private constant SLOT_UNDISTRIBUTED = 6;
    uint256 private constant SLOT_DUST = 7;
    MockMochi18 private mochi;
    MockUSDG private usdg;
    MochiStaking private staking;
    RewardAccountingHandler private handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        mochi = new MockMochi18();
        usdg = new MockUSDG();
        staking = new MochiStaking(address(this), IERC20(address(mochi)), IERC20(address(usdg)), 7 days, 7 days);
        handler = new RewardAccountingHandler(staking, mochi, usdg);
        staking.grantRole(MochiRoles.GOVERNOR_ROLE, address(handler));
        targetContract(address(handler));
    }

    function _load(uint256 slot) private view returns (uint256) {
        return uint256(vm.load(address(staking), bytes32(slot)));
    }

    function _unaccrued() private view returns (uint256 amount) {
        uint256 finish = staking.periodFinish();
        uint256 rate = staking.rewardRate();
        uint256 nowTs = block.timestamp;
        if (finish > nowTs) amount = (finish - nowTs) * rate / 1e18;
        uint256 applicable = nowTs < finish ? nowTs : finish;
        uint256 last = staking.lastUpdateTime();
        // With nothing staked the elapsed segment is not in any earned() view yet; the next checkpoint carries it.
        if (staking.totalStaked() == 0 && applicable > last) amount += (applicable - last) * rate / 1e18;
    }

    function _accounted() private view returns (uint256 accounted) {
        accounted = handler.claimed() + handler.swept() + staking.undistributed() + staking.dust() + _unaccrued();
        address[5] memory all = handler.accounts();
        for (uint256 i; i < all.length; ++i) accounted += staking.earned(all[i]);
    }

    function invariant_distributedPlusUndistributedPlusDustEqualsNotified() public view {
        uint256 accounted = _accounted();
        uint256 notified = handler.notified();
        assertLe(accounted, notified, "staking promised more than it was notified");
        assertLt(notified - accounted, MAX_VIEW_FLOOR_LOSS, "rewards stranded beyond view flooring");
    }

    /// Exact, in 1e36 units, from storage as of the last checkpoint: every notified unit is claimed, swept, credited,
    /// owed through the accumulator, carried, dust, or still to stream. No tolerance.
    function invariant_exactIdentityAtLastCheckpoint() public view {
        uint256 rpt = _load(SLOT_RPT);
        uint256 rhs = (handler.claimed() + handler.swept()) * PRECISION + _load(SLOT_UNDISTRIBUTED) * SCALE
            + _load(SLOT_DUST);
        address[5] memory all = handler.accounts();
        for (uint256 i; i < all.length; ++i) {
            rhs += staking.rewards(all[i]) * PRECISION
                + staking.stakeOf(all[i]) * (rpt - staking.userRewardPerTokenPaid(all[i]));
        }
        uint64 finish = staking.periodFinish();
        uint64 last = staking.lastUpdateTime();
        if (finish > last) rhs += uint256(finish - last) * staking.rewardRate() * SCALE;
        assertEq(handler.notified() * PRECISION, rhs, "exact reward accounting broken");
    }

    function invariant_dustIsAtMostOneBaseUnitPerCheckpoint() public view {
        assertLe(staking.dust() + handler.swept(), handler.checkpoints());
    }

    function invariant_balanceCoversEveryClaimAfterSweeps() public view {
        uint256 balance = usdg.balanceOf(address(staking));
        assertEq(balance, handler.notified() - handler.claimed() - handler.swept());
        assertGe(balance, _accounted() - handler.claimed() - handler.swept());
    }

    /// The handler really reaches totalStaked == 0 mid-stream and comes back: the zero-stake segment is carried and
    /// the next notify re-streams it to the returning stakers, with both identities holding throughout.
    function testHandlerReachesZeroStakeAndComesBack() public {
        handler.notifyReward(700e6, 0);
        handler.exitAll(1 hours);
        assertEq(staking.totalStaked(), 0);
        handler.warp(2 days);
        assertGt(handler.zeroStakeStreaming(), 0);
        handler.poke(0); // checkpoint with nothing staked: the elapsed segment goes to the carry
        uint256 carried = staking.undistributed();
        assertApproxEqAbs(carried, 200e6, 1);
        invariant_exactIdentityAtLastCheckpoint();
        invariant_distributedPlusUndistributedPlusDustEqualsNotified();
        handler.stake(0, 1_000e18, 0);
        assertEq(handler.returnsFromZero(), 1);
        handler.notifyReward(1, 0); // re-streams the carry
        assertEq(staking.undistributed(), 0);
        handler.warp(7 days); // the whale's cooldown
        handler.whaleReturns(0);
        assertEq(staking.stakeOf(handler.WHALE()), handler.WHALE_STAKE());
        handler.warp(10 days);
        handler.claim(0, 0);
        handler.claim(3, 0);
        invariant_exactIdentityAtLastCheckpoint();
        invariant_distributedPlusUndistributedPlusDustEqualsNotified();
        invariant_balanceCoversEveryClaimAfterSweeps();
        // Everything but sub-unit floors reached the stakers (the whale's pre-exit share included).
        assertApproxEqAbs(handler.claimed(), handler.notified(), 2);
    }
}
