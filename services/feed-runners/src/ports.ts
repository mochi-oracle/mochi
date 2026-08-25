import type { Address, Hex } from "viem";
import type { AttestationDoc, IntakeResult } from "@mochi/protocol";
import type { QuoteVerifier } from "@mochi/tee";
import type { SchemaId } from "@mochi/core";

export interface FeedJob {
  runner: RunnerName;
  id: string;
  schemaId: SchemaId;
  n: number;
  feedName: string;
  key: Hex;
  url: string;
  params: Record<string, unknown>;
}
export type RunnerName = "corp-actions" | "earnings" | "attestations";
export interface RunnerState { completed: string[]; multiplierPairs?: Record<string, { next: string; effectiveAt: string }>; edgarSeen?: string[] }
export interface StockTokenReader {
  readMultiplierSchedule(token: Address): Promise<{ uiMultiplier: bigint; newUIMultiplier: bigint; effectiveAt: bigint }>;
  /** Records the pre-change multiplier on StockTokenCrosscheck while a change is pending. Resolves true if a tx was sent. */
  recordBaseline?(tickerKey: Hex, effectiveAt: bigint): Promise<boolean>;
}
export interface EdgarFiling { id: string; accession: string; filingDate: string; summary: string }
export interface EdgarHttp {
  getAtom(cik: string): Promise<string>;
  getFilingIndex(cik: string, accessionNoDashes: string): Promise<string>;
}
export interface AttestationDocPort extends AttestationDoc {}
export interface HttpPort {
  getAttestation(url: string, timeoutMs: number): Promise<AttestationDocPort>;
  postIntake(url: string, envelope: { v: 1; epk: Hex; nonce: Hex; ct: Hex }, timeoutMs: number): Promise<IntakeResult>;
}
export interface ChainPort {
  isActive(address: Address, role: number): Promise<boolean>;
  getJuror(address: Address): Promise<{ measurement: Hex }>;
  computeQueryId(sender: Address, docCommit: Hex, nonce: bigint): Promise<Hex>;
  openFeed(params: { schemaId: number; n: number; isPublic: boolean; allowPanelDisclosure: boolean; paramsHash: Hex; payerCommit: Hex; refundTo: Address; nonce: bigint }, provenance: { docCommit: Hex; kind: number; originId: Hex; fetchedAt: bigint; tokensK: number; transcriptHash: Hex }, intakeSig: Hex): Promise<Hex>;
  feedBudget(): Promise<bigint>;
  fundFeedBudget(amount: bigint): Promise<void>;
  usdgBalance(address: Address): Promise<bigint>;
  approveUsdg(amount: bigint): Promise<void>;
}
export interface FeedQueryRepo { insertFeedQuery(queryId: Hex, feedId: Hex, key: Hex): Promise<void> }
export interface ClockPort { now(): number; sleep(ms: number): Promise<void> }
export interface ExecuteDeps {
  http: HttpPort;
  chain: ChainPort;
  quoteVerifier: QuoteVerifier;
  repo: FeedQueryRepo;
  clock: ClockPort;
  intakeUrl: string;
  feedRunnerAddress: Address;
  refundTo: Address;
  feedRunnerKey: Hex;
  autoFund: boolean;
  feedBudgetMin: bigint;
  feedBudgetTarget: bigint;
  attestationTimeoutMs?: number;
  intakeTimeoutMs?: number;
  confirmationBlocks?: number;
}
