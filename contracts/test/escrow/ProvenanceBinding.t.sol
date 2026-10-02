// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {QueryEscrowFixture} from "./QueryEscrow.t.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

contract ProvenanceHasher {
    function calldataHash(MochiTypes.Provenance calldata p) external pure returns (bytes32) {
        return MochiTypes.hashProvenanceCalldata(p);
    }

    function memoryHash(MochiTypes.Provenance calldata p) external pure returns (bytes32) {
        return MochiTypes.hashProvenance(p);
    }
}

/// @notice Audit A-H2: the intake Provenance must be a single-use grant bound to its opener, payer commitment, params,
///         schema, consent flags, nonce and expiry. On the pre-fix code a (prov, intakeSig) pair copied from a victim's
///         public open transaction opened a query for anyone, any number of times, forever.
contract ProvenanceBindingTest is QueryEscrowFixture {
    address constant VICTIM = address(0xBEEF);
    address constant ATTACKER = address(0xBAD);
    bytes32 constant VICTIM_KEY_COMMIT = keccak256("victim result key");
    bytes32 constant ATTACKER_KEY_COMMIT = keccak256("attacker result key");

    function _fund(address who) internal {
        token.mint(who, 10_000_000);
        vm.prank(who);
        token.approve(address(escrow), type(uint256).max);
    }

    /// The victim's private grant, as the intake signs it after the victim sealed the binding with the document.
    function _victimGrant() internal view returns (MochiTypes.Provenance memory p, bytes memory sig) {
        p = _prov(keccak256("victim private document"), 2, 0, 1);
        p.opener = VICTIM;
        p.payerCommit = VICTIM_KEY_COMMIT;
        p.paramsHash = keccak256("victim params");
        p.schemaId = 1;
        sig = _sig(p);
    }

    function _victimOpens() internal returns (MochiTypes.Provenance memory p, bytes memory sig, bytes32 id) {
        (p, sig) = _victimGrant();
        _fund(VICTIM);
        vm.prank(VICTIM);
        id = escrow.openWithUSDG(_params(3, VICTIM), p, sig);
    }

    // ───────────── PoCs (fail on the pre-fix code, pass after) ─────────────

    function testPoC_ProvenanceReplayByAnotherOpenerIsRejected() public {
        (MochiTypes.Provenance memory p, bytes memory sig,) = _victimOpens();
        _fund(ATTACKER);
        // Verbatim copy of the victim's calldata, sent from the attacker's wallet.
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.NotAuthorized.selector, ATTACKER));
        escrow.openWithUSDG(_params(3, ATTACKER), p, sig);
        // Rewriting the grant to name the attacker (or their key, nonce, consent) breaks the intake signature.
        MochiTypes.Provenance memory forged = p;
        forged.opener = ATTACKER;
        forged.payerCommit = ATTACKER_KEY_COMMIT;
        forged.allowPanelDisclosure = true;
        forged.nonce = 7;
        vm.prank(ATTACKER);
        vm.expectRevert(IQueryEscrow.BadIntakeSignature.selector);
        escrow.openWithUSDG(_params(3, ATTACKER), forged, sig);
    }

    function testPoC_ReusedSignatureIsRejected() public {
        (MochiTypes.Provenance memory p, bytes memory sig, bytes32 id) = _victimOpens();
        // The same grant again: queryId is fixed by (opener, docCommit, nonce), so it can only ever open `id`.
        vm.prank(VICTIM);
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.QueryExists.selector, id));
        escrow.openWithUSDG(_params(3, VICTIM), p, sig);
        // A fresh nonce (or any other change) needs a fresh intake signature.
        p.nonce = 2;
        vm.prank(VICTIM);
        vm.expectRevert(IQueryEscrow.BadIntakeSignature.selector);
        escrow.openWithUSDG(_params(3, VICTIM), p, sig);
    }

    function testPoC_ExpiredSignatureIsRejected() public {
        MochiTypes.Provenance memory p = _prov(keccak256("old doc"), 2, 0, 9);
        bytes memory sig = _sig(p);
        vm.warp(uint256(p.expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.ProvenanceExpired.selector, p.expiry));
        escrow.openWithUSDG(_params(3, address(this)), p, sig);
    }

    // ───────────── binding details ─────────────

    function testGrantIsUsableUntilExpiryInclusive() public {
        MochiTypes.Provenance memory p = _prov(keccak256("edge doc"), 2, 0, 10);
        bytes memory sig = _sig(p);
        vm.warp(p.expiry);
        bytes32 id = escrow.openWithUSDG(_params(3, address(this)), p, sig);
        assertEq(uint8(escrow.getQuery(id).status), uint8(MochiTypes.QueryStatus.OPEN));
    }

    function testQueryTakesEveryBoundFieldFromTheSignedGrant() public {
        (MochiTypes.Provenance memory p,, bytes32 id) = _victimOpens();
        MochiTypes.Query memory q = escrow.getQuery(id);
        assertEq(id, escrow.computeQueryId(VICTIM, p.docCommit, p.nonce));
        assertEq(q.provenanceHash, MochiTypes.hashProvenance(p));
        assertEq(q.payer, VICTIM);
        assertEq(q.payerCommit, VICTIM_KEY_COMMIT);
        assertEq(q.paramsHash, p.paramsHash);
        assertEq(q.schemaId, p.schemaId);
        assertEq(q.schemaVersion, p.schemaVersion);
        assertEq(q.isPublic, p.isPublic);
        assertEq(q.allowPanelDisclosure, p.allowPanelDisclosure);
        assertEq(q.docCommit, p.docCommit);
        assertEq(q.tokensK, p.tokensK);
    }

    /// Changing any signed member after signing must not open a query.
    function testEverySignedMemberIsCovered() public {
        _fund(VICTIM);
        schemas.setLatest(2, 1);
        for (uint256 field; field < 15; ++field) {
            (MochiTypes.Provenance memory p, bytes memory sig) = _victimGrant();
            if (field == 0) p.docCommit = keccak256("other doc");
            else if (field == 1) p.kind = 1;
            else if (field == 2) p.originId = keccak256("other origin");
            else if (field == 3) p.fetchedAt = 1;
            else if (field == 4) p.tokensK = 1;
            else if (field == 5) p.transcriptHash = keccak256("other transcript");
            else if (field == 6) continue; // opener: covered by the replay PoC (NotAuthorized before the signature)
            else if (field == 7) p.schemaId = 2;
            else if (field == 8) continue; // schemaVersion: covered below (must also equal the registry's latest)
            else if (field == 9) p.paramsHash = keccak256("other params");
            else if (field == 10) p.payerCommit = ATTACKER_KEY_COMMIT;
            else if (field == 11) p.isPublic = true;
            else if (field == 12) p.allowPanelDisclosure = true;
            else if (field == 13) p.nonce = 99;
            else p.expiry = p.expiry + 1;
            vm.prank(VICTIM);
            vm.expectRevert(IQueryEscrow.BadIntakeSignature.selector);
            escrow.openWithUSDG(_params(3, VICTIM), p, sig);
        }
    }

    function testSchemaVersionMustMatchTheRegistry() public {
        MochiTypes.Provenance memory p = _prov(keccak256("versioned doc"), 2, 0, 11);
        p.schemaVersion = 2; // intake used a version governance has not activated (latest is 1)
        bytes memory sig = _sig(p);
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.SchemaNotActive.selector, uint32(1)));
        escrow.openWithUSDG(_params(3, address(this)), p, sig);
        schemas.setLatest(1, 2);
        bytes32 id = escrow.openWithUSDG(_params(3, address(this)), p, sig);
        assertEq(escrow.getQuery(id).schemaVersion, 2);
    }

    /// Every open path enforces the opener: shielded and voucher (relayer), and feeds (feed runner).
    function testEveryOpenPathRejectsAGrantIssuedForSomeoneElse() public {
        MochiTypes.Provenance memory p = _prov(keccak256("relayed doc"), 2, 0, 12);
        p.opener = VICTIM;
        bytes memory sig = _sig(p);
        uint256 cost = _quoteTotal(3, 2);

        shielded.fund(cost);
        bytes32 nullifier = keccak256("nullifier");
        bytes memory proof =
            abi.encode(nullifier, cost, address(escrow), escrow.computeQueryId(address(this), p.docCommit, p.nonce));
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.NotAuthorized.selector, address(this)));
        escrow.openShielded(_params(3, address(this)), p, sig, nullifier, proof);

        escrow.fundAnonymaFloat(cost);
        (MochiTypes.AnonymaVoucher memory v, bytes memory vSig) =
            _voucher(keccak256("voucher"), escrow.computeQueryId(address(this), p.docCommit, p.nonce), 1, 3, cost, uint64(block.timestamp + 1 days));
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.NotAuthorized.selector, address(this)));
        escrow.openWithVoucher(_params(3, address(this)), p, sig, v, vSig);

        escrow.grantRole(MochiRoles.FEED_RUNNER_ROLE, address(this));
        escrow.fundFeedBudget(cost);
        MochiTypes.Provenance memory f = _prov(keccak256("feed doc"), 2, 1, 13);
        f.opener = VICTIM;
        f.isPublic = true;
        bytes memory fSig = _sig(f);
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.NotAuthorized.selector, address(this)));
        escrow.openFeed(_params(3, address(this)), f, fSig);

        // The relayer the grant names can use it.
        f.opener = address(this);
        bytes32 feedId = escrow.openFeed(_params(3, address(this)), f, _sig(f));
        assertEq(uint8(escrow.getQuery(feedId).payPath), uint8(MochiTypes.PayPath.FEED));
    }

    function testFuzzCalldataHashMatchesEip712StructHash(MochiTypes.Provenance memory p) public {
        ProvenanceHasher hasher = new ProvenanceHasher();
        assertEq(hasher.calldataHash(p), hasher.memoryHash(p));
        assertEq(hasher.calldataHash(p), MochiTypes.hashProvenance(p));
    }
}
