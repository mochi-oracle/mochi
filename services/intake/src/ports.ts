import type { Hex } from "viem";
import type { Envelope } from "@mochi/tee";
import type { ProvenanceJson } from "@mochi/protocol";

export interface IntakeChainPort {
  getQuery(queryId: Hex): Promise<{
    status: number; docCommit: Hex; paramsHash: Hex; schemaId: number;
    /** EIP-712 struct hash of the Provenance the query was opened with; intake records are keyed by it. */
    provenanceHash: Hex;
    schemaVersion?: number; isPublic?: boolean; allowPanelDisclosure?: boolean;
  }>;
  /** PanelEscalation: current case (caseId = queryId) and the evaluators drawn for a panel. */
  getPanelCase?(queryId: Hex): Promise<{ status: number; panelIndex: number }>;
  panelOf?(queryId: Hex, panelIndex: number): Promise<Hex[]>;
  jurorsOf(queryId: Hex): Promise<Hex[]>;
  isActive(key: Hex, role: number): Promise<boolean>;
  getJuror(key: Hex): Promise<{ measurement: Hex }>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  bytes: Uint8Array;
  /** SHA-256 SPKI fingerprints (base64) observed for the peer certificate chain. */
  certFingerprints: string[];
}
export interface HttpGetter {
  get(url: URL, options: { timeoutMs: number; maxBytes: number; spkiSha256?: string[] }): Promise<HttpResponse>;
}
export interface PdfTextExtractor { extract(bytes: Uint8Array): Promise<string> }
export interface Clock { nowSeconds(): number }
export interface FetchPolicy {
  origins: { host: string; spkiSha256?: string[] }[];
  maxBytes?: number;
  timeoutMs?: number;
  allowHttpHosts?: string[];
}
/**
 * Sealed record for one signed Provenance (key = provenance struct hash). Written once, never overwritten. Before it
 * releases a record the intake re-derives it against the grant: provenanceHash(provenance) is the query's, the bytes
 * and salt give its docCommit, the raw params its paramsHash, and its signed transcriptHash re-derives: for a SUBMITTED
 * document from salt, contentType, text and raw params (core `submittedTranscriptHash`); for a FETCHED one from the
 * fetch metadata, contentType and bytes (core `tlsTranscriptHash`), salted for a private grant (`fetchedTranscriptHash`).
 */
export interface StoredIntake {
  /** The signed grant this record belongs to (uint64 members as decimal strings). */
  provenance: ProvenanceJson;
  schemaId: number;
  schemaVersion: number;
  docCommit: Hex;
  salt: Hex;
  params: Record<string, unknown>;
  paramsHash: Hex;
  payerCommit: Hex;
  isPublic: boolean;
  allowPanelDisclosure: boolean;
  contentType: string;
  docB64: string;
  text: string;
  /** FETCHED only: what the pinned fetch observed besides contentType and bytes (fingerprints as 0x SPKI sha256). */
  fetch?: { host: string; finalUrl: string; status: number; certFingerprints: Hex[] };
}
/**
 * The one grant issued for an open binding, stored under `grant:<opener>:<nonce>` and, for a private binding, also
 * `grant-payer:<payerCommit>`. `requestHash` fingerprints the sealed request (core `hashCanonical` of schema, salt, raw
 * params, binding and the document: upload content type and docHash, or URL), so only an identical retry gets it back.
 */
export interface GrantClaim { v: 1; provenanceHash: Hex; requestHash: Hex }
export interface SealedStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Atomic first write: stores only when the key is absent and reports whether it wrote. */
  putIfAbsent?(key: string, value: Uint8Array): Promise<boolean>;
  /** Keeps an entry past the upload retention window; called once a query opened with its grant is dispatched to
   *  verified peers. */
  retain?(key: string): Promise<void>;
}
export interface EnvelopeSealer { seal(recipientPub: Hex, plaintext: Uint8Array, aad: Uint8Array): Envelope }
