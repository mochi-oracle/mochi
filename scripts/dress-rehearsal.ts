// Testnet (46630) dress rehearsal of the CA-day sequence, handoff §8.2–8.9, then pause and standby (§7D), with
// panel escalation off and the testnet wallets. Testnet only: it refuses any RPC or deployment that is not chain 46630.
//
// It runs every step it may run itself (deploy, verify-ownership, panel inspect, identities and launch files, env
// files, funding, owner configure/activate batches and the guardian pause from key files, the operator's enrollment
// transactions, the canary). It never runs `phala`, `railway` or anything else that touches the CVM: at each CVM
// step it prints the exact command for the operator's lead agent, records the step as awaiting the operator, and exits.
// After the lead agent ran it, continue with `--continue <step>`; the script then checks the CVM's public status.
//
// Each step writes a JSON checkpoint into <out>/checkpoints (directory mode 700, files 600). A finished step is never
// repeated. An interrupted chain step resumes from chain state (timelock operation state, enrolled seats, balances,
// paused flag). An interrupted deploy is never restarted blindly: it continues with `deploy-local --resume`, which checks
// every step recorded in deploy-local's journal (<out>/deployment.json.progress.json) on chain, refuses on any
// contradiction and sends only the missing steps. Without that journal it stays blocked (inspect first, then
// --force-step deploy).
//
// First run (all configuration is recorded in <out>/rehearsal-config.json; later runs need only --out):
//   bun scripts/dress-rehearsal.ts --out <dir> --panel-escalation off \
//     --deployer-key-file <testnet-deployer.json> --owner-key-file <testnet-rehearsal-owner.json> \
//     --operator-key-file <testnet-rehearsal-operator.json> [--payer-key-file <json>, default deployer] \
//     --measurement 0x… --compose <evidence/compose.yml> --cvm-base-env <cvm-base.env> \
//     [--previous-identities <evidence/identities-verified.json>] \
//     (--usdg <Mock USDG on 46630> --mochi-token <stand-in MOCHI on 46630> | --adopt-deployment <rehearsal deployment.json>) \
//     [--cvm-url https://…] [--cvm-id …] [--rpc <public testnet url>] [--yes]
//   bun scripts/dress-rehearsal.ts --out <dir> --status
//   bun scripts/dress-rehearsal.ts --out <dir> --continue cvm-prepare [--yes]
// Options: --until <step> stops after a step; --force-step <step> reruns an interrupted step after you inspected it;
// --fund-owner-eth 0.0003 --fund-operator-eth 0.0003 --fund-orchestrator-eth 0.0005 --fund-signer-eth 0.0001 (top-up
// targets); --canary-timeout 300; --wait-healthy 600; --warmup 120.
import { cpSync, existsSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeFunctionData, http, parseAbi, parseEther,
  type Address, type Hex, type PublicClient,
} from "viem";
import * as A from "@mochi/chain";
import { buildPhalaBatch, type Input as BatchInput } from "./phala-batch.ts";
import { prepareProductionEnrollment } from "./prepare-production-enrollment.ts";
import {
  DEFAULT_CVM_ID, DEFAULT_CVM_URL, PUBLIC_RPC, Redactor, TESTNET_CHAIN_ID, TxRefused, assertPrivateFile, describeHead, checkServiceUrl, ensurePrivateDir,
  fetchJsonBounded, formatEth, formatUsdg, loadKeyFile, parseAddress, parseBytes32, parseCli, parseEthAmount, parsePositiveInt, readJson, resolveRpc,
  sendGuardedTx, serviceSignersFrom, sleep, terminalConfirmIO, writePrivateJson, SERVICE_SIGNER_ROLES,
  type ConfirmIO, type LoadedKey, type RpcConfig, type SendPolicy, type TxIntent,
} from "./launch-ops/common.ts";
import { journalPathFor } from "./launch-ops/deploy-journal.ts";
import { parseCvmStatus } from "./launch-watch.ts";

const ROOT = resolve(import.meta.dir, "..");

// ───────────────────────────── plan ─────────────────────────────

export type StepKind = "read" | "local" | "chain" | "operator";
export type StepDef = { id: string; section: string; kind: StepKind; title: string };
export const STEPS: readonly StepDef[] = [
  { id: "preflight", section: "§7", kind: "read", title: "chain 46630, key files, balances, tokens, CVM status" },
  { id: "deploy", section: "§8.2", kind: "chain", title: "deploy contracts paused (deployer), panel escalation off" },
  { id: "verify-deployment", section: "§8.2", kind: "read", title: "verify-ownership.ts and panel-escalation.ts inspect" },
  { id: "identities", section: "§8.3", kind: "read", title: "verify identities, prepare launch files, runtime copies per mode" },
  { id: "env-files", section: "§8.4", kind: "local", title: "CVM env files for prepare, enroll, active and standby" },
  { id: "fund", section: "§8.5", kind: "chain", title: "top up owner, operator and enclave service signers (deployer)" },
  { id: "cvm-prepare", section: "§8.6", kind: "operator", title: "lead agent deploys prepare mode; then status and identities are checked" },
  { id: "configure", section: "§8.6", kind: "chain", title: "configure batch: owner schedules, waits the delay, executes" },
  { id: "enrollment", section: "§8.7", kind: "chain", title: "enrollment proofs and the operator's 9 enrollment transactions" },
  { id: "cvm-enroll", section: "§8.7", kind: "operator", title: "lead agent deploys enroll mode; wait for 11/11 active identities" },
  { id: "activate", section: "§8.8", kind: "chain", title: "activate batch: owner schedules, waits, executes (unpauses escrow)" },
  { id: "cvm-active", section: "§8.8", kind: "operator", title: "lead agent deploys active mode; wait for payments and warm-up" },
  { id: "canary", section: "§8.9", kind: "chain", title: "paid canary with the SDK (mock USDG, --rehearsal)" },
  { id: "pause", section: "§7D", kind: "chain", title: "guardian (owner) pauses QueryEscrow" },
  { id: "cvm-standby", section: "§7D", kind: "operator", title: "lead agent returns the CVM to standby" },
];
export const STEP_IDS = STEPS.map((s) => s.id);
const OPERATOR_ENV: Record<string, string> = { "cvm-prepare": "prepare", "cvm-enroll": "enroll", "cvm-active": "active", "cvm-standby": "standby" };

export type CheckpointState = "started" | "awaiting-operator" | "done" | "failed";
export type Checkpoint = {
  id: string; state: CheckpointState; startedAt: string; updatedAt: string;
  txs: Array<{ purpose: string; hash: Hex; gasCostWei?: string }>;
  outputs: Record<string, unknown>; error?: string; operatorCommand?: string;
};

export type Decision =
  | { action: "skip" }
  | { action: "run"; resumed: boolean }
  | { action: "await-operator" }
  | { action: "verify-operator" }
  | { action: "blocked"; reason: string };

