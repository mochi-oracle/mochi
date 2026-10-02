// Paid canary (handoff §8.9): one private N3 claim review through the SDK, paid with exactly the on-chain quote
// (0.10 USDG at launch), then verified end to end without printing any content.
//
//   bun scripts/canary-check.ts [run] --deployment <deployment.json> --payer-key-file <payer.json> --measurement 0x…
//     --out <private dir> [--identities <production-identities.json|verified report>] [--cvm-url https://…]
//     [--gateway-url …] [--indexer-url …] [--rpc-key-file <drpc-key> | RPC_URL=… | --rpc <public url>]
//     [--timeout 300] [--expected-total 0.10] [--rehearsal] [--yes] [--resume] [--fixture <json>]
//   bun scripts/canary-check.ts expire --deployment <deployment.json> --payer-key-file <payer.json> --query-id 0x…
//     [--out <private dir>] [--rpc-key-file …] [--yes]
//
// Every transaction (USDG approve, openWithUSDG, expire) is printed first with to, function, value, signer, chain and
// amount. On chain 4663 each one needs a typed "yes" at an interactive terminal; --yes is refused there. On 46630
// (--rehearsal, mock USDG) and local anvil, --yes sends without prompts.
//
// Reported (content-free): status VERDICT / HUNG / EXPIRED / timeout, the decrypted enum label only, whether
// keccak256(decrypted answer) equals MochiVerdicts.answerHash on chain, the payer debit against the quote and the
// QuerySettled jurorsPaid/refunded split, ETH spent by each enclave service signer during the window (balance deltas),
// and latency. HUNG and timeout print telemetry pointers (queryId, round, seat masks) for the public container logs.
// The claim, excerpt, prompts and answer text are never printed or written; the result key stays in memory.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, defineChain, encodeFunctionData, http, parseAbi, parseUnits, toEventSelector, toHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import * as A from "@mochi/chain";
import { payerCommit } from "@mochi/protocol";
import {
  ANVIL_CHAIN_ID, MAINNET_CHAIN_ID, MAINNET_USDG, Redactor, TESTNET_CHAIN_ID, TxRefused, assertYesAllowed, describeHead, chainName, checkServiceUrl, DEFAULT_CVM_URL,
  fetchLogsChunked, formatEth, formatUsdg, intakeAddressFrom, loadKeyFile, parseAddress, parseBytes32, parseCli, parsePositiveInt, readJson, resolveRpc,
  sendGuardedTx, serviceSignersFrom, sleep, terminalConfirmIO, writePrivateJson, SERVICE_SIGNER_ROLES, ZERO_ADDRESS,
  type ConfirmIO, type SendPolicy, type ServiceSigners, type TxIntent,
} from "./launch-ops/common.ts";
import { claimFixtureFrom, createSdkAdapter, fixtureSecrets, type CanaryOutcome, type CanarySecrets, type ClaimReviewAdapter } from "./launch-ops/sdk-adapter.ts";

export const FREEFORM_FACT_SCHEMA_ID = 7;
export const QUERY_STATUS = ["NONE", "OPEN", "SEALED", "DECIDED", "HUNG", "ESCALATED", "EXPIRED"] as const;
const ERC20 = parseAbi([
  "function name() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const ESCROW_EXTRA = parseAbi([
  "function expire(bytes32 queryId)",
  "function paused() view returns (bool)",
  "event QuerySettled(bytes32 indexed queryId, uint8 round, uint8 status, uint256 jurorsPaid, uint256 refunded)",
  "event QueryExpired(bytes32 indexed queryId, uint256 refunded)",
  "event Refunded(bytes32 indexed queryId, address indexed to, uint256 amount)",
]);
const DEFAULT_FIXTURE = resolve(import.meta.dir, "launch-ops/canary-fixture.json");
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

// ───────────────────────────── pure checks ─────────────────────────────

export type OpenCall = {
  params: { n: number; refundTo: Address };
  provenance: {
    docCommit: Hex; kind: number; originId: Hex; fetchedAt: bigint; tokensK: number; transcriptHash: Hex; opener: Address; schemaId: number; schemaVersion: number;
    paramsHash: Hex; payerCommit: Hex; isPublic: boolean; allowPanelDisclosure: boolean; nonce: bigint; expiry: bigint;
  };
};

/**
 * Before paying, check the prepared call is exactly an openWithUSDG on the deployment's escrow whose intake grant is a
 * private N3 FREEFORM_FACT review opened and refunded by the payer and encrypted to this run's result key. The SDK
 * already rejects gateway calldata that differs from the grant; this re-checks the fields the canary relies on.
 */
