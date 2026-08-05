// Wire protocol between Mochi services (wave 2). Every HTTP body is JSON validated with these zod schemas.
// Trust model (docs/ARCHITECTURE.md): intake, juror and consensus are attested enclaves; the orchestrator and gateway
// are untrusted relays. Anything private (document, params, salt, answers, payer result key) travels only inside
// envelopes sealed to an enclave's attested x25519 key, and is bound to on-chain commitments the enclaves re-check.
import { encodePacked, keccak256, toHex, type Hex } from "viem";
import { z } from "zod";

// ───────────────────────── primitives ─────────────────────────

export const hex = z.string().regex(/^0x([0-9a-f]{2})*$/, "lowercase 0x-hex");
export const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "bytes32 lowercase hex");
export const address = z.string().regex(/^0x[0-9a-f]{40}$/, "lowercase address");
/** bigint carried as a decimal string in JSON. */
export const uintString = z.string().regex(/^(0|[1-9][0-9]*)$/, "unsigned decimal string");

export const EnvelopeSchema = z.object({ v: z.literal(1), epk: hex32, nonce: hex, ct: hex });
export type EnvelopeJson = z.infer<typeof EnvelopeSchema>;

export const QuoteSchema = z.object({
  kind: z.enum(["mock", "tdx", "sev-snp", "nvidia-cc"]),
  measurement: hex32,
  reportData: hex32,
  raw: hex,
  issuedAt: z.number().int().nonnegative(),
});

export const EnclaveRole = z.enum(["INTAKE", "JUROR", "CONSENSUS"]);

/** GET /v1/attestation on every enclave service. */
export const AttestationDocSchema = z.object({
  role: EnclaveRole,
  address, // secp256k1 signing address generated in the enclave
  encryptionPubKey: hex32, // x25519
  measurement: hex32,
  jurorClass: z.number().int().min(0).max(4).optional(), // JUROR only
  quote: QuoteSchema, // reportData = keyBinding(address, encryptionPubKey)
});
export type AttestationDoc = z.infer<typeof AttestationDocSchema>;

/** An enclave peer as referenced in dispatch requests: identity + attestation to verify before encrypting to it. */
export const PeerSchema = z.object({ address, encryptionPubKey: hex32, quote: QuoteSchema });
export type Peer = z.infer<typeof PeerSchema>;

// ───────────────────────── AAD conventions ─────────────────────────

const utf8 = (s: string) => new TextEncoder().encode(s);
/** AAD inputs are canonicalized to lowercase: viem returns checksummed addresses, enclaves must agree byte-for-byte. */
const lc = (h: string) => h.toLowerCase();
export const aad = {
  intake: () => utf8("mochi/intake/v1"),
  doc: (docCommit: Hex) => utf8(`mochi/doc/v1|${lc(docCommit)}`),
  consensusSeed: (queryId: Hex) => utf8(`mochi/seed/v1|${lc(queryId)}`),
  answer: (queryId: Hex, juror: Hex) => utf8(`mochi/answer/v1|${lc(queryId)}|${lc(juror)}`),
  result: (verdictId: Hex) => utf8(`mochi/result/v1|${lc(verdictId)}`),
  panel: (queryId: Hex, evaluator: Hex) => utf8(`mochi/panel/v1|${lc(queryId)}|${lc(evaluator)}`),
  disclosure: (verdictId: Hex, recipientPubKey: Hex) => utf8(`mochi/disclosure/v1|${lc(verdictId)}|${lc(recipientPubKey)}`),
};

/**
 * payerCommit for a private query = keccak256(abi.encodePacked("mochi/payer/v1", bytes32 payerResultPubKey)).
 * The consensus enclave only encrypts a private result to a key whose commitment equals Query.payerCommit, so a relay
 * cannot substitute its own key. Public queries use payerCommit = 0x00…00. Use a fresh key per query.
 */
export function payerCommit(payerResultPubKey: Hex): Hex {
  return keccak256(encodePacked(["string", "bytes32"], ["mochi/payer/v1", payerResultPubKey]));
}

// ───────────────────────── intake (enclave) ─────────────────────────

