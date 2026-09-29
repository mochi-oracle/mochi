// Local owner console: shows prepared, unsigned governance transactions in plain terms and sends each one through
// the owner's own browser wallet (window.ethereum), one explicit click at a time. It never sees, requests or stores
// a private key. Binds 127.0.0.1 only.
//
//   bun scripts/owner-console.ts --deployment <deployment.json> --batch <file.json> [--batch <file.json> ...]
//     [--expect-from 0x...] [--rpc https://...] [--port 4455] [--log <path>]
//
// Accepted batch files: scripts/phala-batch.ts output, scripts/owner-timelock.ts output, and transaction lists
// ({chainId, transactions:[{to,data,value,purpose}]}) such as scripts/prepare-production-enrollment.ts output.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createPublicClient, decodeFunctionData, encodeAbiParameters, formatUnits, http, isAddress, keccak256, parseAbi,
  type Abi, type Address, type Hex,
} from "viem";
import * as A from "@mochi/chain";
import { productionChainRule } from "../deploy/production/chain-policy.ts";

export type Step = { id: string; kind: "timelock-schedule" | "timelock-execute" | "transaction"; to: Address; data: Hex; title: string; details: string[]; operationId?: Hex; file: string };
export type StepStatus = "unscheduled" | "pending" | "ready" | "done" | "unknown" | "unavailable";
export type ChainReader = { operationTimestamp(timelock: Address, id: Hex): Promise<bigint>; latestTimestamp(): Promise<bigint> };
type Deployment = { chainId: number; rehearsal?: boolean; rpcUrl?: string; owner?: Address; contracts: Record<string, Address>; privacy?: Record<string, Address> };

const TIMELOCK_ABI = parseAbi([
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes payload,bytes32 predecessor,bytes32 salt)",
  "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function transfer(address to,uint256 amount) returns (bool)"]);
// Every function of every project contract; identical signatures across contracts decode identically.
const PROJECT_ABI = Object.entries(A).filter(([name, value]) => name.endsWith("Abi") && Array.isArray(value)).flatMap(([, value]) => (value as Abi).filter((item) => item.type === "function")) as Abi;
const ROLE_NAMES = new Map<string, string>([...Object.entries(A.ROLE_IDS).map(([name, id]) => [id.toLowerCase(), `${name}_ROLE`] as const), [keccak256(new TextEncoder().encode("ASP_POSTMAN")).toLowerCase(), "ASP_POSTMAN_ROLE"]]);
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function fail(message: string): never { throw new Error(message); }

export function loadDeployment(raw: unknown): Deployment {
  const d = raw as Deployment;
  if (!d || typeof d !== "object" || !d.contracts || typeof d.contracts !== "object") fail("deployment JSON must contain contracts");
  if (productionChainRule(d) === undefined) fail("deployment must be Robinhood Chain mainnet 4663, or a testnet rehearsal on 46630 with rehearsal=true");
  if (!d.contracts.timelock || !isAddress(d.contracts.timelock)) fail("deployment has no timelock address");
  return d;
}

function contractNames(d: Deployment): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(d.contracts)) if (typeof value === "string" && isAddress(value)) names.set(value.toLowerCase(), name);
  for (const [name, value] of Object.entries(d.privacy ?? {})) if (typeof value === "string" && isAddress(value)) names.set(value.toLowerCase(), `privacy.${name}`);
  return names;
}

function tokenDecimals(d: Deployment, target: Address): number | undefined {
  if (d.contracts.mochiToken?.toLowerCase() === target.toLowerCase()) return 18;
  if (d.contracts.usdg?.toLowerCase() === target.toLowerCase()) return 6;
  return undefined;
}

function show(value: unknown, decimals?: number): string {
  if (typeof value === "bigint") return decimals === undefined ? value.toString() : `${value} (${formatUnits(value, decimals)} tokens)`;
  if (typeof value === "string" && BYTES32.test(value) && ROLE_NAMES.has(value.toLowerCase())) return `${ROLE_NAMES.get(value.toLowerCase())} (${value})`;
  if (Array.isArray(value)) return `[${value.map((v) => show(v)).join(", ")}]`;
  if (typeof value === "string" && value.length > 90) return `${value.slice(0, 42)}…(${(value.length - 2) / 2} bytes)`;
  return String(value);
}

/** Human-readable description of one contract call; throws when it cannot be decoded (fail closed). */
export function describeCall(d: Deployment, target: Address, data: Hex): string {
  const names = contractNames(d);
  const name = names.get(target.toLowerCase()) ?? fail(`target ${target} is not a contract in this deployment`);
  const decimals = tokenDecimals(d, target);
  let decoded: { functionName: string; args?: readonly unknown[] };
  try { decoded = decimals === undefined ? decodeFunctionData({ abi: PROJECT_ABI, data }) : decodeFunctionData({ abi: ERC20_ABI, data }); }
  catch { fail(`cannot decode call to ${name}; refusing to show an unexplained transaction`); }
  const args = (decoded.args ?? []).map((arg) => {
    if (typeof arg === "string" && isAddress(arg)) return names.has(arg.toLowerCase()) ? `${arg} (${names.get(arg.toLowerCase())})` : arg;
    return show(arg, decimals);
  });
  return `${name}.${decoded.functionName}(${args.join(", ")})`;
}