export function verifyOpenCalldata(tx: { to: Address; data: Hex }, expect: { escrow: Address; payer: Address; resultPubKey: Hex; nowSec: bigint; n?: number }): OpenCall {
  if (tx.to.toLowerCase() !== expect.escrow.toLowerCase()) throw new Error("prepared transaction is not addressed to the deployment's QueryEscrow");
  let decoded: { functionName: string; args?: readonly unknown[] };
  try { decoded = decodeFunctionData({ abi: A.QueryEscrowAbi, data: tx.data }) as never; }
  catch { throw new Error("prepared calldata does not decode as a QueryEscrow call"); }
  if (decoded.functionName !== "openWithUSDG") throw new Error(`prepared call is ${decoded.functionName}, expected openWithUSDG`);
  const [p, prov] = decoded.args as [OpenCall["params"], OpenCall["provenance"]];
  const problems: string[] = [];
  if (Number(p.n) !== (expect.n ?? 3)) problems.push(`n ${p.n}`);
  if (p.refundTo.toLowerCase() !== expect.payer.toLowerCase()) problems.push("refundTo is not the payer");
  if (prov.opener.toLowerCase() !== expect.payer.toLowerCase()) problems.push("grant opener is not the payer");
  if (Number(prov.schemaId) !== FREEFORM_FACT_SCHEMA_ID) problems.push(`schemaId ${prov.schemaId}`);
  if (prov.isPublic) problems.push("public query");
  if (prov.allowPanelDisclosure) problems.push("panel disclosure allowed");
  if (prov.payerCommit.toLowerCase() !== payerCommit(expect.resultPubKey).toLowerCase()) problems.push("payerCommit is not bound to this run's result key");
  if (Number(prov.kind) !== 0) problems.push("provenance is not SUBMITTED");
  if (BigInt(prov.expiry) <= expect.nowSec) problems.push("intake grant already expired");
  if (problems.length) throw new Error(`prepared openWithUSDG rejected: ${problems.join(", ")}`);
  return {
    params: { n: Number(p.n), refundTo: p.refundTo },
    provenance: { ...prov, kind: Number(prov.kind), fetchedAt: BigInt(prov.fetchedAt), tokensK: Number(prov.tokensK), schemaId: Number(prov.schemaId), schemaVersion: Number(prov.schemaVersion), nonce: BigInt(prov.nonce), expiry: BigInt(prov.expiry) },
  };
}

export function resultPublicKey(resultPrivateKey: Hex): Hex {
  return toHex(x25519.getPublicKey(Buffer.from(resultPrivateKey.slice(2), "hex")));
}

/** Seats whose bit is set in a 32-bit mask (timeoutMask / dissentMask). */
export function maskSeats(mask: number | undefined, n = 9): number[] {
  if (mask === undefined) return [];
  const seats: number[] = [];
  for (let s = 0; s < Math.min(n, 32); s++) if ((mask >>> s) & 1) seats.push(s);
  return seats;
}

export type Settlement = { status: number; round: number; jurorsPaid: bigint; refunded: bigint };
export type Reconciliation = { ok: boolean; lines: string[]; problems: string[] };

/**
 * Charge reconciliation. `transferredAtOpen` is the USDG Transfer payer→escrow in the open receipt; `refundedToPayer`
 * sums Refunded events to the payer. VERDICT: jurorsPaid + refunded + protocol fee = paid. HUNG: jurorsPaid + refunded
 * = paid (the protocol fee is refunded). EXPIRED: refunded = paid.
 */
export function reconcileCharge(input: {
  expectedTotal: bigint; quotedTotal: bigint; paid: bigint; protocolFee: bigint; transferredAtOpen: bigint;
  payerBalanceBefore?: bigint; payerBalanceAfter?: bigint; refundedToPayer: bigint;
  settlement?: Settlement; expiredRefund?: bigint;
}): Reconciliation {
  const lines: string[] = []; const problems: string[] = [];
  lines.push(`quote ${formatUsdg(input.quotedTotal)} USDG (expected ${formatUsdg(input.expectedTotal)}); escrowed ${formatUsdg(input.paid)}; payer → escrow transfer at open ${formatUsdg(input.transferredAtOpen)}`);
  if (input.quotedTotal !== input.expectedTotal) problems.push(`quote ${formatUsdg(input.quotedTotal)} differs from expected ${formatUsdg(input.expectedTotal)}`);
  if (input.transferredAtOpen !== input.paid || input.paid !== input.quotedTotal) problems.push("open debit, escrowed amount and quote disagree");
  if (input.settlement) {
    const s = input.settlement;
    const label = s.status === 1 ? "VERDICT" : s.status === 2 ? "HUNG" : `status ${s.status}`;
    const fee = s.status === 1 ? input.protocolFee : 0n;
    lines.push(`QuerySettled ${label} round ${s.round}: jurorsPaid ${formatUsdg(s.jurorsPaid)} + refunded ${formatUsdg(s.refunded)}${s.status === 1 ? ` + protocol fee ${formatUsdg(input.protocolFee)} (staking/recipient)` : " (protocol fee refunded)"}`);
    if (s.jurorsPaid + s.refunded + fee !== input.paid) problems.push(`settlement split ${formatUsdg(s.jurorsPaid + s.refunded + fee)} does not add up to ${formatUsdg(input.paid)}`);
    if (s.refunded !== input.refundedToPayer) problems.push(`QuerySettled refunded ${formatUsdg(s.refunded)} but Refunded to payer ${formatUsdg(input.refundedToPayer)}`);
  } else if (input.expiredRefund !== undefined) {
    lines.push(`QueryExpired refunded ${formatUsdg(input.expiredRefund)}`);
    if (input.expiredRefund !== input.paid) problems.push("expiry refund differs from the escrowed amount");
  } else lines.push("no QuerySettled/QueryExpired event yet: escrow still holds the payment");
  const expectedNet = input.transferredAtOpen - input.refundedToPayer;
  if (input.payerBalanceBefore !== undefined && input.payerBalanceAfter !== undefined) {
    const net = input.payerBalanceBefore - input.payerBalanceAfter;
    lines.push(`payer net debit ${formatUsdg(net)} USDG (expected ${formatUsdg(expectedNet)} = ${formatUsdg(input.transferredAtOpen)} − refunds ${formatUsdg(input.refundedToPayer)})`);
    if (net !== expectedNet) problems.push(`payer net debit ${formatUsdg(net)} differs from ${formatUsdg(expectedNet)}`);
  }
  return { ok: problems.length === 0, lines, problems };
}