/** Pure resume policy for one step. `deployJournal`: deploy-local's progress journal exists for the rehearsal deployment. */
export function decideStep(step: StepDef, checkpoint: Checkpoint | undefined, opts: { continueStep?: string; forceStep?: string; deployJournal?: boolean }): Decision {
  if (checkpoint?.state === "done") return { action: "skip" };
  if (step.kind === "operator") {
    if (opts.continueStep === step.id) return { action: "verify-operator" };
    return { action: "await-operator" };
  }
  if (!checkpoint) return { action: "run", resumed: false };
  // Interrupted or failed. Read/local steps and chain steps that reconcile against chain state are safe to resume.
  // deploy-local --resume verifies its journal against the chain before it sends anything and refuses on a contradiction.
  if (step.id === "deploy" && opts.forceStep !== "deploy" && !opts.deployJournal) {
    return { action: "blocked", reason: "an earlier deploy was interrupted and left no deploy-local journal; inspect the deployer's transactions first, then pass --force-step deploy (or --adopt-deployment)" };
  }
  return { action: "run", resumed: true };
}

/** The first step that is not done, or undefined when the rehearsal is complete. */
export function nextPendingStep(checkpoints: ReadonlyMap<string, Checkpoint>): StepDef | undefined {
  return STEPS.find((s) => checkpoints.get(s.id)?.state !== "done");
}

/** --continue is accepted only for the operator step the rehearsal is waiting on. */
export function validateContinue(continueStep: string | undefined, checkpoints: ReadonlyMap<string, Checkpoint>): void {
  if (!continueStep) return;
  const step = STEPS.find((s) => s.id === continueStep);
  if (!step || step.kind !== "operator") throw new Error(`--continue takes an operator step: ${STEPS.filter((s) => s.kind === "operator").map((s) => s.id).join(", ")}`);
  const next = nextPendingStep(checkpoints);
  if (next?.id !== continueStep) throw new Error(`--continue ${continueStep}: the rehearsal is at ${next?.id ?? "the end"}, not at ${continueStep}`);
  if (checkpoints.get(continueStep)?.state !== "awaiting-operator") throw new Error(`--continue ${continueStep}: that command has not been handed to the lead agent yet; run without --continue first`);
}

export function cvmDeployCommand(cvmId: string, compose: string, envFile: string): string {
  return `phala deploy --cvm-id ${cvmId} -c ${compose} -e ${envFile} --public-logs --wait --timeout 600`;
}

export type TopUp = { role: string; address: Address; balance: bigint; target: bigint; amount: bigint };
/** Pure: send only the shortfall to reach each target; never more. */
export function topUpPlan(entries: ReadonlyArray<{ role: string; address: Address; balance: bigint; target: bigint }>): TopUp[] {
  return entries.map((e) => ({ ...e, amount: e.balance >= e.target ? 0n : e.target - e.balance }));
}

export type RehearsalDeployment = A.Deployment & { rehearsal?: boolean; deployer?: Address; owner?: Address; guardian?: Address; paused?: boolean; panelEscalation?: string; tokenSource?: { kind?: string }; timelockDelay?: string; minJurorBond?: string };
/** The rehearsal accepts only a chain 46630 rehearsal deployment, external stand-in token, panel off, launched paused. */
export function assertRehearsalDeployment(dep: RehearsalDeployment, expect?: { owner?: Address; deployer?: Address }): void {
  const problems: string[] = [];
  if (dep.chainId !== TESTNET_CHAIN_ID || dep.rehearsal !== true) problems.push("must be chain 46630 with rehearsal=true");
  if (dep.panelEscalation !== "off") problems.push("panelEscalation must be off");
  if (dep.tokenSource?.kind !== "external") problems.push("must use the external (stand-in) MOCHI token path");
  if (dep.paused !== true) problems.push("must record paused=true");
  if (!dep.contracts?.timelock || !dep.privacy?.entrypoint) problems.push("timelock and privacy entrypoint are required");
  if (dep.minJurorBond !== "0") problems.push("minJurorBond must be 0");
  if (expect?.owner && dep.owner?.toLowerCase() !== expect.owner.toLowerCase()) problems.push("owner differs from the owner key file");
  if (expect?.owner && dep.guardian?.toLowerCase() !== expect.owner.toLowerCase()) problems.push("guardian must be the owner");
  if (expect?.deployer && dep.deployer?.toLowerCase() !== expect.deployer.toLowerCase()) problems.push("deployer differs from the deployer key file");
  if (problems.length) throw new Error(`deployment is not a usable dress-rehearsal deployment: ${problems.join("; ")}`);
}

/** Checks deploy-local's printed plan (its run without --yes) against the rehearsal configuration. */
export function deployPlanProblems(plan: Record<string, unknown>, c: Pick<RehearsalConfig, "owner" | "usdg" | "mochiToken" | "timelockDelay">): string[] {
  const problems: string[] = [];
  const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (plan.mode !== "mainnet rehearsal" || plan.chainId !== TESTNET_CHAIN_ID) problems.push("not a chain 46630 mainnet rehearsal");
  if (!same(plan.owner, c.owner) || !same(plan.guardian, c.owner)) problems.push("owner/guardian");
  if (!same(plan.usdg, c.usdg) || !same(plan.mochiToken, c.mochiToken)) problems.push("tokens");
  if (plan.panelEscalation !== "off" || plan.minJurorBondMochi !== "0" || plan.timelockDelay !== c.timelockDelay) problems.push("panel/bond/delay");
  if (plan.shielded !== "privacy-pools" || plan.randomness !== "drand") problems.push("shielded/randomness");
  return problems;
}

/** An exact copy of the prepare-mode runtime with only "mode" changed (handoff §8.3). */
export function runtimeForMode<T extends { mode?: unknown }>(runtime: T, mode: "prepare" | "enroll" | "active"): T {
  if (runtime.mode !== "prepare") throw new Error("production-runtime.json must be the prepare-mode runtime");
  return { ...structuredClone(runtime), mode };
}

/** OpenZeppelin TimelockController operation state from getTimestamp (1 = done). */
export function timelockState(timestamp: bigint, now: bigint): "unscheduled" | "pending" | "ready" | "done" {
  if (timestamp === 0n) return "unscheduled";
  if (timestamp === 1n) return "done";
  return timestamp <= now ? "ready" : "pending";
}

export type RehearsalConfig = {
  version: 1; chainId: 46630; rpcSource: string; rpcPublicUrl?: string;
  deployerKeyFile: string; ownerKeyFile: string; operatorKeyFile: string; payerKeyFile: string;
  deployer: Address; owner: Address; operator: Address; payer: Address;
  measurement: Hex; cvmUrl: string; cvmId: string; compose?: string; cvmBaseEnv?: string; previousIdentities?: string;
  usdg?: Address; mochiToken?: Address; adoptDeployment?: string; timelockDelay: string; panelEscalation: "off";
  fund: { owner: string; operator: string; orchestrator: string; signer: string };
  canaryTimeout: number; waitHealthy: number; warmup: number;
};

/** Later runs may repeat a setting only with the same value; changing configuration needs a new --out. */
export function mergeConfig(existing: RehearsalConfig | undefined, fromFlags: Partial<RehearsalConfig>): Partial<RehearsalConfig> {
  if (!existing) return fromFlags;
  for (const [key, value] of Object.entries(fromFlags)) {
    if (value === undefined) continue;
    const before = (existing as Record<string, unknown>)[key];
    if (JSON.stringify(before) !== JSON.stringify(value)) throw new Error(`--out already records a different ${key}; start a new --out to change the rehearsal configuration`);
  }
  return existing;
}

// ───────────────────────────── runtime context ─────────────────────────────

const TIMELOCK_ABI = parseAbi(["function getTimestamp(bytes32 id) view returns (uint256)"]);
const ESCROW_ABI = parseAbi(["function paused() view returns (bool)", "function pause()", "function hasRole(bytes32,address) view returns (bool)"]);
const ERC20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"]);

