import type { VerdictReceipt, ReceiptSigner } from "@mochi/receipts";
import type { Address, Hex } from "viem";

export interface ChainEvent {
  name: string;
  address: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  timestamp: Date;
  transactionHash: Hex;
  logIndex: number;
}

export interface CursorStore {
  getCursor(name: string): Promise<bigint | null>;
  setCursor(name: string, block: bigint): Promise<void>;
}

export interface ChainPort {
  startBlock: bigint;
  chainId: number;
  verdictContract: string;
  latestBlock(): Promise<bigint>;
  events(from: bigint, to: bigint): Promise<ChainEvent[]>;
  verdict(id: Hex): Promise<ChainVerdict>;
  query(id: Hex): Promise<ChainQuery>;
  seatJurors(queryId: Hex): Promise<string[]>;
  jurorClass(key: string): Promise<number>;
  votesOfPostTx(txHash: Hex): Promise<ChainVote[]>;
  eventSnapshot(event: ChainEvent): Promise<Record<string, unknown>>;
  anchor(root: Hex, count: number): Promise<Hex>;
  blockTimestamp(block: bigint): Promise<Date>;
}

export interface JurorPassport {
  modelId: string;
  lineage: string;
  weightsSha256: string;
  openWeights: boolean;
  provider: string;
  zdr: boolean;
  tee: string;
}

export interface ModelDisagreementWrite {
  bucket: Date;
  window: string;
  schemaId: number;
  field: string;
  modelId: string;
  samples: number;
  disagreeCount: number;
}

export interface ChainVote {
  juror: Address;
  quoteHash: Hex;
}

export interface ChainQuery {
  schemaId: number;
  schemaVersion: number;
  n: number;
  round: number;
  isPublic: boolean;
  payPath: number;
  payerCommit: Hex;
  paramsHash: Hex;
  provenanceKind: number;
  originId: Hex;
  tokensK: number;
  status: number;
  docCommit: Hex;
  payer?: Address | null;
}

export interface ChainVerdict extends ChainQuery {
  id: Hex;
  queryId: Hex;
  escalated: boolean;
  agreementBps: number;
  dissentMask: number;
  timeoutMask: number;
  ts: bigint;
  modelSetHash: Hex;
  evidenceRoot: Hex;
  attestationRoot: Hex;
  answerHash: Hex;
  payloadHash: Hex;
  provenanceHash: Hex;
  tx: Hex;
}

export interface PublicVerdictPart {
  answer: unknown;
  payload: Uint8Array;
  dissent: unknown;
  fieldAgreement: unknown;
}

export interface DisagreementWrite {
  bucket: Date;
  window: string;
  schemaId: number;
  field: string;
  class: number;
  disagreeRate: number;
  samples: number;
  disagreeCount: number;
}

export interface ReceiptRow {
  verdictId: string;
  keyId: string;
  sig: Uint8Array | string;
  payload: VerdictReceipt;
  anchorRoot: string;
  anchorIndex: number;
}

export interface StorePort extends CursorStore {
  applyEvent(event: ChainEvent): Promise<void>;
  getVerdict(id: string): Promise<{
    verdict: Record<string, unknown>;
    publicPart: PublicVerdictPart | null;
  } | null>;
  listUnreceiptedVerdicts(): Promise<ChainVerdict[]>;
  insertReceipt(row: ReceiptRow, disagreement?: DisagreementWrite[]): Promise<void>;
  getReceipt(id: string): Promise<ReceiptRow | null>;
  insertAnchor(row: { root: Hex; ts: Date; count: number; tx: Hex }): Promise<void>;
  updateReceiptAnchor(root: Hex, entries: Array<{ verdictId: string; index: number }>): Promise<void>;
  recordDisagreement(rows: DisagreementWrite[]): Promise<void>;
  getJurorPassports(keys: string[]): Promise<Array<{ key: string; passport: unknown }>>;
  recordModelDisagreement(rows: ModelDisagreementWrite[]): Promise<void>;
  purgeExpiredPrivateResults(now: Date): Promise<number>;
  setQueryPayer(queryId: string, payer: string): Promise<void>;
  upsertFeedSubscription(feedId: string, consumer: string, until: Date, paid: bigint): Promise<void>;
  status(): Promise<Record<string, string | null>>;
  listUnanchoredReceipts(): Promise<Array<{ verdictId: string; payload: VerdictReceipt }>>;
  getReceiptAnchor(verdictId: string): Promise<{ root: Hex; tx: Hex; proof: Hex[] } | null>;
}

export interface AlertPort {
  post(url: string, payload: unknown, timeoutMs: number): Promise<void>;
}

export interface ClockPort {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface IndexerDeps {
  chain: ChainPort;
  store: StorePort;
  signer: ReceiptSigner;
  alert: AlertPort;
  alertUrl?: string;
  clock?: ClockPort;
}
