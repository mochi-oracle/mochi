import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRequestError, TimeoutError, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import * as A from "@mochi/chain";
import {
  JOURNAL_KIND, JOURNAL_VERSION, NonceConsumed, ReceiptTimeout, SendRejected, StepRunner, acquireLock, assertFaultsAllowed, assertUniqueStepIds, broadcastSigned, chainReader, checksFor,
  classifySendError, configHash, isTransientError, journalProblems, noncesUsed, parseFaults, placeholderAddress, planHash, remainingGas, waitForReceipt,
  withRetries, writePrivateFileAtomic, type Journal, type JournalStep, type PlannedStep, type RawRpc,
} from "./deploy-journal.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const h = (n: number) => keccak256(toHex(`tx-${n}`));
const DEPLOYER = a(0xd0);

const PLAN: PlannedStep[] = [
  { id: "deploy.A", kind: "deploy", label: "A", to: null, dataHash: h(1) },
  { id: "wire.a.setX", kind: "call", label: "setX", to: placeholderAddress("deploy.A"), dataHash: h(2) },
  { id: "handover.a.renounceRole.GOVERNOR_ROLE.deployer", kind: "renounce-if-held", label: "renounceRole", to: placeholderAddress("deploy.A"), dataHash: h(3) },
  { id: "handover.a.transfer", kind: "call", label: "transfer", to: a(0x77), dataHash: h(4) },
];
const confirmed = (id: string, kind: JournalStep["kind"], nonce: number, extra: Partial<JournalStep> = {}): JournalStep =>
  ({ id, kind, status: "confirmed", nonce, hash: h(100 + nonce), to: kind === "deploy" ? null : a(0xaa), dataHash: h(200 + nonce), ...(kind === "deploy" ? { address: a(0xaa) } : {}), ...extra });
const journal = (steps: JournalStep[], extra: Partial<Journal> = {}): Journal => ({
  kind: JOURNAL_KIND, version: JOURNAL_VERSION, chainId: 46630, deployer: DEPLOYER, mode: "mainnet rehearsal", configHash: h(9), config: {},
  planHash: planHash(PLAN), plan: PLAN.map((s) => ({ id: s.id, kind: s.kind, label: s.label })), startNonce: 5, startBlock: "10", status: "in-progress",
  createdAt: "t", updatedAt: "t", steps, ...extra,
});
const EXPECT = { chainId: 46630, deployer: DEPLOYER, configHash: h(9), planHash: planHash(PLAN) };

test("plan identity: placeholders and hashes are stable; ids are unique and explicit", () => {
  expect(placeholderAddress("deploy.A")).toBe(placeholderAddress("deploy.A"));
  expect(placeholderAddress("deploy.A")).not.toBe(placeholderAddress("deploy.B"));
  expect(planHash(PLAN)).toBe(planHash(structuredClone(PLAN)));
  expect(planHash([PLAN[1]!, PLAN[0]!, ...PLAN.slice(2)])).not.toBe(planHash(PLAN));
  expect(planHash([{ ...PLAN[0]!, dataHash: h(99) }, ...PLAN.slice(1)])).not.toBe(planHash(PLAN));
  expect(configHash({ b: 1, a: 2n })).toBe(configHash({ a: 2n, b: 1 }));
  expect(() => assertUniqueStepIds([...PLAN, PLAN[0]!])).toThrow("duplicate step id deploy.A");
  expect(() => assertUniqueStepIds([{ ...PLAN[0]!, id: "has space" }])).toThrow("invalid step id");
  expect(() => assertUniqueStepIds([{ ...PLAN[0]!, id: "feeds.register.earnings@RHC" }])).not.toThrow();
});