type Ctx = {
  out: string; config: RehearsalConfig; redactor: Redactor; io: ConfirmIO; policy: SendPolicy; rpc: RpcConfig;
  publicClient: PublicClient; chain: ReturnType<typeof defineChain>; checkpoint: Checkpoint; save(): void;
  keys: Map<string, LoadedKey>;
};

const paths = (out: string) => ({
  config: join(out, "rehearsal-config.json"), checkpoints: join(out, "checkpoints"), logs: join(out, "logs"), batches: join(out, "batches"),
  deployment: join(out, "deployment.json"), identitiesReport: join(out, "identities-launch-verified.json"), launch: join(out, "launch"),
  launchIdentities: join(out, "launch", "production-identities.json"), launchRuntime: join(out, "launch", "production-runtime.json"),
  proofs: join(out, "launch", "enrollment-proofs.json"), canary: join(out, "canary"),
  env: (mode: string) => join(out, `cvm-${mode}.env`), runtime: (mode: string) => join(out, "launch", `runtime-${mode}.json`),
});

function key(ctx: Ctx, role: "deployer" | "owner" | "operator" | "payer"): LoadedKey {
  const cached = ctx.keys.get(role);
  if (cached) return cached;
  const file = { deployer: ctx.config.deployerKeyFile, owner: ctx.config.ownerKeyFile, operator: ctx.config.operatorKeyFile, payer: ctx.config.payerKeyFile }[role];
  const loaded = loadKeyFile(file, `${role} key file`);
  const expected = { deployer: ctx.config.deployer, owner: ctx.config.owner, operator: ctx.config.operator, payer: ctx.config.payer }[role];
  if (loaded.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`${role} key file no longer matches the recorded ${role} address`);
  ctx.keys.set(role, loaded);
  return loaded;
}

async function send(ctx: Ctx, role: "deployer" | "owner" | "operator" | "payer", intent: Omit<TxIntent, "chainId" | "signer">) {
  const signer = key(ctx, role);
  const walletClient = createWalletClient({ chain: ctx.chain, transport: http(ctx.rpc.url, { timeout: 30_000 }), account: signer.account });
  const sent = await sendGuardedTx({ publicClient: ctx.publicClient as never, walletClient: walletClient as never }, { ...intent, chainId: TESTNET_CHAIN_ID, signer: signer.address }, ctx.policy, ctx.io);
  ctx.checkpoint.txs.push({ purpose: intent.purpose, hash: sent.hash, gasCostWei: sent.gasCostWei.toString() });
  ctx.save();
  return sent;
}

function runChild(ctx: Ctx, label: string, args: string[], opts: { allowFail?: boolean; inherit?: boolean } = {}): { code: number; output: string } {
  const env = { ...process.env, RPC_URL: ctx.rpc.url };
  ctx.redactor.log(`  $ bun ${args.join(" ")}`);
  const child = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: opts.inherit ? "inherit" : "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = opts.inherit ? "" : ctx.redactor.text(`${child.stdout ?? ""}${child.stderr ?? ""}`);
  const code = child.status ?? 1;
  if (!opts.inherit) {
    const logDir = paths(ctx.out).logs; ensurePrivateDir(logDir);
    const logFile = join(logDir, `${ctx.checkpoint.id}-${label}.log`);
    writeFileSync(logFile, output, { mode: 0o600 }); chmodSync(logFile, 0o600);
    ctx.redactor.log(`    exit ${code}; log ${logFile}`);
  }
  if (code !== 0 && !opts.allowFail) throw new Error(`${label} failed (exit ${code})${output ? `:\n${failureSummary(output)}` : ""}`);
  return { code, output };
}

/** The informative lines of a failed child (error names, viem details), not its stack frames. */
export function failureSummary(output: string, max = 8): string {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const useful = lines.filter((l) => /^(\w*Error|error:)|^Details:|^Ownership verification failed|^- |reverted|refus|failed|mismatch/i.test(l.trim()) && !/^\s*at /.test(l) && !/^\d+ \|/.test(l.trim()));
  return [...new Set(useful.length ? useful : lines.slice(-max))].slice(0, max).map((l) => `    ${l.trim()}`).join("\n");
}

async function cvmStatus(ctx: Ctx) {
  const res = await fetchJsonBounded(`${ctx.config.cvmUrl}/production/status`, { timeoutMs: 10_000, maxBytes: 256 * 1024 });
  if (!res.ok) return { error: res.error ?? `HTTP ${res.status}` } as const;
  try { return { status: parseCvmStatus(res.json) } as const; } catch { return { error: "invalid status" } as const; }
}

/** Polls /production/status every 10 s (handoff §8.6) until `accept` holds or the bound is reached. */
async function waitForCvm(ctx: Ctx, accept: (s: ReturnType<typeof parseCvmStatus>) => boolean, what: string) {
  const until = Date.now() + ctx.config.waitHealthy * 1000;
  for (;;) {
    const res = await cvmStatus(ctx);
    const line = "status" in res && res.status ? `mode ${res.status.mode}, payments ${res.status.payments}, services ${Object.entries(res.status.services).map(([n, s]) => `${n}:${s}`).join(",") || "none"}` : `unavailable (${"error" in res ? res.error : "?"})`;
    ctx.redactor.log(`  cvm: ${line}`);
    if ("status" in res && res.status && accept(res.status)) return res.status;
    if (Date.now() > until) throw new Error(`CVM did not reach ${what} within ${ctx.config.waitHealthy}s; nothing else was changed`);
    await sleep(10_000);
  }
}
const allHealthy = (s: ReturnType<typeof parseCvmStatus>) => Object.keys(s.services).length > 0 && Object.values(s.services).every((x) => x === "healthy");

function deployment(ctx: Ctx): RehearsalDeployment {
  const dep = readJson<RehearsalDeployment>(paths(ctx.out).deployment, "rehearsal deployment");
  assertRehearsalDeployment(dep, { owner: ctx.config.owner });
  return dep;
}
const launchIdentities = (ctx: Ctx) => readJson<BatchInput & { jurors: Array<BatchInput["jurors"][number]> }>(paths(ctx.out).launchIdentities, "launch production-identities.json");

async function identitiesActive(ctx: Ctx, dep: RehearsalDeployment, ids: BatchInput): Promise<{ active: number; total: number; problems: string[] }> {
  const all: Array<[{ address: Address; measurement: Hex; operator: Address; class?: number }, number]> = [[ids.intake, 2], [ids.consensus, 3], ...ids.jurors.map((j) => [j, 1] as [typeof j, number])];
  let active = 0; const problems: string[] = [];
  for (const [identity, role] of all) {
    const [isActive, juror] = await Promise.all([
      ctx.publicClient.readContract({ address: dep.contracts.jurorRegistry, abi: A.JurorRegistryAbi, functionName: "isActive", args: [identity.address, role] }),
      ctx.publicClient.readContract({ address: dep.contracts.jurorRegistry, abi: A.JurorRegistryAbi, functionName: "getJuror", args: [identity.address] }) as Promise<unknown>,
    ]);
    const j = juror as A.JurorView;
    if (j.operator.toLowerCase() !== identity.operator.toLowerCase() || j.measurement.toLowerCase() !== identity.measurement.toLowerCase() || (role === 1 && Number(j.jurorClass) !== identity.class)) problems.push(`${identity.address} registration differs from the reviewed identity`);
    if (isActive) active++;
  }
  return { active, total: all.length, problems };
}

