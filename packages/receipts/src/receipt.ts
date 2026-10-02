import type { Hex } from "viem";
import type { ReceiptSigner } from "./signer.ts";

export type VerdictStatus = "VERDICT" | "HUNG";
export type ProvenanceKind = "SUBMITTED" | "FETCHED";

/** Model Passport as carried in receipts (mirrors @mochi/protocol PassportSchema; plain JSON, no bigints). */
export interface ReceiptPassport {
  modelId: string;
  lineage: string;
  weightsSha256: string;
  openWeights: boolean;
  provider: string;
  zdr: boolean;
  tee: string;
}

export interface VerdictReceiptInput {
  verdictId: Hex | string;
  chainId: number;
  contract: string;
  txHash: Hex | string;
  queryId: Hex | string;
  round: number;
  status: VerdictStatus;
  agreementBps: number;
  dissentMask: number;
  timeoutMask: number;
  schemaId: number;
  schemaVersion: number;
  docCommit: Hex | string;
  answerHash: Hex | string;
  payloadHash: Hex | string;
  evidenceRoot: Hex | string;
  attestationRoot: Hex | string;
  modelSetHash: Hex | string;
  provenanceKind: ProvenanceKind;
  originId: Hex | string;
  isPublic: boolean;
  escalated: boolean;
  /** passport: the juror's model Passport (Overview §4), included when known. Plain JSON only. */
  jurors: Array<{ seat: number; juror: string; class: string; quoteHash: Hex | string; passport?: ReceiptPassport }>;
  answer_json?: string;
  payload?: Hex | string;
}

export interface VerdictReceipt {
  v: 1;
  id: string;
  issued: string;
  service: "mochi";
  kind: "verdict";
  key_id: string;
  chain_id: number;
  contract: string;
  tx_hash: string;
  query_id: string;
  round: number;
  status: VerdictStatus;
  agreement_bps: number;
  dissent_mask: number;
  timeout_mask: number;
  schema_id: number;
  schema_version: number;
  doc_commit: string;
  answer_hash: string;
  payload_hash: string;
  evidence_root: string;
  attestation_root: string;
  model_set_hash: string;
  provenance_kind: ProvenanceKind;
  origin_id: string;
  is_public: boolean;
  escalated: boolean;
  jurors: Array<{ seat: number; juror: string; class: string; quote_hash: string; passport?: ReceiptPassport }>;
  public?: { answer_json: string; payload: string };
}

export interface BuildReceiptOptions { keyId: string; issued?: string }

function safeInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return value;
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;

function hex(name: string, value: string, bytes?: number): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value) || (bytes !== undefined && value.length !== 2 + 2 * bytes)) {
    throw new TypeError(`${name} must be a 0x-prefixed hex string`);
  }
  return value.toLowerCase();
}

function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("contract must be an address");
  return value.toLowerCase();
}

/** Build an Anonyma v1 verdict envelope. Private receipts contain hashes and metadata only. */
export function buildVerdictReceipt(input: VerdictReceiptInput, options: BuildReceiptOptions): VerdictReceipt {
  if (input.isPublic !== true && input.isPublic !== false) throw new TypeError("isPublic must be boolean");
  if (!input.isPublic && (input.answer_json !== undefined || input.payload !== undefined)) {
    throw new TypeError("Private receipts cannot include answer or payload values");
  }
  if (input.isPublic && (typeof input.answer_json !== "string" || input.payload === undefined)) {
    throw new TypeError("Public receipts require answer_json and payload");
  }
  if (input.status !== "VERDICT" && input.status !== "HUNG") throw new TypeError("Invalid verdict status");
  if (input.provenanceKind !== "SUBMITTED" && input.provenanceKind !== "FETCHED") throw new TypeError("Invalid provenance kind");
  if (typeof input.isPublic !== "boolean" || typeof input.escalated !== "boolean") throw new TypeError("Receipt flags must be boolean");
  if (typeof options.keyId !== "string" || !options.keyId) throw new TypeError("keyId is required");
  const issued = options.issued ?? new Date().toISOString();
  if (typeof issued !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(issued) || Number.isNaN(Date.parse(issued))) {
    throw new TypeError("issued must be an ISO-8601 timestamp");
  }
  const receipt: VerdictReceipt = {
    v: 1,
    id: hex("verdictId", input.verdictId, 32),
    issued,
    service: "mochi",
    kind: "verdict",
    key_id: options.keyId,
    chain_id: safeInt("chainId", input.chainId),
    contract: address(input.contract),
    tx_hash: hex("txHash", input.txHash, 32),
    query_id: hex("queryId", input.queryId, 32),
    round: safeInt("round", input.round),
    status: input.status,
    agreement_bps: safeInt("agreementBps", input.agreementBps),
    dissent_mask: safeInt("dissentMask", input.dissentMask),
    timeout_mask: safeInt("timeoutMask", input.timeoutMask),
    schema_id: safeInt("schemaId", input.schemaId),
    schema_version: safeInt("schemaVersion", input.schemaVersion),
    doc_commit: hex("docCommit", input.docCommit, 32),
    answer_hash: hex("answerHash", input.answerHash, 32),
    payload_hash: hex("payloadHash", input.payloadHash, 32),
    evidence_root: hex("evidenceRoot", input.evidenceRoot, 32),
    attestation_root: hex("attestationRoot", input.attestationRoot, 32),
    model_set_hash: hex("modelSetHash", input.modelSetHash, 32),
    provenance_kind: input.provenanceKind,
    origin_id: hex("originId", input.originId, 32),
    is_public: input.isPublic,
    escalated: input.escalated,
    jurors: input.jurors.map((juror) => {
      safeInt("juror seat", juror.seat);
      if (!/^0x[0-9a-fA-F]{40}$/.test(juror.juror)) throw new TypeError("juror must be an address");
      if (typeof juror.class !== "string" || !juror.class) throw new TypeError("juror class is required");
      const entry = { seat: juror.seat, juror: juror.juror.toLowerCase(), class: juror.class, quote_hash: hex("quoteHash", juror.quoteHash, 32) };
      return juror.passport ? { ...entry, passport: juror.passport } : entry;
    }),
  };
  if (input.isPublic) {
    // A public HUNG verdict has no payload ("0x"); anything else must be real hex bytes.
    const payload = input.payload === "0x" ? "0x" : hex("payload", input.payload!, undefined);
    receipt.public = { answer_json: input.answer_json!, payload };
  }
  return receipt;
}

export function signVerdictReceipt(signer: ReceiptSigner, input: VerdictReceiptInput): { receipt: VerdictReceipt; signature: string; key_id: string } {
  const receipt = buildVerdictReceipt(input, { keyId: signer.keyId });
  return { receipt, signature: signer.sign(receipt), key_id: signer.keyId };
}
