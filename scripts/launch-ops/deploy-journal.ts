// Checkpointed, resumable transaction sending for scripts/deploy-local.ts.
//
// Every step of a deployment has a stable, explicit id. Before a transaction is broadcast, it is signed once and the
// journal (<out>.progress.json, mode 600, written atomically) records the step id, nonce, hash and the signed raw
// transaction. A broadcast that times out or fails in transit is retried with the SAME signed transaction, never a new
// one, and the receipt is awaited with a long timeout. "already known" and "nonce too low" answers are success when the
// recorded hash is known to the chain. A restart with --resume re-reads the journal, checks every recorded step on chain
// (receipt, sender, nonce, calldata, code at a deployed address, role or parameter value) and continues from the first
// incomplete step; it refuses when the chain contradicts the journal.
//
// Nothing here prints or stores an RPC URL or key material. The signed raw transaction is public once broadcast and is
// dropped from the journal when the step is confirmed.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex, type Abi, type AbiFunction, type Address, type Hex } from "viem";

export const JOURNAL_KIND = "mochi-deploy-journal";
export const JOURNAL_VERSION = 1;

export type StepKind = "deploy" | "call" | "renounce-if-held";
/** One planned step; `to` is null for a contract creation. In the plan, addresses of contracts this deployment creates are placeholders. */
export type PlannedStep = { id: string; kind: StepKind; label: string; to: Address | null; dataHash: Hex };
export type StepStatus = "signed" | "broadcast" | "confirmed" | "reverted" | "skipped";
/** An on-chain postcondition of a step, evaluated after its receipt and again on every --resume. */
export type StepCheck =
  | { kind: "code"; address: Address }
  | { kind: "view"; address: Address; signature: string; args: string[]; expect: string; label: string };
export type RevertedAttempt = { hash: Hex; nonce: number; block?: string };
export type JournalStep = {
  id: string; kind: StepKind; status: StepStatus;
  nonce?: number; hash?: Hex; raw?: Hex; to?: Address | null; dataHash?: Hex;
  gasLimit?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; gasPrice?: string;
  address?: Address; block?: string; gasUsed?: string; effectiveGasPrice?: string;
  checks?: StepCheck[]; reason?: string; attempts?: RevertedAttempt[];
  signedAt?: string; broadcastAt?: string; confirmedAt?: string;
};
export type Journal = {
  kind: typeof JOURNAL_KIND; version: typeof JOURNAL_VERSION;
  chainId: number; deployer: Address; mode: string;
  configHash: Hex; config: Record<string, unknown>;
  planHash: Hex; plan: Array<{ id: string; kind: StepKind; label: string }>;
  startNonce: number; startBlock: string;
  status: "in-progress" | "complete";
  createdAt: string; updatedAt: string; completedAt?: string;
  steps: JournalStep[];
};

export const journalPathFor = (out: string) => `${out}.progress.json`;
export const lockPathFor = (out: string) => `${out}.progress.lock`;

// ───────────────────────────── plan identity ─────────────────────────────

/** A stand-in address for a contract the deployment has not created yet (plan pass only). Stable per step id. */
export function placeholderAddress(stepId: string): Address {
  return `0x${keccak256(toHex(`mochi.deploy-local.placeholder:${stepId}`)).slice(26)}` as Address;
}

/** Hash of the ordered plan: any change of order, ids, targets, calldata or contract bytecode changes it. */
export function planHash(plan: readonly PlannedStep[]): Hex {
  return keccak256(toHex(JSON.stringify(plan.map((s) => [s.id, s.kind, s.to ? s.to.toLowerCase() : null, s.dataHash]))));
}

/** Hash of the deployment configuration (sorted keys); operational options such as timeouts are left out by the caller. */
export function configHash(config: Record<string, unknown>): Hex {
  const sorted = Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
  return keccak256(toHex(JSON.stringify(sorted, (_k, v) => typeof v === "bigint" ? v.toString() : v)));
}

export function assertUniqueStepIds(plan: readonly PlannedStep[]): void {
  const seen = new Set<string>();
  for (const step of plan) {
    if (!/^[A-Za-z0-9_.@-]{1,160}$/.test(step.id)) throw new Error(`invalid step id ${JSON.stringify(step.id)}`);
    if (seen.has(step.id)) throw new Error(`duplicate step id ${step.id}`);
    seen.add(step.id);
  }
}

// ───────────────────────────── files ─────────────────────────────

/** Atomic private write: temp file (mode 600) in the same directory, fsync, rename, then a best-effort directory fsync. */
let tmpCounter = 0;
export function writePrivateFileAtomic(path: string, text: string, mode = 0o600): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  try { const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* not supported everywhere */ }
}

export const journalText = (journal: Journal) => `${JSON.stringify(journal, null, 2)}\n`;

export function writeJournal(path: string, journal: Journal): void {
  journal.updatedAt = new Date().toISOString();
  writePrivateFileAtomic(path, journalText(journal));
}

export function readJournal(path: string): Journal {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`deployment journal ${path} is not valid JSON; inspect it by hand`); }
  const j = parsed as Journal;
  if (j?.kind !== JOURNAL_KIND || j.version !== JOURNAL_VERSION || !Array.isArray(j.steps) || !Array.isArray(j.plan)) throw new Error(`${path} is not a version ${JOURNAL_VERSION} deploy-local journal`);
  return j;
}

/**
 * Exclusive lock next to the journal, so two runs never send for the same deployment. A lock left by a killed run
 * (its PID no longer alive) is taken over.
 */