/** Schedules (if needed), waits the recorded delay and executes (if needed) a timelock batch, from chain state. */
async function runTimelockBatch(ctx: Ctx, dep: RehearsalDeployment, phase: "configure" | "activate") {
  const ids = launchIdentities(ctx);
  const batchDep = { chainId: dep.chainId, rehearsal: dep.rehearsal, minJurorBond: dep.minJurorBond, timelockDelay: dep.timelockDelay, contracts: { timelock: dep.contracts.timelock!, jurorRegistry: dep.contracts.jurorRegistry, queryEscrow: dep.contracts.queryEscrow, receiptAnchor: dep.contracts.receiptAnchor, panel: dep.contracts.panel }, privacy: { entrypoint: dep.privacy!.entrypoint } };
  const schedule = buildPhalaBatch(batchDep, ids, "schedule", phase);
  const execute = buildPhalaBatch(batchDep, ids, "execute", phase);
  if (schedule.operationId !== execute.operationId) throw new Error("schedule and execute operation ids differ");
  ensurePrivateDir(paths(ctx.out).batches);
  writePrivateJson(join(paths(ctx.out).batches, `${phase}-schedule.json`), schedule);
  writePrivateJson(join(paths(ctx.out).batches, `${phase}-execute.json`), execute);
  ctx.checkpoint.outputs[`${phase}OperationId`] = schedule.operationId; ctx.save();
  const read = async () => {
    const [ts, block] = await Promise.all([
      ctx.publicClient.readContract({ address: dep.contracts.timelock!, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [schedule.operationId] }),
      ctx.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    return timelockState(ts, block.timestamp);
  };
  let state = await read();
  ctx.redactor.log(`  ${phase} operation ${schedule.operationId}: ${state} (${schedule.callCount} calls, delay ${schedule.delaySeconds}s)`);
  if (state === "unscheduled") {
    await send(ctx, "owner", { to: schedule.to, functionName: `scheduleBatch(${schedule.callCount} calls, ${phase}, delay=${schedule.delaySeconds}s)`, value: 0n, amount: "none", purpose: `${phase} batch: schedule (handoff ${phase === "configure" ? "§8.6" : "§8.8"})`, data: schedule.calldata });
    state = await read();
  }
  const until = Date.now() + (Number(schedule.delaySeconds ?? 60) + 180) * 1000;
  while (state === "pending") {
    if (Date.now() > until) throw new Error(`${phase} operation still pending after its delay`);
    await sleep(5_000);
    state = await read();
  }
  if (state === "ready") {
    await send(ctx, "owner", { to: execute.to, functionName: `executeBatch(${execute.callCount} calls, ${phase})`, value: 0n, amount: "none", purpose: `${phase} batch: execute after the timelock delay`, data: execute.calldata });
    state = await read();
  }
  if (state !== "done") throw new Error(`${phase} operation is ${state}, expected done`);
  ctx.redactor.log(`  ${phase} batch executed`);
}

// ───────────────────────────── step bodies ─────────────────────────────

type Runner = (ctx: Ctx) => Promise<void>;
const RUNNERS: Record<string, Runner> = {
  async preflight(ctx) {
    const chainId = await ctx.publicClient.getChainId();
    if (chainId !== TESTNET_CHAIN_ID) throw new Error(`RPC is chain ${chainId}; the dress rehearsal runs on 46630 only`);
    ctx.redactor.log(`  ${await describeHead(ctx.publicClient)}`);
    const roles = ["deployer", "owner", "operator", "payer"] as const;
    for (const role of roles) key(ctx, role);
    const c = ctx.config;
    if (new Set([c.deployer, c.owner, c.operator].map((a) => a.toLowerCase())).size !== 3) throw new Error("deployer, owner and operator must be three different wallets");
    const balances: Record<string, string> = {};
    for (const role of roles) balances[role] = formatEth(await ctx.publicClient.getBalance({ address: c[role] }));
    ctx.redactor.log(`  wallets: ${roles.map((r) => `${r} ${c[r]} ${balances[r]} ETH`).join("; ")}`);
    const gasPrice = await ctx.publicClient.getGasPrice();
    const deployEstimate = gasPrice * 50_000_000n;
    ctx.redactor.log(`  gas price ${gasPrice} wei; a full deploy (~110 tx, ~46M gas) costs about ${formatEth(deployEstimate)} ETH plus L1 data`);
    if (!c.adoptDeployment) {
      for (const [label, address, symbol, decimals] of [["USDG", c.usdg!, "USDG", 6], ["MOCHI stand-in", c.mochiToken!, "MOCHI", 18]] as const) {
        const [name, sym, dec] = await Promise.all(["name", "symbol", "decimals"].map((f) => ctx.publicClient.readContract({ address, abi: ERC20, functionName: f as "name" })));
        if (String(sym).toUpperCase() !== symbol || Number(dec) !== decimals) throw new Error(`${label} ${address} reports ${String(sym)}/${String(dec)}; expected ${symbol}/${decimals}`);
        if (label === "USDG" && name !== "Mock USDG") throw new Error("the rehearsal pays with Mock USDG on 46630 only");
        ctx.redactor.log(`  ${label} ${address}: ${String(name)} (${String(sym)}, ${String(dec)} decimals)`);
      }
      const deployerWei = await ctx.publicClient.getBalance({ address: c.deployer });
      if (deployerWei < deployEstimate * 2n) throw new Error(`deployer holds ${formatEth(deployerWei)} ETH, below twice the deploy estimate; top it up first`);
    }
    const usdg = c.usdg ?? (readJson<RehearsalDeployment>(c.adoptDeployment!, "--adopt-deployment").contracts.usdg);
    const payerUsdg = await ctx.publicClient.readContract({ address: usdg, abi: ERC20, functionName: "balanceOf", args: [c.payer] });
    ctx.redactor.log(`  payer mock USDG ${formatUsdg(payerUsdg)}`);
    const cvm = await cvmStatus(ctx);
    ctx.redactor.log(`  cvm ${c.cvmUrl}: ${"status" in cvm && cvm.status ? `mode ${cvm.status.mode}, payments ${cvm.status.payments}` : `unavailable (${"error" in cvm ? cvm.error : "?"}); the lead agent starts it in standby (handoff §7A) before the identities step`}`);
    Object.assign(ctx.checkpoint.outputs, { balances, gasPriceWei: gasPrice.toString(), payerUsdg: payerUsdg.toString() });
  },

  async deploy(ctx) {
    const p = paths(ctx.out); const c = ctx.config;
    if (c.adoptDeployment && !existsSync(p.deployment)) {
      const adopted = readJson<RehearsalDeployment>(c.adoptDeployment, "--adopt-deployment");
      assertRehearsalDeployment(adopted, { owner: c.owner, deployer: c.deployer });
      writePrivateJson(p.deployment, adopted);
      ctx.checkpoint.outputs.adoptedFrom = resolve(c.adoptDeployment);
    }
    if (!existsSync(p.deployment)) {
      ctx.redactor.log(`  ${await describeHead(ctx.publicClient)}`);
      // An earlier, interrupted deploy left deploy-local's journal: continue it (the plan run verifies it on chain first).
      const resume = existsSync(journalPathFor(p.deployment));
      const before = await ctx.publicClient.getBalance({ address: c.deployer });
      const base = ["scripts/deploy-local.ts", "--mainnet", "--rehearsal", "--key-file", c.deployerKeyFile, "--out", p.deployment, "--owner", c.owner, "--guardian", c.owner,
        "--usdg", c.usdg!, "--mochi-token", c.mochiToken!, "--min-juror-bond", "0", "--timelock-delay", c.timelockDelay, "--shielded", "privacy-pools", "--randomness", "drand", "--panel-escalation", "off",
        ...(resume ? ["--resume"] : [])];
      const attempt = resume ? `-resume-${Date.now()}` : "";
      const plan = runChild(ctx, `plan${attempt}`, base, { allowFail: true });
      if (!plan.output.includes("review deployment summary and rerun with --yes")) throw new Error("deploy-local did not print its reviewed plan");
      const summaryText = plan.output.slice(plan.output.indexOf("{"), plan.output.indexOf("\n}") + 2);
      const summary = JSON.parse(summaryText) as Record<string, unknown>;
      const mismatch = deployPlanProblems(summary, c);
      if (mismatch.length) throw new Error(`deploy-local plan differs from the rehearsal configuration: ${mismatch.join("; ")}`);
      ctx.redactor.log(summaryText.split("\n").map((l) => `    ${l}`).join("\n"));
      // Cost accounting spans every attempt: keep the balance from before the first one.
      const startBalance = typeof ctx.checkpoint.outputs.deployStartedFromBalance === "string" ? BigInt(ctx.checkpoint.outputs.deployStartedFromBalance) : before;
      ctx.checkpoint.outputs.deployStartedFromBalance = startBalance.toString(); ctx.save();
      runChild(ctx, `deploy${attempt}`, [...base, "--yes"]);
      chmodSync(p.deployment, 0o600);
      const after = await ctx.publicClient.getBalance({ address: c.deployer });
      ctx.checkpoint.outputs.deployCostWei = (startBalance - after).toString();
      ctx.redactor.log(`  deployer spent ${formatEth(startBalance - after, 9)} ETH`);
    }
    const dep = readJson<RehearsalDeployment>(p.deployment, "deployment");
    assertRehearsalDeployment(dep, { owner: c.owner, deployer: c.deployer });
    const code = await ctx.publicClient.getCode({ address: dep.contracts.queryEscrow });
    if (!code || code === "0x") throw new Error("QueryEscrow has no code on 46630");
    Object.assign(ctx.checkpoint.outputs, { deployment: p.deployment, queryEscrow: dep.contracts.queryEscrow, timelock: dep.contracts.timelock });
  },

  async "verify-deployment"(ctx) {
    const p = paths(ctx.out);
    runChild(ctx, "verify-ownership", ["scripts/verify-ownership.ts", p.deployment]);
    const inspect = runChild(ctx, "panel-inspect", ["scripts/panel-escalation.ts", "inspect", p.deployment]);
    const report = JSON.parse(inspect.output.slice(inspect.output.indexOf("{"))) as { ok: boolean; observedMode: string; recordedMode: string };
    if (!report.ok || report.observedMode !== "off" || report.recordedMode !== "off") throw new Error("panel escalation is not off on chain");
    const dep = deployment(ctx);
    if (!await ctx.publicClient.readContract({ address: dep.contracts.queryEscrow, abi: ESCROW_ABI, functionName: "paused" })) throw new Error("QueryEscrow is not paused");
    ctx.redactor.log("  ownership verified; panel escalation off on chain; escrow paused");
  },

  async identities(ctx) {
    const p = paths(ctx.out); const c = ctx.config;
    if (!existsSync(p.identitiesReport)) {
      runChild(ctx, "verify-identities", ["scripts/verify-production-identities.ts", "--url", `${c.cvmUrl}/production/identities`, "--measurement", c.measurement, "--out", p.identitiesReport,
        ...(c.previousIdentities ? ["--previous", c.previousIdentities] : [])]);
      chmodSync(p.identitiesReport, 0o600);
    }
    if (!existsSync(p.launchIdentities)) {
      if (existsSync(p.launch)) throw new Error(`${p.launch} exists without production-identities.json; move it aside after inspecting it`);
      runChild(ctx, "prepare-launch", ["scripts/prepare-production-launch.ts", "--report", p.identitiesReport, "--deployment", p.deployment, "--operator", c.operator, "--measurement", c.measurement, "--out-dir", p.launch]);
    }
    chmodSync(p.launch, 0o700);
    const runtime = readJson<{ mode?: unknown }>(p.launchRuntime, "production-runtime.json");
    for (const mode of ["prepare", "enroll", "active"] as const) if (!existsSync(p.runtime(mode))) writePrivateJson(p.runtime(mode), runtimeForMode(runtime, mode));
    const ids = launchIdentities(ctx);
    if (ids.jurors.some((j) => j.operator.toLowerCase() !== c.operator.toLowerCase())) throw new Error("launch identities name a different juror operator");
    const signers = serviceSignersFrom(ids);
    Object.assign(ctx.checkpoint.outputs, { intake: ids.intake.address, consensus: ids.consensus.address, serviceSigners: signers });
    ctx.redactor.log(`  launch files in ${p.launch}; service signers ${SERVICE_SIGNER_ROLES.map((r) => `${r} ${signers[r]}`).join(", ")}`);
  },

  async "env-files"(ctx) {
    const p = paths(ctx.out); const c = ctx.config;
    if (!c.cvmBaseEnv) throw new Error("--cvm-base-env is required for the env-files step");
    assertPrivateFile(c.cvmBaseEnv, "--cvm-base-env");
    for (const mode of ["prepare", "enroll", "active", "standby"] as const) {
      if (existsSync(p.env(mode))) continue;
      runChild(ctx, `env-${mode}`, ["scripts/phala-cvm-env.ts", "--base", c.cvmBaseEnv, ...(mode === "standby" ? [] : ["--config", p.runtime(mode)]), "--out", p.env(mode)]);
    }
    ctx.checkpoint.outputs.envFiles = ["prepare", "enroll", "active", "standby"].map((m) => p.env(m));
    ctx.redactor.log("  env files written (mode 600); this script never reads them");
  },

  async fund(ctx) {
    const c = ctx.config;
    const signers = serviceSignersFrom(launchIdentities(ctx));
    const targets = [
      { role: "owner", address: c.owner, target: BigInt(c.fund.owner) }, { role: "operator", address: c.operator, target: BigInt(c.fund.operator) },
      ...SERVICE_SIGNER_ROLES.map((role) => ({ role, address: signers[role]!, target: BigInt(role === "orchestrator" ? c.fund.orchestrator : c.fund.signer) })),
    ];
    const plan = topUpPlan(await Promise.all(targets.map(async (t) => ({ ...t, balance: await ctx.publicClient.getBalance({ address: t.address }) }))));
    const total = plan.reduce((s, x) => s + x.amount, 0n);
    const deployerWei = await ctx.publicClient.getBalance({ address: c.deployer });
    ctx.redactor.log(`  top-ups total ${formatEth(total)} ETH; deployer holds ${formatEth(deployerWei)} ETH`);
    if (total > deployerWei) throw new Error("deployer cannot cover the top-ups");
    for (const item of plan) {
      ctx.redactor.log(`  ${item.role.padEnd(12)} ${item.address} ${formatEth(item.balance)} → target ${formatEth(item.target)}${item.amount ? `: send ${formatEth(item.amount)}` : ": ok"}`);
      if (item.amount > 0n) await send(ctx, "deployer", { to: item.address, functionName: "(ETH transfer)", value: item.amount, amount: `${formatEth(item.amount)} ETH`, purpose: `top up ${item.role}`, data: "0x" });
    }
  },

  async configure(ctx) {
    const dep = deployment(ctx);
    await runTimelockBatch(ctx, dep, "configure");
    const ids = launchIdentities(ctx);
    const attestor = await ctx.publicClient.readContract({ address: dep.contracts.jurorRegistry, abi: ESCROW_ABI, functionName: "hasRole", args: [A.ROLE_IDS.ATTESTOR, ids.attestor] });
    const paused = await ctx.publicClient.readContract({ address: dep.contracts.queryEscrow, abi: ESCROW_ABI, functionName: "paused" });
    if (!attestor || !paused) throw new Error("configure did not leave the attestor role granted and the escrow paused");
    ctx.redactor.log("  attestor role granted; escrow still paused");
  },

  async enrollment(ctx) {
    const p = paths(ctx.out); const c = ctx.config; const dep = deployment(ctx);
    if (!existsSync(p.proofs)) {
      const res = await fetchJsonBounded(`${c.cvmUrl}/production/enrollment`, { timeoutMs: 20_000, maxBytes: 1024 * 1024 });
      if (!res.ok) throw new Error(`GET /production/enrollment failed (${res.error}); is the CVM in prepare mode?`);
      writePrivateJson(p.proofs, res.json);
    }
    const prepared = await prepareProductionEnrollment({ deployment: dep, identities: launchIdentities(ctx), operator: c.operator, response: readJson<unknown>(p.proofs, "enrollment proofs") });
    if (prepared.chainId !== TESTNET_CHAIN_ID) throw new Error("enrollment payload is not for chain 46630");
    for (const tx of prepared.transactions) {
      const decoded = decodeFunctionData({ abi: A.JurorRegistryAbi, data: tx.data }) as { functionName: string; args: readonly unknown[] };
      if (decoded.functionName !== "enrollJuror") throw new Error(`unexpected enrollment call ${decoded.functionName} (zero-bond rehearsal sends enrollJuror only)`);
      const jurorKey = decoded.args[0] as Address;
      const registered = await ctx.publicClient.readContract({ address: dep.contracts.jurorRegistry, abi: A.JurorRegistryAbi, functionName: "getJuror", args: [jurorKey] }) as unknown as A.JurorView;
      if (registered.operator.toLowerCase() === c.operator.toLowerCase()) { ctx.redactor.log(`  ${tx.purpose}: ${jurorKey} already enrolled`); continue; }
      await send(ctx, "operator", { to: tx.to, functionName: `enrollJuror(key=${jurorKey}, class=${String(decoded.args[2])}, bond=0)`, value: 0n, amount: "none (zero-bond seat approved by governance)", purpose: tx.purpose, data: tx.data });
    }
  },

  async activate(ctx) {
    const dep = deployment(ctx);
    const status = await identitiesActive(ctx, dep, launchIdentities(ctx));
    if (status.problems.length || status.active !== status.total) throw new Error(`activation needs ${status.total}/${status.total} active reviewed identities; have ${status.active}${status.problems.length ? `; ${status.problems.join("; ")}` : ""}`);
    await runTimelockBatch(ctx, dep, "activate");
    if (await ctx.publicClient.readContract({ address: dep.contracts.queryEscrow, abi: ESCROW_ABI, functionName: "paused" })) throw new Error("escrow is still paused after the activate batch");
    ctx.redactor.log("  escrow unpaused through the timelock");
  },

  async canary(ctx) {
    const p = paths(ctx.out); const c = ctx.config; const dep = deployment(ctx);
    const payerUsdg = await ctx.publicClient.readContract({ address: dep.contracts.usdg, abi: ERC20, functionName: "balanceOf", args: [c.payer] });
    if (payerUsdg < 100_000n) {
      if (await ctx.publicClient.readContract({ address: dep.contracts.usdg, abi: ERC20, functionName: "name" }) !== "Mock USDG") throw new Error("payer lacks USDG and the token is not Mock USDG");
      await send(ctx, "payer", { to: dep.contracts.usdg, functionName: `mint(to=${c.payer}, amount=1 USDG)`, value: 0n, amount: "1 mock USDG minted (testnet rehearsal only)", purpose: "fund the canary payer with mock USDG", data: encodeFunctionData({ abi: ERC20, functionName: "mint", args: [c.payer, 1_000_000n] }) });
    }
    const checkpointFile = join(p.canary, "canary-checkpoint.json");
    const resume = existsSync(checkpointFile) && readJson<{ status?: string }>(checkpointFile, "canary checkpoint").status === "opened";
    const args = ["scripts/canary-check.ts", "run", "--deployment", p.deployment, "--payer-key-file", c.payerKeyFile, "--measurement", c.measurement, "--cvm-url", c.cvmUrl,
      "--identities", p.launchIdentities, "--out", p.canary, "--rehearsal", "--timeout", String(c.canaryTimeout), ...(ctx.policy.yes ? ["--yes"] : []), ...(resume ? ["--resume"] : [])];
    ensurePrivateDir(p.canary);
    const result = runChild(ctx, "canary", args, { allowFail: true, inherit: !ctx.policy.yes });
    if (!ctx.policy.yes) { /* output went to the terminal */ } else ctx.redactor.log(result.output.trim().split("\n").map((l) => `    ${l}`).join("\n"));
    const reports = readdirSync(p.canary).filter((f) => f.startsWith("canary-report-"));
    ctx.checkpoint.outputs.canaryReports = reports.map((f) => join(p.canary, f));
    if (result.code !== 0) throw new Error(`canary did not pass (exit ${result.code}); read ${p.canary} before any retry`);
  },

  async pause(ctx) {
    const dep = deployment(ctx);
    if (await ctx.publicClient.readContract({ address: dep.contracts.queryEscrow, abi: ESCROW_ABI, functionName: "paused" })) { ctx.redactor.log("  escrow already paused"); return; }
    await send(ctx, "owner", { to: dep.contracts.queryEscrow, functionName: "pause()", value: 0n, amount: "none", purpose: "guardian pause at the end of the dress rehearsal (handoff §7D)", data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "pause" }) });
    if (!await ctx.publicClient.readContract({ address: dep.contracts.queryEscrow, abi: ESCROW_ABI, functionName: "paused" })) throw new Error("pause did not take effect");
  },
};

