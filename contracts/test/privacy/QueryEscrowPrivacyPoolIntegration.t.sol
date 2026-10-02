// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {QueryEscrow} from "@mochi/QueryEscrow.sol";
import {PrivacyPoolShieldedPayments} from "@mochi/privacy/PrivacyPoolShieldedPayments.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {ISchemaRegistry} from "@mochi/interfaces/ISchemaRegistry.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";
import {IPrivacyPool} from "ppcore/interfaces/IPrivacyPool.sol";
import {ProofLib} from "ppcore/contracts/lib/ProofLib.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {AdapterPoolMock} from "./PrivacyPoolShieldedPayments.t.sol";
import {MockRegistry} from "../escrow/mocks/MockRegistry.sol";
import {MockSchemas} from "../escrow/mocks/MockSchemas.sol";
import {MockRandomness} from "../escrow/mocks/MockRandomness.sol";
import {MockStaking} from "../escrow/mocks/MockStaking.sol";

contract QueryEscrowPrivacyPoolIntegrationTest is Test {
    uint256 constant INTAKE_PK = 0xA11CE;
    MockUSDG token;
    AdapterPoolMock pool;
    QueryEscrow escrow;
    MockRegistry registry;
    MockSchemas schemas;

    function setUp() public {
        token = new MockUSDG();
        pool = new AdapterPoolMock(token);
        registry = new MockRegistry();
        schemas = new MockSchemas();
        MockRandomness randomness = new MockRandomness();
        MockStaking staking = new MockStaking(token);
        escrow = new QueryEscrow(address(this), token, IJurorRegistry(address(registry)), ISchemaRegistry(address(schemas)), IRandomness(address(randomness)));
        schemas.setLatest(1, 1);
        address intake = vm.addr(INTAKE_PK);
        registry.setActive(intake, MochiTypes.Role.INTAKE, true);
        for (uint8 i; i < 9; ++i) registry.setPreset(i, address(uint160(0x100 + i)));
        for (uint8 i; i < 5; ++i) escrow.setClassPrice(MochiTypes.JurorClass(i), 100_000, 1_000);
        escrow.setStaking(IMochiStaking(address(staking)));
        escrow.setShielded(new PrivacyPoolShieldedPayments(IPrivacyPool(address(pool)), token, address(escrow)));
    }

    function testOpenShieldedCreditsQueryAndHoldsQuote() public {
        bytes32 docCommit = bytes32(uint256(111));
        uint64 nonce = 7;
        MochiTypes.Provenance memory prov = MochiTypes.Provenance(
            docCommit, 0, bytes32(uint256(9)), 0, 2, bytes32(0), address(this), 1, 1, bytes32(0), keccak256("payer key"),
            false, false, nonce, uint64(block.timestamp + 15 minutes)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), MochiTypes.hashProvenance(prov)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(INTAKE_PK, digest);
        bytes memory intakeSig = abi.encodePacked(r, s, v);
        MochiTypes.OpenParams memory params = MochiTypes.OpenParams(3, address(this));
        (uint256 jurorFees, uint256 protocolFee) = escrow.quote(1, 3, 2);
        uint256 total = jurorFees + protocolFee;
        bytes32 queryId = escrow.computeQueryId(address(this), docCommit, nonce);
        bytes32 nullifier = bytes32(uint256(888));
        IPrivacyPool.Withdrawal memory withdrawal = IPrivacyPool.Withdrawal(address(escrow.shielded()), abi.encode(address(escrow), queryId));
        ProofLib.WithdrawProof memory proof;
        proof.pubSignals[1] = uint256(nullifier);
        proof.pubSignals[2] = total;
        pool.setPayout(total);
        token.mint(address(pool), total);
        bytes memory encodedProof = abi.encode(withdrawal, proof);

        bytes32 opened = escrow.openShielded(params, prov, intakeSig, nullifier, encodedProof);
        assertEq(opened, queryId);
        assertEq(token.balanceOf(address(escrow)), total);
        assertEq(uint8(escrow.getQuery(queryId).status), uint8(MochiTypes.QueryStatus.OPEN));
    }
}
