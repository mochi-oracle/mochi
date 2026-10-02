// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";

contract StakeHandler {
    MochiStaking public immutable staking;
    MockUSDG public immutable mochi;
    address[4] public actors;
    uint256 public rewardsNotified;
    uint256 public rewardsPaid;
    bool public lockedUnstakeSucceeded;

    constructor(MochiStaking staking_, MockUSDG mochi_) {
        staking = staking_;
        mochi = mochi_;
        mochi.mint(address(this), 1_000_000 ether);
        mochi.approve(address(staking), type(uint256).max);
        for (uint256 i; i < 4; ++i) {
            Actor actor = new Actor();
            actors[i] = address(actor);
            mochi.mint(actors[i], 1_000_000 ether);
            actor.approve(mochi, address(staking));
        }
    }

    function stake(uint8 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 4];
        uint256 amount = uint256(amountSeed) % (1_000 ether) + 1;
        Actor(actor).stake(staking, amount);
    }

    function requestUnstake(uint8 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 4];
        uint256 active = staking.stakeOf(actor);
        if (active == 0) return;
        uint256 amount = uint256(amountSeed) % active + 1;
        bool succeeded;
        try Actor(actor).requestUnstake(staking, amount) { succeeded = true; } catch {}
        if (block.timestamp <= staking.lockedUntil(actor) && succeeded) lockedUnstakeSucceeded = true;
    }

    function withdraw(uint8 actorSeed) external {
        try Actor(actors[actorSeed % 4]).withdraw(staking) {} catch {}
    }

    function notifyReward(uint96 amountSeed) external {
        uint256 amount = uint256(amountSeed) % (1_000 ether) + 1;
        staking.notifyReward(amount);
        rewardsNotified += amount;
    }

    function claimReward(uint8 actorSeed) external {
        rewardsPaid += Actor(actors[actorSeed % 4]).claim(staking);
    }

    function lockVote(uint8 actorSeed, uint32 secondsSeed) external {
        address actor = actors[actorSeed % 4];
        if (staking.stakeOf(actor) == 0) return;
        uint64 until = uint64(block.timestamp + uint256(secondsSeed % 1 days) + 1);
        staking.lockForVote(actor, until);
    }
}

contract Actor {
    function approve(MockUSDG token, address spender) external { token.approve(spender, type(uint256).max); }
    function stake(MochiStaking staking, uint256 amount) external { staking.stake(amount); }
    function requestUnstake(MochiStaking staking, uint256 amount) external { staking.requestUnstake(amount); }
    function withdraw(MochiStaking staking) external { staking.withdraw(); }
    function claim(MochiStaking staking) external returns (uint256) { return staking.claim(); }
}

contract StakeInvariantTest is Test {
    MockUSDG private token;
    MochiStaking private staking;
    StakeHandler private handler;
    Actor[4] private actors;

    function setUp() public {
        token = new MockUSDG();
        staking = new MochiStaking(address(this), token, token, 7 days, 7 days);
        handler = new StakeHandler(staking, token);
        staking.grantRole(staking.LOCKER_ROLE(), address(handler));
        for (uint256 i; i < 4; ++i) actors[i] = Actor(handler.actors(i));
        targetContract(address(handler));
    }

    function invariant_totalStakedEqualsSumOfStakeOf() public view {
        uint256 sum;
        for (uint256 i; i < 4; ++i) sum += staking.stakeOf(address(actors[i]));
        assertEq(staking.totalStaked(), sum);
    }

    function invariant_stakingDoesNotCreateRewards() public view {
        uint256 accounted = handler.rewardsPaid() + staking.undistributed();
        for (uint256 i; i < 4; ++i) accounted += staking.earned(address(actors[i]));
        uint64 finish = staking.periodFinish();
        if (finish > block.timestamp) {
            accounted += uint256(finish - uint64(block.timestamp)) * staking.rewardRate() / 1e18;
        }
        assertLe(accounted, handler.rewardsNotified());
    }

    function invariant_aVoteLockedStakeCannotBeRemovedBeforeExpiry() public view {
        assertFalse(handler.lockedUnstakeSucceeded());
    }
}
