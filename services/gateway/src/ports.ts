import type { Address, Hex } from "viem";
import type { IntakeResult } from "@mochi/protocol";

export interface IntakeClient {
  request(path: string, body?: unknown): Promise<unknown>;
  attestation(): Promise<unknown>;
}

export interface ChainPort {
  escrow: Address;
  relayer?: Address;
  quote(schemaId: number, n: number, tokensK: number): Promise<{ jurorFees: bigint; protocolFee: bigint }>;
  computeQueryId(sender: Address, docCommit: Hex, nonce: bigint): Promise<Hex>;
  getQuery(queryId: Hex): Promise<unknown>;
  latestVerdictOf(queryId: Hex): Promise<Hex>;
  getVerdict(verdictId: Hex): Promise<unknown>;
  jurorsOf(queryId: Hex): Promise<Address[]>;
  getJuror(juror: Address): Promise<{ jurorClass: number }>;
  feedLatest(feedId: Hex, key: Hex): Promise<{ verdictId: Hex; asOf: bigint; updatedAt: bigint; payload: Hex }>;
  /** Feeds.getFeed(feedId).schemaId (0 when the feed is unknown). */
  feedSchemaId?(feedId: Hex): Promise<number>;
  openWithVoucher(params: unknown, provenance: unknown, sig: Hex, voucher: unknown, voucherSig: Hex): Promise<Hex>;
  simulateOpenShielded?(params: unknown, provenance: unknown, sig: Hex, nullifier: Hex, proof: Hex): Promise<void>;
  relayOpenShielded?(params: unknown, provenance: unknown, sig: Hex, nullifier: Hex, proof: Hex): Promise<Hex>;
  simulateExpandShielded?(queryId: Hex, newN: number, nullifier: Hex, proof: Hex): Promise<void>;
  relayExpandShielded?(queryId: Hex, newN: number, nullifier: Hex, proof: Hex): Promise<Hex>;
}

export interface Store {
  getVerdict(id: string): Promise<any | null>;
  getPrivateResult(id: string): Promise<any | null>;
  disagreementSeries(schemaId: number, field: string, window: string): Promise<unknown[]>;
  modelDisagreementSeries(schemaId: number, field: string, window: string): Promise<unknown[]>;
  getJurorPassports(keys: string[]): Promise<Array<{ key: string; passport: unknown | null }>>;
  paidVerdictCounts(from: Date, to: Date, internalPayers: string[]): Promise<{ external: number; total: number }>;
  activeFeedSubscribers(now: Date): Promise<number>;
  insertDisclosure(verdictId: string, recipientKeyHash: string, envelope: Uint8Array): Promise<boolean>;
  getDisclosure(verdictId: string, recipientKeyHash: string): Promise<{ envelope: Uint8Array } | null>;
  listFeeds(feedId: string): Promise<unknown[]>;
  /** Stores a private query's result key under payerCommit(pub) (first write wins; see db migration 0005). */
  putPayerResultKey(payerCommit: string, pub: string): Promise<void>;
  insertAnonymaVoucher(input: { voucherId: string; queryId: string; tier: number; usdgAmount: string; settled: boolean }): Promise<void>;
}

export interface RelayerWallet {
  sender: Address;
  openWithVoucher(params: unknown, provenance: unknown, sig: Hex, voucher: unknown, voucherSig: Hex): Promise<Hex>;
}

export interface Clock { nowSeconds(): number; }

export interface GatewayDeps {
  intake: IntakeClient;
  chain: ChainPort;
  store: Store;
  relayer?: RelayerWallet;
  relayRateLimit?: { capacity: number; refillPerSecond: number };
  relayBodyLimitBytes?: number;
  clock: Clock;
  anonymaSecret?: string;
  mcpVoucherMode?: boolean;
  internalPayers?: string[];
  sealForIntake?: (attestation: unknown, plaintext: unknown) => Promise<unknown>;
}

export type PreparedQuery = { queryId: Hex; to: Address; data: Hex; quote: { jurorFees: string; protocolFee: string } };
export type IntakeResponse = IntakeResult & { quote?: { jurorFees: string; protocolFee: string } };