const hashBatch = (targets: readonly Address[], values: readonly bigint[], payloads: readonly Hex[], predecessor: Hex, salt: Hex) =>
  keccak256(encodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }], [targets, values, payloads, predecessor, salt]));
const hashSingle = (target: Address, value: bigint, data: Hex, predecessor: Hex, salt: Hex) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }], [target, value, data, predecessor, salt]));

/** Normalise one batch file into steps, verifying every internal hash and decoding every inner call. */
export function loadSteps(d: Deployment, raw: unknown, file: string, prefix: string): Step[] {
  const timelock = d.contracts.timelock!;
  const b = raw as Record<string, any>;
  if (!b || typeof b !== "object") fail(`${file}: not a JSON object`);
  if (Array.isArray(b.transactions)) {
    if (b.chainId !== d.chainId) fail(`${file}: chainId ${b.chainId} does not match the deployment (${d.chainId})`);
    return b.transactions.map((tx: any, i: number) => {
      if (!tx || !isAddress(tx.to) || typeof tx.data !== "string" || !HEX.test(tx.data) || String(tx.value ?? "0") !== "0") fail(`${file}: transaction ${i} is malformed or sends value`);
      if (tx.to.toLowerCase() === timelock.toLowerCase()) fail(`${file}: timelock calls must use a timelock batch file`);
      const call = describeCall(d, tx.to, tx.data);
      return { id: `${prefix}-${i}`, kind: "transaction" as const, to: tx.to, data: tx.data, title: typeof tx.purpose === "string" ? tx.purpose.slice(0, 160) : `Transaction ${i + 1}`, details: [call], file };
    });
  }
  const to = (b.to ?? b.timelock) as Address;
  if (!to || !isAddress(to) || to.toLowerCase() !== timelock.toLowerCase()) fail(`${file}: timelock operations must target the deployment timelock ${timelock}`);
  if (typeof b.calldata !== "string" || !HEX.test(b.calldata)) fail(`${file}: missing calldata`);
  let decoded: { functionName: string; args: readonly unknown[] };
  try { decoded = decodeFunctionData({ abi: TIMELOCK_ABI, data: b.calldata as Hex }) as typeof decoded; } catch { fail(`${file}: calldata is not a timelock schedule/execute call`); }
  const fn = decoded.functionName;
  const isBatch = fn === "scheduleBatch" || fn === "executeBatch";
  const schedule = fn === "scheduleBatch" || fn === "schedule";
  const details: string[] = [];
  let operationId: Hex;
  if (isBatch) {
    const [targets, values, payloads, predecessor, salt, delay] = decoded.args as [Address[], bigint[], Hex[], Hex, Hex, bigint?];
    if (!Array.isArray(b.targets) || !Array.isArray(b.payloads) || b.targets.length !== targets.length || b.payloads.length !== payloads.length
      || targets.some((t, i) => t.toLowerCase() !== String(b.targets[i]).toLowerCase()) || payloads.some((p, i) => p.toLowerCase() !== String(b.payloads[i]).toLowerCase())) fail(`${file}: calldata does not match the listed targets/payloads`);
    if (values.some((v) => v !== 0n)) fail(`${file}: batch sends value`);
    operationId = hashBatch(targets, values, payloads, predecessor, salt);
    targets.forEach((t, i) => details.push(describeCall(d, t, payloads[i]!)));
    if (delay !== undefined) details.push(`Waiting period after scheduling: ${delay} seconds`);
  } else {
    const [target, value, data, predecessor, salt, delay] = decoded.args as [Address, bigint, Hex, Hex, Hex, bigint?];
    if (value !== 0n) fail(`${file}: operation sends value`);
    if (b.target && String(b.target).toLowerCase() !== target.toLowerCase()) fail(`${file}: calldata target does not match the file`);
    if (b.salt && String(b.salt).toLowerCase() !== salt.toLowerCase()) fail(`${file}: calldata salt does not match the file`);
    operationId = hashSingle(target, value, data, predecessor, salt);
    details.push(describeCall(d, target, data));
    if (delay !== undefined) details.push(`Waiting period after scheduling: ${delay} seconds`);
  }
  if (b.operationId && String(b.operationId).toLowerCase() !== operationId.toLowerCase()) fail(`${file}: operationId does not match the calldata`);
  const phase = typeof b.phase === "string" ? ` (${b.phase})` : "";
  return [{ id: prefix, kind: schedule ? "timelock-schedule" : "timelock-execute", to: timelock, data: b.calldata as Hex, operationId, file,
    title: `${schedule ? "Schedule" : "Execute"} governance operation${phase}: ${details.length - (details.at(-1)?.startsWith("Waiting") ? 1 : 0)} call(s)`, details }];
}

