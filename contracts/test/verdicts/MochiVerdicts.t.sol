// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {MochiVerdicts} from "@mochi/MochiVerdicts.sol";
import {MockEscrow} from "./mocks/MockEscrow.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

contract MochiVerdictsTest is Test {
    uint256 constant CONS_KEY = 9001;
    address constant ADMIN = address(0xA11CE);
    address constant PANEL = address(0xBEEF);

    struct Fixture {
        MockEscrow escrow;
        MockRegistry registry;
        MochiVerdicts verdicts;
        address[] seats;
        uint256[] keys;
    }

    function _fixture(uint8 n, uint8 prevN) internal returns (Fixture memory f) {
        f.escrow = new MockEscrow();
        f.registry = new MockRegistry();
        f.verdicts =
            new MochiVerdicts(ADMIN, IQueryEscrow(address(f.escrow)), IJurorRegistry(address(f.registry)), PANEL);
        f.seats = new address[](n);
        f.keys = new uint256[](n);
        for (uint256 i; i < n; i++) {
            f.keys[i] = 100 + i;
            f.seats[i] = vm.addr(f.keys[i]);
            f.registry.setActive(f.seats[i], MochiTypes.Role.JUROR, true);
            // forge-lint: disable-next-line(unsafe-typecast)
            f.registry.setOperator(f.seats[i], address(uint160(0x1000 + i)));
        }
        f.registry.setActive(vm.addr(CONS_KEY), MochiTypes.Role.CONSENSUS, true);
        MochiTypes.Query memory q;
        q.docCommit = keccak256("doc");
        q.schemaId = 2;
        q.schemaVersion = 3;
        q.n = n;
        q.round = prevN == 0 ? 0 : 1;
        q.isPublic = true;
        q.status = MochiTypes.QueryStatus.SEALED;
        q.provenanceKind = MochiTypes.ProvenanceKind.FETCHED;
        q.originId = keccak256("origin");
        q.paramsHash = keccak256("params");
        q.provenanceHash = keccak256("provenance");
        q.payerCommit = keccak256("payer");
        f.escrow.setQuery(q, f.seats, prevN);
    }

    function _votes(Fixture memory f, uint32 timeoutMask) internal view returns (MochiTypes.JurorVote[] memory votes) {
        votes = new MochiTypes.JurorVote[](f.seats.length);
        for (uint256 i; i < f.seats.length; i++) {
            votes[i].juror = f.seats[i];
            // forge-lint: disable-next-line(unsafe-typecast)
            if ((timeoutMask & uint32(uint256(1) << i)) != 0) continue;
            votes[i].answerHash = keccak256(abi.encode("answer", i));
            votes[i].spansRoot = keccak256(abi.encode("span", i));
            votes[i].quoteHash = keccak256(abi.encode("quote", i));
            bytes32 sh = MochiTypes.hashJurorAnswer(
                keccak256("query"), keccak256("doc"), 2, 3, votes[i].answerHash, votes[i].spansRoot, votes[i].quoteHash
            );
            votes[i].sig = _sign(f.verdicts, f.keys[i], sh);
        }
    }

    function _sign(MochiVerdicts verdicts, uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", verdicts.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _input(uint8 n, uint8 round, uint8 status, uint16 bps, uint32 dissent, uint32 timeout)
        internal
        pure
        returns (MochiTypes.VerdictInput memory v)
    {
        v = MochiTypes.VerdictInput(
            keccak256("query"),
            round,
            status,
            bps,
            dissent,
            timeout,
            keccak256("answer-json"),
            status == 1 ? keccak256("payload") : bytes32(0),
            keccak256("evidence")
        );
        n;
    }

    function _post(Fixture memory f, MochiTypes.VerdictInput memory v, MochiTypes.JurorVote[] memory votes)
        internal
        returns (bytes32)
    {
        MochiTypes.JurorVote[] memory copied = votes;
        bytes32 vh = MochiTypes.hashVotes(copied);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", f.verdicts.domainSeparator(), MochiTypes.hashVerdictAttestation(v, vh))
        );
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(CONS_KEY, digest);
        return f.verdicts.post(v, votes, abi.encodePacked(r, s, sigV));
    }

    function _sigForKey(
        uint256 key,
        Fixture memory f,
        MochiTypes.VerdictInput memory v,
        MochiTypes.JurorVote[] memory votes
    ) internal view returns (bytes memory) {
        MochiTypes.JurorVote[] memory copied = votes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                f.verdicts.domainSeparator(),
                MochiTypes.hashVerdictAttestation(v, MochiTypes.hashVotes(copied))
            )
        );
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, sigV);
    }

    function _consensusSig(Fixture memory f, MochiTypes.VerdictInput memory v, MochiTypes.JurorVote[] memory votes)
        internal
        view
        returns (bytes memory)
    {
        MochiTypes.JurorVote[] memory copied = votes;
        bytes32 vh = MochiTypes.hashVotes(copied);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", f.verdicts.domainSeparator(), MochiTypes.hashVerdictAttestation(v, vh))
        );
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(CONS_KEY, digest);
        return abi.encodePacked(r, s, sigV);
    }

    function _expectPost(
        Fixture memory f,
        MochiTypes.VerdictInput memory v,
        MochiTypes.JurorVote[] memory votes,
        bytes4 errorSelector
    ) internal {
        bytes memory sig = _consensusSig(f, v, votes);
        (bool ok, bytes memory ret) = address(f.verdicts).call(abi.encodeCall(IMochiVerdicts.post, (v, votes, sig)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(ret), errorSelector);
    }

    function testPostN3StoresFieldsAndSettles() public {
        Fixture memory f = _fixture(3, 0);
        MochiTypes.JurorVote[] memory votes = _votes(f, 0);
        MochiTypes.VerdictInput memory v = _input(3, 0, 1, 10000, 0, 0);
        vm.expectEmit(true, true, false, true, address(f.verdicts));
        emit IMochiVerdicts.VerdictPosted(
            MochiTypes.computeVerdictId(v.queryId, 0), v.queryId, 0, 1, 10000, 0, 0, v.answerHash, v.payloadHash, true
        );
        bytes32 id = _post(f, v, votes);
        MochiTypes.Verdict memory stored = f.verdicts.getVerdict(id);
        assertEq(stored.docCommit, keccak256("doc"));
        assertEq(stored.schemaId, 2);
        assertEq(stored.schemaVersion, 3);
        assertTrue(stored.isPublic);
        assertEq(stored.paramsHash, keccak256("params"));
        assertEq(stored.provenanceHash, keccak256("provenance"));
        assertEq(stored.originId, keccak256("origin"));
        assertEq(stored.payerCommit, keccak256("payer"));
        assertEq(stored.modelSetHash, keccak256(abi.encode(f.seats)));
        bytes32[] memory quotes = new bytes32[](3);
        for (uint256 i; i < 3; i++) {
            quotes[i] = votes[i].quoteHash;
        }
        assertEq(stored.attestationRoot, keccak256(abi.encode(quotes)));
        assertEq(f.escrow.settledQuery(), v.queryId);
        assertEq(uint8(f.escrow.settledStatus()), 1);
        assertEq(f.registry.recordedKeys(0), f.seats[0]);
        assertEq(f.registry.recordedKeys(2), f.seats[2]);
        assertEq(f.verdicts.latestVerdictOf(v.queryId), id);
        assertTrue(f.verdicts.verify(id, bytes("answer-json")));
        assertFalse(f.verdicts.verify(id, bytes("bad")));
    }

    function testPostN5AndExpansionRecordsOnlyAddedSeats() public {
        Fixture memory f = _fixture(5, 3);
        MochiTypes.JurorVote[] memory votes = _votes(f, 8);
        MochiTypes.VerdictInput memory v = _input(5, 1, 1, 8000, 8, 8);
        bytes32 id = _post(f, v, votes);
        assertEq(f.verdicts.getVerdict(id).status, 1);
        assertEq(f.registry.recordedKeys(0), f.seats[3]);
        assertEq(f.registry.recordedKeys(1), f.seats[4]);
        assertEq(f.registry.recordedMask(), 1);
    }

    function testHungTimeoutAndPanelOutcome() public {
        Fixture memory f = _fixture(5, 0);
        MochiTypes.JurorVote[] memory votes = _votes(f, 1);
        MochiTypes.VerdictInput memory v = _input(5, 0, 1, 8000, 1, 1);
        bytes32 id = _post(f, v, votes);
        assertEq(f.escrow.settledMask(), 1);
        assertEq(f.registry.recordedMask(), 1);
        assertEq(f.verdicts.getVerdict(id).timeoutMask, 1);
        Fixture memory h = _fixture(3, 0);
        MochiTypes.JurorVote[] memory hv = _votes(h, 0);
        MochiTypes.VerdictInput memory hi = _input(3, 0, 2, 6666, 0, 0);
        _post(h, hi, hv);
        assertEq(uint8(h.escrow.settledStatus()), 2);
        MochiTypes.Query memory q = h.escrow.getQuery(bytes32(0));
        q.status = MochiTypes.QueryStatus.ESCALATED;
        h.escrow.setQuery(q, h.seats, 0);
        vm.prank(PANEL);
        bytes32 panelId = h.verdicts.postPanelOutcome(hi.queryId, keccak256("panel answer"), keccak256("panel payload"));
        assertTrue(h.verdicts.getVerdict(panelId).escalated);
        assertEq(h.escrow.decidedQuery(), hi.queryId);
    }

    function testValidationFailures() public {
        Fixture memory f = _fixture(3, 0);
        MochiTypes.JurorVote[] memory votes = _votes(f, 0);
        MochiTypes.VerdictInput memory v = _input(3, 0, 1, 10000, 0, 0);
        MochiTypes.Query memory q = f.escrow.getQuery(bytes32(0));
        q.status = MochiTypes.QueryStatus.OPEN;
        f.escrow.setQuery(q, f.seats, 0);
        _expectPost(f, v, votes, IMochiVerdicts.WrongQueryStatus.selector);
        q.status = MochiTypes.QueryStatus.SEALED;
        q.round = 1;
        f.escrow.setQuery(q, f.seats, 0);
        _expectPost(f, v, votes, IMochiVerdicts.WrongRound.selector);
        q.round = 0;
        address[] memory shortSeats = new address[](2);
        shortSeats[0] = f.seats[0];
        shortSeats[1] = f.seats[1];
        f.escrow.setQuery(q, shortSeats, 0);
        _expectPost(f, v, votes, IMochiVerdicts.SeatCountMismatch.selector);
        f.escrow.setQuery(q, f.seats, 0);
        votes[0].juror = f.seats[1];
        _expectPost(f, v, votes, IMochiVerdicts.SeatJurorMismatch.selector);
        votes = _votes(f, 0);
        votes[0].answerHash = keccak256("altered");
        _expectPost(f, v, votes, IMochiVerdicts.BadJurorSignature.selector);
        votes = _votes(f, 0);
        votes[0].sig = _sign(
            f.verdicts,
            5555,
            MochiTypes.hashJurorAnswer(
                v.queryId, keccak256("doc"), 2, 3, votes[0].answerHash, votes[0].spansRoot, votes[0].quoteHash
            )
        );
        _expectPost(f, v, votes, IMochiVerdicts.BadJurorSignature.selector);
        votes = _votes(f, 0);
        f.registry.setActive(f.seats[0], MochiTypes.Role.JUROR, false);
        _expectPost(f, v, votes, IMochiVerdicts.InactiveJuror.selector);
        f.registry.setActive(f.seats[0], MochiTypes.Role.JUROR, true);
        v.timeoutMask = 1;
        _expectPost(f, v, votes, IMochiVerdicts.TimeoutMaskMismatch.selector);
        votes = _votes(f, 1);
        v.timeoutMask = 0;
        _expectPost(f, v, votes, IMochiVerdicts.TimeoutMaskMismatch.selector);
        votes[0].answerHash = bytes32(uint256(1));
        v.timeoutMask = 1;
        _expectPost(f, v, votes, IMochiVerdicts.TimeoutMaskMismatch.selector);
        votes = _votes(f, 0);
        v.timeoutMask = 0;
        f.registry.setActive(vm.addr(CONS_KEY), MochiTypes.Role.CONSENSUS, false);
        _expectPost(f, v, votes, IMochiVerdicts.InactiveConsensusKey.selector);
        f.registry.setActive(vm.addr(CONS_KEY), MochiTypes.Role.CONSENSUS, true);
        v.agreementBps = 9999;
        _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
        v = _input(3, 0, 1, 10000, 0, 0);
        v.status = 0;
        _expectPost(f, v, votes, IMochiVerdicts.InvalidStatus.selector);
        v.status = 3;
        _expectPost(f, v, votes, IMochiVerdicts.InvalidStatus.selector);
    }

    function testEquivocationAndDuplicateAndPanelAuth() public {
        Fixture memory f = _fixture(3, 0);
        bytes32 qid = keccak256("query");
        bytes32 doc = keccak256("doc");
        bytes32[3] memory a = [keccak256("a"), keccak256("s"), keccak256("q")];
        bytes32[3] memory b = [keccak256("b"), keccak256("s"), keccak256("q")];
        bytes memory sigA = _sign(f.verdicts, f.keys[0], MochiTypes.hashJurorAnswer(qid, doc, 2, 3, a[0], a[1], a[2]));
        bytes memory sigSame =
            _sign(f.verdicts, f.keys[0], MochiTypes.hashJurorAnswer(qid, doc, 2, 3, a[0], a[1], a[2]));
        bytes memory sigB = _sign(f.verdicts, f.keys[0], MochiTypes.hashJurorAnswer(qid, doc, 2, 3, b[0], b[1], b[2]));
        vm.expectPartialRevert(IMochiVerdicts.NotEquivocation.selector);
        f.verdicts.reportEquivocation(qid, doc, 2, 3, a, sigA, a, sigSame);
        f.verdicts.reportEquivocation(qid, doc, 2, 3, a, sigA, b, sigB);
        assertEq(f.registry.slashed(), f.seats[0]);
        bytes memory otherSig =
            _sign(f.verdicts, f.keys[1], MochiTypes.hashJurorAnswer(qid, doc, 2, 3, b[0], b[1], b[2]));
        vm.expectPartialRevert(IMochiVerdicts.NotEquivocation.selector);
        f.verdicts.reportEquivocation(qid, doc, 2, 3, a, sigA, b, otherSig);
        MochiTypes.JurorVote[] memory votes = _votes(f, 0);
        MochiTypes.VerdictInput memory v = _input(3, 0, 1, 10000, 0, 0);
        _post(f, v, votes);
        _expectPost(f, v, votes, IMochiVerdicts.VerdictExists.selector);
        vm.expectPartialRevert(IMochiVerdicts.NotPanel.selector);
        f.verdicts.postPanelOutcome(qid, keccak256("a"), keccak256("p"));
    }

    function testConsensusAndStatusGuardsIncludingDroppedDissenter() public {
        Fixture memory f = _fixture(5, 0);
        MochiTypes.JurorVote[] memory votes = _votes(f, 0);
        MochiTypes.VerdictInput memory v = _input(5, 0, 1, 8000, 0, 0);
        bytes memory sig = _sigForKey(CONS_KEY, f, v, votes);
        vm.expectRevert();
        f.verdicts.post(v, votes, bytes("bad"));
        v.agreementBps = 8001;
        vm.expectRevert();
        f.verdicts.post(v, votes, sig);
        v.agreementBps = 8000;
        votes[4].sig = "";
        votes[4].answerHash = 0;
        votes[4].spansRoot = 0;
        votes[4].quoteHash = 0;
        v.timeoutMask = 16;
        v.dissentMask = 16;
        (bool ok, bytes memory ret) = address(f.verdicts).call(abi.encodeCall(IMochiVerdicts.post, (v, votes, sig)));
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(ret), IMochiVerdicts.InactiveConsensusKey.selector);
        votes = _votes(f, 3); // 3 timeouts leave fewer than k responding seats.
        v = _input(5, 0, 1, 8000, 0, 0);
        v.timeoutMask = 3;
        v.dissentMask = 3;
        _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
        votes = _votes(f, 0);
        v = _input(5, 0, 2, 8000, 0, 0);
        _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
        v = _input(5, 0, 2, 8000, 0, 0);
        v.payloadHash = keccak256("not hung");
        _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
        v = _input(5, 0, 2, 8000, 0, 0);
        _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
        v = _input(5, 0, 3, 8000, 0, 0);
        _expectPost(f, v, votes, IMochiVerdicts.InvalidStatus.selector);
        v = _input(5, 0, 1, 8000, 0, 0);
        v.agreementBps = 7999;
        _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
        v = _input(5, 0, 1, 8000, 0, 0);
        bytes memory wrongKeySig = _sigForKey(7777, f, v, votes);
        vm.expectPartialRevert(IMochiVerdicts.InactiveConsensusKey.selector);
        f.verdicts.post(v, votes, wrongKeySig);
    }

    function testPanelRequiresEscalatedAndNonzero() public {
        Fixture memory f = _fixture(3, 0);
        bytes32 qid = keccak256("query");
        vm.prank(PANEL);
        vm.expectPartialRevert(IMochiVerdicts.WrongQueryStatus.selector);
        f.verdicts.postPanelOutcome(qid, keccak256("a"), keccak256("p"));
        MochiTypes.Query memory q = f.escrow.getQuery(bytes32(0));
        q.status = MochiTypes.QueryStatus.ESCALATED;
        f.escrow.setQuery(q, f.seats, 0);
        vm.prank(PANEL);
        vm.expectRevert();
        f.verdicts.postPanelOutcome(qid, bytes32(0), keccak256("p"));
    }

    function testAgreementBoundaryFuzz() public {
        uint8[4] memory ns = [uint8(3), 5, 7, 9];
        for (uint256 a; a < 4; a++) {
            for (uint8 agree; agree <= ns[a]; agree++) {
                uint8 n = ns[a];
                Fixture memory f = _fixture(n, 0);
                MochiTypes.JurorVote[] memory votes = _votes(f, 0);
                uint16 bps = uint16(uint256(agree) * 10000 / n);
                uint8 k = MochiTypes.requiredAgree(n);
                MochiTypes.VerdictInput memory v = _input(n, 0, 1, bps, 0, 0);
                if (agree >= k) _post(f, v, votes);
                else _expectPost(f, v, votes, IMochiVerdicts.InconsistentStatus.selector);
            }
        }
    }
}

