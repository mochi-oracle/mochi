// Read-only first-hour launch monitor (handoff §8.11 and §10). It never signs, never reads a key and never touches the
// CVM beyond its two public GET endpoints. Each tick prints one content-free status line (or one JSON object):
//   - CVM GET /production/status: mode, payments and each service's health;
//   - GET /production/identities: identity count, measurement against --measurement, service signers against --identities;
//   - QueryEscrow paused state, and open / sealed / HUNG / expiry-eligible query counts derived from escrow events;
//   - ETH balances of the owner, guardian, juror operator and the five enclave service signers, flagged below thresholds;
//   - RPC reachability, chain id, latency and chain-head age (warning above --max-head-age: idle chain or stalled sequencer).
//
//   bun scripts/launch-watch.ts --deployment <deployment.json> [--identities <production-identities.json|verified report>]
//     [--measurement 0x…] [--cvm-url https://…] [--rpc-key-file <drpc-key> | RPC_URL=… | --rpc <public url>]
//     [--interval 30] [--max-failures 3] [--once] [--json] [--expect-mode active|enroll|prepare|standby|any]
//     [--operator 0x…] [--min-orchestrator-eth 0.002] [--min-eth 0.0005] [--strict-balances] [--no-queries]
//     [--from-block <n>] [--log-chunk 10000] [--max-head-age 300]
//
// Exit status: --once exits 0 when the tick has no failures, else 1. Otherwise it runs until --max-failures consecutive
// failing ticks (exit 1) or Ctrl-C (exit 0). Low balances, HUNG and expiry-eligible queries are warnings unless
// --strict-balances makes low balances failures.
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import * as A from "@mochi/chain";
import {
  DEFAULT_CVM_URL, Redactor, checkServiceUrl, fetchJsonBounded, formatEth, headAgeSec, operatorFrom, parseAddress, parseBytes32, parseCli,
  parseEthAmount, parsePositiveInt, readJson, resolveRpc, serviceSignersFrom, sleep, SERVICE_SIGNER_ROLES, type RpcConfig, type ServiceSigners,
} from "./launch-ops/common.ts";

export const EXPECTED_IDENTITY_COUNT = 11;
export const RUNTIME_MODES = ["standby", "prepare", "enroll", "active"] as const;
export const QUERY_STATUS = ["NONE", "OPEN", "SEALED", "DECIDED", "HUNG", "ESCALATED", "EXPIRED"] as const;

/** Escrow lifecycle events (enums are uint8 in the ABI). A test pins these selectors to the generated ABI. */
export const ESCROW_EVENTS = parseAbi([
  "event QueryOpened(bytes32 indexed queryId, uint8 payPath, uint32 schemaId, uint16 schemaVersion, uint8 n, bool isPublic, bytes32 docCommit, uint256 amount, uint64 sealBlock)",
  "event QuerySealed(bytes32 indexed queryId, uint8 round, bytes32 seed, address[] newJurors)",
  "event QueryResealed(bytes32 indexed queryId, uint8 round, uint64 sealBlock)",
  "event QueryExpanded(bytes32 indexed queryId, uint8 round, uint8 newN, uint256 amount, uint64 sealBlock)",
  "event QuerySettled(bytes32 indexed queryId, uint8 round, uint8 status, uint256 jurorsPaid, uint256 refunded)",
  "event QueryExpired(bytes32 indexed queryId, uint256 refunded)",
  "event QueryEscalated(bytes32 indexed queryId)",
  "event QueryDecidedByPanel(bytes32 indexed queryId)",
]);
const PAUSED_ABI = parseAbi(["function paused() view returns (bool)"]);

// ───────────────────────────── pure parsing ─────────────────────────────

export type CvmStatus = { status: string; mode: string; payments: boolean; services: Record<string, string> };