export type GasDelta = { role: string; address: Address; before: bigint; after: bigint; spentWei: bigint };
export function gasDeltas(signers: ServiceSigners, before: Record<string, bigint>, after: Record<string, bigint>): GasDelta[] {
  return SERVICE_SIGNER_ROLES.filter((role) => signers[role] && before[role] !== undefined && after[role] !== undefined)
    .map((role) => ({ role, address: signers[role]!, before: before[role]!, after: after[role]!, spentWei: before[role]! - after[role]! }));
}

/** Chain policy for the canary: mainnet real USDG only; 46630 only with --rehearsal (mock USDG allowed); anvil local. */
export function canaryChainPolicy(input: { chainId: number; rpcChainId: number; deploymentRehearsal?: boolean; rehearsalFlag: boolean; yes: boolean; usdg: Address; usdgName: string }): void {
  if (input.rpcChainId !== input.chainId) throw new Error(`RPC is chain ${input.rpcChainId}, deployment is chain ${input.chainId}`);
  assertYesAllowed(input.chainId, input.yes);
  if (input.chainId === MAINNET_CHAIN_ID) {
    if (input.deploymentRehearsal === true || input.rehearsalFlag) throw new Error("a rehearsal deployment or --rehearsal cannot run on chain 4663");
    if (input.usdg.toLowerCase() !== MAINNET_USDG.toLowerCase() || input.usdgName === "Mock USDG") throw new Error("chain 4663 canary must pay real USDG 0x5fc5…d1168");
    return;
  }
  if (input.chainId === TESTNET_CHAIN_ID) {
    if (!input.rehearsalFlag || input.deploymentRehearsal !== true) throw new Error("chain 46630 canary needs --rehearsal and a rehearsal deployment");
    return;
  }
  if (input.chainId === ANVIL_CHAIN_ID) return;
  throw new Error(`refusing to run a canary on ${chainName(input.chainId)}`);
}

export type CanaryCheckpoint = {
  version: 1; status: "opened" | "finished"; chainId: number; payer: Address; queryId: Hex; openTx: Hex; openBlock: string; openedAt: string;
  paid: string; protocolFee: string; quotedTotal: string; expectedTotal: string; transferredAtOpen: string; payerUsdgBefore: string;
  signerBalancesBefore: Record<string, string>; result?: CanaryResult;
};
export type CanaryResult = {
  status: "VERDICT" | "HUNG" | "EXPIRED" | "timeout" | "UNRESOLVED"; answer?: string; expected?: string; answerMatchesExpected?: boolean;
  answerHashOnChain?: Hex; answerHashMatches?: boolean; payloadHashMatches?: boolean; verdictId?: Hex; round?: number; timeoutSeats?: number[]; dissentSeats?: number[]; agreementBps?: number;
  reconciliation: Reconciliation; gas: Array<{ role: string; address: Address; spentEth: string }>; payerGasEth: string;
  latency: { openToVerdictChainSec?: number; wallClockSec: number };
};

/** A paid query whose checkpoint is not finished must be resumed, never paid again blindly. */
export function checkpointGate(existing: CanaryCheckpoint | undefined, resume: boolean): "new" | "resume" {
  if (resume) {
    if (!existing) throw new Error("--resume: no canary checkpoint in --out");
    return "resume";
  }
  if (existing && existing.status === "opened") throw new Error(`an earlier canary paid for query ${existing.queryId} and did not finish; rerun with --resume (or move ${"canary-checkpoint.json"} aside after checking the chain)`);
  return "new";
}

// ───────────────────────────── chain helpers ─────────────────────────────

type Deployment = A.Deployment & { rehearsal?: boolean; owner?: Address };
type Env = {
  deployment: Deployment; publicClient: PublicClient; redactor: Redactor; io: ConfirmIO; policy: SendPolicy;
  payer: ReturnType<typeof loadKeyFile>; walletClient: ReturnType<typeof createWalletClient>; payerGas: bigint;
};

async function getQuery(env: Env, queryId: Hex) {
  return await env.publicClient.readContract({ address: env.deployment.contracts.queryEscrow, abi: A.QueryEscrowAbi, functionName: "getQuery", args: [queryId] }) as unknown as { status: number; round: number; paid: bigint; protocolFee: bigint; deadline: bigint; refundTo: Address; n: number };
}

async function send(env: Env, intent: Omit<TxIntent, "chainId" | "signer">) {
  const sent = await sendGuardedTx({ publicClient: env.publicClient as never, walletClient: env.walletClient as never }, { ...intent, chainId: env.deployment.chainId, signer: env.payer.address }, env.policy, env.io);
  env.payerGas += sent.gasCostWei;
  return sent;
}