/** After the lead agent ran the printed command: read-only checks of the CVM (and chain) before moving on. */
const OPERATOR_VERIFY: Record<string, Runner> = {
  async "cvm-prepare"(ctx) {
    await waitForCvm(ctx, (s) => s.mode === "prepare" && allHealthy(s) && !s.payments, "prepare mode with every service healthy");
    const res = await fetchJsonBounded(`${ctx.config.cvmUrl}/production/identities`, { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 });
    const live = res.json as { identities?: Array<{ name: string; address: string; measurement: string }> } | undefined;
    if (!res.ok || !Array.isArray(live?.identities)) throw new Error("identities endpoint unavailable after prepare");
    const ids = launchIdentities(ctx);
    const expected = new Set([ids.intake.address, ids.consensus.address, ...ids.jurors.map((j) => j.address)].map((a) => a.toLowerCase()));
    if (live.identities.length !== 11 || live.identities.some((i) => i.measurement.toLowerCase() !== ctx.config.measurement || !expected.has(i.address.toLowerCase()))) throw new Error("identities changed (measurement or keys) after the prepare deploy; stop and re-verify");
    ctx.redactor.log("  prepare mode healthy; 11 identities at the reviewed measurement with the verified keys");
  },
  async "cvm-enroll"(ctx) {
    await waitForCvm(ctx, (s) => s.mode === "enroll" && allHealthy(s) && !s.payments, "enroll mode with every service healthy");
    const dep = deployment(ctx); const ids = launchIdentities(ctx);
    const until = Date.now() + ctx.config.waitHealthy * 1000;
    for (;;) {
      const status = await identitiesActive(ctx, dep, ids);
      ctx.redactor.log(`  ${status.active}/${status.total} identities active in JurorRegistry`);
      if (status.problems.length) throw new Error(status.problems.join("; "));
      if (status.active === status.total) break;
      if (Date.now() > until) throw new Error("identities did not all become active; the attestor retries every 15 s, check its health");
      await sleep(10_000);
    }
  },
  async "cvm-active"(ctx) {
    await waitForCvm(ctx, (s) => s.mode === "active" && s.payments && allHealthy(s), "active mode with payments on");
    ctx.redactor.log(`  juror warm-up: waiting ${ctx.config.warmup}s (handoff §8.8)`);
    await sleep(ctx.config.warmup * 1000);
  },
  async "cvm-standby"(ctx) {
    await waitForCvm(ctx, (s) => s.mode === "standby" && !s.payments, "standby with payments off");
  },
};

