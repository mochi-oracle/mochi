// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {PrivacyPoolShieldedPayments} from "@mochi/privacy/PrivacyPoolShieldedPayments.sol";
import {Entrypoint} from "ppcore/contracts/Entrypoint.sol";
import {PrivacyPoolComplex} from "ppcore/contracts/implementations/PrivacyPoolComplex.sol";
import {WithdrawalVerifier} from "ppcore/contracts/verifiers/WithdrawalVerifier.sol";
import {CommitmentVerifier} from "ppcore/contracts/verifiers/CommitmentVerifier.sol";
import {IEntrypoint} from "ppcore/interfaces/IEntrypoint.sol";
import {IPrivacyPool} from "ppcore/interfaces/IPrivacyPool.sol";
import {ProofLib} from "ppcore/contracts/lib/ProofLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract PrivacyPoolDeploymentTest is Test {
    MockUSDG token;
    IEntrypoint entrypoint;
    PrivacyPoolComplex pool;
    WithdrawalVerifier withdrawalVerifier;
    CommitmentVerifier commitmentVerifier;

    function setUp() public {
        token = new MockUSDG();
        Entrypoint implementation = new Entrypoint();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation), abi.encodeCall(Entrypoint.initialize, (address(this), address(this)))
        );
        entrypoint = IEntrypoint(address(proxy));
        withdrawalVerifier = new WithdrawalVerifier();
        commitmentVerifier = new CommitmentVerifier();
        pool = new PrivacyPoolComplex(
            address(entrypoint), address(withdrawalVerifier), address(commitmentVerifier), address(token)
        );
        entrypoint.registerPool(token, IPrivacyPool(address(pool)), 1, 0, 1_000);
    }

    function testRealDepositAndPostmanRootUpdate() public {
        uint256 depositAmount = 2_000;
        token.mint(address(this), depositAmount);
        token.approve(address(entrypoint), depositAmount);
        vm.expectEmit(true, false, false, false, address(pool));
        emit IPrivacyPool.Deposited(address(this), 0, 0, 0, 0);
        entrypoint.deposit(token, depositAmount, 123456);
        assertEq(pool.currentTreeSize(), 1);
        assertTrue(pool.currentRoot() != 0);
        assertEq(token.balanceOf(address(pool)), depositAmount);

        entrypoint.updateRoot(987654, "bafybeigdyrzt5sfp7udm7hu76uh3k3kq5u6ab7j3g4v2w5x6y7z8abcd");
        assertEq(entrypoint.latestRoot(), 987654);
    }

    function testRealPoolRejectsInvalidGroth16Proof() public {
        uint256 depositAmount = 2_000;
        token.mint(address(this), depositAmount);
        token.approve(address(entrypoint), depositAmount);
        entrypoint.deposit(token, depositAmount, 123456);
        entrypoint.updateRoot(987654, "bafybeigdyrzt5sfp7udm7hu76uh3k3kq5u6ab7j3g4v2w5x6y7z8abcd");

        PrivacyPoolShieldedPayments adapter =
            new PrivacyPoolShieldedPayments(IPrivacyPool(address(pool)), token, address(this));
        IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal(address(adapter), abi.encode(address(this), bytes32(uint256(7))));
        ProofLib.WithdrawProof memory p;
        p.pubSignals[1] = 99;
        p.pubSignals[2] = 100;
        p.pubSignals[3] = pool.currentRoot();
        p.pubSignals[5] = entrypoint.latestRoot();
        p.pubSignals[7] = uint256(keccak256(abi.encode(w, pool.SCOPE()))) %
            21888242871839275222246405745257275088548364400416034343698204186575808495617;
        vm.expectRevert(IPrivacyPool.InvalidProof.selector);
        adapter.spend(bytes32(uint256(99)), 100, address(this), bytes32(uint256(7)), abi.encode(w, p));
    }
}