async function signerBalances(env: Env, signers: ServiceSigners | undefined): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  if (!signers) return out;
  await Promise.all(SERVICE_SIGNER_ROLES.map(async (role) => { if (signers[role]) out[role] = await env.publicClient.getBalance({ address: signers[role]! }); }));
  return out;
}

async function escrowEvents(env: Env, queryId: Hex, fromBlock: bigint) {
  const events = ESCROW_EXTRA.filter((x) => x.type === "event");
  const latest = await env.publicClient.getBlockNumber({ cacheTime: 0 });
  const raw = await fetchLogsChunked(env.publicClient as never, { address: env.deployment.contracts.queryEscrow, topics: [events.map((e) => toEventSelector(e)), queryId] }, fromBlock, latest);
  const logs = raw.map((log) => decodeEventLog({ abi: events, data: log.data, topics: log.topics as [Hex, ...Hex[]] }));
  let settlement: Settlement | undefined; let expiredRefund: bigint | undefined; let refundedToPayer = 0n;
  for (const log of logs as Array<{ eventName: string; args: Record<string, unknown> }>) {
    if (log.eventName === "QuerySettled") settlement = { status: Number(log.args.status), round: Number(log.args.round), jurorsPaid: log.args.jurorsPaid as bigint, refunded: log.args.refunded as bigint };
    if (log.eventName === "QueryExpired") expiredRefund = log.args.refunded as bigint;
    if (log.eventName === "Refunded" && String(log.args.to).toLowerCase() === env.payer.address.toLowerCase()) refundedToPayer += log.args.amount as bigint;
  }
  return { settlement, expiredRefund, refundedToPayer };
}

function telemetryPointers(redactor: Redactor, info: { queryId: Hex; round?: number; verdictId?: Hex; timeoutMask?: number; dissentMask?: number; agreementBps?: number; deadline?: bigint; deploymentPath: string }) {
  redactor.log("Telemetry pointers (content-free; read them before any retry, handoff §10):");
  redactor.log(`  queryId        ${info.queryId}`);
  if (info.round !== undefined) redactor.log(`  round          ${info.round}`);
  redactor.log(`  verdictId      ${info.verdictId ?? "none posted"}`);
  if (info.timeoutMask !== undefined) redactor.log(`  timed-out seats ${JSON.stringify(maskSeats(info.timeoutMask))} (timeoutMask ${info.timeoutMask})`);
  if (info.dissentMask !== undefined) redactor.log(`  dissent seats  ${JSON.stringify(maskSeats(info.dissentMask))} (dissentMask ${info.dissentMask}); agreementBps ${info.agreementBps ?? "n/a"}`);
  redactor.log(`  The lead agent filters the CVM public container logs for "queryId":"${info.queryId}" and reads causeCode, httpStatus, late,`);
  redactor.log("  delivered, seat, modelId, attempt, elapsedMs and remainingBudgetMs. Check Phala ACI status and credits; do not raise timeouts.");
  if (info.deadline) redactor.log(`  Refund: after ${new Date(Number(info.deadline) * 1000).toISOString()} anyone may expire it: bun scripts/canary-check.ts expire --deployment ${info.deploymentPath} --payer-key-file <payer.json> --query-id ${info.queryId}`);
}

// ───────────────────────────── main ─────────────────────────────