export function acquireLock(path: string, isAlive: (pid: number) => boolean = pidAlive): { release(): void; tookOver?: number } {
  let tookOver: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return {
        tookOver,
        release() { try { if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path); } catch { /* already gone */ } },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid = NaN;
      try { pid = Number(readFileSync(path, "utf8").trim()); } catch { /* raced with a release */ }
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        throw new Error(`another deploy-local run (pid ${pid}) holds ${path}; wait for it to exit (if no such run exists, delete the lock file)`);
      }
      tookOver = Number.isInteger(pid) ? pid : undefined;
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  throw new Error(`could not take the deploy lock ${path}`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// ───────────────────────────── journal rules ─────────────────────────────

const lower = (value: string | null | undefined) => value ? value.toLowerCase() : null;
const isPending = (s: JournalStep) => s.status === "signed" || s.status === "broadcast";

/**
 * Pure structural rules for resuming. The journal must belong to this chain, deployer, configuration and plan; its steps
 * must be a prefix of the plan in order; only the last step may be unfinished; and nonces must be consecutive from the
 * recorded start (each sent step, and each reverted attempt kept in history, used exactly one nonce).
 */
export function journalProblems(j: Journal, plan: readonly PlannedStep[], expect: { chainId: number; deployer: Address; configHash: Hex; planHash: Hex }): string[] {
  const problems: string[] = [];
  if (j.chainId !== expect.chainId) problems.push(`journal is for chain ${j.chainId}, the RPC is chain ${expect.chainId}`);
  if (lower(j.deployer) !== lower(expect.deployer)) problems.push(`journal deployer ${j.deployer} is not the --key-file deployer ${expect.deployer}`);
  if (j.configHash !== expect.configHash) problems.push("deployment configuration differs from the journal's (owner, tokens, roles, timings, flags or FEED_ORIGINS changed); rerun with exactly the original options");
  if (j.planHash !== expect.planHash) {
    const first = plan.findIndex((s, i) => j.plan[i]?.id !== s.id || j.plan[i]?.kind !== s.kind);
    problems.push(first >= 0 || j.plan.length !== plan.length
      ? `the step plan changed since the journal was written (first difference at step ${(first >= 0 ? first : Math.min(plan.length, j.plan.length)) + 1}: journal ${j.plan[first >= 0 ? first : plan.length]?.id ?? "(end)"}, now ${plan[first >= 0 ? first : j.plan.length]?.id ?? "(end)"})`
      : "the step plan has the same ids but different calldata or contract bytecode than the journal's (rebuilt contracts or changed code); refusing to mix versions");
  }
  if (j.steps.length > plan.length) problems.push(`journal has ${j.steps.length} steps, the plan only ${plan.length}`);
  const hashes = new Set<string>();
  let nonce = j.startNonce;
  j.steps.forEach((step, i) => {
    const label = `step ${i + 1} (${step.id})`;
    const planned = plan[i];
    if (!planned || planned.id !== step.id || planned.kind !== step.kind) problems.push(`${label} is out of order: the plan has ${planned?.id ?? "(end)"} at this position`);
    if (!["signed", "broadcast", "confirmed", "reverted", "skipped"].includes(step.status)) problems.push(`${label} has unknown status ${String(step.status)}`);
    if (i < j.steps.length - 1 && step.status !== "confirmed" && step.status !== "skipped") problems.push(`${label} is ${step.status} but later steps are recorded: a later step happened without this one`);
    if (step.status === "skipped") {
      if (step.kind !== "renounce-if-held") problems.push(`${label} is skipped, but only conditional renounce steps can be skipped`);
      if (step.hash || step.nonce !== undefined) problems.push(`${label} is skipped but records a transaction`);
    }
    for (const attempt of step.attempts ?? []) {
      if (attempt.nonce !== nonce) problems.push(`${label} reverted attempt uses nonce ${attempt.nonce}, expected ${nonce}`);
      nonce++;
      if (hashes.has(attempt.hash)) problems.push(`${label} repeats transaction ${attempt.hash}`);
      hashes.add(attempt.hash);
    }
    if (step.status === "skipped") return;
    if (step.nonce !== nonce) problems.push(`${label} uses nonce ${String(step.nonce)}, expected ${nonce} (nonces must be consecutive from ${j.startNonce})`);
    nonce++;
    if (!step.hash || !/^0x[0-9a-f]{64}$/i.test(step.hash)) problems.push(`${label} has no transaction hash`);
    else if (hashes.has(step.hash)) problems.push(`${label} repeats transaction ${step.hash}`);
    else hashes.add(step.hash);
    if (!step.dataHash) problems.push(`${label} has no calldata hash`);
    if (isPending(step)) {
      if (!step.raw) problems.push(`${label} is ${step.status} but its signed transaction is missing`);
      else if (step.hash && keccak256(step.raw) !== step.hash.toLowerCase()) problems.push(`${label} signed transaction does not hash to the recorded ${step.hash}`);
    }
    if (step.status === "confirmed" && step.kind === "deploy" && !step.address) problems.push(`${label} is a confirmed deployment without an address`);
  });
  if (j.status === "complete" && (j.steps.length !== plan.length || j.steps.some((s) => s.status !== "confirmed" && s.status !== "skipped"))) problems.push("journal says complete but not every step is confirmed");
  return problems;
}

/** Count of nonces the journal accounts for (sent steps plus reverted attempts). */
export function noncesUsed(j: Journal, includePending = true): number {
  return j.steps.reduce((n, s) => n + (s.attempts?.length ?? 0) + (s.status === "skipped" ? 0 : isPending(s) && !includePending ? 0 : 1), 0);
}

// ───────────────────────────── RPC errors and retries ─────────────────────────────

export type RawRpc = { request(method: string, params: unknown[]): Promise<unknown> };

/** Message, details, codes and causes of an error, flattened for classification (never printed as-is). */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error; let depth = 0;
  while (current && depth++ < 8) {
    const e = current as { name?: unknown; message?: unknown; details?: unknown; shortMessage?: unknown; code?: unknown; status?: unknown; cause?: unknown };
    for (const value of [e.name, e.shortMessage, e.details, e.message]) if (typeof value === "string") parts.push(value);
    if (typeof e.code === "number" || typeof e.code === "string") parts.push(`code=${e.code}`);
    if (typeof e.status === "number") parts.push(`status=${e.status}`);
    current = e.cause;
  }
  if (!parts.length) parts.push(String(error));
  return parts.join(" | ");
}