export function parseCvmStatus(raw: unknown): CvmStatus {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("status is not an object");
  if (typeof r.status !== "string" || typeof r.mode !== "string" || typeof r.payments !== "boolean") throw new Error("status lacks status/mode/payments");
  const services: Record<string, string> = {};
  if (r.services !== undefined) {
    if (!r.services || typeof r.services !== "object" || Array.isArray(r.services)) throw new Error("status services is not an object");
    for (const [name, state] of Object.entries(r.services as Record<string, unknown>)) {
      if (!/^[a-z0-9_-]{1,64}$/i.test(name) || typeof state !== "string") throw new Error("status services entry is invalid");
      services[name] = state;
    }
  }
  return { status: r.status, mode: r.mode, payments: r.payments, services };
}

export type IdentitySummary = { ready: boolean; count: number; measurements: string[]; measurementOk?: boolean; signersMatch?: boolean };

/** Counts identities and checks every identity (and its quote) carries the expected measurement. No DCAP here. */
export function summarizeIdentities(raw: unknown, expectedMeasurement?: Hex, expectedSigners?: ServiceSigners): IdentitySummary {
  const r = raw as { ready?: unknown; identities?: unknown; serviceSigners?: unknown } | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.identities)) throw new Error("identities response lacks identities[]");
  const measurements = new Set<string>();
  for (const item of r.identities as Array<{ measurement?: unknown; quote?: { measurement?: unknown } }>) {
    for (const value of [item?.measurement, item?.quote?.measurement]) {
      measurements.add(typeof value === "string" ? value.toLowerCase() : "missing");
    }
  }
  const summary: IdentitySummary = { ready: r.ready === true, count: r.identities.length, measurements: [...measurements] };
  if (expectedMeasurement) summary.measurementOk = measurements.size === 1 && measurements.has(expectedMeasurement.toLowerCase());
  if (expectedSigners) {
    try {
      const live = serviceSignersFrom(r);
      summary.signersMatch = SERVICE_SIGNER_ROLES.every((role) => live[role]?.toLowerCase() === expectedSigners[role]?.toLowerCase());
    } catch { summary.signersMatch = false; }
  }
  return summary;
}

// ───────────────────────────── query tracking ─────────────────────────────

export type TrackedQuery = { status: number; deadline: bigint; dirty: boolean };
export type QueryCounts = { open: number; sealed: number; hung: number; expiredEligible: number; decided: number; expired: number; escalated: number; total: number };

/** Event-driven cache: each escrow event marks its query dirty; only dirty queries are re-read with getQuery. */
export class QueryTracker {
  readonly queries = new Map<Hex, TrackedQuery>();
  constructor(public scannedTo: bigint) {}
  apply(logs: ReadonlyArray<{ args: { queryId?: Hex } }>): void {
    for (const log of logs) {
      const id = log.args.queryId?.toLowerCase() as Hex | undefined;
      if (!id) continue;
      const existing = this.queries.get(id);
      if (existing) existing.dirty = true;
      else this.queries.set(id, { status: 0, deadline: 0n, dirty: true });
    }
  }
  dirtyIds(limit: number): Hex[] { return [...this.queries].filter(([, q]) => q.dirty).slice(0, limit).map(([id]) => id); }
  update(id: Hex, status: number, deadline: bigint): void { this.queries.set(id.toLowerCase() as Hex, { status, deadline, dirty: false }); }
  counts(nowSec: bigint): QueryCounts { return classifyQueries([...this.queries.values()], nowSec); }
}

export function classifyQueries(queries: ReadonlyArray<{ status: number; deadline: bigint }>, nowSec: bigint): QueryCounts {
  const c: QueryCounts = { open: 0, sealed: 0, hung: 0, expiredEligible: 0, decided: 0, expired: 0, escalated: 0, total: queries.length };
  for (const q of queries) {
    if (q.status === 1) c.open++;
    else if (q.status === 2) c.sealed++;
    else if (q.status === 3) c.decided++;
    else if (q.status === 4) c.hung++;
    else if (q.status === 5) c.escalated++;
    else if (q.status === 6) c.expired++;
    // QueryEscrow.expire accepts OPEN or SEALED strictly after the deadline.
    if ((q.status === 1 || q.status === 2) && q.deadline > 0n && nowSec > q.deadline) c.expiredEligible++;
  }
  return c;
}