// ───────────────────────────── driver ─────────────────────────────

function loadCheckpoints(out: string): Map<string, Checkpoint> {
  const dir = paths(out).checkpoints; const map = new Map<string, Checkpoint>();
  if (!existsSync(dir)) return map;
  for (const step of STEPS) { const file = join(dir, `${step.id}.json`); if (existsSync(file)) map.set(step.id, readJson<Checkpoint>(file, `checkpoint ${step.id}`)); }
  return map;
}

function printStatus(redactor: Redactor, checkpoints: Map<string, Checkpoint>) {
  redactor.log("Dress rehearsal checklist (testnet 46630):");
  for (const step of STEPS) {
    const cp = checkpoints.get(step.id);
    const gas = cp?.txs.reduce((s, t) => s + BigInt(t.gasCostWei ?? "0"), 0n) ?? 0n;
    redactor.log(`  [${cp?.state === "done" ? "x" : cp?.state === "awaiting-operator" ? ">" : cp ? "!" : " "}] ${step.id.padEnd(18)} ${step.section.padEnd(5)} ${step.kind.padEnd(8)} ${cp?.state ?? "pending"}${cp?.txs.length ? `, ${cp.txs.length} tx, ${formatEth(gas, 9)} ETH gas` : ""} — ${step.title}`);
  }
}

