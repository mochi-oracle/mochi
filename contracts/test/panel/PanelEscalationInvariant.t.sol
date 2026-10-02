// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PanelEscalation} from "@mochi/PanelEscalation.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {FreezableUSDG, MockEscrow, MockVerdicts, MockRandomness} from "./mocks/PanelMocks.sol";

/// Drives PanelEscalation through random stake / unstake / withdraw / kick / prune / escalate / draw / reseal /
/// commit / abstain / reveal / resolve / appeal / finalize / expireDraw / claim sequences with time and block warps, frozen
/// recipients, reserve inflows and withdrawals, and minStake changes. It also models the review's attack shapes:
/// sybil bursts that stake and leave (dead positions), pending draws that nobody draws for a while (held cases keep
/// their seals frozen), top-ups that try to re-activate a kept position, and a look at each draw's panel once its seed
/// is public, which the seated panel must match.
contract PanelHandler is Test {
    PanelEscalation public immutable panel;
    FreezableUSDG public immutable token;
    uint256 public constant FEE = 9e6;
    uint256 public constant BASE_MIN = 100e6;
    uint256 public constant MAX_ACTORS = 160;
    address public constant PAYER = address(0xBEEF);
    address public constant SINK = address(0x5111C);
    // CaseStatus bit masks
    uint256 internal constant NONE = 1 << 0;
    uint256 internal constant DRAWING = 1 << 1;
    uint256 internal constant VOTING = (1 << 2) | (1 << 3);
    uint256 internal constant MAJORITY = 1 << 4;
    uint256 internal constant RESOLVED = (1 << 4) | (1 << 5);
    uint256 internal constant DRAW_EXPIRED = 1 << 8;

    address[] internal actors;
    bytes32[] internal queries;
    uint256 public minted;
    uint256 public stakedIn;
    uint256 public withdrawnOut;
    uint256 public donated;
    uint256 public reserveOut;
    uint256 public maxDrawGas;
    mapping(string => uint256) public calls;

    struct Vote {
        bytes32 answer;
        bytes32 payload;
        bytes32 salt;
    }

    mapping(bytes32 => mapping(uint8 => mapping(address => Vote))) internal votes;
    /// Held cases are skipped by draw and expireDraw, so their draw stays pending (and its seal frozen) for a while.
    mapping(bytes32 => bool) public held;
    /// Panel a draw will seat, computed on a snapshot once its seed was public: seal number => panel.
    mapping(uint64 => address[3]) internal expectedPanel;
    mapping(uint64 => bool) public hasExpected;
    uint256 public panelChecks;
    /// Violations seen by the handler. Recorded instead of asserted: with fail_on_revert off, a failed assertion in a
    /// handler call would only revert that call.
    uint256 public ineligibleSeats;
    uint256 public panelMismatches;
    /// Void panels (two or more abstentions) whose resolve changed any stake.
    uint256 public voidSlashes;

    constructor(PanelEscalation panel_, FreezableUSDG token_, bytes32[] memory queries_) {
        panel = panel_;
        token = token_;
        queries = queries_;
        for (uint256 i; i < 10; ++i) actors.push(address(uint160(0xA000 + i)));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function queryCount() external view returns (uint256) {
        return queries.length;
    }

    function queryAt(uint256 i) external view returns (bytes32) {
        return queries[i];
    }

    function _mint(address to, uint256 amount) internal {
        if (token.frozen(to)) return; // the issuer would refuse; the action then fails on its own transfer
        token.mint(to, amount);
        minted += amount;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// First case (starting at a seed-chosen offset) whose status is in `mask`; held cases are skipped.
    function _case(uint256 seed, uint256 mask) internal view returns (bytes32 q, IPanelEscalation.Case memory c, bool found) {
        uint256 n = queries.length;
        for (uint256 i; i < n; ++i) {
            q = queries[(seed % n + i) % n];
            c = panel.getCase(q);
            if (mask & (1 << uint8(c.status)) != 0 && !held[q]) return (q, c, true);
        }
    }

    /// After a call that may have seated `q`: every seat was eligible for the draw (active at its seal, warm, not on
    /// the prior panel), and the panel is the one its seed fixed (if it was looked at).
    function _checkSeated(bytes32 q, uint64 nonce, uint8 pi) internal {
        IPanelEscalation.Case memory c = panel.getCase(q);
        if (c.status != IPanelEscalation.CaseStatus.COMMIT || c.panelIndex != pi) return;
        IPanelEscalation.DrawState memory d = panel.drawStateOf(q);
        if (d.sealNonce != nonce) return;
        address[3] memory got = panel.panelOf(q, pi);
        address[3] memory prior;
        if (pi == 1) prior = panel.panelOf(q, 0);
        for (uint256 i; i < 3; ++i) {
            IPanelEscalation.Member memory m = panel.memberOf(got[i]);
            bool eligible = m.joinSeal < nonce && (m.exitSeal == 0 || m.exitSeal > nonce)
                && uint256(m.joinTicket) + d.warmup <= c.sealBlock;
            if (!eligible || got[i] == prior[0] || got[i] == prior[1] || got[i] == prior[2]) ++ineligibleSeats;
        }
        if (!hasExpected[nonce]) return;
        address[3] memory want = expectedPanel[nonce];
        if (got[0] != want[0] || got[1] != want[1] || got[2] != want[2]) ++panelMismatches;
        hasExpected[nonce] = false;
        ++panelChecks;
    }

    function _stake(address a, uint256 amount) internal {
        _mint(a, amount);
        vm.startPrank(a);
        token.approve(address(panel), amount);
        try panel.stake(amount) {
            stakedIn += amount;
            ++calls["stake"];
        } catch {}
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ evaluators

    /// Usually a stake that reaches minStake; sometimes dust, which must be refused.
    function stake(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 min = panel.minStake();
        uint256 floor = panel.stakeOf(a) >= min ? 1 : min - panel.stakeOf(a);
        _stake(a, amount % 3 == 0 ? bound(amount, 1, BASE_MIN) : bound(amount, floor, floor + 2 * BASE_MIN));
    }

    /// Grows the pool with fresh evaluators at the current minStake.
    function addCrowd(uint256 n) external {
        n = bound(n, 1, 8);
        for (uint256 i; i < n && actors.length < MAX_ACTORS; ++i) {
            address a = address(uint160(0xC0000 + actors.length));
            actors.push(a);
            _stake(a, panel.minStake());
        }
    }

    function requestUnstake(uint256 actorSeed, uint256 n) external {
        n = bound(n, 1, 3);
        for (uint256 i; i < n; ++i) {
            vm.prank(actors[(actorSeed % actors.length + i * 7) % actors.length]);
            try panel.requestUnstake() {
                ++calls["requestUnstake"];
            } catch {}
        }
    }

    /// Withdraws for an evaluator with a pending unstake; with `wait`, first lets its cooldown pass.
    function withdraw(uint256 actorSeed, bool wait) external {
        uint256 n = actors.length;
        for (uint256 i; i < n; ++i) {
            address a = actors[(actorSeed % n + i) % n];
            uint64 readyAt = panel.unstakeReadyAt(a);
            if (readyAt == 0) continue;
            if (wait && readyAt > block.timestamp) vm.warp(readyAt);
            if (readyAt > block.timestamp) continue;
            uint256 amount = panel.stakeOf(a);
            vm.prank(a);
            try panel.withdraw() {
                withdrawnOut += amount;
                ++calls["withdraw"];
            } catch {}
            return;
        }
    }

    /// Sybil burst: new evaluators stake minStake; with `leave` they request unstake in the same step (dead positions).
    function burst(uint256 n, bool leave) external {
        n = bound(n, 1, 24);
        for (uint256 i; i < n && actors.length < MAX_ACTORS; ++i) {
            address a = address(uint160(0xD0000 + actors.length));
            actors.push(a);
            _stake(a, panel.minStake());
            if (!leave) continue;
            vm.prank(a);
            try panel.requestUnstake() {
                ++calls["burstLeave"];
            } catch {}
        }
    }

    /// The most recently added evaluators request unstake: after a held seal, their positions stay kept (dead for
    /// every later draw) inside every frozen pool sealed meanwhile.
    function leaveRecent(uint256 n) external {
        n = bound(n, 1, 24);
        for (uint256 i = actors.length; i != 0 && n != 0; --i) {
            vm.prank(actors[i - 1]);
            try panel.requestUnstake() {
                ++calls["leaveRecent"];
                --n;
            } catch {}
        }
    }

    /// Top-up of an inactive evaluator that still has a position (kicked or slashed below minStake): re-activation is
    /// refused while a pending draw may pick that position.
    function restake(uint256 actorSeed) external {
        uint256 n = actors.length;
        for (uint256 i; i < n; ++i) {
            address a = actors[(actorSeed % n + i) % n];
            IPanelEscalation.Member memory m = panel.memberOf(a);
            if (m.position == 0 || m.exitSeal == 0 || panel.unstakeReadyAt(a) != 0) continue;
            uint256 min = panel.minStake();
            _stake(a, panel.stakeOf(a) >= min ? 1 : min - panel.stakeOf(a));
            return;
        }
    }

    function kick(uint256 actorSeed) external {
        uint256 n = actors.length;
        for (uint256 i; i < n; ++i) {
            address a = actors[(actorSeed % n + i) % n];
            if (panel.stakeOf(a) >= panel.minStake()) continue;
            try panel.kick(a) {
                ++calls["kick"];
                return;
            } catch {}
        }
    }

    function prune(uint256 n) external {
        try panel.prune(bound(n, 1, 32)) {
            ++calls["prune"];
        } catch {}
    }

    function claim(uint256 actorSeed) external {
        uint256 n = actors.length;
        for (uint256 i; i <= n; ++i) {
            address a = i == n ? PAYER : actors[(actorSeed % n + i) % n];
            if (panel.owed(a) == 0) continue;
            vm.prank(a);
            try panel.claim() {
                ++calls["claim"];
            } catch {}
            return;
        }
    }

    function freeze(uint256 actorSeed, bool frozen) external {
        token.setFrozen(actorSeed % 11 == 0 ? PAYER : _actor(actorSeed), frozen);
    }

    // ------------------------------------------------------------------ governance and reserve

    function setMinStake(uint256 amount) external {
        panel.setEconomics(bound(amount, BASE_MIN / 2, 2 * BASE_MIN), FEE);
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 50e6);
        _mint(address(panel), amount);
        donated += amount;
    }

    function withdrawReserve(uint256 amount) external {
        uint256 available = panel.reserveBalance();
        if (available == 0) return;
        amount = bound(amount, 1, available);
        panel.withdrawReserve(SINK, amount);
        reserveOut += amount;
    }

    // ------------------------------------------------------------------ cases

    function escalate(uint256 querySeed) external {
        (bytes32 q,, bool found) = _case(querySeed, NONE | DRAW_EXPIRED);
        if (!found) return;
        _mint(PAYER, FEE);
        vm.startPrank(PAYER);
        token.approve(address(panel), FEE);
        try panel.escalate(q) {
            ++calls["escalate"];
        } catch {}
        vm.stopPrank();
    }

    /// Escalates a case that nobody draws until it is released: its seal stays frozen while exits and joins go on.
    function hold(uint256 querySeed) external {
        (bytes32 q,, bool found) = _case(querySeed, NONE | DRAW_EXPIRED);
        if (!found) return;
        _mint(PAYER, FEE);
        vm.startPrank(PAYER);
        token.approve(address(panel), FEE);
        try panel.escalate(q) {
            held[q] = true;
            ++calls["hold"];
        } catch {}
        vm.stopPrank();
    }

    /// The review's front-run shape in one step: a held seal, then recent evaluators leave, then another case is sealed
    /// in the same block, so its frozen pool holds positions it can never pick (they left before its seal).
    function frontRun(uint256 holdSeed, uint256 leavers, uint256 querySeed) external {
        this.hold(holdSeed);
        this.leaveRecent(leavers);
        this.escalate(querySeed);
        ++calls["frontRun"];
    }

    function release() external {
        for (uint256 i; i < queries.length; ++i) held[queries[i]] = false;
    }

    function draw(uint256 querySeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, DRAWING);
        if (!found) return;
        if (block.number <= c.sealBlock) vm.roll(uint256(c.sealBlock) + 1);
        uint64 nonce = panel.drawStateOf(q).sealNonce;
        vm.cool(address(panel)); // each draw is its own transaction
        uint256 before = gasleft();
        try panel.draw(q) {
            ++calls["draw"];
        } catch {}
        uint256 used = before - gasleft();
        if (used > maxDrawGas) maxDrawGas = used;
        _checkSeated(q, nonce, c.panelIndex);
    }

    /// Once a draw's seed is public, computes on a snapshot the panel it will seat (drawing to the end).
    function peek(uint256 querySeed) external {
        uint256 n = queries.length;
        for (uint256 i; i < n; ++i) {
            bytes32 q = queries[(querySeed % n + i) % n];
            IPanelEscalation.Case memory c = panel.getCase(q);
            if (c.status != IPanelEscalation.CaseStatus.DRAWING) continue;
            IPanelEscalation.DrawState memory d = panel.drawStateOf(q);
            if (hasExpected[d.sealNonce] || d.eligible < 3 || block.timestamp > d.expiry) continue;
            if (d.seed == 0 && (block.number <= c.sealBlock || block.number > uint256(c.sealBlock) + 256)) continue;
            uint256 snap = vm.snapshotState();
            for (uint256 k; k < 64 && panel.getCase(q).status == IPanelEscalation.CaseStatus.DRAWING; ++k) panel.draw(q);
            address[3] memory want = panel.panelOf(q, c.panelIndex);
            vm.revertToStateAndDelete(snap);
            expectedPanel[d.sealNonce] = want;
            hasExpected[d.sealNonce] = true;
            ++calls["peek"];
            return;
        }
    }

    function reseal(uint256 querySeed) external {
        (bytes32 q,, bool found) = _case(querySeed, DRAWING);
        if (!found) return;
        vm.roll(block.number + 260);
        try panel.reseal(q) {
            ++calls["reseal"];
        } catch {}
    }

    function expireDraw(uint256 querySeed, bool late) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, DRAWING);
        if (!found) return;
        if (late && block.timestamp <= c.drawDeadline) vm.warp(uint256(c.drawDeadline) + 1);
        uint64 nonce = panel.drawStateOf(q).sealNonce;
        try panel.expireDraw(q) {
            ++calls["expireDraw"];
        } catch {}
        _checkSeated(q, nonce, c.panelIndex);
    }

    function _commit(bytes32 q, uint8 pi, address seat, uint256 answerSeed) internal {
        uint256 pick = answerSeed % 8;
        // Mostly agreeing answers; sometimes a zero answer, which reveal must reject.
        bytes32 answer = pick == 7 ? bytes32(0) : bytes32(pick % 3 + 1);
        bytes32 payload = keccak256(abi.encode(answer));
        bytes32 salt = keccak256(abi.encode(q, pi, seat, answerSeed));
        vm.prank(seat);
        try panel.commit(q, keccak256(abi.encode(q, pi, seat, answer, payload, salt))) {
            votes[q][pi][seat] = Vote(answer, payload, salt);
            ++calls["commit"];
        } catch {}
    }

    function _reveal(bytes32 q, uint8 pi, address seat) internal {
        Vote memory v = votes[q][pi][seat];
        if (v.salt == 0) return;
        vm.prank(seat);
        try panel.reveal(q, v.answer, v.payload, v.salt) {
            ++calls["reveal"];
        } catch {}
    }

    function commit(uint256 querySeed, uint256 seatSeed, uint256 answerSeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        _commit(q, c.panelIndex, panel.panelOf(q, c.panelIndex)[seatSeed % 3], answerSeed);
    }

    /// All three seats commit (each with its own answer drawn from a small set, so majorities are common).
    function commitAll(uint256 querySeed, uint256 answerSeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        address[3] memory seats = panel.panelOf(q, c.panelIndex);
        for (uint256 i; i < 3; ++i) _commit(q, c.panelIndex, seats[i], uint256(keccak256(abi.encode(answerSeed, i))));
    }

    function reveal(uint256 querySeed, uint256 seatSeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        _reveal(q, c.panelIndex, panel.panelOf(q, c.panelIndex)[seatSeed % 3]);
    }

    function revealAll(uint256 querySeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        address[3] memory seats = panel.panelOf(q, c.panelIndex);
        for (uint256 i; i < 3; ++i) _reveal(q, c.panelIndex, seats[i]);
    }

    function _abstain(bytes32 q, address seat) internal {
        vm.prank(seat);
        try panel.abstain(q) {
            ++calls["abstain"];
        } catch {}
    }

    /// One seat abstains (if it is still allowed to): alone it is slashed as a non-revealer at resolve.
    function abstain(uint256 querySeed, uint256 seatSeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        _abstain(q, panel.panelOf(q, c.panelIndex)[seatSeed % 3]);
    }

    /// Two seats abstain (materials could not be served to them), which voids the panel at resolve.
    function abstainTwo(uint256 querySeed, uint256 seatSeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        address[3] memory seats = panel.panelOf(q, c.panelIndex);
        _abstain(q, seats[seatSeed % 3]);
        _abstain(q, seats[(seatSeed % 3 + 1) % 3]);
    }

    function resolve(uint256 querySeed) external {
        (bytes32 q, IPanelEscalation.Case memory c, bool found) = _case(querySeed, VOTING);
        if (!found) return;
        uint256 stakedBefore = panel.totalStaked();
        try panel.resolve(q) {
            ++calls["resolve"];
            // Only a void panel ends in resolve: a first panel as DRAW_EXPIRED, an appeal as FINAL on panel 0.
            IPanelEscalation.CaseStatus s = panel.getCase(q).status;
            if (
                s == IPanelEscalation.CaseStatus.DRAW_EXPIRED
                    || (c.panelIndex == 1 && s == IPanelEscalation.CaseStatus.FINAL)
            ) {
                ++calls["void"];
                if (panel.totalStaked() != stakedBefore) ++voidSlashes;
            }
        } catch {}
    }

    function appeal(uint256 querySeed) external {
        (bytes32 q,, bool found) = _case(querySeed, MAJORITY);
        if (!found) return;
        _mint(PAYER, FEE);
        vm.startPrank(PAYER);
        token.approve(address(panel), FEE);
        try panel.appeal(q) {
            ++calls["appeal"];
        } catch {}
        vm.stopPrank();
    }

    function finalize(uint256 querySeed) external {
        (bytes32 q,, bool found) = _case(querySeed, RESOLVED);
        if (!found) return;
        try panel.finalize(q) {
            ++calls["finalize"];
        } catch {}
    }

    /// Mostly short steps (inside the 24h windows), sometimes long ones (past deadlines and cooldowns).
    function warp(uint256 secondsAhead, uint256 blocksAhead) external {
        uint256 step = secondsAhead % 4 == 0 ? bound(secondsAhead, 1 days, 8 days) : bound(secondsAhead, 1, 6 hours);
        vm.warp(block.timestamp + step);
        vm.roll(block.number + bound(blocksAhead, 0, 40));
    }
}