test("journal rules: a consistent prefix passes; every inconsistency is named", () => {
  const good = journal([confirmed("deploy.A", "deploy", 5), confirmed("wire.a.setX", "call", 6), { id: PLAN[2]!.id, kind: "renounce-if-held", status: "skipped", reason: "not held" }]);
  expect(journalProblems(good, PLAN, EXPECT)).toEqual([]);
  expect(noncesUsed(good)).toBe(2);
  const pendingRaw = "0x02f86a" as Hex;
  const withPending = journal([confirmed("deploy.A", "deploy", 5), { id: "wire.a.setX", kind: "call", status: "broadcast", nonce: 6, hash: keccak256(pendingRaw), raw: pendingRaw, to: a(1), dataHash: h(1) }]);
  expect(journalProblems(withPending, PLAN, EXPECT)).toEqual([]);
  expect(noncesUsed(withPending)).toBe(2);
  expect(noncesUsed(withPending, false)).toBe(1);

  const problems = (j: Journal, expectOverride: Partial<typeof EXPECT> = {}) => journalProblems(j, PLAN, { ...EXPECT, ...expectOverride }).join("\n");
  expect(problems(good, { chainId: 4663 })).toContain("journal is for chain 46630");
  expect(problems(good, { deployer: a(1) })).toContain("is not the --key-file deployer");
  expect(problems(good, { configHash: h(8) })).toContain("deployment configuration differs");
  const swapped = [PLAN[0]!, PLAN[2]!, PLAN[1]!, PLAN[3]!];
  expect(journalProblems(good, swapped, { ...EXPECT, planHash: planHash(swapped) }).join("\n")).toContain("the step plan changed since the journal was written (first difference at step 2: journal wire.a.setX, now handover.a.renounceRole");
  const rebuilt = [{ ...PLAN[0]!, dataHash: h(77) }, ...PLAN.slice(1)];
  expect(journalProblems(good, rebuilt, { ...EXPECT, planHash: planHash(rebuilt) }).join("\n")).toContain("different calldata or contract bytecode");
  expect(problems(journal([confirmed("wire.a.setX", "call", 5)]))).toContain("out of order");
  expect(problems(journal([{ ...confirmed("deploy.A", "deploy", 5), status: "broadcast", raw: "0x01" }, confirmed("wire.a.setX", "call", 6)]))).toContain("a later step happened without this one");
  expect(problems(journal([confirmed("deploy.A", "deploy", 5), confirmed("wire.a.setX", "call", 7)]))).toContain("uses nonce 7, expected 6");
  expect(problems(journal([confirmed("deploy.A", "deploy", 5), confirmed("wire.a.setX", "call", 6, { hash: h(105) })]))).toContain("repeats transaction");
  expect(problems(journal([{ ...confirmed("deploy.A", "deploy", 5), status: "signed", raw: "0x02f8" }]))).toContain("does not hash to the recorded");
  expect(problems(journal([confirmed("deploy.A", "deploy", 5), { ...confirmed("wire.a.setX", "call", 6), status: "skipped" }]))).toContain("only conditional renounce steps can be skipped");
  expect(problems(journal([confirmed("deploy.A", "deploy", 5)], { status: "complete" }))).toContain("journal says complete");
  // A reverted attempt kept in history used its own nonce.
  const retried = journal([confirmed("deploy.A", "deploy", 6, { attempts: [{ hash: h(1), nonce: 5 }] })]);
  expect(journalProblems(retried, PLAN, EXPECT)).toEqual([]);
  expect(noncesUsed(retried)).toBe(2);
});

test("send errors: already-known and nonce-used are told apart from rejections and transient failures", () => {
  for (const message of ["already known", "transaction already imported", "AlreadyKnown", "known transaction: 0xabc"]) expect(classifySendError(new Error(message))).toBe("known");
  for (const message of ["nonce too low", "nonce too low: address 0x.., tx: 5 state: 6", "replacement transaction underpriced"]) expect(classifySendError(new Error(message))).toBe("nonce-used");
  for (const message of ["Insufficient funds for gas * price + value", "intrinsic gas too low", "max fee per gas less than block base fee", "invalid chain id"]) expect(classifySendError(new Error(message))).toBe("rejected");
  const timeout = new TimeoutError({ body: { method: "eth_sendRawTransaction" }, url: "http://127.0.0.1:1" });
  expect(classifySendError(timeout)).toBe("transient");
  expect(classifySendError(new HttpRequestError({ url: "http://127.0.0.1:1", status: 502 }))).toBe("transient");
  expect(classifySendError(new Error("something nobody has seen before"))).toBe("transient");
  expect(isTransientError(timeout)).toBe(true);
  expect(isTransientError(new Error("BlockOutOfRangeError: block height is 3 but requested was 8"))).toBe(true);
  for (const lag of ["header not found", "block not found", "requested block number 12 is greater than current head block number 11", "unknown block"]) expect(isTransientError(new Error(lag))).toBe(true);
  expect(isTransientError(new Error("execution reverted: AccessControlUnauthorizedAccount"))).toBe(false);
});

