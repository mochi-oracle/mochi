// Shared launch-operations helpers: CLI parsing, RPC/secret redaction, key files, private output files and the
// transaction guard used by launch-watch.ts, canary-check.ts and dress-rehearsal.ts.
//
// Transaction policy (enforced by guardTransaction / sendGuardedTx, never by callers):
//   - chain 4663 (mainnet): every transaction is shown (to, function, value, signer, chain, amount) and needs a "yes"
//     typed by a human on an interactive terminal. There is no flag that skips this; --yes is refused on 4663.
//   - chain 46630 (testnet) and 31337 (local anvil): --yes sends without a prompt; otherwise the same typed yes.
//   - any other chain: refused.
// Secrets: RPC URLs that embed a key, key-file contents and private keys are never printed or persisted. Every line a
// tool prints goes through a Redactor that knows the live secrets.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatEther, formatUnits, isAddress, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
export const ANVIL_CHAIN_ID = 31337;
export const PUBLIC_RPC: Readonly<Record<number, string>> = {
  [MAINNET_CHAIN_ID]: "https://rpc.mainnet.chain.robinhood.com",
  [TESTNET_CHAIN_ID]: "https://rpc.testnet.chain.robinhood.com/rpc",
};
export const DEFAULT_CVM_ID = "21dfb9d71c8d72522bb4372657b96308a190daaa";
export const DEFAULT_CVM_URL = `https://${DEFAULT_CVM_ID}-8080.dstack-pha-prod9.phala.network`;
/** Paxos USDG on Robinhood Chain mainnet (6 decimals). */
export const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function chainName(chainId: number): string {
  if (chainId === MAINNET_CHAIN_ID) return "Robinhood Chain MAINNET 4663";
  if (chainId === TESTNET_CHAIN_ID) return "Robinhood Chain testnet 46630";
  if (chainId === ANVIL_CHAIN_ID) return "local anvil 31337";
  return `unsupported chain ${chainId}`;
}

// ───────────────────────────── redaction ─────────────────────────────

