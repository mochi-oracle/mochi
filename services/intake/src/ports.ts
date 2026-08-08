import type { Hex } from "viem";
import type { Envelope } from "@mochi/tee";

export interface IntakeChainPort {
  getQuery(queryId: Hex): Promise<{
    status: number; docCommit: Hex; paramsHash: Hex; schemaId: number;
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
export interface StoredIntake {
  schemaId: number;
  salt: Hex;
  params: Record<string, unknown>;
  paramsHash: Hex;
  contentType: string;
  docB64: string;
  text: string;
}
export interface SealedStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  has(key: string): Promise<boolean>;
}
export interface EnvelopeSealer { seal(recipientPub: Hex, plaintext: Uint8Array, aad: Uint8Array): Envelope }