test("reads retry only transient errors, a bounded number of times", async () => {
  let calls = 0;
  const flaky = () => { calls++; if (calls < 3) throw new Error("fetch failed"); return Promise.resolve("ok"); };
  expect(await withRetries(flaky, { sleep: async () => {} })).toBe("ok");
  expect(calls).toBe(3);
  calls = 0;
  await expect(withRetries(async () => { calls++; throw new Error("execution reverted"); }, { sleep: async () => {} })).rejects.toThrow("execution reverted");
  expect(calls).toBe(1);
  calls = 0;
  await expect(withRetries(async () => { calls++; throw new Error("timeout"); }, { attempts: 4, sleep: async () => {} })).rejects.toThrow("timeout");
  expect(calls).toBe(4);
});

type Call = { method: string; params: unknown[] };
function fakeRpc(handler: (call: Call, index: number) => unknown): RawRpc & { calls: Call[] } {
  const calls: Call[] = [];
  return { calls, async request(method, params) { const call = { method, params }; calls.push(call); const r = handler(call, calls.length - 1); return r instanceof Error ? Promise.reject(r) : r; } };
}
const RAW = "0x02f8b1820b6a05" as Hex;
const TX = { raw: RAW, hash: keccak256(RAW), nonce: 7, from: DEPLOYER };
const receipt = { status: "0x1", blockNumber: "0x10", contractAddress: null, gasUsed: "0x5208", effectiveGasPrice: "0x1", from: DEPLOYER, to: a(1), transactionHash: TX.hash };

test("a broadcast that times out is retried with the same signed transaction, never a new one", async () => {
  const rpc = fakeRpc(({ method }, i) => method === "eth_sendRawTransaction" && i === 0 ? new TimeoutError({ body: {}, url: "http://127.0.0.1:1" }) : TX.hash);
  expect(await broadcastSigned(rpc, TX, { sleep: async () => {} })).toBe("accepted");
  expect(rpc.calls.map((c) => c.method)).toEqual(["eth_sendRawTransaction", "eth_sendRawTransaction"]);
  expect(rpc.calls.every((c) => c.params[0] === RAW)).toBe(true);

  expect(await broadcastSigned(fakeRpc(() => new Error("already known")), TX)).toBe("accepted");
  expect(await broadcastSigned(fakeRpc(() => new Error("nonce too low")), TX)).toBe("nonce-used");
  await expect(broadcastSigned(fakeRpc(() => new Error("insufficient funds for gas * price + value")), TX)).rejects.toBeInstanceOf(SendRejected);
  await expect(broadcastSigned(fakeRpc(() => keccak256("0x01")), TX)).rejects.toThrow("node returned hash");
  const silent = fakeRpc(() => new TimeoutError({ body: {}, url: "http://127.0.0.1:1" }));
  expect(await broadcastSigned(silent, TX, { sleep: async () => {}, broadcastAttempts: 3 })).toBe("unknown");
  expect(silent.calls.length).toBe(3);
  expect(new Set(silent.calls.map((c) => c.params[0])).size).toBe(1);
});

function clock() { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; }

