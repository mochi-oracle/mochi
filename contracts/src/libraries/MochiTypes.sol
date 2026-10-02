// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

/// @title MochiTypes
/// @notice Shared enums, structs, EIP-712 typehashes and jury math for every Mochi contract.
/// @dev This file is the on-chain source of truth. `packages/core` mirrors it byte-for-byte; change both together.
library MochiTypes {
    // ─────────────────────────────── enums ───────────────────────────────

    enum JurorClass {
        LARGE_A, // 0
        LARGE_B, // 1
        DOC_SPECIALIST, // 2
        SMALL_FAST, // 3
        DISSENTER // 4
    }

    enum Role {
        NONE, // 0
        JUROR, // 1
        INTAKE, // 2
        CONSENSUS // 3
    }

    enum QueryStatus {
        NONE, // 0
        OPEN, // 1  opened, waiting for seal
        SEALED, // 2  jurors selected for the current round, waiting for a verdict
        DECIDED, // 3  VERDICT posted (final)
        HUNG, // 4  HUNG posted for the current round (may expand or escalate)
        ESCALATED, // 5  handed to PanelEscalation
        EXPIRED // 6  deadline passed without a final verdict; refunded
    }

    enum VerdictStatus {
        NONE, // 0
        VERDICT, // 1
        HUNG // 2
    }

    enum PayPath {
        USDG, // 0
        SHIELDED, // 1
        ANONYMA, // 2
        FEED // 3
    }

    enum ProvenanceKind {
        SUBMITTED, // 0 bytes supplied by the requester
        FETCHED // 1 fetched by the intake enclave from an allow-listed origin over pinned TLS
    }

    enum SchemaId {
        NONE, // 0 (unused)
        EX_DIVIDEND, // 1
        SPLIT, // 2
        EARNINGS, // 3
        RESERVE_ATTESTATION, // 4
        NAV, // 5
        INVOICE, // 6
        FREEFORM_FACT // 7
    }

    // ─────────────────────────────── constants ───────────────────────────────

    uint8 internal constant MAX_N = 9;
    uint16 internal constant BPS = 10_000;
    /// @dev Sentinel for an absent optional int256 value inside a payload body.
    int256 internal constant ABSENT_INT = type(int256).min;

    // ─────────────────────────────── structs ───────────────────────────────

    /// @notice Signed by an INTAKE enclave key (EIP-712, domain = QueryEscrow): a single-use grant to open ONE query.
    ///         The first six fields describe the document the intake measured. The rest bind the grant to the open
    ///         the document owner asked for (they were sealed to the intake together with the document), so a copied
    ///         (provenance, signature) pair cannot open a query for anyone else, with other params, consent flags or a
    ///         different result key. queryId = computeQueryId(opener, docCommit, nonce) is fixed by the grant, so it
    ///         can open at most one query (a second open reverts QueryExists). It expires at `expiry`.
    struct Provenance {
        bytes32 docCommit; // keccak256(abi.encodePacked(salt, docHash)); salt = 0 for public queries
        uint8 kind; // ProvenanceKind
        bytes32 originId; // keccak256(bytes(lowercase origin host)), 0 for SUBMITTED
        uint64 fetchedAt; // unix seconds, 0 for SUBMITTED
        uint32 tokensK; // document size in 1k-token units after OCR (ceil), >= 1
        bytes32 transcriptHash; // SUBMITTED: H(salt, contentType, text, params); FETCHED: TLS transcript, salted H(salt, tls) if private
        address opener; // the only msg.sender allowed to open with this grant (payer wallet, relayer or feed runner)
        uint32 schemaId;
        uint16 schemaVersion; // the intake's schema version; must equal SchemaRegistry.latest(schemaId) at open
        bytes32 paramsHash; // keccak256 of canonical query params JSON (e.g. consensus EPS), computed by the intake
        bytes32 payerCommit; // commitment to the payer's result key (private queries), 0 for public queries
        bool isPublic;
        bool allowPanelDisclosure; // payer consents to human-panel escalation seeing the document
        uint64 nonce; // opener-chosen; makes queryId unique
        uint64 expiry; // unix seconds; open reverts after it
    }

    /// @notice Caller-supplied payment parameters for opening a query. Everything else comes from the signed Provenance.
    struct OpenParams {
        uint8 n; // 3, 5, 7 or 9
        address refundTo; // where refunds go; must be non-zero
    }

    /// @notice Stored per query by QueryEscrow.
    struct Query {
        bytes32 docCommit;
        uint32 schemaId;
        uint16 schemaVersion; // SchemaRegistry.latest(schemaId) at open
        uint8 n; // current jury size (grows on expand)
        uint8 round; // 0-based; incremented by expand
        bool isPublic;
        bool allowPanelDisclosure;
        PayPath payPath;
        QueryStatus status;
        ProvenanceKind provenanceKind;
        bytes32 originId;
        uint32 tokensK;
        bytes32 provenanceHash; // EIP-712 struct hash of the Provenance (unique per query; intake keys its record by it)
        bytes32 paramsHash;
        bytes32 payerCommit;
        address payer; // msg.sender of open (relayer for shielded path)
        address refundTo;
        uint64 openedAt;
        uint64 deadline;
        uint64 sealBlock; // block number whose hash seeds the current round's selection
        bytes32 seed; // set by seal for the current round
        uint256 paid; // total USDG escrowed for this query so far (all rounds)
        uint256 protocolFee; // protocol fee escrowed for the current round
    }

    /// @notice One seat's vote as submitted to MochiVerdicts.post. A timed-out seat has an empty `sig`
    ///         and zero `answerHash`/`spansRoot`/`quoteHash`.
    struct JurorVote {
        address juror;
        bytes32 answerHash;
        bytes32 spansRoot;
        bytes32 quoteHash;
        bytes sig; // EIP-712 JurorAnswer signature (domain = MochiVerdicts)
    }

    /// @notice What the consensus enclave attests and the orchestrator submits.
    struct VerdictInput {
        bytes32 queryId;
        uint8 round;
        uint8 status; // VerdictStatus
        uint16 agreementBps; // min over required fields of agreeCount * 10000 / n (floor)
        uint32 dissentMask; // bit i = seat i dissented on a required field or timed out
        uint32 timeoutMask; // bit i = seat i timed out
        bytes32 answerHash; // keccak256(canonical JSON of the agreed answer incl. salt)
        // Public query: keccak256(payload) (Feeds re-checks it). Private query: keccak256(abi.encodePacked(
        // "mochi/private-payload/v1", salt, keccak256(payload))) with the query's secret salt, so the outcome cannot be
        // found by hashing candidate payloads. 0 when status == HUNG.
        bytes32 payloadHash;
        bytes32 evidenceRoot; // merkle root over agreed-field span hashes
    }

    /// @notice Stored per verdict by MochiVerdicts. verdictId = computeVerdictId(queryId, round) = keccak256(abi.encode(queryId, round)).
    struct Verdict {
        bytes32 queryId;
        uint8 round;
        uint8 status; // VerdictStatus
        bool isPublic;
        bool escalated;
        uint8 provenanceKind;
        uint32 schemaId;
        uint16 schemaVersion;
        uint16 agreementBps;
        uint32 dissentMask;
        uint32 timeoutMask;
        uint64 ts;
        bytes32 docCommit;
        bytes32 modelSetHash; // keccak256(abi.encode(address[] jurors))
        bytes32 evidenceRoot;
        bytes32 attestationRoot; // keccak256(abi.encode(bytes32[] quoteHashes)) in seat order
        bytes32 answerHash;
        bytes32 payloadHash;
        bytes32 paramsHash;
        bytes32 provenanceHash;
        bytes32 originId;
        bytes32 payerCommit;
    }

    /// @notice EIP-712 voucher signed by Anonyma's settlement key (domain = QueryEscrow). It pays for exactly one query:
    ///         its open to jury size n (openWithVoucher) or its expansion to n (expandWithVoucher). Anonyma computes
    ///         queryId = QueryEscrow.computeQueryId(opener, docCommit, nonce) from the open binding it seals for the
    ///         intake (opener = the relaying gateway, nonce = the grant's nonce), so nobody else's grant can spend it.
    struct AnonymaVoucher {
        bytes32 voucherId;
        bytes32 queryId;
        uint32 schemaId;
        uint8 n;
        uint256 maxAmount; // USDG ceiling for this open or expansion
        uint8 tier; // NYMA holder tier (recorded only; discount is absorbed by Anonyma)
        uint64 expiry;
    }

    // ─────────────────────────────── payload bodies ───────────────────────────────
    // payload = abi.encode(bytes32 subjectKey, uint64 asOf, bytes body), body = abi.encode(<Struct>)
    // Money / decimals are fixed-point int256 x 1e8 ("E8"). Dates are unix seconds at 00:00 UTC (uint64, 0 = absent).
    // Short strings (ticker, currency, symbols) are left-aligned ASCII in bytes32 (uppercase). subjectKey is the feed key.

    struct ExDividendBody {
        bytes32 ticker; // subjectKey
        uint64 exDate; // asOf
        uint64 recordDate;
        uint64 payDate;
        int256 amountPerShareE8;
        bytes32 currency;
        uint8 dividendType; // 0 CASH, 1 STOCK, 2 SPECIAL, 3 RETURN_OF_CAPITAL, 4 OTHER
        bool multiplierEffectExpected;
    }

    struct SplitBody {
        bytes32 ticker; // subjectKey
        uint64 effectiveDate; // asOf
        uint32 ratioNum;
        uint32 ratioDen;
    }

    struct EarningsBody {
        bytes32 ticker; // subjectKey
        bytes32 period; // e.g. "2026Q3" / "FY2026"
        uint64 releaseTs; // asOf (0 if absent → asOf = open time)
        int256 epsGaapDilutedE8;
        int256 epsNonGaapDilutedE8; // ABSENT_INT if absent
        int256 revenueE8;
        bytes32 currency;
        int8 beatEps; // -1 miss, 0 inline, 1 beat, 2 n/a (no consensus supplied)
        int8 beatRevenue; // same encoding
    }

    struct ReserveAttestationBody {
        bytes32 assetSymbol; // subjectKey
        uint64 asOf; // asOf
        int256 reportedSupplyE8;
        int256 reportedReservesE8;
        bool signaturePresent;
        string issuer;
        string custodian; // "" if absent
        string auditor; // "" if absent
        string attestationType; // "" if absent
    }

    struct NavBody {
        bytes32 fundId; // subjectKey
        uint64 asOf; // asOf
        int256 navPerShareE8;
        int256 totalAssetsE8; // ABSENT_INT if absent
        int256 totalLiabilitiesE8; // ABSENT_INT if absent
        int256 sharesOutstandingE8; // ABSENT_INT if absent
    }

    struct InvoiceBody {
        bytes32 invoiceKey; // subjectKey = keccak256(abi.encodePacked(payeeId, "|", invoiceNumber))
        uint64 dueDate; // asOf
        int256 amountE8;
        bytes32 currency;
        string payeeId;
        string payerId;
        string invoiceNumber;
    }

    struct FreeformBody {
        bytes32 questionHash; // subjectKey = keccak256(bytes(question))
        uint64 asOf; // open time
        uint8 answerType; // 0 bool, 1 number, 2 string
        bool boolAnswer;
        int256 numberAnswerE8;
        string stringAnswer;
    }

    // ─────────────────────────────── EIP-712 ───────────────────────────────
    // Domains (OZ EIP712, version "1"):
    //   QueryEscrow    name "MochiQueryEscrow"  → Provenance, AnonymaVoucher
    //   MochiVerdicts name "MochiVerdicts"     → JurorAnswer, VerdictAttestation
    string internal constant ESCROW_DOMAIN_NAME = "MochiQueryEscrow";
    string internal constant VERDICTS_DOMAIN_NAME = "MochiVerdicts";
    string internal constant DOMAIN_VERSION = "1";
    /// @dev Round number used for the verdict record produced by a human panel.
    uint8 internal constant PANEL_ROUND = 255;


    bytes32 internal constant PROVENANCE_TYPEHASH = keccak256(
        "Provenance(bytes32 docCommit,uint8 kind,bytes32 originId,uint64 fetchedAt,uint32 tokensK,bytes32 transcriptHash,address opener,uint32 schemaId,uint16 schemaVersion,bytes32 paramsHash,bytes32 payerCommit,bool isPublic,bool allowPanelDisclosure,uint64 nonce,uint64 expiry)"
    );

    bytes32 internal constant JUROR_ANSWER_TYPEHASH = keccak256(
        "JurorAnswer(bytes32 queryId,bytes32 docCommit,uint32 schemaId,uint16 schemaVersion,bytes32 answerHash,bytes32 spansRoot,bytes32 quoteHash)"
    );

    bytes32 internal constant VERDICT_ATTESTATION_TYPEHASH = keccak256(
        "VerdictAttestation(bytes32 queryId,uint8 round,uint8 status,uint16 agreementBps,uint32 dissentMask,uint32 timeoutMask,bytes32 answerHash,bytes32 payloadHash,bytes32 evidenceRoot,bytes32 votesHash)"
    );

    bytes32 internal constant ANONYMA_VOUCHER_TYPEHASH = keccak256(
        "AnonymaVoucher(bytes32 voucherId,bytes32 queryId,uint32 schemaId,uint8 n,uint256 maxAmount,uint8 tier,uint64 expiry)"
    );

    /// @dev Every member is a static atomic type, so abi.encode(struct) is exactly the EIP-712 encodeData of its
    ///      members in declaration order (each one 32-byte word).
    function hashProvenance(Provenance memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(PROVENANCE_TYPEHASH, p));
    }

    /// @dev Same hash, read straight from the calldata words of the (static) struct. A non-canonical encoding (dirty
    ///      high bits) hashes differently from what the intake signed, so it fails signature recovery, and any member
    ///      read through Solidity is still range-checked.
    function hashProvenanceCalldata(Provenance calldata p) internal pure returns (bytes32 h) {
        bytes32 typehash = PROVENANCE_TYPEHASH;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, typehash)
            calldatacopy(add(ptr, 0x20), p, 0x1e0) // 15 members x 32 bytes
            h := keccak256(ptr, 0x200)
        }
    }

    function hashAnonymaVoucher(AnonymaVoucher memory v) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(ANONYMA_VOUCHER_TYPEHASH, v.voucherId, v.queryId, v.schemaId, v.n, v.maxAmount, v.tier, v.expiry)
        );
    }

    /// @dev A juror signs at most one answer per queryId, ever. Answers are reused across expansion rounds, so the
    ///      round is deliberately NOT part of the signed struct. Two different answerHashes = equivocation.
    function hashJurorAnswer(
        bytes32 queryId,
        bytes32 docCommit,
        uint32 schemaId,
        uint16 schemaVersion,
        bytes32 answerHash,
        bytes32 spansRoot,
        bytes32 quoteHash
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                JUROR_ANSWER_TYPEHASH,
                queryId,
                docCommit,
                schemaId,
                schemaVersion,
                answerHash,
                spansRoot,
                quoteHash
            )
        );
    }

    /// @notice votesHash = keccak256(abi.encode(address[] jurors, bytes32[] answerHashes, bytes32[] spansRoots, bytes32[] quoteHashes)), seat order.
    function hashVotes(JurorVote[] memory votes) internal pure returns (bytes32) {
        uint256 len = votes.length;
        address[] memory jurors = new address[](len);
        bytes32[] memory answers = new bytes32[](len);
        bytes32[] memory spans = new bytes32[](len);
        bytes32[] memory quotes = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            jurors[i] = votes[i].juror;
            answers[i] = votes[i].answerHash;
            spans[i] = votes[i].spansRoot;
            quotes[i] = votes[i].quoteHash;
        }
        return keccak256(abi.encode(jurors, answers, spans, quotes));
    }

    function hashVerdictAttestation(VerdictInput memory v, bytes32 votesHash) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERDICT_ATTESTATION_TYPEHASH,
                v.queryId,
                v.round,
                v.status,
                v.agreementBps,
                v.dissentMask,
                v.timeoutMask,
                v.answerHash,
                v.payloadHash,
                v.evidenceRoot,
                votesHash
            )
        );
    }

    // ─────────────────────────────── jury math ───────────────────────────────

    function isValidN(uint8 n) internal pure returns (bool) {
        return n == 3 || n == 5 || n == 7 || n == 9;
    }

    /// @notice k(N) = ceil(3N/4): 3→3, 5→4, 7→6, 9→7.
    function requiredAgree(uint8 n) internal pure returns (uint8) {
        return uint8((uint256(n) * 3 + 3) / 4);
    }

    /// @notice Nested class mix; seats [0, n) of the N9 ordering.
    ///         N3 = [LARGE_A, DOC_SPECIALIST, DISSENTER]; N5 = N3 + [LARGE_B, SMALL_FAST];
    ///         N7 = N5 + [LARGE_A, DOC_SPECIALIST]; N9 = N7 + [LARGE_B, DISSENTER].
    function seatClass(uint8 seat) internal pure returns (JurorClass) {
        if (seat == 0) return JurorClass.LARGE_A;
        if (seat == 1) return JurorClass.DOC_SPECIALIST;
        if (seat == 2) return JurorClass.DISSENTER;
        if (seat == 3) return JurorClass.LARGE_B;
        if (seat == 4) return JurorClass.SMALL_FAST;
        if (seat == 5) return JurorClass.LARGE_A;
        if (seat == 6) return JurorClass.DOC_SPECIALIST;
        if (seat == 7) return JurorClass.LARGE_B;
        if (seat == 8) return JurorClass.DISSENTER;
        revert("MochiTypes: seat out of range");
    }

    function classMix(uint8 n) internal pure returns (JurorClass[] memory mix) {
        require(isValidN(n), "MochiTypes: invalid n");
        mix = new JurorClass[](n);
        for (uint8 i = 0; i < n; i++) {
            mix[i] = seatClass(i);
        }
    }

    function popcount(uint32 x) internal pure returns (uint8 c) {
        while (x != 0) {
            x &= x - 1;
            c++;
        }
    }

    function computeVerdictId(bytes32 queryId, uint8 round) internal pure returns (bytes32) {
        return keccak256(abi.encode(queryId, round));
    }

    function computeDocCommit(bytes32 salt, bytes32 docHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt, docHash));
    }
}
