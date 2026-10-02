// Mirrors contracts/src/libraries/MochiTypes.sol. Numeric enum values MUST match Solidity.
import type { Address, Hex } from "viem";

export enum JurorClass {
  LARGE_A = 0,
  LARGE_B = 1,
  DOC_SPECIALIST = 2,
  SMALL_FAST = 3,
  DISSENTER = 4,
}

export enum Role {
  NONE = 0,
  JUROR = 1,
  INTAKE = 2,
  CONSENSUS = 3,
}

export enum QueryStatus {
  NONE = 0,
  OPEN = 1,
  SEALED = 2,
  DECIDED = 3,
  HUNG = 4,
  ESCALATED = 5,
  EXPIRED = 6,
}

export enum VerdictStatus {
  NONE = 0,
  VERDICT = 1,
  HUNG = 2,
}

export enum PayPath {
  USDG = 0,
  SHIELDED = 1,
  ANONYMA = 2,
  FEED = 3,
}

export enum ProvenanceKind {
  SUBMITTED = 0,
  FETCHED = 1,
}

export enum SchemaId {
  EX_DIVIDEND = 1,
  SPLIT = 2,
  EARNINGS = 3,
  RESERVE_ATTESTATION = 4,
  NAV = 5,
  INVOICE = 6,
  FREEFORM_FACT = 7,
}

export type SchemaName = keyof typeof SchemaId;

// ───────────────────────── normalized values ─────────────────────────
// Every juror answer is normalized inside the juror enclave BEFORE hashing/signing, with packages/schemas.
// Consensus operates only on normalized values.

/** Fixed-point decimal ×1e8, as a bigint. "2.11" → 211000000n. */
export type NumE8 = bigint;

export type NormalizedValue =
  | { t: "num"; e8: NumE8 } // decimals / money
  | { t: "int"; v: bigint } // integers (ratios, counts)
  | { t: "date"; v: string } // "YYYY-MM-DD" (UTC calendar date)
  | { t: "ts"; v: number } // unix seconds UTC
  | { t: "str"; v: string } // canonicalized string (see schemas normalizers)
  | { t: "enum"; v: string } // one of the field's enum members (UPPER_SNAKE)
  | { t: "bool"; v: boolean };

export type ValueKind = NormalizedValue["t"];

export type Tolerance =
  | { kind: "exact" }
  | { kind: "rel"; bps: number } // |a - anchor| * 10000 <= bps * |anchor|
  | { kind: "abs"; e8: bigint }; // |a - anchor| <= e8 (num only)

export interface FieldSpec {
  name: string; // snake_case, as in the spec
  kind: ValueKind;
  required: boolean;
  tolerance: Tolerance;
  /** For enums. */
  enumValues?: readonly string[];
  /**
   * For str: how to canonicalize.
   *  ticker   — uppercase, strip leading "$" and an exchange prefix ("NASDAQ:NVDA" → "NVDA")
   *  currency — ISO 4217 uppercase 3 letters ("US$", "$", "usd" → "USD")
   *  name     — legal/entity names: NFKC, case-fold, "&" → "and", drop punctuation, collapse spaces,
   *             strip trailing legal suffixes (inc, llc, ltd, corp, corporation, co, company, plc, lp, llp, na, sa, ag, gmbh)
   *  id       — identifiers (fund ids, invoice numbers): NFKC, uppercase, remove whitespace
   *  period   — fiscal period: "2026Q3" or "FY2026" (also "H1 2026" → "2026H1")
   *  text     — free text: NFKC, trim, collapse whitespace (case preserved)
   */
  strMode?: "ticker" | "currency" | "name" | "id" | "period" | "text";
  description: string; // shown to the model in the extraction prompt
}

export interface ParamSpec {
  name: string;
  kind: ValueKind;
  required: boolean;
  description: string;
  enumValues?: readonly string[];
  strMode?: FieldSpec["strMode"];
}

export interface SchemaDef {
  id: SchemaId;
  name: SchemaName;
  version: number; // starts at 1
  fields: readonly FieldSpec[];
  /** Names of params the requester may supply (committed as paramsHash), e.g. consensus_eps. */
  params: readonly ParamSpec[];
  /** Derived (post-consensus, deterministic) field names, e.g. beat_eps. Never extracted. */
  derived: readonly string[];
}

