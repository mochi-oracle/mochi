// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IShieldedPayments} from "@mochi/interfaces/IShieldedPayments.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPrivacyPool} from "ppcore/interfaces/IPrivacyPool.sol";
import {ProofLib} from "ppcore/contracts/lib/ProofLib.sol";

/// @title PrivacyPoolShieldedPayments
/// @notice Adapts 0xbow Privacy Pools withdrawals to Mochi's shielded payment interface.
contract PrivacyPoolShieldedPayments is IShieldedPayments, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPrivacyPool public immutable pool;
    IERC20 public immutable usdg;
    address public immutable escrow;

    event ShieldedSpend(bytes32 indexed context, bytes32 nullifier, uint256 amount);

    error OnlyEscrow();
    error ZeroAddress();
    error WrongPoolAsset(address expected, address actual);
    error WrongProcessooor(address actual);
    error WrongWithdrawalData();
    error NullifierSignalMismatch(uint256 expected, uint256 actual);
    error AmountSignalMismatch(uint256 expected, uint256 actual);
    error PoolBalanceMismatch(uint256 expected, uint256 actual);

    /// @notice Creates an immutable adapter bound to one USDG pool and QueryEscrow.
    constructor(IPrivacyPool pool_, IERC20 usdg_, address escrow_) {
        if (address(pool_) == address(0) || address(usdg_) == address(0) || escrow_ == address(0)) {
            revert ZeroAddress();
        }
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        address actualAsset = pool_.ASSET();
        if (actualAsset != address(usdg_)) revert WrongPoolAsset(address(usdg_), actualAsset);
        pool = pool_;
        usdg = usdg_;
        escrow = escrow_;
    }

    /// @inheritdoc IShieldedPayments
    function spend(bytes32 nullifier, uint256 amount, address recipient, bytes32 context, bytes calldata proof)
        external
        override
        nonReentrant
    {
        if (msg.sender != escrow) revert OnlyEscrow();

        (IPrivacyPool.Withdrawal memory withdrawal, ProofLib.WithdrawProof memory withdrawalProof) =
            abi.decode(proof, (IPrivacyPool.Withdrawal, ProofLib.WithdrawProof));

        if (withdrawal.processooor != address(this)) revert WrongProcessooor(withdrawal.processooor);
        if (keccak256(withdrawal.data) != keccak256(abi.encode(recipient, context))) revert WrongWithdrawalData();

        uint256 proofNullifier = withdrawalProof.pubSignals[1];
        if (proofNullifier != uint256(nullifier)) revert NullifierSignalMismatch(uint256(nullifier), proofNullifier);
        uint256 proofAmount = withdrawalProof.pubSignals[2];
        if (proofAmount != amount) revert AmountSignalMismatch(amount, proofAmount);

        // The balance delta is the check that the pool paid. pool.withdraw only staticcalls the Entrypoint and the
        // Groth16 verifier, then transfers USDG (no transfer hooks) to this adapter; spend is nonReentrant and
        // escrow-only, so nothing else can move this balance between the two reads.
        // slither-disable-next-line reentrancy-balance -- no reentrant path; the delta check is the defence
        uint256 balanceBefore = usdg.balanceOf(address(this));
        pool.withdraw(withdrawal, withdrawalProof);
        uint256 balanceAfter = usdg.balanceOf(address(this));
        uint256 received = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0;
        if (received != amount) revert PoolBalanceMismatch(amount, received);

        usdg.safeTransfer(recipient, amount);
        emit ShieldedSpend(context, nullifier, amount);
    }
}
