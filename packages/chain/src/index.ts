// Typed access to the Mochi contracts for services. ABIs are generated from Foundry artifacts
// (scripts/gen-abis.ts); deployments are JSON files written by contracts/script/DeployLocal.s.sol.
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  nonceManager,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  MochiVerdictsAbi,
  FeedsAbi,
  JurorRegistryAbi,
  PanelEscalationAbi,
  QueryEscrowAbi,
  ReceiptAnchorAbi,
  SchemaRegistryAbi,
} from "./abis.ts";

export * from "./abis.ts";
export { DRAND_QUICKNET, DrandClient, drandRoundMessage, drandRoundPublishedAt, ensureBeacon, g1ToEip2537, g2ToEip2537, verifyDrandBeacon } from "./drand.ts";
export type { Beacon, DrandInfo } from "./drand.ts";

export interface ContractAddresses {
  mochiToken: Address;
  randomness: Address;
  schemaRegistry: Address;
  jurorRegistry: Address;
  queryEscrow: Address;
  verdicts: Address;
  feeds: Address;
  stockTokenCrosscheck: Address;
  panel: Address;
  staking: Address;
  receiptAnchor: Address;
  usdg: Address;
  shielded: Address;
  classMix?: Address;
  clerkVoting?: Address;
  disclosureRegistry?: Address;
  timelock?: Address;
}

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  startBlock: string; // decimal
  contracts: ContractAddresses;
  privacy?: { entrypoint: Address; pool: Address; adapter: Address; withdrawalVerifier: Address; commitmentVerifier: Address; poseidonT3: Address; poseidonT4: Address; scope: string };
  randomness?: { kind: "blockhash" } | { kind: "drand"; chainHash: string; relays?: string[]; publicKey?: string; genesisTime?: number; period?: number };
}

/**
 * Loads the deployment: inline JSON from `MOCHI_DEPLOYMENT_JSON` when set (Phala CVMs get it inside the measured
 * compose file, so an enclave's identity pins the contracts it serves), otherwise the file at `path`.
 */
export function loadDeployment(path = process.env.MOCHI_DEPLOYMENT ?? "deployments/local.json"): Deployment {
  const inline = process.env.MOCHI_DEPLOYMENT_JSON;
  const raw = JSON.parse(inline ?? readFileSync(path, "utf8")) as Deployment;
  if (!raw.contracts?.queryEscrow) throw new Error(`invalid deployment ${inline ? "in MOCHI_DEPLOYMENT_JSON" : `file: ${path}`}`);
  return raw;
}

/** Role ids, mirroring MochiRoles.sol and contract-local roles. */
export const ROLE_IDS = {
  GOVERNOR: keccakString("mochi.role.GOVERNOR"),
  GUARDIAN: keccakString("mochi.role.GUARDIAN"),
  ATTESTOR: keccakString("mochi.role.ATTESTOR"),
  FEED_RUNNER: keccakString("mochi.role.FEED_RUNNER"),
  SLASHER: keccakString("mochi.role.SLASHER"),
  ANCHORER: keccakString("mochi.role.ANCHORER"),
} as const;

function keccakString(s: string): Hex {
  return keccak256(toHex(s));
}

/** Query as returned by QueryEscrow.getQuery (viem decodes the struct to named fields). */
export interface QueryView {
  docCommit: Hex;
  schemaId: number;
  schemaVersion: number;
  n: number;
  round: number;
  isPublic: boolean;
  allowPanelDisclosure: boolean;
  payPath: number;
  status: number;
  provenanceKind: number;
  originId: Hex;
  tokensK: number;
  provenanceHash: Hex;
  paramsHash: Hex;
  payerCommit: Hex;
  payer: Address;
  refundTo: Address;
  openedAt: bigint;
  deadline: bigint;
  sealBlock: bigint;
  seed: Hex;
  paid: bigint;
  protocolFee: bigint;
}

export interface JurorView {
  operator: Address;
  measurement: Hex;
  role: number;
  jurorClass: number;
  bond: bigint;
  attestedUntil: bigint;
  exitRequestedAt: bigint;
  delisted: boolean;
  served: number;
  timeouts: number;
  lastTimeoutSlashAt: bigint;
}