/** Plaintext sealed to the intake key (aad.intake()) — upload form. salt = ZERO32 for public queries. */
export const IntakeUploadPlainSchema = z.object({
  v: z.literal(1),
  schemaId: z.number().int().min(1),
  salt: hex32,
  params: z.record(z.string(), z.unknown()).default({}),
  contentType: z.string().min(1),
  docB64: z.string(),
});
/** Plaintext sealed to the intake key (aad.intake()) — URL form (intake fetches from an allow-listed origin). */
export const IntakeUrlPlainSchema = z.object({
  v: z.literal(1),
  schemaId: z.number().int().min(1),
  salt: hex32,
  params: z.record(z.string(), z.unknown()).default({}),
  url: z.string().url(),
});
export type IntakeUploadPlain = z.infer<typeof IntakeUploadPlainSchema>;
export type IntakeUrlPlain = z.infer<typeof IntakeUrlPlainSchema>;

/** POST /v1/intake/upload and /v1/intake/url body. */
export const IntakeReqSchema = z.object({ envelope: EnvelopeSchema });

export const ProvenanceJsonSchema = z.object({
  docCommit: hex32,
  kind: z.union([z.literal(0), z.literal(1)]),
  originId: hex32,
  fetchedAt: uintString,
  tokensK: z.number().int().min(1),
  transcriptHash: hex32,
});
export type ProvenanceJson = z.infer<typeof ProvenanceJsonSchema>;

export const IntakeResultSchema = z.object({
  provenance: ProvenanceJsonSchema,
  intakeSig: hex, // EIP-712 Provenance signature (domain MochiQueryEscrow)
  intake: address,
  docCommit: hex32,
  paramsHash: hex32, // the caller must pass this as OpenParams.paramsHash
  schemaId: z.number().int().min(1),
  tokensK: z.number().int().min(1),
});
export type IntakeResult = z.infer<typeof IntakeResultSchema>;

/** POST /v1/dispatch — after seal. Intake re-checks every peer on-chain and against its quote before encrypting. */
export const DispatchReqSchema = z.object({
  queryId: hex32,
  jurors: z.array(PeerSchema.extend({ seat: z.number().int().min(0).max(8) })).min(1),
  consensus: PeerSchema,
});
export const DispatchResSchema = z.object({
  jurors: z.array(z.object({ seat: z.number().int(), address, docEnvelope: EnvelopeSchema })),
  consensusSeed: EnvelopeSchema,
});
export type DispatchReq = z.infer<typeof DispatchReqSchema>;
export type DispatchRes = z.infer<typeof DispatchResSchema>;

/** Sealed to a juror (aad.doc(docCommit)). The juror re-derives docCommit and paramsHash and checks them on-chain. */
export const JurorDocPlainSchema = z.object({
  v: z.literal(1),
  queryId: hex32,
  schemaId: z.number().int().min(1),
  docCommit: hex32,
  paramsHash: hex32,
  salt: hex32,
  params: z.record(z.string(), z.unknown()),
  contentType: z.string(),
  docB64: z.string(), // original bytes (for docHash)
  text: z.string(), // intake's extracted text (spans index into this)
});
export type JurorDocPlain = z.infer<typeof JurorDocPlainSchema>;

/** Sealed to the consensus enclave (aad.consensusSeed(queryId)). */
export const ConsensusSeedPlainSchema = z.object({
  v: z.literal(1),
  queryId: hex32,
  schemaId: z.number().int().min(1),
  docCommit: hex32,
  paramsHash: hex32,
  salt: hex32,
  params: z.record(z.string(), z.unknown()),
});
export type ConsensusSeedPlain = z.infer<typeof ConsensusSeedPlainSchema>;

// ───────────────────────── juror (enclave) ─────────────────────────

export const JurorVoteJsonSchema = z.object({
  juror: address,
  answerHash: hex32,
  spansRoot: hex32,
  quoteHash: hex32,
  sig: hex, // "0x" only for timed-out seats (never produced by a juror)
});
export type JurorVoteJson = z.infer<typeof JurorVoteJsonSchema>;

