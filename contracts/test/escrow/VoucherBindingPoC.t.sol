// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";

/// @notice Anonyma vouchers must pay for exactly one query. Bound only to (docCommit, schemaId, n), a voucher for a
///         public document could be spent by anyone holding an intake grant for the same document, and an expansion
///         voucher could expand any HUNG voucher query on that document. Vouchers now name the queryId.
contract VoucherBindingPoCTest is Harness {
    function _signVoucher(MochiTypes.AnonymaVoucher memory v) private view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), MochiTypes.hashAnonymaVoucher(v)));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(anonymaPk, digest);
        return abi.encodePacked(r, s, vv);
    }

    function _cost(uint8 n) private view returns (uint256) {
        (uint256 jf, uint256 pf) = escrow.quote(1, n, 1);
        return jf + pf;
    }

    function testVoucherCannotPayForAnotherOpenersQuery() public {
        bytes32 doc = keccak256("public-filing"); // public: salt 0, so the commitment is predictable
        MochiTypes.Provenance memory victim = _provenance(doc, 0, bytes32(0), 1); // opener = this relayer
        bytes32 victimQuery = escrow.computeQueryId(address(this), doc, victim.nonce);
        MochiTypes.AnonymaVoucher memory v = MochiTypes.AnonymaVoucher(
            bytes32(uint256(victim.nonce)), victimQuery, 1, 3, _cost(3), 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory vs = _signVoucher(v);

        // Someone who sees the voucher gets their own grant for the same public document, with their own result key.
        address thief = makeAddr("voucher-thief");
        MochiTypes.Provenance memory stolen = _provenance(doc, 0, bytes32(0), 1);
        stolen.opener = thief;
        stolen.nonce = 99;
        stolen.isPublic = false;
        stolen.payerCommit = keccak256("thief-result-key");
        bytes memory stolenSig = _signProvenance(stolen);
        vm.prank(thief);
        vm.expectRevert(IQueryEscrow.VoucherMismatch.selector);
        escrow.openWithVoucher(MochiTypes.OpenParams(3, thief), stolen, stolenSig, v, vs);

        bytes32 id = escrow.openWithVoucher(MochiTypes.OpenParams(3, address(this)), victim, _signProvenance(victim), v, vs);
        assertEq(id, victimQuery);
        assertEq(uint8(escrow.getQuery(id).payPath), uint8(MochiTypes.PayPath.ANONYMA));
    }

    function testExpansionVoucherCannotExpandAnotherQuery() public {
        bytes32 doc = keccak256("public-filing-2");
        bytes32[2] memory ids;
        for (uint256 i; i < 2; ++i) {
            MochiTypes.Provenance memory p = _provenance(doc, 0, bytes32(0), 1);
            p.nonce = uint64(100 + i);
            MochiTypes.AnonymaVoucher memory open = MochiTypes.AnonymaVoucher(
                bytes32(uint256(100 + i)),
                escrow.computeQueryId(address(this), doc, p.nonce),
                1,
                3,
                _cost(3),
                1,
                uint64(block.timestamp + 1 days)
            );
            ids[i] = escrow.openWithVoucher(MochiTypes.OpenParams(3, address(this)), p, _signProvenance(p), open, _signVoucher(open));
            _seal(ids[i]);
            bytes32[9] memory answers;
            for (uint8 s; s < 3; ++s) answers[s] = keccak256(abi.encode("split", s));
            _post(ids[i], 2, 3333, 6, 0, bytes32(0), _votes(ids[i], answers, 0));
        }
        (uint256 jf, uint256 pf) = escrow.quoteExpansion(ids[0], 5);
        // Anonyma authorizes expanding the first query only.
        MochiTypes.AnonymaVoucher memory exp =
            MochiTypes.AnonymaVoucher(bytes32(uint256(200)), ids[0], 1, 5, jf + pf, 1, uint64(block.timestamp + 1 days));
        bytes memory expSig = _signVoucher(exp);
        vm.expectRevert(IQueryEscrow.VoucherMismatch.selector);
        escrow.expandWithVoucher(ids[1], 5, exp, expSig);
        escrow.expandWithVoucher(ids[0], 5, exp, expSig);
        assertEq(escrow.getQuery(ids[0]).n, 5);
        assertEq(escrow.getQuery(ids[1]).n, 3);
    }
}
