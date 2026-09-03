// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivacyPoolShieldedPayments} from "@mochi/privacy/PrivacyPoolShieldedPayments.sol";
import {IPrivacyPool} from "ppcore/interfaces/IPrivacyPool.sol";
import {ProofLib} from "ppcore/contracts/lib/ProofLib.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";

contract AdapterPoolMock {
    MockUSDG public immutable token;
    uint256 public payout;
    IPrivacyPool.Withdrawal public lastWithdrawal;
    uint256 public calls;

    constructor(MockUSDG token_) { token = token_; }
    function ASSET() external view returns (address) { return address(token); }
    function setPayout(uint256 value) external { payout = value; }
    function withdraw(IPrivacyPool.Withdrawal memory w, ProofLib.WithdrawProof memory) external {
        lastWithdrawal = w;
        ++calls;
        if (payout != 0) token.transfer(msg.sender, payout);
    }
}

contract PrivacyPoolShieldedPaymentsTest is Test {
    MockUSDG token;
    AdapterPoolMock pool;
    PrivacyPoolShieldedPayments adapter;
    address constant ESCROW = address(0xE5C0);
    address constant RECIPIENT = address(0xBEEF);
    bytes32 constant CTX = bytes32(uint256(42));
    bytes32 constant NULLIFIER = bytes32(uint256(99));
    uint256 constant AMOUNT = 500;

    function setUp() public {
        token = new MockUSDG();
        pool = new AdapterPoolMock(token);
        adapter = new PrivacyPoolShieldedPayments(IPrivacyPool(address(pool)), token, ESCROW);
        token.mint(address(pool), 10_000);
        pool.setPayout(AMOUNT);
    }

    function _proof(address processooor, address recipient, bytes32 context, uint256 nullifier, uint256 amount)
        internal pure returns (bytes memory)
    {
        IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal(processooor, abi.encode(recipient, context));
        ProofLib.WithdrawProof memory p;
        p.pubSignals[1] = nullifier;
        p.pubSignals[2] = amount;
        return abi.encode(w, p);
    }

    function _spend(bytes memory proof) internal {
        vm.prank(ESCROW);
        adapter.spend(NULLIFIER, AMOUNT, RECIPIENT, CTX, proof);
    }

    function testOnlyEscrow() public {
        vm.expectRevert(PrivacyPoolShieldedPayments.OnlyEscrow.selector);
        adapter.spend(NULLIFIER, AMOUNT, RECIPIENT, CTX, _proof(address(adapter), RECIPIENT, CTX, uint256(NULLIFIER), AMOUNT));
    }

    function testWrongProcessooor() public {
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolShieldedPayments.WrongProcessooor.selector, address(1)));
        _spend(_proof(address(1), RECIPIENT, CTX, uint256(NULLIFIER), AMOUNT));
    }

    function testWrongDataBinding() public {
        vm.expectRevert(PrivacyPoolShieldedPayments.WrongWithdrawalData.selector);
        _spend(_proof(address(adapter), address(1), CTX, uint256(NULLIFIER), AMOUNT));
        vm.expectRevert(PrivacyPoolShieldedPayments.WrongWithdrawalData.selector);
        _spend(_proof(address(adapter), RECIPIENT, bytes32(uint256(1)), uint256(NULLIFIER), AMOUNT));
    }

    function testSignalMismatches() public {
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolShieldedPayments.NullifierSignalMismatch.selector, uint256(NULLIFIER), 7));
        _spend(_proof(address(adapter), RECIPIENT, CTX, 7, AMOUNT));
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolShieldedPayments.AmountSignalMismatch.selector, AMOUNT, 1));
        _spend(_proof(address(adapter), RECIPIENT, CTX, uint256(NULLIFIER), 1));
    }

    function testRejectsShortOrExcessPoolPayout() public {
        pool.setPayout(AMOUNT - 1);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolShieldedPayments.PoolBalanceMismatch.selector, AMOUNT, AMOUNT - 1));
        _spend(_proof(address(adapter), RECIPIENT, CTX, uint256(NULLIFIER), AMOUNT));
        pool.setPayout(AMOUNT + 1);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolShieldedPayments.PoolBalanceMismatch.selector, AMOUNT, AMOUNT + 1));
        _spend(_proof(address(adapter), RECIPIENT, CTX, uint256(NULLIFIER), AMOUNT));
    }

    function testSuccessfulSpendTransfersAndEmits() public {
        vm.expectEmit(true, true, false, true, address(adapter));
        emit PrivacyPoolShieldedPayments.ShieldedSpend(CTX, NULLIFIER, AMOUNT);
        _spend(_proof(address(adapter), RECIPIENT, CTX, uint256(NULLIFIER), AMOUNT));
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(pool.calls(), 1);
    }
}