/** Same rules as scripts/deploy-local.ts `redactRpc`: provider URLs embed API keys (dRPC ?dkey=… or /<key>). */
export const redactRpc = (url: string) => url
  .replace(/([?&](?:dkey|key|apikey|api_key|token)=)[^&#]+/gi, "$1<redacted>")
  .replace(/(\/)[A-Za-z0-9_-]{20,}(?=\/?$|[?#])/, "$1<redacted>");

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`]+/g;

/** Scrubs known secrets (exact strings) and keyed URLs from free text such as viem or child-process errors. */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s && s.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("<redacted>");
  }
  out = out.replace(URL_IN_TEXT, (url) => redactRpc(url));
  // A raw 32-byte private key never belongs in output, whatever its source.
  out = out.replace(/(privateKey["']?\s*[:=]\s*["']?)0x[0-9a-fA-F]{64}/g, "$1<redacted>");
  return out;
}

/** Holds the live secrets of one process and scrubs everything that is printed. */
export class Redactor {
  private readonly secrets = new Set<string>();
  constructor(initial: readonly string[] = []) { for (const s of initial) this.add(s); }
  add(secret: string | undefined): void { if (secret && secret.length >= 6) this.secrets.add(secret); }
  text(value: string): string { return scrubText(value, [...this.secrets]); }
  error(error: unknown): string {
    const message = error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error);
    // viem appends request bodies and versions; keep the first lines only, they carry the reason.
    return this.text(message.split("\n").slice(0, 6).join("\n"));
  }
  log(line = ""): void { console.log(this.text(line)); }
  warn(line: string): void { console.error(this.text(line)); }
}

// ───────────────────────────── CLI ─────────────────────────────

export type CliSpec = { flags?: readonly string[]; options?: readonly string[]; multi?: readonly string[]; positionals?: number };
export type Cli = { flags: Set<string>; options: Map<string, string>; multi: Map<string, string[]>; positionals: string[] };

/** Strict parser: unknown options, missing values and repeated single options are errors. */
export function parseCli(argv: readonly string[], spec: CliSpec): Cli {
  const flags = new Set<string>(); const options = new Map<string, string>(); const multi = new Map<string, string[]>(); const positionals: string[] = [];
  const flagSet = new Set(spec.flags ?? []); const optionSet = new Set(spec.options ?? []); const multiSet = new Set(spec.multi ?? []);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    if (flagSet.has(arg)) { flags.add(arg); continue; }
    if (!optionSet.has(arg) && !multiSet.has(arg)) throw new Error(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    i++;
    if (multiSet.has(arg)) multi.set(arg, [...(multi.get(arg) ?? []), value]);
    else { if (options.has(arg)) throw new Error(`${arg} given twice`); options.set(arg, value); }
  }
  if (spec.positionals !== undefined && positionals.length > spec.positionals) throw new Error(`unexpected argument ${positionals[spec.positionals]}`);
  return { flags, options, multi, positionals };
}

export function requireOption(cli: Cli, name: string): string {
  const value = cli.options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseAddress(value: string | undefined, field: string): Address {
  if (!value || !isAddress(value, { strict: false }) || value.toLowerCase() === ZERO_ADDRESS) throw new Error(`${field} must be a nonzero address`);
  return value as Address;
}

export function parseBytes32(value: string | undefined, field: string): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new Error(`${field} must be a nonzero 0x-prefixed bytes32`);
  return value.toLowerCase() as Hex;
}

export function parsePositiveInt(value: string | undefined, field: string, fallback: number, max = 86_400): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) throw new Error(`${field} must be a whole number from 1 to ${max}`);
  return Number(value);
}

export function parseEthAmount(value: string | undefined, field: string, fallback: string): bigint {
  const raw = value ?? fallback;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(raw)) throw new Error(`${field} must be a decimal ETH amount`);
  return parseEther(raw);
}

export const formatEth = (wei: bigint, digits = 6) => Number(formatEther(wei)).toFixed(digits);
export const formatUsdg = (units: bigint) => formatUnits(units, 6);

// ───────────────────────────── RPC ─────────────────────────────

export type RpcConfig = { url: string; display: string; secrets: string[]; source: "key-file" | "env" | "flag" | "deployment" | "public" };
const DRPC_KEY = /^[A-Za-z0-9_-]{8,256}$/;

/** Owner-only file check: secrets live in files with no group/other permission bits. */
export function assertPrivateFile(path: string, what: string, statMode: (p: string) => number = (p) => statSync(p).mode): void {
  let mode: number;
  try { mode = statMode(path); } catch { throw new Error(`${what} not found`); }
  if ((mode & 0o077) !== 0) throw new Error(`${what} must not be readable by group or others (chmod 600)`);
}

/**
 * Chooses the RPC endpoint. A keyed endpoint comes only from --rpc-key-file (dRPC key, mode 600) or RPC_URL; a key in
 * argv would leak through the process list and shell history, so --rpc refuses URLs that carry one.
 */
export function resolveRpc(opts: {
  rpcKeyFile?: string; rpcFlag?: string; env?: Record<string, string | undefined>; deploymentRpc?: string; chainId?: number;
  drpcNetwork?: string; readFile?: (p: string) => string; statMode?: (p: string) => number;
}): RpcConfig {
  const env = opts.env ?? {};
  if (opts.rpcKeyFile) {
    const path = opts.rpcKeyFile.replace(/^~(?=\/)/, homedir());
    assertPrivateFile(path, "--rpc-key-file", opts.statMode);
    const key = (opts.readFile ?? ((p) => readFileSync(p, "utf8")))(path).trim();
    if (!DRPC_KEY.test(key)) throw new Error("--rpc-key-file must contain only the dRPC key");
    const network = opts.drpcNetwork ?? "robinhood";
    if (!/^[a-z0-9-]{1,64}$/.test(network)) throw new Error("--drpc-network is invalid");
    const url = `https://lb.drpc.org/ogrpc?network=${network}&dkey=${key}`;
    return { url, display: redactRpc(url), secrets: [url, key], source: "key-file" };
  }
  const fromEnv = env.RPC_URL?.trim();
  if (fromEnv) return { url: fromEnv, display: redactRpc(fromEnv), secrets: redactRpc(fromEnv) === fromEnv ? [] : [fromEnv], source: "env" };
  if (opts.rpcFlag) {
    if (redactRpc(opts.rpcFlag) !== opts.rpcFlag) throw new Error("--rpc must not contain an API key; use --rpc-key-file or RPC_URL");
    return { url: opts.rpcFlag, display: opts.rpcFlag, secrets: [], source: "flag" };
  }
  if (opts.deploymentRpc) {
    if (redactRpc(opts.deploymentRpc) !== opts.deploymentRpc) throw new Error("deployment rpcUrl carries a key; use --rpc-key-file or RPC_URL");
    return { url: opts.deploymentRpc, display: opts.deploymentRpc, secrets: [], source: "deployment" };
  }
  const fallback = opts.chainId === undefined ? undefined : PUBLIC_RPC[opts.chainId];
  if (!fallback) throw new Error("no RPC: pass --rpc-key-file, RPC_URL, or --rpc");
  return { url: fallback, display: fallback, secrets: [], source: "public" };
}

// ───────────────────────────── key files ─────────────────────────────

export type LoadedKey = { account: PrivateKeyAccount; address: Address };

/**
 * Loads a JSON key file `{address, privateKey}` (mode 600) inside the signing process. Errors never echo the file.
 * When the file records an address it must match the key.
 */
export function loadKeyFile(path: string, what: string, deps: { readFile?: (p: string) => string; statMode?: (p: string) => number } = {}): LoadedKey {
  const resolved = path.replace(/^~(?=\/)/, homedir());
  assertPrivateFile(resolved, what, deps.statMode);
  let parsed: unknown;
  try { parsed = JSON.parse((deps.readFile ?? ((p) => readFileSync(p, "utf8")))(resolved)); }
  catch { throw new Error(`${what} is not valid JSON`); }
  const record = parsed as { privateKey?: unknown; address?: unknown };
  if (typeof record?.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.privateKey)) throw new Error(`${what} has no valid privateKey field`);
  const account = privateKeyToAccount(record.privateKey as Hex);
  if (record.address !== undefined && (typeof record.address !== "string" || record.address.toLowerCase() !== account.address.toLowerCase())) {
    throw new Error(`${what}: recorded address does not match its key`);
  }
  return { account, address: account.address };
}

// ───────────────────────────── private files ─────────────────────────────

export function ensurePrivateDir(path: string): void {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} must not be a symlink`);
    if (!statSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
  } else mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export const jsonText = (value: unknown) => `${JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2)}\n`;

/** Atomic write, mode 600. */
export function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, jsonText(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readJson<T>(path: string, what: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new Error(`${what} (${path}) is missing or not valid JSON`); }
}

// ───────────────────────────── transaction guard ─────────────────────────────

export type TxIntent = {
  chainId: number;
  signer: Address;
  to: Address;
  /** Human-readable function, e.g. "approve(spender=QueryEscrow 0x…, amount=0.10 USDG)". */
  functionName: string;
  value: bigint;
  /** Token amount moved or approved, already formatted with its unit; "none" when the call moves no token. */
  amount: string;
  purpose: string;
  data: Hex;
};
export type SendPolicy = { yes: boolean };
export type ConfirmIO = { interactive: boolean; ask(question: string): Promise<string>; print(line: string): void };
export class TxRefused extends Error { constructor(message: string) { super(message); this.name = "TxRefused"; } }

/** --yes is a testnet/anvil convenience only; on mainnet it is an error, so nobody believes it skipped a prompt. */
export function assertYesAllowed(chainId: number, yes: boolean): void {
  if (yes && chainId === MAINNET_CHAIN_ID) throw new Error("--yes is not accepted on chain 4663: every mainnet transaction needs a typed yes");
}

export type SendDecision = { kind: "auto" } | { kind: "ask" } | { kind: "refuse"; reason: string };

/** Pure policy: what is required before this transaction may be sent. */
export function sendDecision(chainId: number, policy: SendPolicy, interactive: boolean): SendDecision {
  if (chainId === MAINNET_CHAIN_ID) {
    if (policy.yes) return { kind: "refuse", reason: "--yes is not accepted on chain 4663" };
    if (!interactive) return { kind: "refuse", reason: "chain 4663 needs a human at an interactive terminal to type yes for each transaction" };
    return { kind: "ask" };
  }
  if (chainId === TESTNET_CHAIN_ID || chainId === ANVIL_CHAIN_ID) {
    if (policy.yes) return { kind: "auto" };
    if (!interactive) return { kind: "refuse", reason: `pass --yes to send on ${chainName(chainId)} without a terminal` };
    return { kind: "ask" };
  }
  return { kind: "refuse", reason: `refusing to send on ${chainName(chainId)}` };
}

export function describeTx(intent: TxIntent): string[] {
  return [
    `  chain    : ${intent.chainId} (${chainName(intent.chainId)})`,
    `  signer   : ${intent.signer}`,
    `  to       : ${intent.to}`,
    `  function : ${intent.functionName}`,
    `  value    : ${formatEth(intent.value, 18).replace(/\.?0+$/, "") || "0"} ETH`,
    `  amount   : ${intent.amount}`,
    `  purpose  : ${intent.purpose}`,
  ];
}

/** Shows the transaction and enforces the policy. Throws TxRefused unless sending is allowed. */
export async function guardTransaction(intent: TxIntent, policy: SendPolicy, io: ConfirmIO): Promise<void> {
  io.print(`Transaction${intent.chainId === MAINNET_CHAIN_ID ? " (MAINNET, real funds)" : ""}:`);
  for (const line of describeTx(intent)) io.print(line);
  const decision = sendDecision(intent.chainId, policy, io.interactive);
  if (decision.kind === "refuse") throw new TxRefused(decision.reason);
  if (decision.kind === "auto") { io.print(`  sending (--yes on ${chainName(intent.chainId)})`); return; }
  const answer = await io.ask(`Type yes to send this transaction on chain ${intent.chainId}, anything else to stop: `);
  if (answer.trim() !== "yes") throw new TxRefused("not confirmed; nothing sent");
}

/** Terminal IO: interactive only when both stdin and stdout are TTYs, so `yes | tool` cannot confirm. */
export function terminalConfirmIO(redactor: Redactor): ConfirmIO {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try { return await rl.question(question); } finally { rl.close(); }
    },
    print: (line) => redactor.log(line),
  };
}

type ReceiptLike = { status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice?: bigint; blockNumber: bigint; transactionHash: Hex; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] };
export type GuardedClients = {
  publicClient: { getChainId(): Promise<number>; call(args: { account: Address; to: Address; data: Hex; value?: bigint }): Promise<unknown>; waitForTransactionReceipt(args: { hash: Hex; timeout?: number }): Promise<ReceiptLike> };
  walletClient: { chain?: { id: number } | undefined; account?: { address: Address } | undefined; sendTransaction(args: any): Promise<Hex> };
};
export type SentTx = { hash: Hex; receipt: ReceiptLike; gasCostWei: bigint };

/**
 * The only send path in these tools: live chain check, signer check, revert simulation, the policy gate, a second chain
 * check, send, and a successful receipt. `onSent` runs as soon as the hash is known (for checkpoints).
 */
export async function sendGuardedTx(clients: GuardedClients, intent: TxIntent, policy: SendPolicy, io: ConfirmIO, onSent?: (hash: Hex) => void): Promise<SentTx> {
  const { publicClient, walletClient } = clients;
  const live = await publicClient.getChainId();
  if (live !== intent.chainId) throw new TxRefused(`RPC reports chain ${live}, transaction is for chain ${intent.chainId}`);
  if (walletClient.chain?.id !== intent.chainId) throw new TxRefused("wallet client is not pinned to the transaction chain");
  if (walletClient.account?.address.toLowerCase() !== intent.signer.toLowerCase()) throw new TxRefused("wallet account is not the declared signer");
  try { await publicClient.call({ account: intent.signer, to: intent.to, data: intent.data, value: intent.value }); }
  catch (error) { throw new TxRefused(`simulation reverted, nothing sent: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
  await guardTransaction(intent, policy, io);
  if (await publicClient.getChainId() !== intent.chainId) throw new TxRefused("RPC chain changed during confirmation; nothing sent");
  const hash = await walletClient.sendTransaction({ account: walletClient.account, chain: walletClient.chain, to: intent.to, data: intent.data, value: intent.value });
  onSent?.(hash);
  io.print(`  sent ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  io.print(`  confirmed in block ${receipt.blockNumber}, gas ${receipt.gasUsed} (${formatEth(gasCostWei, 9)} ETH)`);
  return { hash, receipt, gasCostWei };
}

// ───────────────────────────── identities / service signers ─────────────────────────────

export const SERVICE_SIGNER_ROLES = ["orchestrator", "indexer", "attestor", "postman", "feedRunner"] as const;
export type ServiceSignerRole = typeof SERVICE_SIGNER_ROLES[number];
export type ServiceSigners = Partial<Record<ServiceSignerRole, Address>>;

/**
 * Reads the five enclave service signers from a launch `production-identities.json` (flat attestor/feedRunner/…
 * fields) or from a verified identities report / live `/production/identities` (`serviceSigners[]`).
 */
export function serviceSignersFrom(doc: unknown): ServiceSigners {
  const record = doc as Record<string, unknown> | null;
  if (!record || typeof record !== "object") throw new Error("identities document must be a JSON object");
  const out: ServiceSigners = {};
  if (Array.isArray(record.serviceSigners)) {
    const names: Record<string, ServiceSignerRole> = { orchestrator: "orchestrator", indexer: "indexer", attestor: "attestor", postman: "postman", "feed-runner": "feedRunner", feedRunner: "feedRunner" };
    for (const item of record.serviceSigners as Array<{ name?: unknown; address?: unknown }>) {
      const role = typeof item?.name === "string" ? names[item.name] : undefined;
      if (role && typeof item.address === "string") out[role] = parseAddress(item.address, `serviceSigners.${item.name}`);
    }
  } else {
    for (const role of SERVICE_SIGNER_ROLES) if (typeof record[role] === "string") out[role] = parseAddress(record[role] as string, role);
  }
  const missing = SERVICE_SIGNER_ROLES.filter((role) => !out[role]);
  if (missing.length) throw new Error(`identities document lacks service signers: ${missing.join(", ")}`);
  return out;
}

/** The single juror operator recorded in a launch identities file (all nine seats share it), if any. */
export function operatorFrom(doc: unknown): Address | undefined {
  const jurors = (doc as { jurors?: Array<{ operator?: unknown }> } | null)?.jurors;
  if (!Array.isArray(jurors)) return undefined;
  const operators = new Set(jurors.map((j) => typeof j?.operator === "string" ? j.operator.toLowerCase() : "").filter(Boolean));
  if (operators.size !== 1) return undefined;
  return parseAddress([...operators][0], "jurors[].operator");
}

/** Intake signing address from a launch identities file or an identities report. */
export function intakeAddressFrom(doc: unknown): Address | undefined {
  const record = doc as { intake?: { address?: unknown }; identities?: Array<{ name?: unknown; address?: unknown }> } | null;
  if (typeof record?.intake?.address === "string") return parseAddress(record.intake.address, "intake.address");
  const item = record?.identities?.find((i) => i?.name === "intake");
  return typeof item?.address === "string" ? parseAddress(item.address, "identities.intake") : undefined;
}

// ───────────────────────────── HTTP ─────────────────────────────

/** Public HTTPS only (loopback HTTP for local tests); no credentials or query strings in the base URL. */
export function checkServiceUrl(raw: string, field: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${field} must be a URL`); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) throw new Error(`${field} must be https (http only on loopback)`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${field} must not carry credentials, a query or a fragment`);
  return url.toString().replace(/\/$/, "");
}

export type FetchResult = { ok: boolean; status: number; ms: number; json?: unknown; error?: string };

/** GET with a timeout and a body cap; never throws and never returns the raw body on failure. */
export async function fetchJsonBounded(url: string, opts: { timeoutMs?: number; maxBytes?: number; fetcher?: typeof fetch } = {}): Promise<FetchResult> {
  const started = performance.now();
  try {
    const response = await (opts.fetcher ?? fetch)(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (opts.maxBytes ?? 4 * 1024 * 1024)) { await reader.cancel(); return { ok: false, status: response.status, ms: Math.round(performance.now() - started), error: "response too large" }; }
      chunks.push(value);
    }
    const ms = Math.round(performance.now() - started);
    let json: unknown;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { ok: false, status: response.status, ms, error: "response is not JSON" }; }
    return { ok: response.ok, status: response.status, ms, json, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, status: 0, ms: Math.round(performance.now() - started), error: name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Robinhood Chain (Arbitrum Nitro) makes a block only when a transaction arrives, so an old head can mean an idle chain
 * as well as a stalled sequencer or a lagging RPC node. Tools report it; they do not treat it as proof of an outage.
 */
export const HEAD_AGE_NOTE_SEC = 300;
export function headAgeSec(blockTimestamp: bigint, nowMs = Date.now()): number {
  return Math.max(0, Math.round(nowMs / 1000 - Number(blockTimestamp)));
}
export async function describeHead(client: { getBlock(args: { blockTag: "latest" }): Promise<{ number: bigint | null; timestamp: bigint }> }, nowMs = Date.now()): Promise<string> {
  const block = await client.getBlock({ blockTag: "latest" });
  const age = headAgeSec(block.timestamp, nowMs);
  return `chain head ${block.number} is ${age}s old${age > HEAD_AGE_NOTE_SEC ? " (idle chain, or a stalled sequencer/RPC: if a submission times out, check the sender's nonce before any retry)" : ""}`;
}

export type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex };

/**
 * eth_getLogs over [from, to] in chunks, halving the chunk when a provider rejects a range (dRPC and public nodes cap
 * block ranges differently).
 */
export async function fetchLogsChunked(
  client: { request(args: { method: "eth_getLogs"; params: [unknown] }): Promise<unknown> },
  filter: { address: Address; topics: Array<Hex | Hex[] | null> },
  from: bigint, to: bigint, chunk = 5_000n, minChunk = 250n,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let size = chunk;
  for (let start = from; start <= to;) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    try {
      const logs = await client.request({ method: "eth_getLogs", params: [{ address: filter.address, topics: filter.topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }] }) as RawLog[];
      out.push(...logs);
      start = end + 1n;
    } catch (error) {
      if (size <= minChunk) throw error;
      size /= 2n;
    }
  }
  return out;
}
