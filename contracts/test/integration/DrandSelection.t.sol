// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "./utils/Harness.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {DrandRandomness} from "@mochi/DrandRandomness.sol";

contract DrandSelectionTest is Harness {
    uint64 private constant GENESIS = 1_000;
    string private vectors;
    DrandRandomness private drand;

    function _newRandomness() internal override returns (IRandomness) {
        vectors = vm.readFile("./test/fixtures/drand-vectors.json");
        drand = new DrandRandomness(vm.parseJsonBytes(vectors, "$.testKey.publicKeyG2"), GENESIS, 3, 2);
        return IRandomness(address(drand));
    }

    function testEscrowAndPanelSelectionUsePostedDrandTickets() public {
        bytes32 queryId = _open(1, 3, keccak256("drand integration"), false);
        MochiTypes.Query memory query = escrow.getQuery(queryId);
        assertEq(query.sealBlock, 2);
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedNotReady.selector, query.sealBlock, 0));
        escrow.seal(queryId);
        vm.expectRevert();
        escrow.reseal(queryId);
        assertFalse(drand.isExpired(query.sealBlock));

        vm.warp(GENESIS + 3);
        drand.postBeacon(query.sealBlock, _testSignature(query.sealBlock));
        bytes32 seed = drand.seed(keccak256(abi.encode(queryId, query.docCommit, query.round)), query.sealBlock);
        address[] memory previous = new address[](0);
        address[] memory expectedJurors = registry.selectJurors(address(escrow), queryId, seed, 0, query.n, previous);
        escrow.seal(queryId);
        address[] memory jurors = escrow.jurorsOf(queryId);
        assertEq(jurors.length, expectedJurors.length);
        for (uint256 i; i < jurors.length; ++i) assertEq(jurors[i], expectedJurors[i]);

        bytes32[9] memory answers;
        answers[0] = keccak256("A");
        answers[1] = answers[0];
        answers[2] = keccak256("B");
        _post(queryId, 2, 6666, 4, 0, bytes32(0), _votes(queryId, answers, 0));
        usdg.mint(address(this), 25 * USD);
        usdg.approve(address(panel), type(uint256).max);
        bytes32 caseId = panel.escalate(queryId);
        uint64 panelTicket = panel.getCase(caseId).sealBlock;
        assertEq(panelTicket, 4);
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedNotReady.selector, panelTicket, 2));
        panel.draw(caseId);
        vm.expectRevert();
        panel.reseal(caseId);
        assertFalse(drand.isExpired(panelTicket));

        vm.warp(GENESIS + 9);
        drand.postBeacon(panelTicket, _testSignature(panelTicket));
        panel.draw(caseId);
        address[3] memory panelists = panel.panelOf(caseId, 0);
        assertTrue(panelists[0] != address(0) && panelists[1] != address(0) && panelists[2] != address(0));
    }

    function _testSignature(uint64 round) private view returns (bytes memory) {
        return vm.parseJsonBytes(vectors, string.concat("$.testKey.rounds[", vm.toString(uint256(round) - 1), "].signature"));
    }
}