/// Invariants for PanelEscalation.
/// - USDG held = stakes + escrowed case fees + slashed pool + owed payouts + reserve, and it never goes insolvent.
/// - Stakes, fees, open-panel locks, pending draws and the pool index stay consistent with the cases.
/// - Draw cost stays under a fixed bound however the pool is shaped.
/// - No case can be stuck forever: after any sequence, permissionless calls plus time take every case to a terminal
///   state in a bounded number of steps, after which every evaluator can withdraw and every owed payout can be claimed.
/// - Every pending draw that can seat a panel still has exactly the eligible positions it counted at its seal, and a
///   panel seated after its seed was public is the one that seed fixed.
/// - A panel voided by two or more abstentions slashes nobody.
contract PanelEscalationInvariantTest is Test {
    uint256 internal constant DRAW_GAS_BOUND = 1_500_000;
    FreezableUSDG token;
    MockEscrow escrow;
    MockVerdicts verdicts;
    MockRandomness rng;
    PanelEscalation panel;
    PanelHandler handler;

    function setUp() public {
        token = new FreezableUSDG();
        escrow = new MockEscrow();
        verdicts = new MockVerdicts();
        rng = new MockRandomness();
        panel = new PanelEscalation(
            address(this),
            token,
            IQueryEscrow(address(escrow)),
            IMochiVerdicts(address(verdicts)),
            IRandomness(address(rng)),
            100e6,
            9e6
        );
        bytes32[] memory queries = new bytes32[](24);
        for (uint256 i; i < queries.length; ++i) {
            queries[i] = keccak256(abi.encode("invariant-query", i));
            MochiTypes.Query memory q;
            q.status = MochiTypes.QueryStatus.HUNG;
            q.isPublic = true;
            q.payer = address(0xBEEF);
            q.refundTo = address(0xBEEF);
            escrow.setQuery(queries[i], q);
        }
        handler = new PanelHandler(panel, token, queries);
        panel.grantRole(MochiRoles.GOVERNOR_ROLE, address(handler));
        for (uint256 i; i < 6; ++i) handler.stake(i, 100e6);
        vm.roll(block.number + 5);
        targetContract(address(handler));
    }

    function _terminal(IPanelEscalation.CaseStatus s) internal pure returns (bool) {
        return s == IPanelEscalation.CaseStatus.NONE || s == IPanelEscalation.CaseStatus.FINAL
            || s == IPanelEscalation.CaseStatus.DRAW_EXPIRED;
    }

    function invariant_usdgHeldEqualsLiabilitiesPlusReserve() public view {
        uint256 held = token.balanceOf(address(panel));
        uint256 liabilities = panel.totalStaked() + panel.escrowedCaseFees() + panel.slashedPool() + panel.totalOwed();
        assertGe(held, liabilities, "insolvent");
        assertEq(held, liabilities + panel.reserveBalance());
        // The reserve only grows by inflows and by slashes nobody earned, and only shrinks by governed withdrawals.
        uint256 slashedEver = handler.stakedIn() - handler.withdrawnOut() - panel.totalStaked();
        assertGe(panel.reserveBalance() + handler.reserveOut(), handler.donated());
        assertLe(panel.reserveBalance() + handler.reserveOut(), handler.donated() + slashedEver);
        // No USDG leaves the tracked accounts.
        uint256 tracked = held + token.balanceOf(handler.PAYER()) + token.balanceOf(handler.SINK());
        for (uint256 i; i < handler.actorCount(); ++i) tracked += token.balanceOf(handler.actorAt(i));
        assertEq(tracked, handler.minted());
    }

    function invariant_stakesFeesAndLocksMatchCases() public view {
        uint256 stakes;
        uint256 open;
        for (uint256 i; i < handler.actorCount(); ++i) {
            stakes += panel.stakeOf(handler.actorAt(i));
            open += panel.openPanels(handler.actorAt(i));
        }
        assertEq(stakes, panel.totalStaked());
        uint256 fees;
        uint256 drawing;
        uint256 seats;
        bool anyOpen;
        for (uint256 i; i < handler.queryCount(); ++i) {
            IPanelEscalation.Case memory c = panel.getCase(handler.queryAt(i));
            if (_terminal(c.status)) continue;
            anyOpen = true;
            fees += c.fee + (c.panelIndex == 1 ? handler.FEE() : 0);
            if (c.status == IPanelEscalation.CaseStatus.DRAWING) {
                ++drawing;
                seats += c.panelIndex == 1 ? 3 : 0;
            } else {
                seats += 3 * (uint256(c.panelIndex) + 1);
            }
        }
        assertEq(panel.escrowedCaseFees(), fees, "escrowed fees");
        assertEq(panel.pendingDraws(), drawing, "pending draws");
        assertEq(open, seats, "open panel locks");
        if (!anyOpen) assertEq(panel.slashedPool(), 0);
    }

    function invariant_poolIndexIsConsistent() public view {
        uint256 len = panel.poolLength();
        for (uint256 i; i < len; ++i) assertEq(uint256(panel.memberOf(panel.pool(i)).position), i + 1);
        uint256 active;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actorAt(i);
            IPanelEscalation.Member memory m = panel.memberOf(a);
            if (m.position != 0) assertEq(panel.pool(m.position - 1), a);
            if (m.position != 0 && m.exitSeal == 0) {
                ++active;
                assertEq(panel.unstakeReadyAt(a), 0);
                assertGt(panel.stakeOf(a), 0);
            }
        }
        assertEq(active, panel.activeEvaluators());
        assertGe(len, active);
    }

    /// Every seated panel was eligible at its seal (active at it, warm, not the prior panel), and a panel looked at
    /// once its seed was public is the panel that was seated.
    function invariant_seatedPanelsAreFixedAtTheSeal() public view {
        assertEq(handler.ineligibleSeats(), 0, "seated an evaluator that was not eligible at the seal");
        assertEq(handler.panelMismatches(), 0, "seated panel differs from the one its seed fixed");
    }

    /// Two or more abstentions void a panel without slashing anyone.
    function invariant_voidPanelsSlashNobody() public view {
        assertEq(handler.voidSlashes(), 0, "a void panel slashed a stake");
    }

    function invariant_drawCostIsBounded() public view {
        assertLe(handler.maxDrawGas(), DRAW_GAS_BOUND);
    }

    /// A pending draw that can seat a panel reads only positions whose eligibility is fixed: the eligible positions
    /// below its frozen pool length are exactly the ones it counted at its seal, and the seats it chose are among them.
    function invariant_pendingDrawEligibilityIsFixed() public view {
        uint256 len = panel.poolLength();
        for (uint256 i; i < handler.queryCount(); ++i) {
            bytes32 q = handler.queryAt(i);
            IPanelEscalation.Case memory c = panel.getCase(q);
            if (c.status != IPanelEscalation.CaseStatus.DRAWING) continue;
            IPanelEscalation.DrawState memory d = panel.drawStateOf(q);
            if (d.eligible < 3) continue;
            address[3] memory prior;
            if (c.panelIndex == 1) prior = panel.panelOf(q, 0);
            uint256 count;
            uint256 end = c.poolSize < len ? c.poolSize : len;
            for (uint256 p; p < end; ++p) {
                address e = panel.pool(p);
                if (e != prior[0] && e != prior[1] && e != prior[2] && _eligible(e, c, d)) ++count;
            }
            assertEq(count, d.eligible, "eligible positions of a pending draw changed");
            address[3] memory chosen = panel.panelOf(q, c.panelIndex);
            for (uint256 k; k < d.filled; ++k) assertTrue(_eligible(chosen[k], c, d), "chosen seat not eligible");
        }
    }

    function _eligible(address e, IPanelEscalation.Case memory c, IPanelEscalation.DrawState memory d)
        internal
        view
        returns (bool)
    {
        IPanelEscalation.Member memory m = panel.memberOf(e);
        return m.position != 0 && m.joinSeal < d.sealNonce && (m.exitSeal == 0 || m.exitSeal > d.sealNonce)
            && uint256(m.joinTicket) + d.warmup <= c.sealBlock;
    }

    /// The handler's abstain actions are reachable: a lone abstention is slashed, two void the panel, and the case can
    /// then be escalated again (all through the handler, as the fuzzer drives it).
    function test_handlerReachesAbstentionAndVoid() public {
        handler.escalate(0);
        bytes32 q = handler.queryAt(0);
        handler.draw(0);
        assertEq(uint8(panel.getCase(q).status), uint8(IPanelEscalation.CaseStatus.COMMIT));
        handler.abstainTwo(0, 0);
        assertEq(handler.calls("abstain"), 2);
        handler.resolve(0);
        assertEq(handler.calls("void"), 1);
        assertEq(uint8(panel.getCase(q).status), uint8(IPanelEscalation.CaseStatus.DRAW_EXPIRED));
        handler.escalate(0);
        handler.draw(0);
        address[3] memory seats = panel.panelOf(q, 0);
        handler.abstain(0, 1);
        handler.commit(0, 0, 1);
        handler.commit(0, 2, 1);
        handler.reveal(0, 0);
        handler.reveal(0, 2);
        handler.warp(4, 0); // a long step: past the reveal deadline
        handler.resolve(0);
        assertEq(handler.calls("void"), 1);
        assertEq(uint8(panel.getCase(q).status), uint8(IPanelEscalation.CaseStatus.RESOLVED_MAJORITY));
        assertLt(panel.stakeOf(seats[1]), 100e6, "the lone abstainer is slashed");
        assertEq(panel.stakeOf(seats[0]), 100e6);
        assertEq(handler.voidSlashes(), 0);
    }

    /// After every sequence: drive each case to a terminal state with permissionless calls only, then show that all
    /// stake and owed USDG can leave. Runs on a snapshot.
    function afterInvariant() external {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < handler.queryCount(); ++i) _driveToEnd(handler.queryAt(i));
        assertEq(panel.pendingDraws(), 0);
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(panel.slashedPool(), 0);
        // With no draw pending every kept position can go: the dead set is bounded by what pending draws can pick.
        while (panel.prune(256) != 0) {}
        assertEq(panel.poolLength(), panel.activeEvaluators(), "dead positions left with no draw pending");
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actorAt(i);
            assertEq(panel.openPanels(a), 0);
            token.setFrozen(a, false);
            if (panel.stakeOf(a) != 0 && panel.unstakeReadyAt(a) == 0) {
                vm.prank(a);
                panel.requestUnstake();
            }
        }
        token.setFrozen(handler.PAYER(), false);
        vm.warp(block.timestamp + panel.unstakeCooldown() + 1);
        for (uint256 i; i < n; ++i) {
            address a = handler.actorAt(i);
            if (panel.stakeOf(a) != 0) {
                vm.prank(a);
                panel.withdraw();
            }
            if (panel.owed(a) != 0) {
                vm.prank(a);
                panel.claim();
            }
        }
        if (panel.owed(handler.PAYER()) != 0) {
            vm.prank(handler.PAYER());
            panel.claim();
        }
        assertEq(panel.totalStaked(), 0);
        assertEq(panel.totalOwed(), 0);
        assertEq(panel.activeEvaluators(), 0);
        assertEq(panel.poolLength(), 0);
        assertEq(token.balanceOf(address(panel)), panel.reserveBalance());
        vm.revertToState(snap);
    }

    function _driveToEnd(bytes32 q) internal {
        for (uint256 step; step < 120; ++step) {
            IPanelEscalation.Case memory c = panel.getCase(q);
            if (_terminal(c.status)) return;
            if (c.status == IPanelEscalation.CaseStatus.DRAWING) {
                if (block.number <= c.sealBlock) vm.roll(uint256(c.sealBlock) + 1);
                IPanelEscalation.DrawState memory d = panel.drawStateOf(q);
                bool seedLost = d.seed == 0 && block.number > uint256(c.sealBlock) + 256;
                // A possible draw (enough eligible, before its expiry, seed not lost) must end seated, never expired.
                if (d.eligible >= 3 && block.timestamp <= d.expiry && !seedLost) {
                    panel.draw(q);
                    if (panel.getCase(q).status == IPanelEscalation.CaseStatus.DRAWING) continue;
                    assertEq(uint8(panel.getCase(q).status), uint8(IPanelEscalation.CaseStatus.COMMIT));
                    continue;
                }
                if (block.timestamp <= c.drawDeadline) vm.warp(uint256(c.drawDeadline) + 1);
                panel.expireDraw(q);
            } else if (c.status == IPanelEscalation.CaseStatus.COMMIT || c.status == IPanelEscalation.CaseStatus.REVEAL)
            {
                if (block.timestamp <= c.revealDeadline) vm.warp(uint256(c.revealDeadline) + 1);
                panel.resolve(q);
            } else {
                if (block.timestamp <= c.appealDeadline) vm.warp(uint256(c.appealDeadline) + 1);
                panel.finalize(q);
            }
        }
        assertTrue(_terminal(panel.getCase(q).status), "case is stuck");
    }
}