const TRANSIENT = /TimeoutError|took too long|timed out|timeout|HttpRequestError|SocketClosedError|fetch failed|failed to fetch|network|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|socket hang up|connection (?:reset|closed|refused)|status=(?:408|425|429|5\d\d)|code=(?:-32603|-32005|-32007|429)|rate limit|too many requests|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|try again|header not found|unknown block|block not found|could not be found|block ?out ?of ?range|block height is|greater than (?:the )?(?:current|latest) (?:head|block)|not yet available|cannot fulfill|missing trie node|request failed|internal error|upstream/i;

/** True for errors that say nothing about the request itself: timeouts, transport failures, rate limits, lagging nodes. */
export function isTransientError(error: unknown): boolean {
  return TRANSIENT.test(errorText(error));
}

export type SendErrorClass = "known" | "nonce-used" | "rejected" | "transient";
const KNOWN = /already known|already imported|known transaction|alreadyknown|already in (?:the )?(?:mempool|pool)|already exists/i;
const NONCE_USED = /nonce too low|nonce has already been used|noncetoolow|nonce is too low|replacement transaction underpriced|replacement fee too low|transaction underpriced: replacement/i;
const REJECTED = /insufficient funds|intrinsic gas too low|gas too low|max fee per gas less than block base fee|fee cap less than block base fee|feecap.*basefee|exceeds block gas limit|gas limit reached|invalid sender|invalid signature|invalid chain ?id|chain ?id mismatch|transaction type not supported|max priority fee per gas higher|tip higher than fee cap|oversized data|exceeds the configured cap|nonce too high|execution reverted/i;

/** What an eth_sendRawTransaction failure means for a transaction whose hash we already recorded. */
export function classifySendError(error: unknown): SendErrorClass {
  const text = errorText(error);
  if (KNOWN.test(text)) return "known";
  if (NONCE_USED.test(text)) return "nonce-used";
  if (REJECTED.test(text)) return "rejected";
  // Unknown outcome (timeouts, transport errors, anything unrecognised): re-broadcasting the same signed transaction is
  // always safe, so treat it as transient.
  return "transient";
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type RetryOptions = { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, error: unknown) => void };

/** Bounded retries with exponential backoff, for reads only and only on transient errors. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= attempts || !isTransientError(error)) throw error;
      opts.onRetry?.(attempt, error);
      await (opts.sleep ?? sleep)(Math.min(opts.maxDelayMs ?? 15_000, (opts.baseDelayMs ?? 500) * 2 ** (attempt - 1)));
    }
  }
}

// ───────────────────────────── chain reads over raw JSON-RPC ─────────────────────────────

export type ParsedReceipt = { status: "success" | "reverted"; blockNumber: bigint; contractAddress: Address | null; gasUsed: bigint; effectiveGasPrice: bigint; from: Address; to: Address | null; transactionHash: Hex };
export type ParsedTx = { hash: Hex; from: Address; nonce: number; to: Address | null; input: Hex; blockNumber: bigint | null };
export type BlockTag = "latest" | "pending" | bigint;
const tag = (b: BlockTag) => typeof b === "bigint" ? toHex(b) : b;
const big = (v: unknown) => BigInt(typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? v : 0);

export function parseReceipt(raw: unknown): ParsedReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.blockNumber === null || r.blockNumber === undefined) return null;
  return {
    status: r.status === "0x1" || r.status === 1 || r.status === "success" ? "success" : "reverted",
    blockNumber: big(r.blockNumber), contractAddress: (r.contractAddress as Address | null) ?? null,
    gasUsed: big(r.gasUsed), effectiveGasPrice: big(r.effectiveGasPrice ?? 0), from: r.from as Address, to: (r.to as Address | null) ?? null,
    transactionHash: r.transactionHash as Hex,
  };
}

export function parseTx(raw: unknown): ParsedTx | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  return { hash: t.hash as Hex, from: t.from as Address, nonce: Number(big(t.nonce)), to: (t.to as Address | null) ?? null, input: (t.input ?? t.data ?? "0x") as Hex, blockNumber: t.blockNumber === null || t.blockNumber === undefined ? null : big(t.blockNumber) };
}

/** Read helpers with bounded transient retries; `block` pins a read to a block at or after our last receipt (lagging nodes answer "unknown block" and are retried). */
export function chainReader(rpc: RawRpc, retry: RetryOptions = {}) {
  const call = <T>(method: string, params: unknown[]) => withRetries(() => rpc.request(method, params) as Promise<T>, retry);
  return {
    receipt: async (hash: Hex) => parseReceipt(await call("eth_getTransactionReceipt", [hash])),
    tx: async (hash: Hex) => parseTx(await call("eth_getTransactionByHash", [hash])),
    code: async (address: Address, block: BlockTag = "latest") => (await call<Hex>("eth_getCode", [address, tag(block)])) ?? "0x",
    nonce: async (address: Address, block: BlockTag = "latest") => Number(big(await call("eth_getTransactionCount", [address, tag(block)]))),
    blockNumber: async () => big(await call("eth_blockNumber", [])),
    async view(check: Extract<StepCheck, { kind: "view" }>, block: BlockTag = "latest"): Promise<string> {
      const abi = parseAbi([check.signature]) as Abi;
      const fn = abi[0] as AbiFunction;
      const data = encodeFunctionData({ abi, functionName: fn.name, args: check.args.map((a, i) => decodeArg(fn.inputs[i]?.type ?? "", a)) } as never);
      const result = await call<Hex>("eth_call", [{ to: check.address, data }, tag(block)]);
      return normalizeValue(decodeFunctionResult({ abi, functionName: fn.name, data: result } as never));
    },
  };
}
export type ChainReader = ReturnType<typeof chainReader>;

function decodeArg(type: string, value: string): unknown {
  if (/^u?int\d*$/.test(type)) return BigInt(value);
  if (type === "bool") return value === "true";
  return value;
}

export function normalizeValue(value: unknown): string {
  if (typeof value === "string") return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v);
}

// ───────────────────────────── postconditions ─────────────────────────────

const view = (address: Address, signature: string, args: unknown[], expect: unknown, label: string): StepCheck =>
  ({ kind: "view", address, signature, args: args.map(normalizeValue), expect: normalizeValue(expect), label });

