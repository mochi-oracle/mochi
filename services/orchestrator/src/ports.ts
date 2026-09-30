import type { Address, Hex } from "viem";
import type { AnswerRes, AttestationDoc, DecisionRes, DispatchRes, Peer, RoundOpenReq } from "@mochi/protocol";
import type { DrandClient, QueryView, JurorView, JurorVoteArg, VerdictInputArg, VerdictView } from "@mochi/chain";

export type QueryLog = { queryId: Hex; blockNumber: bigint; kind: "opened" | "expanded" };
export interface ChainPort {
  dep: { startBlock: string; randomness?: { kind: "blockhash" } | { kind: "drand"; chainHash: string; relays?: string[]; publicKey?: string; genesisTime?: number; period?: number }; contracts: { randomness: Address; queryEscrow: Address; usdg: Address; panel: Address; verdicts: Address } };
  blockNumber(): Promise<bigint>;
  /** Timestamp (seconds) of the latest block — the clock on-chain deadlines are measured against. */
  latestTimestamp(): Promise<bigint>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<QueryLog[]>;
  getQuery(id: Hex): Promise<QueryView>;
  jurorsOf(id: Hex): Promise<Address[]>;
  prevNOf(id: Hex): Promise<number>;
  getJuror(key: Address): Promise<JurorView>;
  getVerdict(verdictId: Hex): Promise<VerdictView>;
  latestVerdictOf(id: Hex): Promise<Hex>;
  /** Transaction hash of the VerdictPosted event for a verdict, or null if not found. */
  verdictTx(verdictId: Hex): Promise<Hex | null>;
  seal(id: Hex): Promise<Hex>; reseal(id: Hex): Promise<Hex>; expire(id: Hex): Promise<Hex>;
  expand(id: Hex, n: number): Promise<Hex>; escalate(id: Hex): Promise<Hex>;
  panelFee(): Promise<bigint>; usdgApprove(spender: Address, amount: bigint): Promise<Hex>;
  post(v: VerdictInputArg, votes: JurorVoteArg[], sig: Hex): Promise<Hex>;
  feedsUpdate(feedId: Hex, key: Hex, verdictId: Hex, payload: Hex): Promise<Hex>;
}
export interface IntakeClient { attestation(url: string): Promise<AttestationDoc>; dispatch(url: string, req: { queryId: Hex; jurors: Array<Peer & { seat: number }>; consensus: Peer }): Promise<DispatchRes> }
export interface JurorClient { attestation(url: string): Promise<AttestationDoc>; answer(url: string, req: { queryId: Hex; seat: number; docEnvelope: DispatchRes["jurors"][number]["docEnvelope"]; consensus: Peer; consensusUrl: string; round: number; deadlineMs: number }, signal?: AbortSignal): Promise<AnswerRes> }
export interface ConsensusClient {
  attestation(url: string): Promise<AttestationDoc>;
  open(url: string, req: RoundOpenReq): Promise<{ deadlineMs: number }>;
  close(url: string, queryId: Hex, remainingMs?: number): Promise<DecisionRes>;
}
export interface Directory { urlOf(addr: Hex): Promise<string | undefined> }
export type FeedQuery = { feedId: Hex; key: Hex };
export interface Store {
  insertQuery(query: QueryView & { id: Hex; ts: Date }): Promise<void>;
  setCursor(name: string, block: bigint): Promise<void>;
  getCursor(name: string): Promise<bigint | null>;
  /** Queries the orchestrator still has work on: DB status not DECIDED / ESCALATED / EXPIRED. */
  queryIds(): Promise<Hex[]>;
  hasVerdict(verdictId: Hex): Promise<boolean>;
  getFeedQuery(id: Hex): Promise<FeedQuery | null>;
  /** Result key for a private query, looked up by its on-chain payerCommit (cannot be overwritten by others). */
  getPayerResultKey(payerCommit: Hex): Promise<Hex | null>;
  insertJurorAnswer(input: { queryId: Hex; round: number; seat: number; juror: Address; class: number; answerHash: Hex; spansRoot: Hex; quoteHash: Hex; sig: Uint8Array; timedOut: boolean; ts: Date }): Promise<void>;
  insertVerdict(v: Record<string, unknown>, publicPart?: { answer: unknown; payload: Uint8Array; dissent: unknown; fieldAgreement: unknown }): Promise<void>;
  storePrivateResult(id: Hex, ciphertext: Uint8Array): Promise<void>;
  updateQueryStatus(id: Hex, status: number): Promise<void>;
  statusCounts(): Promise<Record<string, number>>;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export type OrchestratorDeps = { chain: ChainPort; drand?: DrandClient; intake: IntakeClient; juror: JurorClient; consensus: ConsensusClient; directory: Directory; store: Store; clock: Clock; config: { intakeUrl: string; consensusUrl: string; jurorTimeoutMs: number; closeMaxWaitMs: number; maxParallelQueries: number; feedRunnerKey?: Hex } };
