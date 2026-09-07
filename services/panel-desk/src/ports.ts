import type { Address, Hex } from "viem";
import type { DispatchPanelReq, DispatchPanelRes } from "@mochi/protocol";
import type { DrandClient, ensureBeacon } from "@mochi/chain";

export type PanelCase = {
  queryId: Hex; status: number; panelIndex: number; sealBlock: bigint; commitDeadline: bigint;
  revealDeadline: bigint; appealDeadline: bigint; payer: Address; fee: bigint;
  outcomeAnswerHash: Hex; outcomePayloadHash: Hex;
};
export type QueryInfo = { schemaId: number; schemaVersion: number; isPublic: boolean; status: number };
export type ChainPort = {
  dep: { startBlock: string; randomness?: { kind: "blockhash" } | { kind: "drand"; chainHash: string; relays?: string[]; publicKey?: string; genesisTime?: number; period?: number }; contracts: { panel: Address; feeds: Address; randomness: Address } };
  /** Clients `ensureBeacon` needs to read `beaconOf` and post drand beacons with the keeper key. */
  beaconChain: Parameters<typeof ensureBeacon>[0];
  blockNumber(): Promise<bigint>; timestamp(): Promise<bigint>;
  getPanelEvents(from: bigint, to: bigint): Promise<Hex[]>;
  getCase(caseId: Hex): Promise<PanelCase>; panelOf(caseId: Hex, panelIndex: number): Promise<Address[]>;
  getQuery(queryId: Hex): Promise<QueryInfo>; latestVerdictOf(queryId: Hex): Promise<Hex>;
  simulateResolve(caseId: Hex): Promise<boolean>;
  draw(caseId: Hex): Promise<Hex>; reseal(caseId: Hex): Promise<Hex>; resolve(caseId: Hex): Promise<Hex>; finalize(caseId: Hex): Promise<Hex>;
  feedsUpdate(feedId: Hex, key: Hex, verdictId: Hex, payload: Hex): Promise<Hex>;
  feedLatest(feedId: Hex, key: Hex): Promise<{ verdictId: Hex } | null>;
  panelStake(evaluator: Address): Promise<bigint>; stake(amount: bigint): Promise<Hex>; approvePanel(amount: bigint): Promise<Hex>;
  commit(caseId: Hex, commitment: Hex): Promise<Hex>; reveal(caseId: Hex, answerHash: Hex, payloadHash: Hex, salt: Hex): Promise<Hex>;
};
export type IntakeClient = { dispatchPanel(req: DispatchPanelReq): Promise<DispatchPanelRes> };
export type PanelPayload = { caseId: string; panelIndex: number; evaluator: string; payloadHash: string; payload: Uint8Array; answerJson?: string };
export type Store = {
  getCursor(name: string): Promise<bigint | null>; setCursor(name: string, block: bigint): Promise<void>;
  getFeedQuery(queryId: string): Promise<{ feedId: string; key: string } | null>;
  getPanelPayloadByHash(caseId: string, payloadHash: string): Promise<{ payload: Uint8Array } | null>;
  insertPanelPayload(input: PanelPayload): Promise<void>;
  getVerdict(verdictId: string): Promise<{ verdict: Record<string, unknown>; publicPart: { dissent: unknown; fieldAgreement: unknown } | null } | null>;
};
export type Clock = { sleep(ms: number): Promise<void> };
export type PanelDeps = { chain: ChainPort; drand?: DrandClient; intake: IntakeClient; store: Store; clock: Clock; config: { intakeUrl: string; pollMs: number } };