async function setup(cli: ReturnType<typeof parseCli>, redactor: Redactor) {
  const deploymentPath = cli.options.get("--deployment");
  if (!deploymentPath) throw new Error("--deployment is required");
  const deployment = readJson<Deployment>(deploymentPath, "deployment");
  for (const name of ["queryEscrow", "usdg", "verdicts", "jurorRegistry"] as const) parseAddress(deployment.contracts?.[name], `deployment.contracts.${name}`);
  const rpc = resolveRpc({ rpcKeyFile: cli.options.get("--rpc-key-file"), rpcFlag: cli.options.get("--rpc"), env: process.env, deploymentRpc: deployment.rpcUrl, chainId: deployment.chainId, drpcNetwork: cli.options.get("--drpc-network") });
  for (const s of rpc.secrets) redactor.add(s);
  const yes = cli.flags.has("--yes");
  assertYesAllowed(deployment.chainId, yes);
  const chain = defineChain({ id: deployment.chainId, name: chainName(deployment.chainId), nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc.url] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpc.url, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  const rpcChainId = await publicClient.getChainId();
  const [usdgName, usdgDecimals] = await Promise.all([
    publicClient.readContract({ address: deployment.contracts.usdg, abi: ERC20, functionName: "name" }),
    publicClient.readContract({ address: deployment.contracts.usdg, abi: ERC20, functionName: "decimals" }),
  ]);
  canaryChainPolicy({ chainId: deployment.chainId, rpcChainId, deploymentRehearsal: deployment.rehearsal, rehearsalFlag: cli.flags.has("--rehearsal"), yes, usdg: deployment.contracts.usdg, usdgName });
  if (Number(usdgDecimals) !== 6) throw new Error("USDG must have 6 decimals");
  const payerFile = cli.options.get("--payer-key-file");
  if (!payerFile) throw new Error("--payer-key-file is required");
  const payer = loadKeyFile(payerFile, "--payer-key-file");
  const walletClient = createWalletClient({ chain, transport: http(rpc.url, { timeout: 30_000 }), account: payer.account });
  const env: Env = { deployment, publicClient, redactor, io: terminalConfirmIO(redactor), policy: { yes }, payer, walletClient, payerGas: 0n };
  redactor.log(`canary: ${chainName(deployment.chainId)} via ${rpc.display}; payer ${payer.address}; escrow ${deployment.contracts.queryEscrow}; USDG ${deployment.contracts.usdg}${usdgName === "Mock USDG" ? " (Mock USDG, rehearsal)" : ""}; ${await describeHead(publicClient)}`);
  return { env, deploymentPath, rpc };
}

async function runExpire(cli: ReturnType<typeof parseCli>, redactor: Redactor): Promise<number> {
  const { env, deploymentPath } = await setup(cli, redactor);
  const queryId = parseBytes32(cli.options.get("--query-id"), "--query-id");
  const q = await getQuery(env, queryId);
  const block = await env.publicClient.getBlock();
  redactor.log(`query ${queryId}: status ${QUERY_STATUS[Number(q.status)] ?? q.status}, paid ${formatUsdg(q.paid)} USDG, deadline ${new Date(Number(q.deadline) * 1000).toISOString()}, refundTo ${q.refundTo}`);
  if (Number(q.status) !== 1 && Number(q.status) !== 2) throw new Error("only OPEN or SEALED queries can expire");
  if (block.timestamp <= BigInt(q.deadline)) throw new Error(`deadline not passed yet (chain time ${new Date(Number(block.timestamp) * 1000).toISOString()})`);
  const before = await env.publicClient.readContract({ address: env.deployment.contracts.usdg, abi: ERC20, functionName: "balanceOf", args: [q.refundTo] });
  const sent = await send(env, {
    to: env.deployment.contracts.queryEscrow, functionName: `expire(queryId=${queryId})`, value: 0n,
    amount: `refunds the remaining escrow (up to ${formatUsdg(q.paid)} USDG) to ${q.refundTo}`, purpose: "expire a paid query past its deadline", data: encodeFunctionData({ abi: ESCROW_EXTRA, functionName: "expire", args: [queryId] }),
  });
  const after = await env.publicClient.readContract({ address: env.deployment.contracts.usdg, abi: ERC20, functionName: "balanceOf", args: [q.refundTo] });
  const events = await escrowEvents(env, queryId, sent.receipt.blockNumber);
  redactor.log(`expired: QueryExpired refunded ${formatUsdg(events.expiredRefund ?? 0n)} USDG; refundTo balance +${formatUsdg(after - before)} USDG`);
  if (cli.options.has("--out")) writePrivateJson(join(cli.options.get("--out")!, `canary-expire-${queryId.slice(2, 10)}.json`), { queryId, tx: sent.hash, refunded: (events.expiredRefund ?? 0n).toString(), refundToDelta: (after - before).toString(), deployment: resolve(deploymentPath) });
  return events.expiredRefund === after - before ? 0 : 1;
}

async function runCanary(cli: ReturnType<typeof parseCli>, redactor: Redactor): Promise<number> {
  const fixture = claimFixtureFrom(readJson<unknown>(cli.options.get("--fixture") ?? DEFAULT_FIXTURE, "canary fixture"));
  for (const secret of fixtureSecrets(fixture)) redactor.add(secret);
  const outDir = cli.options.get("--out");
  if (!outDir) throw new Error("--out <private dir> is required (checkpoint: a paid canary is never repeated blindly)");
  const checkpointPath = join(outDir, "canary-checkpoint.json");
  const existing = existsSync(checkpointPath) ? readJson<CanaryCheckpoint>(checkpointPath, "canary checkpoint") : undefined;
  const mode = checkpointGate(existing, cli.flags.has("--resume"));
  const { env, deploymentPath, rpc } = await setup(cli, redactor);
  const { deployment, publicClient, payer } = env;
  const measurement = parseBytes32(cli.options.get("--measurement"), "--measurement");
  const timeoutSec = parsePositiveInt(cli.options.get("--timeout"), "--timeout", 300, 3600);
  const expectedTotal = parseUnits(cli.options.get("--expected-total") ?? "0.10", 6);
  const identitiesDoc = cli.options.has("--identities") ? readJson<unknown>(cli.options.get("--identities")!, "--identities") : undefined;
  const signers = identitiesDoc ? serviceSignersFrom(identitiesDoc) : undefined;
  const gatewayUrl = checkServiceUrl(cli.options.get("--gateway-url") ?? cli.options.get("--cvm-url") ?? DEFAULT_CVM_URL, "--gateway-url");
  const indexerUrl = cli.options.has("--indexer-url") ? checkServiceUrl(cli.options.get("--indexer-url")!, "--indexer-url") : undefined;
  const mockRoot = cli.options.get("--insecure-mock-quote-root");
  if (mockRoot && (deployment.chainId !== ANVIL_CHAIN_ID || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(rpc.url))) throw new Error("--insecure-mock-quote-root is for local anvil tests only");
  const adapter: ClaimReviewAdapter = createSdkAdapter({
    gatewayUrl, ...(indexerUrl ? { indexerUrl } : {}), measurement, deployment, publicClient,
    quoteVerifier: mockRoot ? { mockRootAddress: parseAddress(mockRoot, "--insecure-mock-quote-root") } : "dcap",
  });
  const started = Date.now();
  let checkpoint: CanaryCheckpoint;
  let querySecrets: CanarySecrets | undefined;

  if (mode === "new") {
    if (await publicClient.readContract({ address: deployment.contracts.queryEscrow, abi: ESCROW_EXTRA, functionName: "paused" })) throw new Error("QueryEscrow is paused; nothing sent");
    const intake = await adapter.intake();
    const intakeActive = await publicClient.readContract({ address: deployment.contracts.jurorRegistry, abi: A.JurorRegistryAbi, functionName: "isActive", args: [intake.address, 2] });
    const pinnedIntake = identitiesDoc ? intakeAddressFrom(identitiesDoc) : undefined;
    redactor.log(`intake ${intake.address}: quote verified against ${measurement}; active on chain: ${intakeActive}${pinnedIntake ? `; matches --identities: ${pinnedIntake.toLowerCase() === intake.address.toLowerCase()}` : ""}`);
    if (!intakeActive) throw new Error("intake is not active on chain; nothing sent");
    if (pinnedIntake && pinnedIntake.toLowerCase() !== intake.address.toLowerCase()) throw new Error("gateway intake differs from the verified identities; nothing sent");

    const prepared = await adapter.prepare(fixture, payer.address);
    querySecrets = prepared.secrets;
    const chainNow = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    const call = verifyOpenCalldata(prepared.tx, { escrow: deployment.contracts.queryEscrow, payer: payer.address, resultPubKey: resultPublicKey(prepared.secrets.resultPrivateKey), nowSec: chainNow });
    const computedId = await publicClient.readContract({ address: deployment.contracts.queryEscrow, abi: A.QueryEscrowAbi, functionName: "computeQueryId", args: [payer.address, call.provenance.docCommit, call.provenance.nonce] });
    if (String(computedId).toLowerCase() !== prepared.queryId.toLowerCase()) throw new Error("gateway queryId does not match computeQueryId; nothing sent");
    const [jurorFees, protocolFee] = await publicClient.readContract({ address: deployment.contracts.queryEscrow, abi: A.QueryEscrowAbi, functionName: "quote", args: [call.provenance.schemaId, call.params.n, call.provenance.tokensK] }) as readonly [bigint, bigint];
    const total = jurorFees + protocolFee;
    const grantExpiry = new Date(Number(call.provenance.expiry) * 1000).toISOString();
    redactor.log(`prepared query ${prepared.queryId}: private N${call.params.n} FREEFORM_FACT, tokensK ${call.provenance.tokensK}; intake grant for opener ${call.provenance.opener} expires ${grantExpiry}; on-chain quote ${formatUsdg(total)} USDG (jurors ${formatUsdg(jurorFees)}, protocol ${formatUsdg(protocolFee)})`);
    if (total !== expectedTotal) throw new Error(`quote ${formatUsdg(total)} USDG differs from --expected-total ${formatUsdg(expectedTotal)}; nothing sent`);
    const [usdgBalance, ethBalance, allowance] = await Promise.all([
      publicClient.readContract({ address: deployment.contracts.usdg, abi: ERC20, functionName: "balanceOf", args: [payer.address] }),
      publicClient.getBalance({ address: payer.address }),
      publicClient.readContract({ address: deployment.contracts.usdg, abi: ERC20, functionName: "allowance", args: [payer.address, deployment.contracts.queryEscrow] }),
    ]);
    redactor.log(`payer balances: ${formatUsdg(usdgBalance)} USDG, ${formatEth(ethBalance)} ETH; allowance to escrow ${formatUsdg(allowance)} USDG`);
    if (usdgBalance < total) throw new Error("payer USDG balance is below the quote; nothing sent");
    if (allowance !== total) {
      if (allowance > 0n) await send(env, { to: deployment.contracts.usdg, functionName: `approve(spender=QueryEscrow ${deployment.contracts.queryEscrow}, amount=0)`, value: 0n, amount: "0 USDG approved (reset)", purpose: "reset the USDG allowance before an exact approval", data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [deployment.contracts.queryEscrow, 0n] }) });
      await send(env, { to: deployment.contracts.usdg, functionName: `approve(spender=QueryEscrow ${deployment.contracts.queryEscrow}, amount=${formatUsdg(total)} USDG)`, value: 0n, amount: `${formatUsdg(total)} USDG approved (exactly the quote)`, purpose: "allow QueryEscrow to collect exactly this canary's quote", data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [deployment.contracts.queryEscrow, total] }) });
    }
    const afterApprovals = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    if (afterApprovals + 60n >= call.provenance.expiry) throw new Error(`the intake grant expires at ${grantExpiry}, too soon to open; rerun for a fresh grant (nothing paid)`);
    const signerBefore = await signerBalances(env, signers);
    const payerUsdgBefore = await publicClient.readContract({ address: deployment.contracts.usdg, abi: ERC20, functionName: "balanceOf", args: [payer.address] });
    const sent = await send(env, {
      to: prepared.tx.to, functionName: `openWithUSDG(n=3, refundTo=${payer.address}; intake grant: FREEFORM_FACT, private, opener=${payer.address}, expires ${grantExpiry}; queryId=${prepared.queryId})`, value: 0n,
      amount: `${formatUsdg(total)} USDG paid into escrow`, purpose: "paid canary claim review (content encrypted to the attested intake)", data: prepared.tx.data,
    });
    const transferredAtOpen = sent.receipt.logs.filter((log) => log.address.toLowerCase() === deployment.contracts.usdg.toLowerCase()).map((log) => {
      try { return decodeEventLog({ abi: ERC20, data: log.data, topics: log.topics as [Hex, ...Hex[]] }); } catch { return undefined; }
    }).filter((ev): ev is NonNullable<typeof ev> => ev?.eventName === "Transfer" && String(ev.args.from).toLowerCase() === payer.address.toLowerCase() && String(ev.args.to).toLowerCase() === deployment.contracts.queryEscrow.toLowerCase())
      .reduce((sum, ev) => sum + (ev.args as { value: bigint }).value, 0n);
    const q = await getQuery(env, prepared.queryId);
    checkpoint = {
      version: 1, status: "opened", chainId: deployment.chainId, payer: payer.address, queryId: prepared.queryId, openTx: sent.hash, openBlock: sent.receipt.blockNumber.toString(),
      openedAt: new Date().toISOString(), paid: q.paid.toString(), protocolFee: q.protocolFee.toString(), quotedTotal: total.toString(), expectedTotal: expectedTotal.toString(),
      transferredAtOpen: transferredAtOpen.toString(), payerUsdgBefore: payerUsdgBefore.toString(), signerBalancesBefore: Object.fromEntries(Object.entries(signerBefore).map(([k, v]) => [k, v.toString()])),
    };
    writePrivateJson(checkpointPath, checkpoint);
    redactor.log(`checkpoint written: ${checkpointPath} (ids and amounts only)`);
  } else {
    checkpoint = existing!;
    if (checkpoint.chainId !== deployment.chainId || checkpoint.payer.toLowerCase() !== payer.address.toLowerCase()) throw new Error("checkpoint belongs to another chain or payer");
    redactor.log(`resuming query ${checkpoint.queryId} (opened ${checkpoint.openedAt}); the result key is never persisted, so the answer label cannot be decrypted on resume`);
  }

  // Wait on the chain itself; the SDK is used to read and decrypt once a verdict exists.
  const queryId = checkpoint.queryId;
  const openBlock = BigInt(checkpoint.openBlock);
  const deadline = Date.now() + timeoutSec * 1000;
  let status: CanaryResult["status"] = "timeout";
  let verdictId: Hex | undefined;
  let q = await getQuery(env, queryId);
  for (;;) {
    q = await getQuery(env, queryId);
    const latest = await publicClient.readContract({ address: deployment.contracts.verdicts, abi: A.MochiVerdictsAbi, functionName: "latestVerdictOf", args: [queryId] }) as Hex;
    if (Number(q.status) === 6) { status = "EXPIRED"; break; }
    if ((Number(q.status) === 3 || Number(q.status) === 4) && latest !== ZERO32) { verdictId = latest; status = Number(q.status) === 3 ? "VERDICT" : "HUNG"; break; }
    if (Date.now() > deadline) break;
    await sleep(3_000);
  }
  const observedAt = Date.now();
  const result: Partial<CanaryResult> = { status, expected: fixture.expected };
  let onChainVerdict: A.VerdictView | undefined;
  if (verdictId) {
    onChainVerdict = await publicClient.readContract({ address: deployment.contracts.verdicts, abi: A.MochiVerdictsAbi, functionName: "getVerdict", args: [verdictId] }) as unknown as A.VerdictView;
    Object.assign(result, { verdictId, round: Number(onChainVerdict.round), answerHashOnChain: onChainVerdict.answerHash, agreementBps: Number(onChainVerdict.agreementBps), timeoutSeats: maskSeats(Number(onChainVerdict.timeoutMask)), dissentSeats: maskSeats(Number(onChainVerdict.dissentMask)) });
  }
  if (status === "VERDICT" && verdictId && querySecrets) {
    try {
      const outcome: CanaryOutcome = await adapter.wait(queryId, querySecrets, Math.max(30_000, deadline - Date.now()));
      const decrypted = await adapter.decryptAndCheck(queryId, verdictId, querySecrets, { answerHash: onChainVerdict!.answerHash, payloadHash: onChainVerdict!.payloadHash });
      result.answer = decrypted.answer ?? "unrecognised";
      result.answerMatchesExpected = decrypted.answer === fixture.expected;
      result.answerHashMatches = decrypted.answerHash.toLowerCase() === onChainVerdict!.answerHash.toLowerCase();
      result.payloadHashMatches = decrypted.mismatch === undefined;
      if (outcome.status !== "VERDICT" || outcome.answer !== decrypted.answer) result.status = "UNRESOLVED";
    } catch (error) {
      redactor.warn(`decrypt/verify failed: ${redactor.error(error).split("\n")[0]}`);
      result.answerHashMatches = false;
    }
  }
  const events = await escrowEvents(env, queryId, openBlock);
  const payerAfter = await publicClient.readContract({ address: deployment.contracts.usdg, abi: ERC20, functionName: "balanceOf", args: [payer.address] });
  const reconciliation = reconcileCharge({
    expectedTotal: BigInt(checkpoint.expectedTotal), quotedTotal: BigInt(checkpoint.quotedTotal), paid: BigInt(checkpoint.paid), protocolFee: BigInt(checkpoint.protocolFee),
    transferredAtOpen: BigInt(checkpoint.transferredAtOpen), payerBalanceBefore: BigInt(checkpoint.payerUsdgBefore), payerBalanceAfter: payerAfter, refundedToPayer: events.refundedToPayer,
    ...(events.settlement ? { settlement: events.settlement } : {}), ...(events.expiredRefund !== undefined ? { expiredRefund: events.expiredRefund } : {}),
  });
  const after = await signerBalances(env, signers);
  const gas = signers ? gasDeltas(signers, Object.fromEntries(Object.entries(checkpoint.signerBalancesBefore).map(([k, v]) => [k, BigInt(v)])), after) : [];
  const openBlockData = await publicClient.getBlock({ blockNumber: openBlock });
  const final: CanaryResult = {
    ...(result as CanaryResult), reconciliation, gas: gas.map((g) => ({ role: g.role, address: g.address, spentEth: formatEth(g.spentWei, 9) })), payerGasEth: formatEth(env.payerGas, 9),
    latency: { ...(onChainVerdict ? { openToVerdictChainSec: Number(BigInt(onChainVerdict.ts) - openBlockData.timestamp) } : {}), wallClockSec: Math.round((observedAt - started) / 1000) },
  };

  redactor.log("");
  redactor.log(`CANARY ${final.status} — query ${queryId}`);
  if (final.answer) redactor.log(`  outcome (decrypted enum label): ${final.answer}; expected ${fixture.expected}: ${final.answerMatchesExpected ? "match" : "MISMATCH"}`);
  if (verdictId) redactor.log(`  verdict ${verdictId}; on-chain answerHash ${final.answerHashOnChain}; keccak256(decrypted answer) ${final.answerHashMatches === undefined ? "not checked (no result key)" : final.answerHashMatches ? "MATCHES" : "DOES NOT MATCH"}${final.payloadHashMatches === undefined ? "" : `; salted private payloadHash ${final.payloadHashMatches ? "matches" : "DOES NOT MATCH"}`}`);
  for (const line of reconciliation.lines) redactor.log(`  charge: ${line}`);
  for (const problem of reconciliation.problems) redactor.log(`  charge PROBLEM: ${problem}`);
  if (gas.length) for (const g of gas) redactor.log(`  gas ${g.role.padEnd(12)} ${g.address} spent ${formatEth(g.spentWei, 9)} ETH (balance delta over the window)`);
  else redactor.log("  gas: pass --identities to measure the enclave service signers");
  redactor.log(`  payer gas ${final.payerGasEth} ETH; latency: open→verdict ${final.latency.openToVerdictChainSec ?? "n/a"} s on chain, ${final.latency.wallClockSec} s wall clock`);
  if (final.status !== "VERDICT") telemetryPointers(redactor, { queryId, round: Number(q.round), ...(verdictId ? { verdictId } : {}), ...(onChainVerdict ? { timeoutMask: Number(onChainVerdict.timeoutMask), dissentMask: Number(onChainVerdict.dissentMask), agreementBps: Number(onChainVerdict.agreementBps) } : {}), ...(Number(q.status) === 1 || Number(q.status) === 2 ? { deadline: BigInt(q.deadline) } : {}), deploymentPath });

  const finished = final.status === "VERDICT" || final.status === "HUNG" || final.status === "EXPIRED";
  writePrivateJson(checkpointPath, { ...checkpoint, status: finished ? "finished" : "opened", result: final });
  writePrivateJson(join(outDir, `canary-report-${queryId.slice(2, 10)}.json`), { queryId, chainId: deployment.chainId, payer: payer.address, deployment: resolve(deploymentPath), ...final });
  const pass = final.status === "VERDICT" && final.answerMatchesExpected === true && final.answerHashMatches === true && final.payloadHashMatches === true && reconciliation.ok;
  redactor.log(pass ? "CANARY PASSED" : "CANARY NOT PASSED (see above; nothing is retried automatically)");
  return pass ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] === "expire" || argv[0] === "run" ? argv[0] : "run";
  const rest = argv[0] === command ? argv.slice(1) : argv;
  const cli = parseCli(rest, {
    flags: ["--yes", "--rehearsal", "--resume"],
    options: ["--deployment", "--payer-key-file", "--measurement", "--out", "--identities", "--cvm-url", "--gateway-url", "--indexer-url", "--rpc-key-file", "--rpc", "--drpc-network",
      "--timeout", "--expected-total", "--fixture", "--query-id", "--insecure-mock-quote-root"],
    positionals: 0,
  });
  const redactor = new Redactor();
  try {
    return command === "expire" ? await runExpire(cli, redactor) : await runCanary(cli, redactor);
  } catch (error) {
    redactor.warn(`canary: ${error instanceof TxRefused ? "refused: " : ""}${redactor.error(error)}`);
    return error instanceof TxRefused ? 3 : 1;
  }
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