/** POST /v1/answer (orchestrator → juror). The juror pushes its sealed answer straight to the consensus enclave. */
export const AnswerReqSchema = z.object({
  queryId: hex32,
  seat: z.number().int().min(0).max(8),
  docEnvelope: EnvelopeSchema,
  consensus: PeerSchema,
  consensusUrl: z.string().url(),
});
export const AnswerResSchema = z.object({ seat: z.number().int(), vote: JurorVoteJsonSchema, delivered: z.boolean() });
export type AnswerReq = z.infer<typeof AnswerReqSchema>;
export type AnswerRes = z.infer<typeof AnswerResSchema>;

/** POST /v1/rounds/:queryId/answers (juror → consensus). answerEnvelope is sealed with aad.answer(queryId, juror)
 *  and contains a JurorAnswerBody (core type) serialized with canonicalJson (bigints as decimal strings). */
export const SubmitAnswerReqSchema = z.object({
  queryId: hex32,
  seat: z.number().int().min(0).max(8),
  vote: JurorVoteJsonSchema,
  answerEnvelope: EnvelopeSchema,
});
export type SubmitAnswerReq = z.infer<typeof SubmitAnswerReqSchema>;

// ───────────────────────── consensus (enclave) ─────────────────────────

/** POST /v1/rounds (orchestrator → consensus) after seal. The enclave reads the query from chain itself. */
export const RoundOpenReqSchema = z.object({
  queryId: hex32,
  round: z.number().int().min(0).max(254),
  consensusSeed: EnvelopeSchema,
  /** Private queries only: x25519 key the result is sealed to; must satisfy payerCommit(key) == Query.payerCommit. */
  payerResultPubKey: hex32.optional(),
});
export type RoundOpenReq = z.infer<typeof RoundOpenReqSchema>;

export const VerdictInputJsonSchema = z.object({
  queryId: hex32,
  round: z.number().int(),
  status: z.union([z.literal(1), z.literal(2)]),
  agreementBps: z.number().int().min(0).max(10000),
  dissentMask: z.number().int().nonnegative(),
  timeoutMask: z.number().int().nonnegative(),
  answerHash: hex32,
  payloadHash: hex32,
  evidenceRoot: hex32,
});
export type VerdictInputJson = z.infer<typeof VerdictInputJsonSchema>;

/** Public part of a decision (only when Query.isPublic). */
export const PublicDecisionSchema = z.object({
  answerJson: z.string(),
  payload: hex, // "0x" when HUNG
  fields: z.array(
    z.object({
      field: z.string(),
      required: z.boolean(),
      agreeBps: z.number().int(),
      hung: z.boolean(),
      value: z.unknown(), // NormalizedValue as canonical JSON object, or null
      dissent: z.record(z.string(), z.unknown()), // seat → value | null | "INVALID" | "TIMEOUT"
    }),
  ),
  disagreement: z.array(
    z.object({
      field: z.string(),
      jurorClass: z.number().int(),
      seat: z.number().int(),
      disagreed: z.boolean(),
      timedOut: z.boolean(),
    }),
  ),
});
export type PublicDecision = z.infer<typeof PublicDecisionSchema>;

/** POST /v1/rounds/:queryId/close → 409 if the enclave's deadline has not passed and seats are still missing. */
export const DecisionResSchema = z.object({
  verdictId: hex32,
  verdictInput: VerdictInputJsonSchema,
  votes: z.array(JurorVoteJsonSchema),
  consensusSig: hex,
  public: PublicDecisionSchema.optional(),
  /** Private queries: PrivateResultPlain sealed to payerResultPubKey with aad.result(verdictId). */
  privateResult: EnvelopeSchema.optional(),
});
export type DecisionRes = z.infer<typeof DecisionResSchema>;

/** What the payer decrypts for a private verdict. */
export const PrivateResultPlainSchema = z.object({
  v: z.literal(1),
  verdictId: hex32,
  salt: hex32,
  answerJson: z.string(),
  payload: hex,
  fields: PublicDecisionSchema.shape.fields,
});
export type PrivateResultPlain = z.infer<typeof PrivateResultPlainSchema>;

// ───────────────────────── model Passport (Overview §4) ─────────────────────────

/**
 * What a juror enclave runs. Produced inside the enclave and signed with its attested signing key (EIP-191 over
 * passportHash), so it is as trustworthy as the enclave measurement. Shown per verdict (receipts, verdict API) and
 * used for the per-model disagreement index.
 */