/** Splits [from, to] into chunks of at most `size` blocks. */
export function blockRanges(from: bigint, to: bigint, size: bigint): Array<[bigint, bigint]> {
  if (size < 1n) throw new Error("chunk size must be positive");
  const out: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += size) out.push([start, start + size - 1n < to ? start + size - 1n : to]);
  return out;
}

// ───────────────────────────── evaluation and output ─────────────────────────────

export type WatchSigner = { role: string; address: Address; minWei: bigint };
export type BalanceReading = { role: string; address: Address; wei?: bigint; minWei: bigint; low: boolean; error?: string };
export type TickReport = {
  at: string;
  ok: boolean;
  failures: string[];
  warnings: string[];
  rpc: { reachable: boolean; chainId?: number; chainOk?: boolean; block?: bigint; headAgeSec?: number; ms: number; error?: string };
  cvm: { reachable: boolean; ms: number; status?: CvmStatus; error?: string };
  identities: { reachable: boolean; ms: number; summary?: IdentitySummary; error?: string } | null;
  escrow: { paused?: boolean; error?: string };
  queries: (QueryCounts & { scannedTo: bigint; partial: boolean }) | { error: string } | null;
  balances: BalanceReading[];
  consecutiveFailures?: number;
  maxFailures?: number;
};

export function balanceReading(signer: WatchSigner, wei: bigint | undefined, error?: string): BalanceReading {
  return { role: signer.role, address: signer.address, minWei: signer.minWei, ...(wei === undefined ? {} : { wei }), low: wei !== undefined && wei < signer.minWei, ...(error ? { error } : {}) };
}

/** Pure: turns observations into failures (count toward exit) and warnings (flag only). */
export function evaluateTick(report: Omit<TickReport, "ok" | "failures" | "warnings" | "at">, opts: { expectMode: string; strictBalances: boolean; maxHeadAgeSec?: number }): { failures: string[]; warnings: string[] } {
  const failures: string[] = []; const warnings: string[] = [];
  const { rpc, cvm, identities, escrow, queries, balances } = report;
  if (!rpc.reachable) failures.push("rpc_unreachable");
  else if (rpc.chainOk === false) failures.push(`rpc_chain_${rpc.chainId}_mismatch`);
  // Arbitrum chains make blocks only on transactions: an old head is a warning (idle chain or stalled sequencer).
  if (rpc.reachable && rpc.headAgeSec !== undefined && rpc.headAgeSec > (opts.maxHeadAgeSec ?? 300)) warnings.push(`head_age_${rpc.headAgeSec}s`);
  const mode = cvm.status?.mode;
  if (!cvm.reachable) failures.push(`cvm_${cvm.error ?? "unreachable"}`.replace(/\s+/g, "_"));
  else if (!cvm.status) failures.push("cvm_status_invalid");
  else {
    if (opts.expectMode !== "any" && mode !== opts.expectMode) failures.push(`cvm_mode_${mode}_expected_${opts.expectMode}`);
    if (mode !== "standby") {
      const services = Object.entries(cvm.status.services);
      if (!services.length) failures.push("cvm_services_empty");
      for (const [name, state] of services) if (state !== "healthy") failures.push(`service_${name}_${state}`);
    }
    if (mode === "active" && !cvm.status.payments) failures.push("payments_off");
    if (mode !== "active" && cvm.status.payments) failures.push(`payments_on_in_${mode}`);
  }
  if (identities) {
    if (!identities.reachable || !identities.summary) failures.push(`identities_${identities.error ?? "invalid"}`.replace(/\s+/g, "_"));
    else {
      if (!identities.summary.ready) failures.push("identities_not_ready");
      if (identities.summary.count !== EXPECTED_IDENTITY_COUNT) failures.push(`identities_${identities.summary.count}_of_${EXPECTED_IDENTITY_COUNT}`);
      if (identities.summary.measurementOk === false) failures.push("measurement_mismatch");
      if (identities.summary.signersMatch === false) failures.push("service_signers_changed");
    }
  }
  if (escrow.error) failures.push("escrow_read_failed");
  else if (escrow.paused !== undefined && mode) {
    // Prepare and enroll need a paused escrow; active needs it open.
    if ((mode === "prepare" || mode === "enroll") && !escrow.paused) failures.push(`escrow_unpaused_in_${mode}`);
    if (mode === "active" && escrow.paused) failures.push("escrow_paused_in_active");
  }
  if (queries && "error" in queries) warnings.push("query_scan_failed");
  else if (queries) {
    if (queries.expiredEligible > 0) warnings.push(`expiry_eligible_${queries.expiredEligible}`);
    if (queries.hung > 0) warnings.push(`hung_${queries.hung}`);
  }
  for (const b of balances) {
    if (b.error) failures.push(`balance_${b.role}_unreadable`);
    else if (b.low) (opts.strictBalances ? failures : warnings).push(`low_${b.role}`);
  }
  return { failures, warnings };
}