/**
 * The on-chain facts a call establishes: role grants and renounces, the pause, and parameter setters with a matching
 * getter in the ABI. Grants to the deployer are not checked (the handover renounces them later).
 */
export function checksFor(abi: Abi, address: Address, functionName: string, args: readonly unknown[], deployer: Address): StepCheck[] {
  const fns = abi.filter((x): x is AbiFunction => x.type === "function");
  const getter = (name: string, inputs: number) => fns.find((f) => f.name === name && f.inputs.length === inputs && f.outputs.length === 1 && (f.stateMutability === "view" || f.stateMutability === "pure"));
  const sig = (f: AbiFunction) => `function ${f.name}(${f.inputs.map((i) => i.type).join(",")}) view returns (${f.outputs[0]!.type})`;
  const hasRole = "function hasRole(bytes32,address) view returns (bool)";
  if (functionName === "grantRole") {
    const [role, account] = args as [Hex, Address];
    return lower(account) === lower(deployer) ? [] : [view(address, hasRole, [role, account], true, `hasRole(${role}, ${account})`)];
  }
  if (functionName === "renounceRole") {
    const [role, account] = args as [Hex, Address];
    return [view(address, hasRole, [role, account], false, `deployer no longer holds ${role}`)];
  }
  if (functionName === "pause") return [view(address, "function paused() view returns (bool)", [], true, "paused")];
  if (functionName === "transferMetadataAdmin") return [view(address, "function metadataAdmin() view returns (address)", [], args[0], "metadataAdmin")];
  if (functionName === "setClassPrice") {
    const base = getter("classBase", 1); const perK = getter("classPerK", 1);
    return base && perK ? [view(address, sig(base), [args[0]], args[1], `classBase(${String(args[0])})`), view(address, sig(perK), [args[0]], args[2], `classPerK(${String(args[0])})`)] : [];
  }
  if (functionName === "setProtocolFee") {
    const bps = getter("protocolFeeBps", 0); const min = getter("minProtocolFee", 0);
    return bps && min ? [view(address, sig(bps), [], args[0], "protocolFeeBps"), view(address, sig(min), [], args[1], "minProtocolFee")] : [];
  }
  if (functionName === "setToken") {
    const tokenOf = getter("tokenOf", 1);
    return tokenOf ? [view(address, sig(tokenOf), [args[0]], args[1], `tokenOf(${String(args[0])})`)] : [];
  }
  const setter = /^set([A-Z]\w*)$/.exec(functionName);
  if (setter && args.length === 1) {
    const name = setter[1]!.charAt(0).toLowerCase() + setter[1]!.slice(1);
    const g = getter(name, 0);
    if (g) return [view(address, sig(g), [], args[0], name)];
  }
  return [];
}

/** Failed postconditions, each as a sentence; reads are pinned to `block` when given. */
export async function failedChecks(reader: ChainReader, checks: readonly StepCheck[] | undefined, block: BlockTag = "latest"): Promise<string[]> {
  const failures: string[] = [];
  for (const check of checks ?? []) {
    if (check.kind === "code") {
      const code = await reader.code(check.address, block);
      if (!code || code === "0x") failures.push(`no contract code at ${check.address}`);
    } else {
      const actual = await reader.view(check, block);
      if (actual !== check.expect) failures.push(`${check.label} on ${check.address} is ${actual}, expected ${check.expect}`);
    }
  }
  return failures;
}

// ───────────────────────────── broadcast and receipt ─────────────────────────────

export type SignedTx = { raw: Hex; hash: Hex; nonce: number; from: Address };
export type SendOptions = {
  log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number;
  /** Broadcast attempts before falling back to polling (which keeps re-broadcasting). */
  broadcastAttempts?: number;
  receiptTimeoutMs?: number; pollMs?: number; rebroadcastEveryMs?: number;
  /** How long a consumed nonce without our transaction is tolerated (load-balanced nodes lag) before it is a contradiction. */
  nonceGraceMs?: number;
};
export class SendRejected extends Error { constructor(message: string) { super(message); this.name = "SendRejected"; } }
export class NonceConsumed extends Error { constructor(message: string) { super(message); this.name = "NonceConsumed"; } }
export class ReceiptTimeout extends Error { constructor(message: string) { super(message); this.name = "ReceiptTimeout"; } }

/** Short reason for logs; never includes URLs or request bodies. */
export function shortReason(error: unknown): string {
  const e = error as { name?: string; details?: string; shortMessage?: string; message?: string };
  const text = (e?.details || e?.shortMessage || e?.message || String(error)).split("\n")[0]!;
  return `${e?.name && e.name !== "Error" ? `${e.name}: ` : ""}${text}`.replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 200);
}

/**
 * Broadcasts a recorded signed transaction. Transient failures re-broadcast the SAME raw transaction; "already known"
 * means the node has it. Returns "accepted", "nonce-used" (the node says the nonce is spent: mined, or a contradiction
 * that waitForReceipt resolves) or "unknown" (every attempt failed in transit). Throws SendRejected when the node refuses
 * the transaction itself (for example insufficient funds); the recorded transaction is unchanged and can be re-sent.
 */
export async function broadcastSigned(rpc: RawRpc, tx: SignedTx, opts: SendOptions = {}): Promise<"accepted" | "nonce-used" | "unknown"> {
  const attempts = opts.broadcastAttempts ?? 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const returned = await rpc.request("eth_sendRawTransaction", [tx.raw]);
      if (typeof returned === "string" && returned.toLowerCase() !== tx.hash.toLowerCase()) throw new SendRejected(`node returned hash ${returned} for recorded transaction ${tx.hash}`);
      return "accepted";
    } catch (error) {
      if (error instanceof SendRejected) throw error;
      const kind = classifySendError(error);
      if (kind === "known") return "accepted";
      if (kind === "nonce-used") return "nonce-used";
      if (kind === "rejected") throw new SendRejected(`the node rejected transaction ${tx.hash} (nonce ${tx.nonce}): ${shortReason(error)}`);
      opts.log?.(`    broadcast attempt ${attempt}/${attempts} of ${tx.hash} failed (${shortReason(error)}); re-broadcasting the same signed transaction`);
      if (attempt < attempts) await (opts.sleep ?? sleep)(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
    }
  }
  return "unknown";
}

