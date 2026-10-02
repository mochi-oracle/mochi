import type { Address, Hex } from "viem";
import type { IntakeResult } from "@mochi/protocol";

export interface IntakeClient {
  request(path: string, body?: unknown): Promise<unknown>;
  attestation(): Promise<unknown>;
}

export interface ChainPort {
  /** EIP-712 domain of intake grants: the chain id and QueryEscrow (`escrow`). */
  chainId: number;
  escrow: Address;
  relayer?: Address;
  /** JurorRegistry.isActive(key, role): an intake grant is honoured only from an active INTAKE key. */
  isActive(key: Address, role: number): Promise<boolean>;
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
  /** DisclosureRegistry.disclosureOf(verdictId, recipientKeyHash, discloser).envelopeHash (zero if that address never
   *  disclosed); absent when the deployment has no DisclosureRegistry. */
  disclosedEnvelopeHash?(verdictId: Hex, recipientKeyHash: Hex, discloser: Address): Promise<Hex>;
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
  /** Stores one disclosure envelope (its canonical JSON bytes) under envelopeHash = keccak256(envelope); idempotent.
   *  Distinct envelopes for the same verdict and recipient are all kept: there is no first-come slot to squat. */
  insertDisclosure(verdictId: string, recipientKeyHash: string, envelopeHash: string, envelope: Uint8Array): Promise<void>;
  /** The envelope with `envelopeHash`, or without one the oldest for the verdict and recipient. */
  getDisclosure(verdictId: string, recipientKeyHash: string, envelopeHash?: string): Promise<{ envelopeHash: string; envelope: Uint8Array } | null>;
  /** Envelope hashes for the verdict and recipient, oldest first (bounded); `total` counts them all. */
  listDisclosures(verdictId: string, recipientKeyHash: string): Promise<{ envelopes: Array<{ envelopeHash: string; createdAt: Date }>; total: number }>;
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
  /** Per-caller /v1/query calls (default 60 burst, 1/s). */
  queryRateLimit?: { capacity: number; refillPerSecond: number };
  /**
   * Global budget for payer-key rows written by public private-query preparation (default 500 burst, 1 per 3 s). Only
   * a grant that passes every check spends it.
   */
  payerKeyWriteLimit?: { capacity: number; refillPerSecond: number };
  /** Per payerCommit share of that budget, so replaying one valid grant cannot spend it (default 3 burst, 1 per 10 min). */
  payerKeyGrantLimit?: { capacity: number; refillPerSecond: number };
  /** Per-caller POST /v1/disclosures calls (default 10 burst, 1 per minute). */
  disclosureRateLimit?: { capacity: number; refillPerSecond: number };
  /** Global budget for disclosure rows written by public callers (default 200 burst, 1 per 10 s). */
  disclosureWriteLimit?: { capacity: number; refillPerSecond: number };
  /** POST /v1/disclosures body cap in bytes (default 64 KiB). */
  disclosureBodyLimitBytes?: number;
  relayBodyLimitBytes?: number;
  clock: Clock;
  anonymaSecret?: string;
  mcpVoucherMode?: boolean;
  internalPayers?: string[];
  sealForIntake?: (attestation: unknown, plaintext: unknown) => Promise<unknown>;
}

export type PreparedQuery = { queryId: Hex; to: Address; data: Hex; quote: { jurorFees: string; protocolFee: string } };
export type IntakeResponse = IntakeResult & { quote?: { jurorFees: string; protocolFee: string } };