// ───────────────────────── spans / answers ─────────────────────────

export interface SpanRef {
  field: string;
  start: number; // char offset into the enclave's extracted document text
  end: number; // exclusive
  /** keccak256(utf8(docText.slice(start, end))) */
  hash: Hex;
}

/** A juror's normalized answer. `fields[name] = null` means "not present in the document". */
export interface JurorAnswerBody {
  schemaId: SchemaId;
  schemaVersion: number;
  fields: Record<string, NormalizedValue | null>;
  /** Field names whose raw value could not be normalized (never support any anchor). */
  invalid: string[];
  spans: SpanRef[];
  confidence: Record<string, number>; // 0..1 per field
}

/** What the consensus engine receives per seat. */
export type SeatInput =
  | {
      seat: number;
      juror: Address;
      jurorClass: JurorClass;
      timedOut: false;
      answer: JurorAnswerBody;
    }
  | {
      seat: number;
      juror: Address;
      jurorClass: JurorClass;
      timedOut: true;
    };

export interface FieldOutcome {
  field: string;
  required: boolean;
  /** Agreed normalized value, or null when the field is hung / all-null (optional fields may agree on null). */
  value: NormalizedValue | null;
  agreeCount: number;
  agreeBps: number; // floor(agreeCount * 10000 / n)
  hung: boolean;
  /** seat → that seat's (normalized or null/invalid) value, for seats that did not support the anchor. */
  dissent: Record<number, NormalizedValue | null | "INVALID" | "TIMEOUT">;
  supportingSeats: number[];
}

export interface ConsensusResult {
  status: VerdictStatus.VERDICT | VerdictStatus.HUNG;
  n: number;
  k: number;
  agreementBps: number; // min over required fields of agreeBps (10000 if no required fields)
  dissentMask: number; // uint32
  timeoutMask: number; // uint32
  fields: FieldOutcome[];
  /** Agreed values for all fields that are not hung (null allowed for optional fields). */
  agreed: Record<string, NormalizedValue | null>;
  hungFields: string[];
}

// ───────────────────────── on-chain structs (viem-friendly) ─────────────────────────

/** EIP-712 Provenance signed by the intake: a single-use, expiring grant for `opener` to open one query. */
export interface Provenance {
  docCommit: Hex;
  kind: ProvenanceKind;
  originId: Hex;
  fetchedAt: bigint;
  tokensK: number;
  transcriptHash: Hex;
  /** The only msg.sender that may open with this grant (payer wallet, shielded/voucher relayer, or feed runner). */
  opener: Address;
  schemaId: number;
  schemaVersion: number;
  paramsHash: Hex;
  /** payerCommit(payerResultPubKey) for private queries, ZERO32 for public ones. */
  payerCommit: Hex;
  isPublic: boolean;
  allowPanelDisclosure: boolean;
  /** queryId nonce: queryId = computeQueryId(opener, docCommit, nonce). */
  nonce: bigint;
  /** Unix seconds; QueryEscrow rejects the grant after this. */
  expiry: bigint;
}

/** Payment-side open parameters; everything else comes from the signed Provenance. */
export interface OpenParams {
  n: number;
  refundTo: Address;
}

/** Pays for exactly one query: its open to `n` jurors, or its expansion to `n`. `queryId` is
 *  computeQueryId(opener, docCommit, nonce) of the grant the relayer opens with. */
export interface AnonymaVoucher {
  voucherId: Hex;
  queryId: Hex;
  schemaId: number;
  n: number;
  maxAmount: bigint;
  tier: number;
  expiry: bigint;
}

export interface JurorVote {
  juror: Address;
  answerHash: Hex;
  spansRoot: Hex;
  quoteHash: Hex;
  sig: Hex; // "0x" for timed-out seats
}

export interface VerdictInput {
  queryId: Hex;
  round: number;
  status: VerdictStatus;
  agreementBps: number;
  dissentMask: number;
  timeoutMask: number;
  answerHash: Hex;
  payloadHash: Hex;
  evidenceRoot: Hex;
}