test("waiting for a receipt re-broadcasts the same raw transaction until it is mined", async () => {
  const c = clock();
  let polls = 0;
  const rpc = fakeRpc(({ method }) => {
    if (method === "eth_getTransactionReceipt") return ++polls > 40 ? receipt : null;
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_sendRawTransaction") return new Error("already known");
    return null;
  });
  const r = await waitForReceipt(rpc, TX, { ...c, rebroadcastEveryMs: 10_000 });
  expect(r.status).toBe("success");
  const resent = rpc.calls.filter((x) => x.method === "eth_sendRawTransaction");
  expect(resent.length).toBeGreaterThan(0);
  expect(resent.every((x) => x.params[0] === RAW)).toBe(true);
});

test("a nonce used by another transaction is a contradiction, after a grace period for lagging nodes", async () => {
  const c = clock();
  const rpc = fakeRpc(({ method }) => method === "eth_getTransactionCount" ? "0x8" : method === "eth_sendRawTransaction" ? new Error("nonce too low") : null);
  await expect(waitForReceipt(rpc, TX, { ...c, nonceGraceMs: 30_000 })).rejects.toBeInstanceOf(NonceConsumed);
  expect(c.now()).toBeGreaterThanOrEqual(30_000);
  // While the node still knows our transaction (pending), a moved nonce is not a contradiction; the timeout applies.
  const c2 = clock();
  const known = fakeRpc(({ method }) => method === "eth_getTransactionCount" ? "0x8" : method === "eth_getTransactionByHash" ? { hash: TX.hash, from: DEPLOYER, nonce: "0x7", to: a(1), input: "0x", blockNumber: null } : null);
  await expect(waitForReceipt(known, TX, { ...c2, nonceGraceMs: 1_000, receiptTimeoutMs: 60_000 })).rejects.toBeInstanceOf(ReceiptTimeout);
});

test("postconditions are derived for roles, pause and setters with a getter", () => {
  const E = A.QueryEscrowAbi as Abi;
  const escrow = a(0xe5);
  const [verdicts] = checksFor(E, escrow, "setVerdicts", [a(0x11)], DEPLOYER);
  expect(verdicts).toMatchObject({ kind: "view", signature: "function verdicts() view returns (address)", expect: a(0x11) });
  expect(checksFor(E, escrow, "setPanelReserveBps", [0], DEPLOYER)[0]).toMatchObject({ signature: "function panelReserveBps() view returns (uint16)", expect: "0" });
  expect(checksFor(E, escrow, "setClassPrice", [2, 4000n, 900n], DEPLOYER).map((x) => x.kind === "view" && [x.signature, x.args, x.expect])).toEqual([
    ["function classBase(uint8) view returns (uint256)", ["2"], "4000"], ["function classPerK(uint8) view returns (uint256)", ["2"], "900"],
  ]);
  expect(checksFor(E, escrow, "setProtocolFee", [500, 10n], DEPLOYER)).toHaveLength(2);
  expect(checksFor(E, escrow, "pause", [], DEPLOYER)[0]).toMatchObject({ signature: "function paused() view returns (bool)", expect: "true" });
  const role = keccak256(toHex("mochi.role.GOVERNOR"));
  expect(checksFor(E, escrow, "grantRole", [role, a(0x22)], DEPLOYER)[0]).toMatchObject({ signature: "function hasRole(bytes32,address) view returns (bool)", args: [role, a(0x22)], expect: "true" });
  expect(checksFor(E, escrow, "grantRole", [role, DEPLOYER], DEPLOYER)).toEqual([]);
  expect(checksFor(E, escrow, "renounceRole", [role, DEPLOYER], DEPLOYER)[0]).toMatchObject({ expect: "false" });
  expect(checksFor(A.SchemaRegistryAbi as Abi, a(1), "propose", [1, h(1), h(2), h(3), h(4)], DEPLOYER)).toEqual([]);
});