/**
 * Polls for the receipt of a recorded transaction, re-broadcasting the same raw transaction periodically (a dropped or
 * never-delivered broadcast is recovered without a new nonce). Fails with NonceConsumed when the deployer's nonce moved
 * past ours and our transaction stays unknown beyond the grace period, and with ReceiptTimeout after the timeout.
 */
export async function waitForReceipt(rpc: RawRpc, tx: SignedTx, opts: SendOptions = {}): Promise<ParsedReceipt> {
  const now = opts.now ?? Date.now; const pause = opts.sleep ?? sleep;
  const timeoutMs = opts.receiptTimeoutMs ?? 900_000; const rebroadcastEveryMs = opts.rebroadcastEveryMs ?? 30_000; const graceMs = opts.nonceGraceMs ?? 90_000;
  const started = now();
  let lastBroadcast = started; let consumedSince: number | undefined; let poll = opts.pollMs ?? 100; let polls = 0; let lastNote = started;
  for (;;) {
    let receipt: ParsedReceipt | null = null;
    try { receipt = parseReceipt(await rpc.request("eth_getTransactionReceipt", [tx.hash])); } catch (error) { if (!isTransientError(error)) throw error; }
    if (receipt) return receipt;
    polls++;
    const elapsed = now() - started;
    if (polls % 5 === 0) {
      try {
        const latest = Number(big(await rpc.request("eth_getTransactionCount", [tx.from, "latest"])));
        if (latest > tx.nonce) {
          const known = parseTx(await rpc.request("eth_getTransactionByHash", [tx.hash]));
          if (known) consumedSince = undefined;
          else {
            consumedSince ??= now();
            if (now() - consumedSince >= graceMs) throw new NonceConsumed(`nonce ${tx.nonce} of ${tx.from} was used by a transaction other than the recorded ${tx.hash}; stop and inspect the deployer's transactions`);
          }
        } else consumedSince = undefined;
      } catch (error) { if (error instanceof NonceConsumed || !isTransientError(error)) throw error; }
    }
    if (elapsed >= timeoutMs) throw new ReceiptTimeout(`transaction ${tx.hash} (nonce ${tx.nonce}) has no receipt after ${Math.round(timeoutMs / 1000)}s; it stays recorded in the journal: rerun with --resume to keep waiting for this same transaction`);
    if (now() - lastBroadcast >= rebroadcastEveryMs) {
      lastBroadcast = now();
      try { await rpc.request("eth_sendRawTransaction", [tx.raw]); }
      catch (error) {
        const kind = classifySendError(error);
        if (kind === "rejected") opts.log?.(`    re-broadcast of ${tx.hash} was refused (${shortReason(error)}); still waiting for its receipt`);
      }
    }
    if (now() - lastNote >= 60_000) { lastNote = now(); opts.log?.(`    still waiting for ${tx.hash} (${Math.round(elapsed / 1000)}s)`); }
    await pause(poll);
    poll = Math.min(opts.pollMs ? opts.pollMs * 8 : 2_000, Math.round(poll * 1.6));
  }
}

// ───────────────────────────── resume verification ─────────────────────────────

export type Verification = { problems: string[]; warnings: string[]; lastBlock: bigint; changed: boolean; pending?: JournalStep };

/**
 * Checks every recorded step against the chain before anything is sent: each transaction exists with the recorded
 * sender, nonce, target and calldata and the recorded outcome; deployed addresses match and hold code; role and
 * parameter postconditions hold; and the deployer's nonce is exactly what the journal accounts for (no transaction
 * outside the journal, nothing lost). A recorded but unfinished last step that has since been mined is completed here
 * (`changed`). Postcondition differences on a complete journal are warnings (governance may have acted since).
 */