/** One content-free line: states, counts, addresses' roles, balances and timings only. */
export function formatStatusLine(r: TickReport): string {
  const parts: string[] = [r.at, r.ok ? "OK  " : "FAIL"];
  if (r.cvm.status) {
    const services = Object.entries(r.cvm.status.services);
    const healthy = services.filter(([, s]) => s === "healthy").length;
    parts.push(`cvm=${r.cvm.status.mode} pay=${r.cvm.status.payments ? "on" : "off"} svc=${healthy}/${services.length}${services.length && healthy < services.length ? `(${services.filter(([, s]) => s !== "healthy").map(([n, s]) => `${n}:${s}`).join(",")})` : ""} ${r.cvm.ms}ms`);
  } else parts.push(`cvm=${r.cvm.error ?? "invalid"}`);
  if (r.identities) {
    const s = r.identities.summary;
    parts.push(s ? `ids=${s.count}${s.ready ? "" : "(not-ready)"} meas=${s.measurementOk === undefined ? "unchecked" : s.measurementOk ? "ok" : "MISMATCH"}${s.signersMatch === undefined ? "" : ` signers=${s.signersMatch ? "ok" : "CHANGED"}`}` : `ids=${r.identities.error ?? "invalid"}`);
  }
  parts.push(`escrow=${r.escrow.error ? "unreadable" : r.escrow.paused === undefined ? "?" : r.escrow.paused ? "PAUSED" : "open"}`);
  if (r.queries) {
    parts.push("error" in r.queries ? "q=scan-failed" : `q[open=${r.queries.open} sealed=${r.queries.sealed} hung=${r.queries.hung} expiry-eligible=${r.queries.expiredEligible} decided=${r.queries.decided} expired=${r.queries.expired}${r.queries.partial ? " partial" : ""}]`);
  }
  parts.push(r.rpc.reachable ? `rpc=${r.rpc.chainId}${r.rpc.chainOk === false ? "(WRONG)" : ""} ${r.rpc.ms}ms blk=${r.rpc.block}${r.rpc.headAgeSec === undefined ? "" : ` age=${r.rpc.headAgeSec}s`}` : `rpc=${r.rpc.error ?? "unreachable"}`);
  if (r.balances.length) parts.push(`bal[${r.balances.map((b) => `${b.role}=${b.error ? "?" : formatEth(b.wei ?? 0n)}${b.low ? "(LOW)" : ""}`).join(" ")}]`);
  if (r.consecutiveFailures !== undefined) parts.push(`fails=${r.consecutiveFailures}/${r.maxFailures}`);
  if (r.failures.length) parts.push(`failures=${r.failures.join(",")}`);
  if (r.warnings.length) parts.push(`warnings=${r.warnings.join(",")}`);
  return parts.join(" ");
}