test("gas pre-flight sums the remaining steps and calibrates on a resumed chain", () => {
  const table = { steps: { "deploy.A": 1_000_000, "wire.a.setX": 50_000 }, defaults: { deploy: 3_000_000, call: 100_000 } };
  const fresh = remainingGas(PLAN, undefined, table);
  expect(fresh).toMatchObject({ steps: 4, deploys: 1, gas: 1_250_000n, factor: 1 });
  expect(fresh.unknown).toEqual([PLAN[2]!.id, PLAN[3]!.id]);
  const resumed = remainingGas(PLAN, journal([confirmed("deploy.A", "deploy", 5, { gasUsed: "1500000" })]), table);
  expect(resumed).toMatchObject({ steps: 3, deploys: 0, factor: 1.5, gas: 375_000n });
});

test("fault injection is a loopback-only test hook", () => {
  const faults = parseFaults("before-broadcast:deploy.A, after-confirm:feeds.register.earnings@RHC");
  expect([...faults.get("deploy.A")!]).toEqual(["before-broadcast"]);
  expect(faults.has("feeds.register.earnings@RHC")).toBe(true);
  expect(() => parseFaults("explode:deploy.A")).toThrow("invalid entry");
  expect(() => assertFaultsAllowed(faults, "http://127.0.0.1:9", 46630)).not.toThrow();
  expect(() => assertFaultsAllowed(faults, "http://127.0.0.1:9", 4663)).toThrow("refused");
  expect(() => assertFaultsAllowed(faults, "https://rpc.example.org", 46630)).toThrow("refused");
  expect(() => assertFaultsAllowed(new Map(), "https://rpc.example.org", 4663)).not.toThrow();
});

test("journal files are private and atomic; the lock admits one live run and takes over a dead one", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-journal-"));
  const file = join(dir, "d.json.progress.json");
  writePrivateFileAtomic(file, "{}\n");
  writePrivateFileAtomic(file, "{\"a\":1}\n");
  expect(readFileSync(file, "utf8")).toBe("{\"a\":1}\n");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const lockFile = join(dir, "d.json.progress.lock");
  const first = acquireLock(lockFile);
  expect(() => acquireLock(lockFile, () => true)).toThrow("another deploy-local run");
  first.release();
  expect(existsSync(lockFile)).toBe(false);
  writeFileSync(lockFile, "999999\n");
  const second = acquireLock(lockFile, () => false);
  expect(second.tookOver).toBe(999999);
  expect(readFileSync(lockFile, "utf8").trim()).toBe(String(process.pid));
  second.release();
});