export async function verifyJournalOnChain(j: Journal, reader: ChainReader, opts: { sleep?: (ms: number) => Promise<void>; lagRetries?: number } = {}): Promise<Verification> {
  const problems: string[] = []; const warnings: string[] = [];
  const pause = opts.sleep ?? sleep; let lagRetries = opts.lagRetries ?? 4;
  let lastBlock = BigInt(j.startBlock); let changed = false; let pending: JournalStep | undefined;
  /** A transaction the journal says is mined; a lagging node gets a few chances, once. */
  const mined = async (hash: Hex) => {
    for (let i = 0; ; i++) {
      const receipt = await reader.receipt(hash);
      if (receipt || i >= lagRetries) { if (!receipt) lagRetries = 0; return receipt; }
      await pause(500 * 2 ** i);
    }
  };
  for (const [i, step] of j.steps.entries()) {
    if (problems.length >= 12) break;
    const label = `step ${i + 1} (${step.id})`;
    for (const attempt of step.attempts ?? []) {
      const receipt = await mined(attempt.hash);
      if (!receipt) problems.push(`${label}: reverted attempt ${attempt.hash} is not on chain`);
      else if (receipt.status !== "reverted") problems.push(`${label}: attempt ${attempt.hash} is recorded as reverted but succeeded on chain`);
      else if (receipt.blockNumber > lastBlock) lastBlock = receipt.blockNumber;
    }
    if (step.status === "skipped") continue;
    const receipt = isPending(step) ? await reader.receipt(step.hash!) : await mined(step.hash!);
    if (!receipt) {
      if (isPending(step)) { pending = step; continue; }
      problems.push(`${label}: transaction ${step.hash} is recorded as ${step.status} but the chain has no receipt for it (a different, reset or reorganised chain, or a lagging RPC)`);
      continue;
    }
    const tx = await reader.tx(step.hash!);
    if (!tx) { problems.push(`${label}: transaction ${step.hash} has a receipt but no transaction record`); continue; }
    if (lower(tx.from) !== lower(j.deployer)) problems.push(`${label}: transaction ${step.hash} was sent by ${tx.from}, not the deployer`);
    if (tx.nonce !== step.nonce) problems.push(`${label}: transaction ${step.hash} has nonce ${tx.nonce}, the journal records ${String(step.nonce)}`);
    if (lower(tx.to) !== lower(step.to ?? null)) problems.push(`${label}: transaction ${step.hash} targets ${tx.to ?? "a contract creation"}, the journal records ${step.to ?? "a contract creation"}`);
    if (keccak256(tx.input) !== step.dataHash) problems.push(`${label}: transaction ${step.hash} carries different calldata than the journal records`);
    if (receipt.blockNumber > lastBlock) lastBlock = receipt.blockNumber;
    if (step.status === "reverted") { if (receipt.status !== "reverted") problems.push(`${label}: transaction ${step.hash} is recorded as reverted but succeeded`); continue; }
    if (receipt.status !== "success") {
      if (isPending(step)) { Object.assign(step, { status: "reverted", block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }); delete step.raw; changed = true; continue; }
      problems.push(`${label}: transaction ${step.hash} reverted on chain but the journal records it as confirmed`);
      continue;
    }
    if (step.kind === "deploy") {
      if (!receipt.contractAddress) problems.push(`${label}: transaction ${step.hash} created no contract`);
      else if (step.status === "confirmed" && lower(step.address) !== lower(receipt.contractAddress)) problems.push(`${label}: the journal records ${step.address}, the transaction created ${receipt.contractAddress}`);
    }
    if (isPending(step)) {
      // Mined after the earlier run stopped watching: record it now.
      Object.assign(step, { status: "confirmed", block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), confirmedAt: new Date().toISOString() });
      if (step.kind === "deploy" && receipt.contractAddress) { step.address = receipt.contractAddress; step.checks = [{ kind: "code", address: receipt.contractAddress }, ...(step.checks ?? [])]; }
      delete step.raw; changed = true;
    }
  }
  if (problems.length) return { problems, warnings, lastBlock, changed, pending };
  for (const step of j.steps) {
    if (step.status !== "confirmed" && step.status !== "skipped") continue;
    const checks = [...(step.kind === "deploy" && step.address && !step.checks?.some((c) => c.kind === "code") ? [{ kind: "code", address: step.address } as StepCheck] : []), ...(step.checks ?? [])];
    for (const failure of await failedChecks(reader, checks, lastBlock)) (j.status === "complete" ? warnings : problems).push(`step ${step.id}: ${failure}`);
  }
  // Nonce accounting: the chain must show exactly the journal's transactions from the deployer since the start.
  const expected = j.startNonce + noncesUsed(j, false);
  let latest = await reader.nonce(j.deployer, "latest");
  for (let i = 0; latest < expected && i < (opts.lagRetries ?? 4); i++) { await pause(500 * 2 ** i); latest = await reader.nonce(j.deployer, "latest"); }
  if (pending && latest > expected) {
    for (let i = 0; i < (opts.lagRetries ?? 4); i++) {
      if (await reader.receipt(pending.hash!)) return { problems: [`step ${pending.id}: its transaction ${pending.hash} was just mined; rerun --resume to record it`], warnings, lastBlock, changed, pending };
      await pause(500 * 2 ** i);
    }
    problems.push(`step ${pending.id}: nonce ${pending.nonce} of the deployer was used by a transaction other than the recorded ${pending.hash}; refusing to resume (inspect the deployer's transactions)`);
  } else if (latest > expected) {
    problems.push(`the deployer's nonce on chain is ${latest} but the journal accounts for ${expected}: ${latest - expected} transaction(s) were sent from the deployer outside this journal, or the journal lost entries; refusing to resume`);
  } else if (latest < expected) {
    problems.push(`the RPC reports deployer nonce ${latest}, below the ${expected} that the journal's mined transactions imply (lagging RPC or a different chain); retry later`);
  }
  const pendingNonce = await reader.nonce(j.deployer, "pending");
  const allowed = expected + (pending ? 1 : 0);
  if (!problems.length && pendingNonce > allowed) problems.push(`the deployer has ${pendingNonce - allowed} unknown pending transaction(s) in the mempool; wait for them and inspect them first`);
  return { problems, warnings, lastBlock, changed, pending };
}

// ───────────────────────────── journaled step runner ─────────────────────────────

export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };
export type UnsignedTx = { chainId: number; nonce: number; to: Address | null; data: Hex; gas: bigint; fees: Fees };
export type RunnerDeps = {
  journal: Journal; plan: readonly PlannedStep[]; persist(): void;
  chainId: number; from: Address; sign(tx: UnsignedTx): Promise<Hex>;
  rpc: RawRpc; reader: ChainReader; lastBlock: bigint; nextNonce: number;
  retryReverted?: boolean; faults?: Map<string, Set<FaultPoint>>; receiptTimeoutMs?: number;
  log(line: string): void; sleep?: (ms: number) => Promise<void>;
  /** Gas limit = estimate × gasBufferPct / 100 (default 150): unused gas is not charged. */
  gasBufferPct?: bigint;
  /** maxFeePerGas = baseFee × feeCapMultiplier + tip (default 3): headroom so a signed transaction stays valid if the base fee rises. */
  feeCapMultiplier?: bigint;
};
export type StepOptions = { checks?: StepCheck[]; skipIf?: () => Promise<string | undefined>; runtimeLimit?: boolean };
export type StepResult = { step: JournalStep; replayed: boolean; runtimeBytes?: number };

/** Sends the plan's steps in order, one transaction per step, recording each in the journal before it is broadcast. */
export class StepRunner {
  private pos = 0;
  lastBlock: bigint;
  private nextNonce: number;
  constructor(private readonly d: RunnerDeps) { this.lastBlock = d.lastBlock; this.nextNonce = d.nextNonce; }

  get position(): number { return this.pos; }

  private fault(point: FaultPoint, id: string) {
    if (this.d.faults?.get(id)?.has(point)) {
      this.d.log(`TEST FAULT ${point}:${id}: killing this process`);
      process.kill(process.pid, "SIGKILL");
    }
  }