export const toJsonLine = (r: TickReport) => JSON.stringify(r, (_k, v) => typeof v === "bigint" ? v.toString() : v);

/** Owner, guardian (when distinct), juror operator and the five service signers with their thresholds. */
export function watchSigners(input: { owner?: Address; guardian?: Address; operator?: Address; services?: ServiceSigners; minOrchestratorWei: bigint; minWei: bigint }): WatchSigner[] {
  const out: WatchSigner[] = [];
  const seen = new Set<string>();
  const push = (role: string, address: Address | undefined, minWei: bigint) => {
    if (!address) return;
    const key = `${role}:${address.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key); out.push({ role, address, minWei });
  };
  push("owner", input.owner, input.minWei);
  if (input.guardian && input.guardian.toLowerCase() !== input.owner?.toLowerCase()) push("guardian", input.guardian, input.minWei);
  push("operator", input.operator, input.minWei);
  for (const role of SERVICE_SIGNER_ROLES) push(role, input.services?.[role], role === "orchestrator" ? input.minOrchestratorWei : input.minWei);
  return out;
}

// ───────────────────────────── live reads ─────────────────────────────

type Deployment = { chainId: number; rpcUrl?: string; startBlock?: string; owner?: Address; guardian?: Address; contracts: { queryEscrow: Address } };
type Ctx = {
  deployment: Deployment; rpc: RpcConfig; redactor: Redactor; cvmUrl: string; measurement?: Hex; expectedSigners?: ServiceSigners;
  signers: WatchSigner[]; tracker: QueryTracker | null; logChunk: bigint; maxScanPerTick: bigint; client: ReturnType<typeof createPublicClient>;
};

async function scanQueries(ctx: Ctx, latest: bigint): Promise<TickReport["queries"]> {
  const tracker = ctx.tracker;
  if (!tracker) return null;
  try {
    const target = latest - tracker.scannedTo > ctx.maxScanPerTick ? tracker.scannedTo + ctx.maxScanPerTick : latest;
    let chunk = ctx.logChunk;
    let from = tracker.scannedTo + 1n;
    while (from <= target) {
      const to = from + chunk - 1n < target ? from + chunk - 1n : target;
      try {
        const logs = await ctx.client.getLogs({ address: ctx.deployment.contracts.queryEscrow, events: ESCROW_EVENTS, fromBlock: from, toBlock: to });
        tracker.apply(logs as ReadonlyArray<{ args: { queryId?: Hex } }>);
        tracker.scannedTo = to; from = to + 1n;
      } catch (error) {
        if (chunk <= 500n) throw error;
        chunk /= 2n;
      }
    }
    for (const id of tracker.dirtyIds(200)) {
      const q = await ctx.client.readContract({ address: ctx.deployment.contracts.queryEscrow, abi: A.QueryEscrowAbi, functionName: "getQuery", args: [id] }) as { status: number; deadline: bigint };
      tracker.update(id, Number(q.status), BigInt(q.deadline));
    }
    const block = await ctx.client.getBlock({ blockNumber: tracker.scannedTo });
    return { ...tracker.counts(block.timestamp), scannedTo: tracker.scannedTo, partial: tracker.scannedTo < latest || tracker.dirtyIds(1).length > 0 };
  } catch (error) {
    return { error: ctx.redactor.error(error).split("\n")[0]! };
  }
}

async function runTick(ctx: Ctx, opts: { expectMode: string; strictBalances: boolean; maxHeadAgeSec: number }): Promise<TickReport> {
  const at = new Date().toISOString();
  const rpcStarted = performance.now();
  let rpc: TickReport["rpc"];
  try {
    const [chainId, head] = await Promise.all([ctx.client.getChainId(), ctx.client.getBlock({ blockTag: "latest" })]);
    rpc = { reachable: true, chainId, chainOk: chainId === ctx.deployment.chainId, block: head.number, headAgeSec: headAgeSec(head.timestamp), ms: Math.round(performance.now() - rpcStarted) };
  } catch (error) {
    rpc = { reachable: false, ms: Math.round(performance.now() - rpcStarted), error: ctx.redactor.error(error).split("\n")[0]!.slice(0, 120) };
  }
  const [statusRes, identityRes] = await Promise.all([
    fetchJsonBounded(`${ctx.cvmUrl}/production/status`, { timeoutMs: 10_000, maxBytes: 256 * 1024 }),
    fetchJsonBounded(`${ctx.cvmUrl}/production/identities`, { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 }),
  ]);
  const cvm: TickReport["cvm"] = { reachable: statusRes.ok, ms: statusRes.ms, ...(statusRes.error ? { error: statusRes.error } : {}) };
  if (statusRes.ok) { try { cvm.status = parseCvmStatus(statusRes.json); } catch { cvm.error = "status_invalid"; } }
  const identities: TickReport["identities"] = { reachable: identityRes.ok, ms: identityRes.ms, ...(identityRes.error ? { error: identityRes.error } : {}) };
  if (identityRes.ok) { try { identities.summary = summarizeIdentities(identityRes.json, ctx.measurement, ctx.expectedSigners); } catch { identities.error = "invalid"; } }
  let escrow: TickReport["escrow"] = {};
  let queries: TickReport["queries"] = null;
  const balances: BalanceReading[] = [];
  if (rpc.reachable && rpc.chainOk) {
    try { escrow = { paused: await ctx.client.readContract({ address: ctx.deployment.contracts.queryEscrow, abi: PAUSED_ABI, functionName: "paused" }) }; }
    catch (error) { escrow = { error: ctx.redactor.error(error).split("\n")[0]! }; }
    await Promise.all(ctx.signers.map(async (signer) => {
      try { balances.push(balanceReading(signer, await ctx.client.getBalance({ address: signer.address }))); }
      catch { balances.push(balanceReading(signer, undefined, "unreadable")); }
    }));
    balances.sort((a, b) => ctx.signers.findIndex((s) => s.role === a.role) - ctx.signers.findIndex((s) => s.role === b.role));
    queries = await scanQueries(ctx, rpc.block!);
  } else {
    escrow = { error: "rpc unavailable" };
  }
  const base = { rpc, cvm, identities, escrow, queries, balances };
  const { failures, warnings } = evaluateTick(base, opts);
  return { at, ok: failures.length === 0, failures, warnings, ...base };
}

async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv, {
    flags: ["--once", "--json", "--strict-balances", "--no-queries"],
    options: ["--deployment", "--identities", "--cvm-url", "--measurement", "--interval", "--max-failures", "--rpc-key-file", "--rpc", "--drpc-network",
      "--operator", "--min-orchestrator-eth", "--min-eth", "--expect-mode", "--from-block", "--log-chunk", "--max-head-age"],
    positionals: 0,
  });
  const redactor = new Redactor();
  const deploymentPath = cli.options.get("--deployment");
  if (!deploymentPath) throw new Error("--deployment <deployment.json> is required");
  const deployment = readJson<Deployment>(deploymentPath, "deployment");
  parseAddress(deployment.contracts?.queryEscrow, "deployment.contracts.queryEscrow");
  const rpc = resolveRpc({ rpcKeyFile: cli.options.get("--rpc-key-file"), rpcFlag: cli.options.get("--rpc"), env: process.env, deploymentRpc: deployment.rpcUrl, chainId: deployment.chainId, drpcNetwork: cli.options.get("--drpc-network") });
  for (const secret of rpc.secrets) redactor.add(secret);
  const cvmUrl = checkServiceUrl(cli.options.get("--cvm-url") ?? DEFAULT_CVM_URL, "--cvm-url");
  const measurement = cli.options.has("--measurement") ? parseBytes32(cli.options.get("--measurement"), "--measurement") : undefined;
  const expectMode = cli.options.get("--expect-mode") ?? "active";
  if (![...RUNTIME_MODES, "any"].includes(expectMode as never)) throw new Error("--expect-mode must be standby, prepare, enroll, active or any");
  let services: ServiceSigners | undefined; let operator: Address | undefined;
  if (cli.options.has("--identities")) {
    const doc = readJson<unknown>(cli.options.get("--identities")!, "--identities");
    services = serviceSignersFrom(doc);
    operator = operatorFrom(doc);
  }
  if (cli.options.has("--operator")) operator = parseAddress(cli.options.get("--operator"), "--operator");
  const signers = watchSigners({
    owner: deployment.owner, guardian: deployment.guardian, operator, services,
    minOrchestratorWei: parseEthAmount(cli.options.get("--min-orchestrator-eth"), "--min-orchestrator-eth", "0.002"),
    minWei: parseEthAmount(cli.options.get("--min-eth"), "--min-eth", "0.0005"),
  });
  const interval = parsePositiveInt(cli.options.get("--interval"), "--interval", 30, 3600);
  const maxFailures = parsePositiveInt(cli.options.get("--max-failures"), "--max-failures", 3, 1000);
  const fromBlockRaw = cli.options.get("--from-block") ?? deployment.startBlock ?? "0";
  if (!/^[0-9]+$/.test(fromBlockRaw)) throw new Error("--from-block must be a block number");
  const client = createPublicClient({ transport: http(rpc.url, { timeout: 15_000, retryCount: 1 }) });
  const ctx: Ctx = {
    deployment, rpc, redactor, cvmUrl, ...(measurement ? { measurement } : {}), ...(services ? { expectedSigners: services } : {}), signers,
    tracker: cli.flags.has("--no-queries") ? null : new QueryTracker(BigInt(fromBlockRaw)),
    logChunk: BigInt(parsePositiveInt(cli.options.get("--log-chunk"), "--log-chunk", 10_000, 1_000_000)), client,
    // A loop catches up 200k blocks per tick so each status line stays timely; --once scans to the head.
    maxScanPerTick: cli.flags.has("--once") ? 2n ** 63n : 200_000n,
  };
  const json = cli.flags.has("--json");
  if (!json) redactor.log(`launch-watch: chain ${deployment.chainId} via ${rpc.display}; cvm ${cvmUrl}; escrow ${deployment.contracts.queryEscrow}; ${signers.length} wallets; expect mode ${expectMode}${cli.flags.has("--once") ? "; once" : `; every ${interval}s, exit after ${maxFailures} consecutive failures`}`);
  let stop = false;
  process.on("SIGINT", () => { stop = true; });
  let consecutive = 0;
  for (;;) {
    const report = await runTick(ctx, { expectMode, strictBalances: cli.flags.has("--strict-balances"), maxHeadAgeSec: parsePositiveInt(cli.options.get("--max-head-age"), "--max-head-age", 300, 86_400) });
    consecutive = report.ok ? 0 : consecutive + 1;
    report.consecutiveFailures = consecutive; report.maxFailures = cli.flags.has("--once") ? 1 : maxFailures;
    redactor.log(json ? toJsonLine(report) : formatStatusLine(report));
    if (cli.flags.has("--once")) return report.ok ? 0 : 1;
    if (consecutive >= maxFailures) { redactor.warn(`launch-watch: ${consecutive} consecutive failing checks; exiting 1`); return 1; }
    for (let waited = 0; waited < interval * 1000 && !stop; waited += 250) await sleep(250);
    if (stop) return 0;
  }
}

if (import.meta.main) {
  const redactor = new Redactor();
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => { redactor.warn(`launch-watch: ${redactor.error(error)}`); process.exit(2); });
}