function configFromFlags(cli: ReturnType<typeof parseCli>, rpc: RpcConfig): Partial<RehearsalConfig> {
  const opt = (name: string) => cli.options.get(name);
  const abs = (v: string | undefined) => v ? resolve(v) : undefined;
  const addr = (v: string | undefined, f: string) => v ? parseAddress(v, f) : undefined;
  const panel = opt("--panel-escalation");
  if (panel !== undefined && panel !== "off") throw new Error("the dress rehearsal runs with --panel-escalation off");
  const fund = ["--fund-owner-eth", "--fund-operator-eth", "--fund-orchestrator-eth", "--fund-signer-eth"].some((f) => cli.options.has(f)) ? {
    owner: parseEthAmount(opt("--fund-owner-eth"), "--fund-owner-eth", "0.0003").toString(), operator: parseEthAmount(opt("--fund-operator-eth"), "--fund-operator-eth", "0.0003").toString(),
    orchestrator: parseEthAmount(opt("--fund-orchestrator-eth"), "--fund-orchestrator-eth", "0.0005").toString(), signer: parseEthAmount(opt("--fund-signer-eth"), "--fund-signer-eth", "0.0001").toString(),
  } : undefined;
  const raw: Partial<RehearsalConfig> = {
    ...(rpc.secrets.length ? {} : { rpcPublicUrl: rpc.url }),
    deployerKeyFile: abs(opt("--deployer-key-file")), ownerKeyFile: abs(opt("--owner-key-file")), operatorKeyFile: abs(opt("--operator-key-file")),
    payerKeyFile: abs(opt("--payer-key-file")) ?? abs(opt("--deployer-key-file")),
    measurement: opt("--measurement") ? parseBytes32(opt("--measurement"), "--measurement") : undefined,
    cvmUrl: opt("--cvm-url") ? checkServiceUrl(opt("--cvm-url")!, "--cvm-url") : undefined, cvmId: opt("--cvm-id"),
    compose: abs(opt("--compose")), cvmBaseEnv: abs(opt("--cvm-base-env")), previousIdentities: abs(opt("--previous-identities")),
    usdg: addr(opt("--usdg"), "--usdg"), mochiToken: addr(opt("--mochi-token"), "--mochi-token"), adoptDeployment: abs(opt("--adopt-deployment")),
    timelockDelay: opt("--timelock-delay"), ...(panel ? { panelEscalation: "off" as const } : {}), ...(fund ? { fund } : {}),
    canaryTimeout: cli.options.has("--canary-timeout") ? parsePositiveInt(opt("--canary-timeout"), "--canary-timeout", 300, 3600) : undefined,
    waitHealthy: cli.options.has("--wait-healthy") ? parsePositiveInt(opt("--wait-healthy"), "--wait-healthy", 600, 3600) : undefined,
    warmup: cli.options.has("--warmup") ? parsePositiveInt(opt("--warmup"), "--warmup", 120, 900) : undefined,
  };
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Partial<RehearsalConfig>;
}

function completeConfig(partial: Partial<RehearsalConfig>): RehearsalConfig {
  const need = (v: unknown, flag: string) => { if (v === undefined) throw new Error(`${flag} is required on the first run`); };
  need(partial.deployerKeyFile, "--deployer-key-file"); need(partial.ownerKeyFile, "--owner-key-file"); need(partial.operatorKeyFile, "--operator-key-file");
  need(partial.measurement, "--measurement"); need(partial.panelEscalation, "--panel-escalation off");
  if (!partial.adoptDeployment && (!partial.usdg || !partial.mochiToken)) throw new Error("pass --usdg and --mochi-token (Mock USDG and the stand-in MOCHI on 46630), or --adopt-deployment");
  if (partial.adoptDeployment && (partial.usdg || partial.mochiToken)) throw new Error("--adopt-deployment already fixes the tokens; drop --usdg/--mochi-token");
  const addresses = (["deployer", "owner", "operator", "payer"] as const).map((role) => [role, loadKeyFile(partial[`${role}KeyFile`]!, `${role} key file`).address] as const);
  return {
    version: 1, chainId: TESTNET_CHAIN_ID, rpcSource: partial.rpcSource ?? "public", ...(partial.rpcPublicUrl ? { rpcPublicUrl: partial.rpcPublicUrl } : {}),
    deployerKeyFile: partial.deployerKeyFile!, ownerKeyFile: partial.ownerKeyFile!, operatorKeyFile: partial.operatorKeyFile!, payerKeyFile: partial.payerKeyFile!,
    ...Object.fromEntries(addresses) as Record<"deployer" | "owner" | "operator" | "payer", Address>,
    measurement: partial.measurement!, cvmUrl: partial.cvmUrl ?? DEFAULT_CVM_URL, cvmId: partial.cvmId ?? DEFAULT_CVM_ID,
    ...(partial.compose ? { compose: partial.compose } : {}), ...(partial.cvmBaseEnv ? { cvmBaseEnv: partial.cvmBaseEnv } : {}), ...(partial.previousIdentities ? { previousIdentities: partial.previousIdentities } : {}),
    ...(partial.usdg ? { usdg: partial.usdg } : {}), ...(partial.mochiToken ? { mochiToken: partial.mochiToken } : {}), ...(partial.adoptDeployment ? { adoptDeployment: partial.adoptDeployment } : {}),
    timelockDelay: partial.timelockDelay ?? "60", panelEscalation: "off",
    fund: partial.fund ?? { owner: parseEther("0.0003").toString(), operator: parseEther("0.0003").toString(), orchestrator: parseEther("0.0005").toString(), signer: parseEther("0.0001").toString() },
    canaryTimeout: partial.canaryTimeout ?? 300, waitHealthy: partial.waitHealthy ?? 600, warmup: partial.warmup ?? 120,
  };
}