export interface VerdictView {
  queryId: Hex;
  round: number;
  status: number;
  isPublic: boolean;
  escalated: boolean;
  provenanceKind: number;
  schemaId: number;
  schemaVersion: number;
  agreementBps: number;
  dissentMask: number;
  timeoutMask: number;
  ts: bigint;
  docCommit: Hex;
  modelSetHash: Hex;
  evidenceRoot: Hex;
  attestationRoot: Hex;
  answerHash: Hex;
  payloadHash: Hex;
  paramsHash: Hex;
  provenanceHash: Hex;
  originId: Hex;
  payerCommit: Hex;
}

export interface FeedEntryView {
  verdictId: Hex;
  asOf: bigint;
  updatedAt: bigint;
  payload: Hex;
}

export interface ProvenanceArg {
  docCommit: Hex;
  kind: number;
  originId: Hex;
  fetchedAt: bigint;
  tokensK: number;
  transcriptHash: Hex;
}

export interface OpenParamsArg {
  schemaId: number;
  n: number;
  isPublic: boolean;
  allowPanelDisclosure: boolean;
  paramsHash: Hex;
  payerCommit: Hex;
  refundTo: Address;
  nonce: bigint;
}

export interface VerdictInputArg {
  queryId: Hex;
  round: number;
  status: number;
  agreementBps: number;
  dissentMask: number;
  timeoutMask: number;
  answerHash: Hex;
  payloadHash: Hex;
  evidenceRoot: Hex;
}

export interface JurorVoteArg {
  juror: Address;
  answerHash: Hex;
  spansRoot: Hex;
  quoteHash: Hex;
  sig: Hex;
}

export interface Chain {
  dep: Deployment;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  account?: PrivateKeyAccount;
  blockNumber(): Promise<bigint>;
  // reads
  getQuery(queryId: Hex): Promise<QueryView>;
  jurorsOf(queryId: Hex): Promise<Address[]>;
  prevNOf(queryId: Hex): Promise<number>;
  isActive(key: Address, role: number): Promise<boolean>;
  getJuror(key: Address): Promise<JurorView>;
  getVerdict(verdictId: Hex): Promise<VerdictView>;
  latestVerdictOf(queryId: Hex): Promise<Hex>;
  feedLatest(feedId: Hex, key: Hex): Promise<FeedEntryView>;
  schemaLatest(schemaId: number): Promise<number>;
  quote(schemaId: number, n: number, tokensK: number): Promise<{ jurorFees: bigint; protocolFee: bigint }>;
  computeQueryId(sender: Address, docCommit: Hex, nonce: bigint): Promise<Hex>;
  // writes (need a private key); each waits for the receipt and returns the tx hash
  seal(queryId: Hex): Promise<Hex>;
  reseal(queryId: Hex): Promise<Hex>;
  expand(queryId: Hex, newN: number): Promise<Hex>;
  openFeed(p: OpenParamsArg, prov: ProvenanceArg, intakeSig: Hex): Promise<Hex>;
  post(v: VerdictInputArg, votes: JurorVoteArg[], consensusSig: Hex): Promise<Hex>;
  feedsUpdate(feedId: Hex, key: Hex, verdictId: Hex, payload: Hex): Promise<Hex>;
  refreshAttestation(keys: Address[], until: bigint): Promise<Hex>;
  reportAttestationFailure(key: Address): Promise<Hex>;
  anchor(root: Hex, count: number): Promise<Hex>;
  escalate(queryId: Hex): Promise<Hex>;
}