  async run(id: string, kind: StepKind, tx: { to: Address | null; data: Hex }, opts: StepOptions = {}): Promise<StepResult> {
    const index = this.pos;
    const planned = this.d.plan[index];
    if (!planned || planned.id !== id || planned.kind !== kind) throw new Error(`internal error: step ${index + 1} is ${id} but the plan has ${planned?.id ?? "(end)"} there`);
    const dataHash = keccak256(tx.data);
    let rec = this.d.journal.steps[index];
    if (rec) {
      if (rec.id !== id) throw new Error(`journal step ${index + 1} is ${rec.id}, the plan has ${id}`);
      if (rec.status === "skipped") { this.pos++; return { step: rec, replayed: true }; }
      if (lower(rec.to ?? null) !== lower(tx.to) || rec.dataHash !== dataHash) {
        throw new Error(`refusing to continue: journal step ${id} was signed for ${rec.to ?? "a contract creation"} with calldata ${rec.dataHash}, the same step now targets ${tx.to ?? "a contract creation"} with calldata ${dataHash} (configuration or contract artifacts changed since it was recorded)`);
      }
      if (rec.status === "confirmed") { this.pos++; return { step: rec, replayed: true }; }
      if (rec.status === "reverted") {
        if (!this.d.retryReverted) throw new Error(`step ${id}: transaction ${rec.hash} (nonce ${rec.nonce}) reverted on chain; inspect it, then --resume --retry-reverted sends this one step again with the next nonce (a reverted transaction changed nothing)`);
        (rec.attempts ??= []).push({ hash: rec.hash!, nonce: rec.nonce!, ...(rec.block ? { block: rec.block } : {}) });
        this.d.log(`  step ${id}: transaction ${rec.hash} reverted; sending it again with a new nonce (--retry-reverted)`);
      } else {
        const runtimeBytes = await this.finish(index, rec, opts);
        this.pos++;
        return { step: rec, replayed: false, runtimeBytes };
      }
    } else if (opts.skipIf) {
      const reason = await opts.skipIf();
      if (reason) {
        rec = { id, kind, status: "skipped", reason, checks: opts.checks ?? [] };
        this.d.journal.steps.push(rec); this.d.persist();
        this.d.log(`  [${index + 1}/${this.d.plan.length}] ${id}: skipped (${reason})`);
        this.pos++;
        return { step: rec, replayed: false };
      }
    }
    rec = await this.sign(index, id, kind, tx, dataHash, opts.checks ?? [], rec);
    const runtimeBytes = await this.finish(index, rec, opts);
    this.pos++;
    return { step: rec, replayed: false, runtimeBytes };
  }

