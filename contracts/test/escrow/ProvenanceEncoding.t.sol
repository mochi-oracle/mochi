// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {QueryEscrowFixture} from "./QueryEscrow.t.sol";
import {ProvenanceHasher} from "./ProvenanceBinding.t.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

/// @notice The escrow's EIP-712 Provenance hash against forge's independent EIP-712 implementation, and the open
///         calldata decoding: non-canonical (dirty high bits) and truncated encodings of a signed grant never open.
///
///         `fetchedAt` is NEVER range-checked on chain: QueryEscrow neither reads nor stores it. It is covered only by
///         the intake signature (it is one of the hashed members), so its value is exactly what the attested intake
///         chose (0 for SUBMITTED, the fetch time for FETCHED). Consumers must not read it as an on-chain freshness
///         check; see docs/ARCHITECTURE.md (Provenance).
contract ProvenanceEncodingTest is QueryEscrowFixture {
    string constant PROVENANCE_TYPE =
        "Provenance(bytes32 docCommit,uint8 kind,bytes32 originId,uint64 fetchedAt,uint32 tokensK,bytes32 transcriptHash,address opener,uint32 schemaId,uint16 schemaVersion,bytes32 paramsHash,bytes32 payerCommit,bool isPublic,bool allowPanelDisclosure,uint64 nonce,uint64 expiry)";

    /// Word index of each narrow (non-32-byte) Provenance member, and its bit width.
    uint256[10] internal NARROW_WORDS = [uint256(1), 3, 4, 6, 7, 8, 11, 12, 13, 14];
    uint256[10] internal NARROW_BITS = [uint256(8), 64, 32, 160, 32, 16, 1, 1, 64, 64];

    // ───────────── EIP-712 parity with forge ─────────────

    function testTypeHashMatchesForge() public pure {
        assertEq(MochiTypes.PROVENANCE_TYPEHASH, vm.eip712HashType(PROVENANCE_TYPE));
    }

    function testDomainSeparatorMatchesEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MochiQueryEscrow"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.domainSeparator(), expected);
    }

    /// Any Provenance: the calldata and memory hashes the escrow uses equal forge's independent EIP-712 struct hash.
    function testFuzzEscrowHashMatchesForgeEip712HashStruct(MochiTypes.Provenance memory p) public {
        bytes32 forgeHash = vm.eip712HashStruct(PROVENANCE_TYPE, abi.encode(p));
        ProvenanceHasher hasher = new ProvenanceHasher();
        assertEq(hasher.calldataHash(p), forgeHash);
        assertEq(hasher.memoryHash(p), forgeHash);
        assertEq(MochiTypes.hashProvenance(p), forgeHash);
    }

    /// A grant signed over forge's struct hash opens, and the escrow records exactly that hash as provenanceHash.
    function testFuzzEscrowAcceptsGrantSignedOverForgeHash(
        bytes32 docCommit,
        bool fetched,
        bytes32 originId,
        uint64 fetchedAt,
        uint32 tokensK,
        bytes32 transcriptHash,
        bytes32 paramsHash,
        bytes32 payerCommit,
        bool isPublic,
        bool allowPanelDisclosure,
        uint64 nonce
    ) public {
        MochiTypes.Provenance memory p = MochiTypes.Provenance({
            docCommit: docCommit,
            kind: fetched ? 1 : 0,
            originId: originId,
            fetchedAt: fetchedAt,
            tokensK: uint32(bound(tokensK, 1, 100)),
            transcriptHash: transcriptHash,
            opener: address(this),
            schemaId: 1,
            schemaVersion: 1,
            paramsHash: paramsHash,
            payerCommit: payerCommit,
            isPublic: isPublic,
            allowPanelDisclosure: allowPanelDisclosure,
            nonce: nonce,
            expiry: uint64(block.timestamp + 15 minutes)
        });
        bytes32 structHash = vm.eip712HashStruct(PROVENANCE_TYPE, abi.encode(p));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(INTAKE_PK, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash)));
        bytes32 id = escrow.openWithUSDG(_params(3, address(this)), p, abi.encodePacked(r, s, v));
        assertEq(id, escrow.computeQueryId(address(this), docCommit, nonce));
        assertEq(id, keccak256(abi.encode(block.chainid, address(escrow), address(this), docCommit, nonce)));
        assertEq(escrow.getQuery(id).provenanceHash, structHash);
    }

    // ───────────── non-canonical and truncated calldata ─────────────

    function _grantCalldata(uint64 nonce) internal view returns (bytes memory data) {
        MochiTypes.Provenance memory p = _prov(keccak256(abi.encode("encoding doc", nonce)), 2, 1, nonce);
        p.fetchedAt = 1_700_000_000;
        p.transcriptHash = keccak256("tls transcript");
        p.allowPanelDisclosure = true;
        data = abi.encodeCall(IQueryEscrow.openWithUSDG, (_params(3, address(this)), p, _sig(p)));
    }

    /// Byte offset of head word `i` (OpenParams occupies words 0-1, the Provenance words 2-16).
    function _word(uint256 i) internal pure returns (uint256) {
        return 4 + 32 * i;
    }

    function _withWord(bytes memory data, uint256 wordIndex, uint256 value) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        uint256 offset = _word(wordIndex);
        assembly ("memory-safe") {
            mstore(add(add(out, 0x20), offset), value)
        }
    }

    function _readWord(bytes memory data, uint256 wordIndex) internal pure returns (uint256 value) {
        uint256 offset = _word(wordIndex);
        assembly ("memory-safe") {
            value := mload(add(add(data, 0x20), offset))
        }
    }

    /// The call reverts, either in ABI validation (empty revert data) or because the non-canonical words hash to
    /// something the intake never signed (BadIntakeSignature), and opens nothing.
    function _assertRejected(bytes memory data, string memory what) internal {
        (bool ok, bytes memory ret) = address(escrow).call(data);
        assertFalse(ok, what);
        assertTrue(ret.length == 0 || bytes4(ret) == IQueryEscrow.BadIntakeSignature.selector, what);
    }

    function testDirtyHighBitsInEveryNarrowMemberRevert() public {
        bytes memory clean = _grantCalldata(41);
        for (uint256 i; i < NARROW_WORDS.length; ++i) {
            uint256 word = 2 + NARROW_WORDS[i];
            uint256 value = _readWord(clean, word);
            // The first bit above the member's width, and the top bit of the word.
            _assertRejected(_withWord(clean, word, value | (uint256(1) << NARROW_BITS[i])), "first dirty bit");
            _assertRejected(_withWord(clean, word, value | (uint256(1) << 255)), "top dirty bit");
        }
        // OpenParams: n (uint8) and refundTo (address).
        _assertRejected(_withWord(clean, 0, _readWord(clean, 0) | (uint256(1) << 8)), "OpenParams.n");
        _assertRejected(_withWord(clean, 1, _readWord(clean, 1) | (uint256(1) << 160)), "OpenParams.refundTo");
        // The canonical encoding of the same grant opens.
        token.approve(address(escrow), type(uint256).max);
        (bool ok,) = address(escrow).call(clean);
        assertTrue(ok);
    }

    /// Every Provenance member is covered: dirty high bits anywhere change the signed hash (fetchedAt included,
    /// although nothing on chain ever reads or range-checks it).
    function testDirtyFetchedAtFailsTheSignatureNotARangeCheck() public {
        bytes memory clean = _grantCalldata(42);
        uint256 word = 2 + 3; // fetchedAt
        (bool ok, bytes memory ret) =
            address(escrow).call(_withWord(clean, word, _readWord(clean, word) | (uint256(1) << 64)));
        assertFalse(ok);
        assertEq(bytes4(ret), IQueryEscrow.BadIntakeSignature.selector);
    }

    /// Head: OpenParams (words 0-1), Provenance (2-16), signature offset (17); tail: signature length (18) and its 65
    /// bytes from word 19, zero-padded to 96. Any cut into that content reverts. (Dropping only the trailing zero
    /// padding still decodes to the very same grant and signature, which is not a different encoding of anything.)
    function testTruncatedCalldataReverts() public {
        bytes memory clean = _grantCalldata(43);
        assertEq(clean.length, _word(22));
        uint256[8] memory lengths = [
            uint256(4), // selector only
            _word(1), // inside OpenParams
            _word(2) + 7, // OpenParams and part of the first Provenance word
            _word(10), // half of the Provenance
            _word(17), // whole Provenance, no signature offset
            _word(18), // signature offset, no length
            _word(19), // signature length, no signature bytes
            _word(19) + 64 // one byte short of the signature
        ];
        for (uint256 i; i < lengths.length; ++i) {
            bytes memory cut = new bytes(lengths[i]);
            for (uint256 j; j < cut.length; ++j) {
                cut[j] = clean[j];
            }
            (bool ok,) = address(escrow).call(cut);
            assertFalse(ok, "truncated calldata must not open");
        }
        (bool opened,) = address(escrow).call(clean);
        assertTrue(opened);
    }

    /// fetchedAt is only signed, never range-checked: any value the intake signs opens, for either kind.
    function testFetchedAtIsNeverRangeCheckedOnChain() public {
        uint64[3] memory values = [uint64(0), uint64(1), type(uint64).max];
        for (uint256 i; i < values.length; ++i) {
            for (uint8 kind; kind < 2; ++kind) {
                MochiTypes.Provenance memory p = _prov(keccak256(abi.encode("fetchedAt", i, kind)), 2, kind, uint64(500 + 2 * i + kind));
                p.fetchedAt = values[i];
                bytes32 id = escrow.openWithUSDG(_params(3, address(this)), p, _sig(p));
                assertEq(uint8(escrow.getQuery(id).status), uint8(MochiTypes.QueryStatus.OPEN));
            }
        }
    }
}