export const PassportSchema = z.object({
  v: z.literal(1),
  juror: address,
  jurorClass: z.number().int().min(0).max(4),
  modelId: z.string().min(1).max(200), // e.g. "Qwen/Qwen3-72B-Instruct"
  lineage: z.string().min(1).max(64), // training family, e.g. "qwen", "llama", "mistral", "deepseek"
  weightsSha256: hex32, // sha256 over the weight files loaded in the enclave (sorted by path)
  openWeights: z.boolean(),
  provider: z.string().min(1).max(100), // who operates the enclave host
  zdr: z.boolean(), // zero data retention
  tee: z.enum(["mock", "tdx", "sev-snp", "nvidia-cc"]),
});
export type Passport = z.infer<typeof PassportSchema>;

/** keccak256 of the passport's canonical JSON (sorted keys). The enclave signs this with signMessage({ raw }). */
export function passportHash(p: Passport): Hex {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v;
  return keccak256(toHex(JSON.stringify(sortKeys(p))));
}

/** Juror attestation documents carry their Passport (AttestationDoc stays valid without it for other roles). */
export const JurorAttestationDocSchema = AttestationDocSchema.extend({ passport: PassportSchema, passportSig: hex });
export type JurorAttestationDoc = z.infer<typeof JurorAttestationDocSchema>;

// ───────────────────────── view keys / disclosures (Overview §3) ─────────────────────────

/**
 * A payer discloses a private result to an auditor by sealing the PrivateResultPlain to the auditor's x25519 key
 * (aad.disclosure(verdictId, recipientPubKey)). Self-authenticating: the auditor checks keccak256(answerJson) against
 * the on-chain answerHash, so storage/relay needs no access control. DisclosureRegistry logs it on-chain.
 */
export const DisclosureReqSchema = z.object({
  verdictId: hex32,
  recipientPubKey: hex32,
  envelope: EnvelopeSchema,
});
export type DisclosureReq = z.infer<typeof DisclosureReqSchema>;
export const recipientKeyHash = (recipientPubKey: Hex): Hex => keccak256(recipientPubKey);

// ───────────────────────── human panel (§3.4) ─────────────────────────

/**
 * Evaluators are humans with a USDG-staked address (no identity checks). To receive the document they bind an x25519
 * key to their staked address: evaluatorKeySig = EIP-191 signature by the evaluator address over
 * evaluatorKeyDigest(queryId, panelIndex, encryptionPubKey).
 */
export function evaluatorKeyDigest(queryId: Hex, panelIndex: number, encryptionPubKey: Hex): Hex {
  return keccak256(
    encodePacked(["string", "bytes32", "uint8", "bytes32"], ["mochi/evaluator-key/v1", queryId, panelIndex, encryptionPubKey]),
  );
}

/** POST /v1/dispatch-panel on intake (called by panel-desk). */
export const DispatchPanelReqSchema = z.object({
  queryId: hex32,
  panelIndex: z.union([z.literal(0), z.literal(1)]),
  evaluators: z.array(z.object({ address, encryptionPubKey: hex32, keySig: hex })).min(1).max(3),
});
export const DispatchPanelResSchema = z.object({
  evaluators: z.array(z.object({ address, docEnvelope: EnvelopeSchema })),
});
export type DispatchPanelReq = z.infer<typeof DispatchPanelReqSchema>;
export type DispatchPanelRes = z.infer<typeof DispatchPanelResSchema>;

/** Sealed to an evaluator (aad.panel(queryId, evaluator)): the document plus what they need to build an answer. */
export const PanelDocPlainSchema = z.object({
  v: z.literal(1),
  queryId: hex32,
  schemaId: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  docCommit: hex32,
  salt: hex32,
  params: z.record(z.string(), z.unknown()),
  contentType: z.string(),
  docB64: z.string(),
  text: z.string(),
});
export type PanelDocPlain = z.infer<typeof PanelDocPlainSchema>;

// ───────────────────────── directory ─────────────────────────

/** Off-chain map from enclave signing address to its HTTP base URL (config file or DB). */
export interface EndpointDirectory {
  urlOf(addr: Hex): Promise<string | undefined>;
}

export const ApiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