export function chainFor(dep: Deployment) {
  return defineChain({
    id: dep.chainId,
    name: dep.chainId === 31337 ? "anvil" : `mochi-${dep.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [dep.rpcUrl] } },
  });
}

export function createChain(dep: Deployment, opts: { privateKey?: Hex; transport?: Transport } = {}): Chain {
  const chain = chainFor(dep);
  const transport = opts.transport ?? http(dep.rpcUrl);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  // nonceManager: services send transactions concurrently from one key (e.g. the orchestrator advances many queries
  // in parallel); without it concurrent sends pick the same nonce and all but one fail.
  const account = opts.privateKey ? privateKeyToAccount(opts.privateKey, { nonceManager }) : undefined;
  const walletClient = account ? createWalletClient({ chain, transport, account }) : undefined;
  const c = dep.contracts;

  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

  async function write(address: Address, abi: readonly unknown[], functionName: string, args: unknown[]): Promise<Hex> {
    if (!walletClient || !account) throw new Error(`createChain: ${functionName} needs a private key`);
    const { request } = await publicClient.simulateContract({
      account,
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
    });
    const hash = await walletClient.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  const num = (x: unknown) => Number(x);

  return {
    dep,
    publicClient,
    walletClient,
    account,
    blockNumber: () => publicClient.getBlockNumber(),
    async getQuery(queryId) {
      const q = await read<Record<string, unknown>>(c.queryEscrow, QueryEscrowAbi, "getQuery", [queryId]);
      return {
        ...(q as unknown as QueryView),
        schemaId: num(q.schemaId),
        schemaVersion: num(q.schemaVersion),
        n: num(q.n),
        round: num(q.round),
        payPath: num(q.payPath),
        status: num(q.status),
        provenanceKind: num(q.provenanceKind),
        tokensK: num(q.tokensK),
      };
    },
    jurorsOf: (queryId) => read<Address[]>(c.queryEscrow, QueryEscrowAbi, "jurorsOf", [queryId]),
    prevNOf: async (queryId) => num(await read(c.queryEscrow, QueryEscrowAbi, "prevNOf", [queryId])),
    isActive: (key, role) => read<boolean>(c.jurorRegistry, JurorRegistryAbi, "isActive", [key, role]),
    async getJuror(key) {
      const j = await read<Record<string, unknown>>(c.jurorRegistry, JurorRegistryAbi, "getJuror", [key]);
      return { ...(j as unknown as JurorView), role: num(j.role), jurorClass: num(j.jurorClass), served: num(j.served), timeouts: num(j.timeouts) };
    },
    async getVerdict(verdictId) {
      const v = await read<Record<string, unknown>>(c.verdicts, MochiVerdictsAbi, "getVerdict", [verdictId]);
      return {
        ...(v as unknown as VerdictView),
        round: num(v.round),
        status: num(v.status),
        provenanceKind: num(v.provenanceKind),
        schemaId: num(v.schemaId),
        schemaVersion: num(v.schemaVersion),
        agreementBps: num(v.agreementBps),
        dissentMask: num(v.dissentMask),
        timeoutMask: num(v.timeoutMask),
      };
    },
    latestVerdictOf: (queryId) => read<Hex>(c.verdicts, MochiVerdictsAbi, "latestVerdictOf", [queryId]),
    feedLatest: (feedId, key) => read<FeedEntryView>(c.feeds, FeedsAbi, "latest", [feedId, key]),
    schemaLatest: async (schemaId) => num(await read(c.schemaRegistry, SchemaRegistryAbi, "latest", [schemaId])),
    async quote(schemaId, n, tokensK) {
      const [jurorFees, protocolFee] = await read<[bigint, bigint]>(c.queryEscrow, QueryEscrowAbi, "quote", [schemaId, n, tokensK]);
      return { jurorFees, protocolFee };
    },
    computeQueryId: (sender, docCommit, nonce) =>
      read<Hex>(c.queryEscrow, QueryEscrowAbi, "computeQueryId", [sender, docCommit, nonce]),
    seal: (queryId) => write(c.queryEscrow, QueryEscrowAbi, "seal", [queryId]),
    reseal: (queryId) => write(c.queryEscrow, QueryEscrowAbi, "reseal", [queryId]),
    expand: (queryId, newN) => write(c.queryEscrow, QueryEscrowAbi, "expand", [queryId, newN]),
    openFeed: (p, prov, intakeSig) => write(c.queryEscrow, QueryEscrowAbi, "openFeed", [p, prov, intakeSig]),
    post: (v, votes, consensusSig) => write(c.verdicts, MochiVerdictsAbi, "post", [v, votes, consensusSig]),
    feedsUpdate: (feedId, key, verdictId, payload) => write(c.feeds, FeedsAbi, "update", [feedId, key, verdictId, payload]),
    refreshAttestation: (keys, until) => write(c.jurorRegistry, JurorRegistryAbi, "refreshAttestation", [keys, until]),
    reportAttestationFailure: (key) => write(c.jurorRegistry, JurorRegistryAbi, "reportAttestationFailure", [key]),
    anchor: (root, count) => write(c.receiptAnchor, ReceiptAnchorAbi, "anchor", [root, count]),
    escalate: (queryId) => write(c.panel, PanelEscalationAbi, "escalate", [queryId]),
  };
}