/** A minimal in-memory chain for the step runner: one account, instant mining, scripted receipt outcomes. */
function fakeChain(outcomes: Array<"success" | "reverted"> = []) {
  const state = { nonce: 5, block: 10, sent: [] as Hex[], mined: new Map<string, unknown>() };
  const rpc: RawRpc = {
    async request(method, params) {
      switch (method) {
        case "eth_getTransactionCount": return toHex(state.nonce);
        case "eth_estimateGas": return "0x5208";
        case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00" };
        case "eth_maxPriorityFeePerGas": return "0x0";
        case "eth_sendRawTransaction": {
          const raw = params[0] as Hex; const hash = keccak256(raw);
          if (state.mined.has(hash)) throw new Error("nonce too low");
          state.sent.push(raw); state.nonce++; state.block++;
          state.mined.set(hash, { status: (outcomes.shift() ?? "success") === "success" ? "0x1" : "0x0", blockNumber: toHex(state.block), contractAddress: null, gasUsed: "0x5208", effectiveGasPrice: "0x1", from: DEPLOYER, to: a(1), transactionHash: hash });
          return hash;
        }
        case "eth_getTransactionReceipt": return state.mined.get(params[0] as string) ?? null;
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { state, rpc };
}
const CALLS: PlannedStep[] = [{ id: "wire.a", kind: "call", label: "a", to: a(1), dataHash: keccak256("0xaa") }, { id: "wire.b", kind: "call", label: "b", to: a(1), dataHash: keccak256("0xbb") }];
const runnerFor = (j: Journal, chain: ReturnType<typeof fakeChain>, extra: Partial<ConstructorParameters<typeof StepRunner>[0]> = {}) => new StepRunner({
  journal: j, plan: CALLS, persist: () => {}, chainId: 46630, from: DEPLOYER, rpc: chain.rpc, reader: chainReader(chain.rpc, { sleep: async () => {} }),
  lastBlock: 10n, nextNonce: j.startNonce + noncesUsed(j), log: () => {}, sleep: async () => {},
  sign: async (tx) => toHex(`${tx.chainId}:${tx.nonce}:${tx.to}:${tx.data}:${tx.gas}`), ...extra,
});
const emptyJournal = () => journal([], { plan: CALLS.map((s) => ({ id: s.id, kind: s.kind, label: s.label })), planHash: planHash(CALLS) });

test("step runner: a mined revert stops the run; --retry-reverted sends that one step again with the next nonce and keeps the attempt", async () => {
  const chain = fakeChain(["reverted"]);
  const j = emptyJournal();
  await expect(runnerFor(j, chain).run("wire.a", "call", { to: a(1), data: "0xaa" })).rejects.toThrow("reverted in block");
  expect(j.steps[0]).toMatchObject({ id: "wire.a", status: "reverted", nonce: 5 });
  expect(j.steps[0]!.raw).toBeUndefined();
  await expect(runnerFor(j, chain).run("wire.a", "call", { to: a(1), data: "0xaa" })).rejects.toThrow("--retry-reverted");
  expect(chain.state.sent).toHaveLength(1);
  const retry = runnerFor(j, chain, { retryReverted: true });
  await retry.run("wire.a", "call", { to: a(1), data: "0xaa" });
  await retry.run("wire.b", "call", { to: a(1), data: "0xbb" });
  expect(j.steps.map((s) => [s.id, s.status, s.nonce, s.attempts?.map((x) => x.nonce)])).toEqual([["wire.a", "confirmed", 6, [5]], ["wire.b", "confirmed", 7, undefined]]);
  expect(journalProblems(j, CALLS, { ...EXPECT, planHash: planHash(CALLS) })).toEqual([]);
  expect(chain.state.sent).toHaveLength(3);
});

test("step runner: a recorded broadcast is finished with the same transaction; calldata changes and foreign nonces are refused", async () => {
  const chain = fakeChain();
  const j = emptyJournal();
  const first = runnerFor(j, chain);
  await first.run("wire.a", "call", { to: a(1), data: "0xaa" });
  // An earlier run recorded wire.b as broadcast, then died; the chain already mined it.
  const raw = toHex("46630:6:recorded-b") as Hex;
  j.steps.push({ id: "wire.b", kind: "call", status: "broadcast", nonce: 6, hash: keccak256(raw), raw, to: a(1), dataHash: keccak256("0xbb") });
  await chain.rpc.request("eth_sendRawTransaction", [raw]);
  const resumed = runnerFor(j, chain);
  await resumed.run("wire.a", "call", { to: a(1), data: "0xaa" }); // replayed, nothing sent
  await resumed.run("wire.b", "call", { to: a(1), data: "0xbb" });
  expect(j.steps[1]).toMatchObject({ status: "confirmed", hash: keccak256(raw) });
  expect(chain.state.sent).toHaveLength(2);

  const changed = emptyJournal();
  changed.steps.push({ ...j.steps[0]! });
  await expect(runnerFor(changed, chain).run("wire.a", "call", { to: a(1), data: "0xab" })).rejects.toThrow("configuration or contract artifacts changed");
  const foreign = fakeChain();
  foreign.state.nonce = 9; // someone else used the deployer key
  await expect(runnerFor(emptyJournal(), foreign).run("wire.a", "call", { to: a(1), data: "0xaa" })).rejects.toThrow("a transaction outside this deployment was sent from the deployer key");
  expect(foreign.state.sent).toHaveLength(0);
  await expect(runnerFor(emptyJournal(), chain).run("wire.b", "call", { to: a(1), data: "0xbb" })).rejects.toThrow("internal error: step 1 is wire.b but the plan has wire.a");
});