async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv, {
    flags: ["--yes", "--status"],
    options: ["--out", "--deployer-key-file", "--owner-key-file", "--operator-key-file", "--payer-key-file", "--measurement", "--cvm-url", "--cvm-id", "--compose", "--cvm-base-env",
      "--previous-identities", "--usdg", "--mochi-token", "--adopt-deployment", "--timelock-delay", "--panel-escalation", "--fund-owner-eth", "--fund-operator-eth",
      "--fund-orchestrator-eth", "--fund-signer-eth", "--canary-timeout", "--wait-healthy", "--warmup", "--continue", "--until", "--force-step", "--rpc"],
    positionals: 0,
  });
  const redactor = new Redactor();
  const outArg = cli.options.get("--out");
  if (!outArg) throw new Error("--out <private dir> is required");
  const out = resolve(outArg);
  ensurePrivateDir(out);
  const p = paths(out);
  const checkpoints = loadCheckpoints(out);
  if (cli.flags.has("--status")) { printStatus(redactor, checkpoints); return 0; }
  for (const name of ["--until", "--force-step"] as const) if (cli.options.has(name) && !STEP_IDS.includes(cli.options.get(name)!)) throw new Error(`${name} must be one of ${STEP_IDS.join(", ")}`);
  validateContinue(cli.options.get("--continue"), checkpoints);

  const existing = existsSync(p.config) ? readJson<RehearsalConfig>(p.config, "rehearsal config") : undefined;
  // Later runs reuse the recorded key-less RPC; a keyed RPC_URL is never recorded and must be set again.
  const rpc = resolveRpc({ rpcFlag: cli.options.get("--rpc"), env: process.env, deploymentRpc: existing?.rpcPublicUrl, chainId: TESTNET_CHAIN_ID });
  for (const s of rpc.secrets) redactor.add(s);
  const merged = mergeConfig(existing, configFromFlags(cli, rpc));
  const config = existing ?? completeConfig({ ...merged, rpcSource: rpc.source });
  if (!existing) writePrivateJson(p.config, config);
  if (config.chainId !== TESTNET_CHAIN_ID) throw new Error("rehearsal config is not for chain 46630");
  const chain = defineChain({ id: TESTNET_CHAIN_ID, name: "Robinhood Chain testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc.url] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpc.url, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  const live = await publicClient.getChainId();
  if (live !== TESTNET_CHAIN_ID) throw new Error(`RPC reports chain ${live}; the dress rehearsal refuses anything but 46630`);
  redactor.log(`dress rehearsal: chain 46630 via ${rpc.display}; out ${out}; cvm ${config.cvmUrl}`);

  const policy: SendPolicy = { yes: cli.flags.has("--yes") };
  const io = terminalConfirmIO(redactor);
  const keys = new Map<string, LoadedKey>();
  mkdirSync(p.checkpoints, { recursive: true, mode: 0o700 }); ensurePrivateDir(p.checkpoints);
  for (const step of STEPS) {
    const existingCp = checkpoints.get(step.id);
    const decision = decideStep(step, existingCp, { continueStep: cli.options.get("--continue"), forceStep: cli.options.get("--force-step"), deployJournal: existsSync(journalPathFor(p.deployment)) });
    if (decision.action === "skip") continue;
    const now = new Date().toISOString();
    const checkpoint: Checkpoint = existingCp && existingCp.state !== "done" ? existingCp : { id: step.id, state: "started", startedAt: now, updatedAt: now, txs: [], outputs: {} };
    const file = join(p.checkpoints, `${step.id}.json`);
    const save = () => { checkpoint.updatedAt = new Date().toISOString(); checkpoints.set(step.id, checkpoint); writePrivateJson(file, checkpoint); };
    const ctx: Ctx = { out, config, redactor, io, policy, rpc, publicClient, chain, checkpoint, save, keys };
    if (decision.action === "blocked") { redactor.warn(`[${step.id}] blocked: ${decision.reason}`); return 1; }
    if (decision.action === "await-operator") {
      const mode = OPERATOR_ENV[step.id]!;
      if (!config.compose) throw new Error("--compose <compose.yml> is required to print the CVM deploy command");
      const command = cvmDeployCommand(config.cvmId, config.compose, p.env(mode));
      checkpoint.state = "awaiting-operator"; checkpoint.operatorCommand = command; save();
      redactor.log("");
      redactor.log(`[${step.id}] ${step.section} OPERATOR STEP — this script does not run phala. The lead agent runs exactly:`);
      redactor.log(`  ${command}`);
      redactor.log(`then: bun scripts/dress-rehearsal.ts --out ${out} --continue ${step.id}${policy.yes ? " --yes" : ""}`);
      printStatus(redactor, checkpoints);
      return 0;
    }
    redactor.log("");
    redactor.log(`[${step.id}] ${step.section} ${step.title}${decision.action === "run" && decision.resumed ? " (resuming from chain state)" : ""}`);
    checkpoint.state = "started"; delete checkpoint.error; save();
    try {
      await (decision.action === "verify-operator" ? OPERATOR_VERIFY[step.id]! : RUNNERS[step.id]!)(ctx);
      checkpoint.state = "done"; save();
      redactor.log(`[${step.id}] done`);
    } catch (error) {
      checkpoint.state = step.kind === "operator" ? "awaiting-operator" : "failed"; checkpoint.error = redactor.error(error).split("\n")[0]; save();
      redactor.warn(`[${step.id}] ${error instanceof TxRefused ? "refused" : "failed"}: ${redactor.error(error)}`);
      return 1;
    }
    if (cli.options.get("--until") === step.id) { redactor.log(`stopping after ${step.id} (--until)`); printStatus(redactor, checkpoints); return 0; }
  }
  printStatus(redactor, checkpoints);
  writePrivateJson(join(out, "rehearsal-summary.json"), { completedAt: new Date().toISOString(), steps: STEPS.map((s) => ({ id: s.id, state: checkpoints.get(s.id)?.state, txs: checkpoints.get(s.id)?.txs ?? [] })) });
  redactor.log("DRESS REHEARSAL COMPLETE");
  return 0;
}

if (import.meta.main) {
  const redactor = new Redactor();
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => { redactor.warn(`dress-rehearsal: ${redactor.error(error)}`); process.exit(2); });
}