  private async fees(): Promise<Fees> {
    const block = await withRetries(() => this.d.rpc.request("eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas?: Hex } | null;
    const multiplier = this.d.feeCapMultiplier ?? 3n;
    if (block?.baseFeePerGas) {
      let tip = 0n;
      try { tip = big(await withRetries(() => this.d.rpc.request("eth_maxPriorityFeePerGas", []))); } catch { tip = 0n; }
      return { maxFeePerGas: big(block.baseFeePerGas) * multiplier + tip, maxPriorityFeePerGas: tip };
    }
    return { gasPrice: big(await withRetries(() => this.d.rpc.request("eth_gasPrice", []))) * multiplier };
  }

  /** The chain's pending nonce must match the journal's next nonce: higher means someone else used the deployer key. */
  private async checkNonce(nonce: number) {
    for (let i = 0; ; i++) {
      const pending = await this.d.reader.nonce(this.d.from, "pending");
      if (pending === nonce) return;
      if (pending > nonce) throw new Error(`the deployer's pending nonce is ${pending}, but the next journal step uses nonce ${nonce}: a transaction outside this deployment was sent from the deployer key; stop and inspect`);
      if (i >= 4) { this.d.log(`    note: the RPC reports pending nonce ${pending} below ${nonce} (lagging node); using the journal's nonce ${nonce}`); return; }
      await (this.d.sleep ?? sleep)(500 * 2 ** i);
    }
  }

  private async sign(index: number, id: string, kind: StepKind, tx: { to: Address | null; data: Hex }, dataHash: Hex, checks: StepCheck[], existing?: JournalStep): Promise<JournalStep> {
    const nonce = this.nextNonce;
    await this.checkNonce(nonce);
    // Estimated on the state of our last receipt's block (or later): a lagging node answers "unknown block" and is retried
    // instead of estimating against state that lacks our earlier steps.
    const estimate = big(await withRetries(() => this.d.rpc.request("eth_estimateGas", [{ from: this.d.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data }, toHex(this.lastBlock)]), { attempts: 8 }));
    const gas = (estimate * (this.d.gasBufferPct ?? 150n)) / 100n;
    const fees = await this.fees();
    const raw = await this.d.sign({ chainId: this.d.chainId, nonce, to: tx.to, data: tx.data, gas, fees });
    const hash = keccak256(raw);
    const fields: JournalStep = {
      id, kind, status: "signed", nonce, hash, raw, to: tx.to, dataHash, gasLimit: gas.toString(),
      ...("gasPrice" in fees ? { gasPrice: fees.gasPrice.toString() } : { maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }),
      checks, signedAt: new Date().toISOString(),
    };
    let rec: JournalStep;
    if (existing) {
      // --retry-reverted: same journal entry, the reverted attempt stays in its history.
      for (const key of Object.keys(existing) as (keyof JournalStep)[]) if (key !== "attempts" && key !== "id" && key !== "kind") delete existing[key];
      rec = Object.assign(existing, fields);
    } else {
      rec = fields;
      this.d.journal.steps.push(rec);
    }
    this.d.persist();
    this.nextNonce = nonce + 1;
    this.d.log(`  [${index + 1}/${this.d.plan.length}] ${id}: nonce ${nonce}, tx ${hash} (signed and recorded)`);
    this.fault("before-broadcast", id);
    return rec;
  }

  private async finish(index: number, rec: JournalStep, opts: StepOptions): Promise<number | undefined> {
    const signed: SignedTx = { raw: rec.raw!, hash: rec.hash!, nonce: rec.nonce!, from: this.d.from };
    const sendOpts: SendOptions = { log: this.d.log, ...(this.d.sleep ? { sleep: this.d.sleep } : {}), receiptTimeoutMs: this.d.receiptTimeoutMs ?? 1_800_000 };
    if (rec.status === "signed") {
      const outcome = await broadcastSigned(this.d.rpc, signed, sendOpts);
      rec.status = "broadcast"; rec.broadcastAt = new Date().toISOString(); this.d.persist();
      if (outcome === "unknown") this.d.log(`    broadcast of ${signed.hash} did not get an answer; waiting for its receipt and re-broadcasting the same transaction`);
      this.fault("after-broadcast", rec.id);
    } else {
      // Recorded as broadcast by an earlier run and not mined yet: offer the same signed transaction again.
      this.d.log(`  [${index + 1}/${this.d.plan.length}] ${rec.id}: re-broadcasting the recorded transaction ${signed.hash} (nonce ${signed.nonce})`);
      try { await broadcastSigned(this.d.rpc, signed, { ...sendOpts, broadcastAttempts: 2 }); }
      catch (error) { if (!(error instanceof SendRejected)) throw error; this.d.log(`    ${error.message}; still waiting for its receipt`); }
    }
    const receipt = await waitForReceipt(this.d.rpc, signed, sendOpts);
    if (receipt.status !== "success") {
      Object.assign(rec, { status: "reverted", block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }); delete rec.raw; this.d.persist();
      throw new Error(`step ${rec.id}: transaction ${rec.hash} (nonce ${rec.nonce}) reverted in block ${receipt.blockNumber}; nothing else was sent. Inspect it; --resume --retry-reverted sends this one step again`);
    }
    if (rec.kind === "deploy") {
      if (!receipt.contractAddress) throw new Error(`step ${rec.id}: transaction ${rec.hash} created no contract`);
      rec.address = receipt.contractAddress;
      rec.checks = [{ kind: "code", address: receipt.contractAddress }, ...(rec.checks ?? []).filter((c) => c.kind !== "code")];
    }
    const failures = await failedChecks(this.d.reader, rec.checks, receipt.blockNumber);
    Object.assign(rec, { status: "confirmed", block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), confirmedAt: new Date().toISOString() });
    delete rec.raw;
    this.d.persist();
    if (receipt.blockNumber > this.lastBlock) this.lastBlock = receipt.blockNumber;
    this.d.log(`  [${index + 1}/${this.d.plan.length}] ${rec.id}: mined in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
    if (failures.length) throw new Error(`step ${rec.id} was mined (tx ${rec.hash}) but its postcondition failed: ${failures.join("; ")}; stop and inspect`);
    let runtimeBytes: number | undefined;
    if (opts.runtimeLimit && rec.address) {
      const code = await this.d.reader.code(rec.address, receipt.blockNumber);
      runtimeBytes = (code.length - 2) / 2;
      if (runtimeBytes >= 24_576) throw new Error(`${rec.id} runtime is ${runtimeBytes} bytes (EIP-170 limit 24576)`);
    }
    this.fault("after-confirm", rec.id);
    return runtimeBytes;
  }
}

// ───────────────────────────── gas pre-flight ─────────────────────────────

export type GasTable = { note?: string; steps: Record<string, number>; defaults: { deploy: number; call: number } };

/**
 * Gas for the steps not yet done, from the recorded table (unknown ids use the per-kind default). On a resume the
 * confirmed steps calibrate the table to this chain (actual/recorded, never below 1).
 */
export function remainingGas(plan: readonly PlannedStep[], journal: Journal | undefined, table: GasTable): { steps: number; deploys: number; gas: bigint; factor: number; unknown: string[] } {
  const done = new Set((journal?.steps ?? []).filter((s) => s.status === "confirmed" || s.status === "skipped").map((s) => s.id));
  const unknown: string[] = [];
  const recorded = (s: PlannedStep) => {
    const v = table.steps[s.id];
    if (v === undefined) { unknown.push(s.id); return s.kind === "deploy" ? table.defaults.deploy : table.defaults.call; }
    return v;
  };
  let gas = 0n; let steps = 0; let deploys = 0;
  for (const s of plan) if (!done.has(s.id)) { gas += BigInt(recorded(s)); steps++; if (s.kind === "deploy") deploys++; }
  let actual = 0n; let expected = 0n;
  for (const s of journal?.steps ?? []) if (s.status === "confirmed" && s.gasUsed && table.steps[s.id] !== undefined) { actual += BigInt(s.gasUsed); expected += BigInt(table.steps[s.id]!); }
  const factor = expected > 0n && actual > expected ? Number((actual * 1000n) / expected) / 1000 : 1;
  return { steps, deploys, gas: (gas * BigInt(Math.round(factor * 1000))) / 1000n, factor, unknown };
}

// ───────────────────────────── test-only fault injection ─────────────────────────────

export type FaultPoint = "before-broadcast" | "after-broadcast" | "after-confirm";
export const FAULT_ENV = "MOCHI_DEPLOY_TEST_FAULT";

/** `<point>:<step id>[,<point>:<step id>…]`; the process kills itself (SIGKILL) at that point. Tests only. */
export function parseFaults(value: string | undefined): Map<string, Set<FaultPoint>> {
  const faults = new Map<string, Set<FaultPoint>>();
  for (const item of (value ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const at = item.indexOf(":");
    const point = item.slice(0, at) as FaultPoint; const id = item.slice(at + 1);
    if (at < 1 || !id || !["before-broadcast", "after-broadcast", "after-confirm"].includes(point)) throw new Error(`${FAULT_ENV}: invalid entry ${item}`);
    if (!faults.has(id)) faults.set(id, new Set());
    faults.get(id)!.add(point);
  }
  return faults;
}

/** Fault injection is refused anywhere but a loopback RPC on a chain other than mainnet. */
export function assertFaultsAllowed(faults: Map<string, Set<FaultPoint>>, rpcUrl: string, chainId: number): void {
  if (!faults.size) return;
  let host = "";
  try { host = new URL(rpcUrl).hostname; } catch { /* not a URL */ }
  if (chainId === 4663 || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error(`${FAULT_ENV} is a test hook: refused outside a loopback test chain`);
}

export function existsJournal(out: string): boolean { return existsSync(journalPathFor(out)); }