export async function stepStatus(step: Step, timelock: Address, reader: ChainReader | undefined): Promise<StepStatus> {
  if (!step.operationId) return "unknown";
  if (!reader) return "unavailable";
  try {
    const [scheduled, now] = await Promise.all([reader.operationTimestamp(timelock, step.operationId), reader.latestTimestamp()]);
    if (scheduled === 0n) return "unscheduled";
    if (scheduled === 1n) return "done";
    return scheduled > now ? "pending" : "ready";
  } catch { return "unavailable"; }
}

export function rpcReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  return {
    operationTimestamp: (timelock, id) => client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [id] }),
    latestTimestamp: async () => (await client.getBlock()).timestamp,
  };
}

export function createOwnerConsole(options: { deployment: Deployment; steps: Step[]; expectFrom: Address; logPath: string; reader?: ChainReader; html: string }) {
  const { deployment, steps, expectFrom, logPath, reader, html } = options;
  const security = { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'", "x-frame-options": "DENY", "cache-control": "no-store", "referrer-policy": "no-referrer" };
  return async (request: Request, origin: string): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(html, { headers: { ...security, "content-type": "text/html; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/api/steps") {
      const withStatus = await Promise.all(steps.map(async (step) => ({ ...step, status: await stepStatus(step, deployment.contracts.timelock!, reader) })));
      return Response.json({ chainId: deployment.chainId, rehearsal: deployment.rehearsal === true, expectFrom, steps: withStatus }, { headers: security });
    }
    if (request.method === "POST" && url.pathname === "/api/record") {
      if (request.headers.get("origin") !== origin) return Response.json({ error: "cross-origin request refused" }, { status: 403, headers: security });
      let body: any;
      try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400, headers: security }); }
      const step = steps.find((s) => s.id === body?.stepId);
      if (!step || typeof body.txHash !== "string" || !BYTES32.test(body.txHash) || typeof body.from !== "string" || body.from.toLowerCase() !== expectFrom.toLowerCase() || body.chainId !== deployment.chainId || !["sent", "success", "reverted"].includes(body.outcome)) {
        return Response.json({ error: "invalid record" }, { status: 400, headers: security });
      }
      const line = JSON.stringify({ time: new Date().toISOString(), stepId: step.id, title: step.title, operationId: step.operationId ?? null, txHash: body.txHash, from: body.from, chainId: body.chainId, outcome: body.outcome });
      if (!existsSync(logPath)) writeFileSync(logPath, "", { mode: 0o600 });
      appendFileSync(logPath, `${line}\n`); chmodSync(logPath, 0o600);
      return Response.json({ ok: true }, { headers: security });
    }
    return new Response("Not found", { status: 404, headers: security });
  };
}

export function parseArgs(argv: string[]) {
  const out: { deployment?: string; batches: string[]; expectFrom?: string; rpc?: string; port: number; log?: string } = { batches: [], port: 4455 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!; const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${key}`);
    if (key === "--deployment") out.deployment = value; else if (key === "--batch") out.batches.push(value);
    else if (key === "--expect-from") out.expectFrom = value; else if (key === "--rpc") out.rpc = value;
    else if (key === "--port") { out.port = Number(value); if (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535) fail("--port must be 1024-65535"); }
    else if (key === "--log") out.log = value; else fail(`unknown option ${key}`);
    i++;
  }
  if (!out.deployment || !out.batches.length) fail("usage: bun scripts/owner-console.ts --deployment <json> --batch <json> [--batch <json>] [--expect-from 0x..] [--rpc https://..] [--port 4455] [--log path]");
  return out;
}

if (import.meta.main) {
  if (process.env.HOST && process.env.HOST !== "127.0.0.1") throw new Error("owner console binds 127.0.0.1 only");
  const args = parseArgs(process.argv.slice(2));
  const deployment = loadDeployment(JSON.parse(readFileSync(resolve(args.deployment!), "utf8")));
  const expectFrom = (args.expectFrom ?? deployment.owner) as Address | undefined;
  if (!expectFrom || !isAddress(expectFrom)) throw new Error("expected sender unknown: pass --expect-from or use a deployment with an owner");
  const steps = args.batches.flatMap((file, i) => loadSteps(deployment, JSON.parse(readFileSync(resolve(file), "utf8")), file.split("/").pop()!, `b${i + 1}`));
  const rpc = args.rpc ?? deployment.rpcUrl;
  if (rpc && !rpc.startsWith("https://") && !rpc.startsWith("http://127.0.0.1")) throw new Error("--rpc must be HTTPS");
  const logPath = resolve(args.log ?? join(dirname(resolve(args.batches[0]!)), "owner-console-log.jsonl"));
  const html = readFileSync(new URL("./owner-console.html", import.meta.url), "utf8");
  const handler = createOwnerConsole({ deployment, steps, expectFrom, logPath, reader: rpc ? rpcReader(rpc) : undefined, html });
  const server = Bun.serve({ hostname: "127.0.0.1", port: args.port, fetch: (request) => handler(request, `http://127.0.0.1:${args.port}`) });
  console.log(`Owner console: http://127.0.0.1:${server.port}/  (${steps.length} step(s); sender ${expectFrom}; chain ${deployment.chainId}${deployment.rehearsal ? " REHEARSAL" : ""}; log ${logPath})`);
}
