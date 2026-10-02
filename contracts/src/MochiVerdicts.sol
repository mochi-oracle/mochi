// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MochiVerdicts is IMochiVerdicts, EIP712, AccessControl, ReentrancyGuard {
    IQueryEscrow public immutable escrow;
    IJurorRegistry public immutable registry;
    address public panel;
    mapping(bytes32 => MochiTypes.Verdict) private _verdicts;
    mapping(bytes32 => bytes32) public override latestVerdictOf;

    constructor(address admin, IQueryEscrow escrow_, IJurorRegistry registry_, address panel_)
        EIP712(MochiTypes.VERDICTS_DOMAIN_NAME, MochiTypes.DOMAIN_VERSION)
    {
        escrow = escrow_;
        registry = registry_;
        panel = panel_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
    }

    // aderyn-ignore-next-line(state-change-without-event) governor-only; the timelock's CallScheduled logs it
    function setPanel(address panel_) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        panel = panel_;
    }

    function domainSeparator() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    function post(
        MochiTypes.VerdictInput calldata v,
        MochiTypes.JurorVote[] calldata votes,
        bytes calldata consensusSig
    ) external override nonReentrant returns (bytes32 verdictId) {
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        MochiTypes.Query memory q = escrow.getQuery(v.queryId);
        if (q.status != MochiTypes.QueryStatus.SEALED) revert WrongQueryStatus(v.queryId, q.status);
        if (v.round != q.round) revert WrongRound(q.round, v.round);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        address[] memory seats = escrow.jurorsOf(v.queryId);
        _validateSeatData(v, votes, seats, q.n);
        _validateSignatures(v, votes, seats, q, consensusSig);
        _validateStatus(v, q.n);
        verdictId = MochiTypes.computeVerdictId(v.queryId, v.round);
        if (_verdicts[verdictId].status != 0) revert VerdictExists(verdictId);
        _storeVerdict(verdictId, v, votes, seats, q);
        latestVerdictOf[v.queryId] = verdictId;
        _emitPosted(verdictId, v, q.isPublic);
        escrow.settle(v.queryId, v.round, MochiTypes.VerdictStatus(v.status), v.timeoutMask);
        uint8 prevN = escrow.prevNOf(v.queryId);
        if (prevN < q.n) {
            address[] memory added = new address[](q.n - prevN);
            for (uint256 i = prevN; i < q.n; ++i) {
                added[i - prevN] = seats[i];
            }
            registry.recordService(added, v.timeoutMask >> prevN);
        }
    }

    function _emitPosted(bytes32 verdictId, MochiTypes.VerdictInput calldata v, bool isPublic) private {
        emit VerdictPosted(
            verdictId,
            v.queryId,
            v.round,
            v.status,
            v.agreementBps,
            v.dissentMask,
            v.timeoutMask,
            v.answerHash,
            v.payloadHash,
            isPublic
        );
    }

    function _validateSeatData(
        MochiTypes.VerdictInput calldata v,
        MochiTypes.JurorVote[] calldata votes,
        address[] memory seats,
        uint8 n
    ) private pure {
        if (votes.length != seats.length || seats.length != n) {
            revert SeatCountMismatch(seats.length, votes.length);
        }
        // slither-disable-next-line uninitialized-local -- bitmask accumulator, starts empty
        uint32 derivedTimeouts;
        for (uint256 i; i < seats.length; ++i) {
            if (votes[i].juror != seats[i]) revert SeatJurorMismatch(i, seats[i], votes[i].juror);
            if (votes[i].sig.length == 0) {
                // Seat count is bounded by the protocol maximum of 9, so this mask fits uint32.
                // forge-lint: disable-next-line(unsafe-typecast)
                derivedTimeouts |= uint32(uint256(1) << i);
                if (votes[i].answerHash != 0 || votes[i].spansRoot != 0 || votes[i].quoteHash != 0) {
                    revert TimeoutMaskMismatch(v.timeoutMask, derivedTimeouts);
                }
            }
        }
        if (derivedTimeouts != v.timeoutMask) revert TimeoutMaskMismatch(v.timeoutMask, derivedTimeouts);
    }

    function _validateSignatures(
        MochiTypes.VerdictInput calldata v,
        MochiTypes.JurorVote[] calldata votes,
        address[] memory seats,
        MochiTypes.Query memory q,
        bytes calldata consensusSig
    ) private view {
        for (uint256 i; i < votes.length; ++i) {
            if (votes[i].sig.length == 0) continue;
            bytes32 sh = MochiTypes.hashJurorAnswer(
                v.queryId,
                q.docCommit,
                q.schemaId,
                q.schemaVersion,
                votes[i].answerHash,
                votes[i].spansRoot,
                votes[i].quoteHash
            );
            // slither-disable-next-line unused-return -- err is checked; the third value only details err
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(sh), votes[i].sig);
            if (err != ECDSA.RecoverError.NoError || recovered != seats[i]) revert BadJurorSignature(i);
            if (!registry.isActive(seats[i], MochiTypes.Role.JUROR)) revert InactiveJuror(i, seats[i]);
        }
        MochiTypes.JurorVote[] memory copiedVotes = votes;
        bytes32 digest = _hashTypedDataV4(MochiTypes.hashVerdictAttestation(v, MochiTypes.hashVotes(copiedVotes)));
        // slither-disable-next-line unused-return -- err is checked; the third value only details err
        (address signer, ECDSA.RecoverError consensusErr,) = ECDSA.tryRecover(digest, consensusSig);
        // Signature is supplied in calldata; passed through the temporary setter-free helper below.
        if (consensusErr != ECDSA.RecoverError.NoError) revert BadConsensusSignature();
        if (!registry.isActive(signer, MochiTypes.Role.CONSENSUS)) revert InactiveConsensusKey(signer);
    }

    function _validateStatus(MochiTypes.VerdictInput calldata v, uint8 n) private pure {
        if (v.status != uint8(MochiTypes.VerdictStatus.VERDICT) && v.status != uint8(MochiTypes.VerdictStatus.HUNG)) {
            revert InvalidStatus(v.status);
        }
        uint8 k = MochiTypes.requiredAgree(n);
        if (v.status == uint8(MochiTypes.VerdictStatus.VERDICT)) {
            if (
                n - MochiTypes.popcount(v.timeoutMask) < k
                    || uint256(v.agreementBps) * n < uint256(k) * 10000 - (n - 1) || v.payloadHash == 0
                    || (v.dissentMask & v.timeoutMask) != v.timeoutMask
            ) revert InconsistentStatus();
        } else if (v.payloadHash != 0 || uint256(v.agreementBps) * n >= uint256(k) * 10000 - (n - 1)) {
            // HUNG must be the exact negation of the VERDICT threshold. agreementBps is floored, so at the k(N)
            // boundary (e.g. 6/7 → 8571, 7/9 → 7777) a "< k·10000" test would accept HUNG as well.
            revert InconsistentStatus();
        }
    }

    function _storeVerdict(
        bytes32 verdictId,
        MochiTypes.VerdictInput calldata v,
        MochiTypes.JurorVote[] calldata votes,
        address[] memory seats,
        MochiTypes.Query memory q
    ) private {
        bytes32[] memory quoteHashes = new bytes32[](votes.length);
        for (uint256 i; i < votes.length; ++i) {
            quoteHashes[i] = votes[i].quoteHash;
        }
        _verdicts[verdictId] = MochiTypes.Verdict({
            queryId: v.queryId,
            round: v.round,
            status: v.status,
            isPublic: q.isPublic,
            escalated: false,
            provenanceKind: uint8(q.provenanceKind),
            schemaId: q.schemaId,
            schemaVersion: q.schemaVersion,
            agreementBps: v.agreementBps,
            dissentMask: v.dissentMask,
            timeoutMask: v.timeoutMask,
            ts: uint64(block.timestamp),
            docCommit: q.docCommit,
            modelSetHash: keccak256(abi.encode(seats)),
            evidenceRoot: v.evidenceRoot,
            attestationRoot: keccak256(abi.encode(quoteHashes)),
            answerHash: v.answerHash,
            payloadHash: v.payloadHash,
            paramsHash: q.paramsHash,
            provenanceHash: q.provenanceHash,
            originId: q.originId,
            payerCommit: q.payerCommit
        });
    }

    function postPanelOutcome(bytes32 queryId, bytes32 answerHash, bytes32 payloadHash)
        external
        override
        nonReentrant
        returns (bytes32 verdictId)
    {
        if (msg.sender != panel) revert NotPanel(msg.sender);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        MochiTypes.Query memory q = escrow.getQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.ESCALATED) revert WrongQueryStatus(queryId, q.status);
        require(answerHash != 0 && payloadHash != 0, "zero panel result");
        verdictId = MochiTypes.computeVerdictId(queryId, MochiTypes.PANEL_ROUND);
        if (_verdicts[verdictId].status != 0) revert VerdictExists(verdictId);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        address[] memory seats = escrow.jurorsOf(queryId);
        _verdicts[verdictId] = MochiTypes.Verdict({
            queryId: queryId,
            round: MochiTypes.PANEL_ROUND,
            status: uint8(MochiTypes.VerdictStatus.VERDICT),
            isPublic: q.isPublic,
            escalated: true,
            provenanceKind: uint8(q.provenanceKind),
            schemaId: q.schemaId,
            schemaVersion: q.schemaVersion,
            agreementBps: 0,
            dissentMask: 0,
            timeoutMask: 0,
            ts: uint64(block.timestamp),
            docCommit: q.docCommit,
            modelSetHash: keccak256(abi.encode(seats)),
            evidenceRoot: 0,
            attestationRoot: 0,
            answerHash: answerHash,
            payloadHash: payloadHash,
            paramsHash: q.paramsHash,
            provenanceHash: q.provenanceHash,
            originId: q.originId,
            payerCommit: q.payerCommit
        });
        latestVerdictOf[queryId] = verdictId;
        emit PanelVerdictPosted(verdictId, queryId, answerHash, payloadHash);
        escrow.markDecided(queryId);
    }

    function reportEquivocation(
        bytes32 queryId,
        bytes32 docCommit,
        uint32 schemaId,
        uint16 schemaVersion,
        bytes32[3] calldata answerA,
        bytes calldata sigA,
        bytes32[3] calldata answerB,
        bytes calldata sigB
    ) external override {
        bytes32 hashA = MochiTypes.hashJurorAnswer(
            queryId, docCommit, schemaId, schemaVersion, answerA[0], answerA[1], answerA[2]
        );
        bytes32 hashB = MochiTypes.hashJurorAnswer(
            queryId, docCommit, schemaId, schemaVersion, answerB[0], answerB[1], answerB[2]
        );
        // slither-disable-next-line unused-return -- err is checked; the third value only details err
        (address signerA, ECDSA.RecoverError errA,) = ECDSA.tryRecover(_hashTypedDataV4(hashA), sigA);
        // slither-disable-next-line unused-return -- err is checked; the third value only details err
        (address signerB, ECDSA.RecoverError errB,) = ECDSA.tryRecover(_hashTypedDataV4(hashB), sigB);
        if (
            errA != ECDSA.RecoverError.NoError || errB != ECDSA.RecoverError.NoError || signerA == address(0)
                || signerA != signerB || answerA[0] == answerB[0]
        ) revert NotEquivocation();
        if (registry.getJuror(signerA).operator == address(0)) revert NotEquivocation();
        registry.slashEquivocation(signerA);
        emit EquivocationReported(signerA, queryId, msg.sender);
    }

    function getVerdict(bytes32 verdictId) external view override returns (MochiTypes.Verdict memory) {
        return _verdicts[verdictId];
    }

    function verify(bytes32 verdictId, bytes calldata answerJson) external view override returns (bool) {
        MochiTypes.Verdict storage v = _verdicts[verdictId];
        return v.status != uint8(MochiTypes.VerdictStatus.NONE) && keccak256(answerJson) == v.answerHash;
    }
}
