import { expect, test } from "bun:test";
import { parseEther, toEventSelector, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import * as A from "@mochi/chain";
import {
  ESCROW_EVENTS, QueryTracker, balanceReading, blockRanges, classifyQueries, evaluateTick, formatStatusLine, parseCvmStatus, summarizeIdentities, toJsonLine,
  watchSigners, type TickReport,
} from "./launch-watch.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const M = `0x${"b7".repeat(32)}` as Hex;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const healthy = { status: "running", mode: "active", payments: true, services: { intake: "healthy", consensus: "healthy", gateway: "healthy", orchestrator: "healthy" } };

test("escrow event signatures match the generated QueryEscrow ABI", () => {
  const generated = new Map((A.QueryEscrowAbi as Abi).filter((x): x is AbiEvent => x.type === "event").map((e) => [e.name, toEventSelector(e)]));
  for (const event of ESCROW_EVENTS) expect(toEventSelector(event), event.name).toBe(generated.get(event.name)!);
});

test("parseCvmStatus accepts the runtime shape and rejects anything else", () => {
  expect(parseCvmStatus(healthy)).toEqual(healthy);
  expect(parseCvmStatus({ status: "standby", mode: "standby", payments: false, services: {} }).services).toEqual({});
  for (const bad of [null, [], { mode: "active" }, { status: "x", mode: "active", payments: "yes" }, { ...healthy, services: [] }, { ...healthy, services: { "bad name!": "healthy" } }, { ...healthy, services: { a: 1 } }]) {
    expect(() => parseCvmStatus(bad)).toThrow();
  }
});

test("identity summary: count, measurement (identity and quote) and service signers", () => {
  const identity = (m: Hex = M) => ({ name: "x", address: a(1), measurement: m, quote: { measurement: m } });
  const signers = { attestor: a(1), indexer: a(2), orchestrator: a(3), feedRunner: a(4), postman: a(5) };
  const live = { ready: true, identities: Array.from({ length: 11 }, () => identity()), serviceSigners: [
    { name: "attestor", address: a(1) }, { name: "indexer", address: a(2) }, { name: "orchestrator", address: a(3) }, { name: "feed-runner", address: a(4) }, { name: "postman", address: a(5) }] };
  expect(summarizeIdentities(live, M, signers)).toEqual({ ready: true, count: 11, measurements: [M], measurementOk: true, signersMatch: true });
  expect(summarizeIdentities(live).measurementOk).toBeUndefined();
  const oneOff = { ...live, identities: [...live.identities.slice(1), { ...identity(), quote: { measurement: `0x${"00".repeat(32)}` } }] };
  expect(summarizeIdentities(oneOff, M).measurementOk).toBe(false);
  expect(summarizeIdentities(live, M, { ...signers, orchestrator: a(9) }).signersMatch).toBe(false);
  expect(() => summarizeIdentities({ ready: false, error: "x" })).toThrow();
});

test("query tracker: events mark queries dirty; counts and expiry eligibility come from status and deadline", () => {
  const tracker = new QueryTracker(10n);
  tracker.apply([{ args: { queryId: id(1) } }, { args: { queryId: id(2) } }, { args: { queryId: id(1) } }, { args: {} }]);
  expect(tracker.dirtyIds(10)).toEqual([id(1), id(2)]);
  tracker.update(id(1), 1, 1_000n); tracker.update(id(2), 3, 0n);
  expect(tracker.dirtyIds(10)).toEqual([]);
  tracker.apply([{ args: { queryId: id(2) } }]);
  expect(tracker.dirtyIds(10)).toEqual([id(2)]);
  expect(classifyQueries([{ status: 1, deadline: 100n }, { status: 2, deadline: 100n }, { status: 2, deadline: 300n }, { status: 4, deadline: 50n }, { status: 3, deadline: 0n }, { status: 6, deadline: 0n }, { status: 5, deadline: 0n }], 200n))
    .toEqual({ open: 1, sealed: 2, hung: 1, expiredEligible: 2, decided: 1, expired: 1, escalated: 1, total: 7 });
  // expire() needs block.timestamp strictly after the deadline
  expect(classifyQueries([{ status: 1, deadline: 200n }], 200n).expiredEligible).toBe(0);
  expect(blockRanges(1n, 25n, 10n)).toEqual([[1n, 10n], [11n, 20n], [21n, 25n]]);
  expect(blockRanges(5n, 4n, 10n)).toEqual([]);
});

const base = (): Omit<TickReport, "ok" | "failures" | "warnings" | "at"> => ({
  rpc: { reachable: true, chainId: 4663, chainOk: true, block: 123n, headAgeSec: 2, ms: 80 },
  cvm: { reachable: true, ms: 40, status: parseCvmStatus(healthy) },
  identities: { reachable: true, ms: 90, summary: { ready: true, count: 11, measurements: [M], measurementOk: true, signersMatch: true } },
  escrow: { paused: false },
  queries: { open: 0, sealed: 1, hung: 0, expiredEligible: 0, decided: 2, expired: 0, escalated: 0, total: 3, scannedTo: 123n, partial: false },
  balances: [balanceReading({ role: "orchestrator", address: a(3), minWei: parseEther("0.002") }, parseEther("0.005"))],
});
const opts = { expectMode: "active", strictBalances: false };

test("evaluateTick: a healthy active launch has no failures", () => {
  expect(evaluateTick(base(), opts)).toEqual({ failures: [], warnings: [] });
});

test("evaluateTick: each problem is a failure; low balances and stuck queries are warnings", () => {
  const cases: Array<[string, (r: ReturnType<typeof base>) => void, string]> = [
    ["rpc down", (r) => { r.rpc = { reachable: false, ms: 10_000, error: "timeout" }; }, "rpc_unreachable"],
    ["wrong chain", (r) => { r.rpc.chainOk = false; r.rpc.chainId = 46630; }, "rpc_chain_46630_mismatch"],
    ["cvm down", (r) => { r.cvm = { reachable: false, ms: 1, error: "unreachable" }; }, "cvm_unreachable"],
    ["service failed", (r) => { r.cvm.status!.services.orchestrator = "failed"; }, "service_orchestrator_failed"],
    ["payments off", (r) => { r.cvm.status!.payments = false; }, "payments_off"],
    ["standby", (r) => { r.cvm.status = parseCvmStatus({ status: "standby", mode: "standby", payments: false, services: {} }); }, "cvm_mode_standby_expected_active"],
    ["paused while active", (r) => { r.escrow.paused = true; }, "escrow_paused_in_active"],
    ["measurement", (r) => { r.identities!.summary!.measurementOk = false; }, "measurement_mismatch"],
    ["identity count", (r) => { r.identities!.summary!.count = 10; }, "identities_10_of_11"],
    ["signers rotated", (r) => { r.identities!.summary!.signersMatch = false; }, "service_signers_changed"],
    ["balance unreadable", (r) => { r.balances = [balanceReading({ role: "owner", address: a(1), minWei: 1n }, undefined, "unreadable")]; }, "balance_owner_unreadable"],
  ];
  for (const [label, mutate, failure] of cases) {
    const r = base(); mutate(r);
    expect(evaluateTick(r, opts).failures, label).toContain(failure);
  }
  const prepare = base();
  prepare.cvm.status = parseCvmStatus({ ...healthy, mode: "prepare", payments: false });
  expect(evaluateTick(prepare, { ...opts, expectMode: "prepare" }).failures).toEqual(["escrow_unpaused_in_prepare"]);
  prepare.escrow.paused = true;
  expect(evaluateTick(prepare, { ...opts, expectMode: "prepare" }).failures).toEqual([]);
  const low = base();
  low.balances = [balanceReading({ role: "orchestrator", address: a(3), minWei: parseEther("0.002") }, parseEther("0.001"))];
  low.queries = { ...(low.queries as object), hung: 2, expiredEligible: 1 } as never;
  expect(evaluateTick(low, opts)).toEqual({ failures: [], warnings: ["expiry_eligible_1", "hung_2", "low_orchestrator"] });
  expect(evaluateTick(low, { ...opts, strictBalances: true }).failures).toEqual(["low_orchestrator"]);
  const idle = base(); idle.rpc.headAgeSec = 900;
  expect(evaluateTick(idle, opts)).toEqual({ failures: [], warnings: ["head_age_900s"] });
  expect(evaluateTick(idle, { ...opts, maxHeadAgeSec: 1000 }).warnings).toEqual([]);
  const any = base(); any.cvm.status = parseCvmStatus({ status: "standby", mode: "standby", payments: false, services: {} }); any.escrow.paused = true;
  expect(evaluateTick(any, { ...opts, expectMode: "any" }).failures).toEqual([]);
});

test("status line and JSON line are content-free and carry the monitored fields", () => {
  const r = { ...base(), at: "2026-10-02T15:00:00.000Z", ok: true, failures: [], warnings: [], consecutiveFailures: 0, maxFailures: 3 } as TickReport;
  const line = formatStatusLine(r);
  for (const part of ["OK", "cvm=active pay=on svc=4/4", "ids=11 meas=ok signers=ok", "escrow=open", "q[open=0 sealed=1 hung=0 expiry-eligible=0", "rpc=4663 80ms blk=123 age=2s", "orchestrator=0.005000", "fails=0/3"]) expect(line).toContain(part);
  const bad = { ...r, ok: false, failures: ["payments_off"], balances: [balanceReading({ role: "attestor", address: a(1), minWei: parseEther("0.0005") }, parseEther("0.0001"))] };
  expect(formatStatusLine(bad)).toContain("attestor=0.000100(LOW)");
  expect(formatStatusLine(bad)).toContain("failures=payments_off");
  const parsed = JSON.parse(toJsonLine(r));
  expect(parsed.rpc.block).toBe("123");
  expect(parsed.balances[0].wei).toBe(parseEther("0.005").toString());
});

test("watched wallets: owner, distinct guardian, operator and five service signers with their thresholds", () => {
  const signers = watchSigners({ owner: a(1), guardian: a(1), operator: a(2), services: { orchestrator: a(3), indexer: a(4), attestor: a(5), postman: a(6), feedRunner: a(7) }, minOrchestratorWei: parseEther("0.002"), minWei: parseEther("0.0005") });
  expect(signers.map((s) => s.role)).toEqual(["owner", "operator", "orchestrator", "indexer", "attestor", "postman", "feedRunner"]);
  expect(signers.find((s) => s.role === "orchestrator")!.minWei).toBe(parseEther("0.002"));
  expect(signers.filter((s) => s.role !== "orchestrator").every((s) => s.minWei === parseEther("0.0005"))).toBe(true);
  expect(watchSigners({ owner: a(1), guardian: a(9), minOrchestratorWei: 1n, minWei: 1n }).map((s) => s.role)).toEqual(["owner", "guardian"]);
});
