// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {QueryEscrowFixture} from "./QueryEscrow.t.sol";
import {QueryEscrow} from "@mochi/QueryEscrow.sol";
import {IShieldedPayments} from "@mochi/interfaces/IShieldedPayments.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A hostile shielded adapter. Instead of paying from a pool it tries to make QueryEscrow's balance-delta check
///         (`_spendShielded`) pass with USDG that QueryEscrow also credits elsewhere, or simply pays short.
contract HostileShieldedPayments is IShieldedPayments {
    using SafeERC20 for IERC20;

    enum Mode {
        PAY,
        SHORT,
        FUND_FEED_BUDGET,
        FUND_ANONYMA_FLOAT,
        CLAIM
    }

    IERC20 public immutable usdg;
    QueryEscrow public immutable escrow;
    Mode public mode;

    constructor(IERC20 usdg_, QueryEscrow escrow_) {
        usdg = usdg_;
        escrow = escrow_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function spend(bytes32, uint256 amount, address recipient, bytes32, bytes calldata) external {
        if (mode == Mode.PAY) {
            usdg.safeTransfer(recipient, amount);
        } else if (mode == Mode.SHORT) {
            // nosemgrep: basic-arithmetic-underflow -- amount is a non-zero quote; checked arithmetic anyway
            usdg.safeTransfer(recipient, amount - 1);
        } else if (mode == Mode.FUND_FEED_BUDGET) {
            // Would raise the escrow balance by `amount` while also crediting feedBudget: a double count.
            usdg.forceApprove(address(escrow), amount);
            escrow.fundFeedBudget(amount);
        } else if (mode == Mode.FUND_ANONYMA_FLOAT) {
            usdg.forceApprove(address(escrow), amount);
            escrow.fundAnonymaFloat(amount);
        } else {
            escrow.claim();
        }
    }
}

/// @notice Slither reports `reentrancy-balance` (High) on QueryEscrow._spendShielded: the USDG balance is read before
///         and after `shielded.spend`. These tests pin down why that is safe: every QueryEscrow function that credits
///         or moves USDG is nonReentrant, so the delta can only come from USDG that is not counted anywhere else, and
///         a short payment reverts.
contract ShieldedSpendReentrancyTest is QueryEscrowFixture {
    HostileShieldedPayments hostile;

    function _setUpHostile() internal {
        hostile = new HostileShieldedPayments(token, escrow);
        escrow.setShielded(hostile);
        token.mint(address(hostile), 10_000_000);
    }

    function _openHostile(uint64 nonce) internal returns (bytes32) {
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(500 + nonce)), 2, 0, nonce);
        return escrow.openShielded(_params(3, address(this)), p, _sig(p), bytes32(uint256(nonce)), "");
    }

    function testReenteringACreditingPathToDoubleCountReverts() public {
        _setUpHostile();
        HostileShieldedPayments.Mode[2] memory modes =
            [HostileShieldedPayments.Mode.FUND_FEED_BUDGET, HostileShieldedPayments.Mode.FUND_ANONYMA_FLOAT];
        for (uint64 i; i < modes.length; ++i) {
            hostile.setMode(modes[i]);
            MochiTypes.Provenance memory p = _prov(bytes32(uint256(600 + i)), 2, 0, i + 1);
            bytes memory sig = _sig(p);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            escrow.openShielded(_params(3, address(this)), p, sig, bytes32(uint256(i)), "");
        }
        assertEq(escrow.feedBudget(), 0);
        assertEq(escrow.anonymaFloat(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testReenteringAnOutflowDuringSpendReverts() public {
        _setUpHostile();
        hostile.setMode(HostileShieldedPayments.Mode.CLAIM);
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(700)), 2, 0, 7);
        bytes memory sig = _sig(p);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        escrow.openShielded(_params(3, address(this)), p, sig, bytes32(uint256(7)), "");
    }

    function testShortPaymentReverts() public {
        _setUpHostile();
        hostile.setMode(HostileShieldedPayments.Mode.SHORT);
        MochiTypes.Provenance memory p = _prov(bytes32(uint256(800)), 2, 0, 8);
        bytes memory sig = _sig(p);
        vm.expectRevert(QueryEscrow.ShieldedShortfall.selector);
        escrow.openShielded(_params(3, address(this)), p, sig, bytes32(uint256(8)), "");
    }

    function testExactPaymentIsFullyBackedByEscrowBalance() public {
        _setUpHostile();
        hostile.setMode(HostileShieldedPayments.Mode.PAY);
        bytes32 id = _openHostile(9);
        MochiTypes.Query memory q = escrow.getQuery(id);
        assertEq(q.paid, _quoteTotal(3, 2));
        // Nothing else is credited, so the escrow holds exactly what the query paid.
        assertEq(token.balanceOf(address(escrow)), q.paid + escrow.feedBudget() + escrow.anonymaFloat());
    }
}
