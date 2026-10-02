import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import {
  STEPS, assertRehearsalDeployment, cvmDeployCommand, decideStep, deployPlanProblems, failureSummary, mergeConfig, nextPendingStep, runtimeForMode, timelockState, topUpPlan, validateContinue,
  type Checkpoint, type RehearsalConfig, type RehearsalDeployment,
} from "./dress-rehearsal.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const step = (id: string) => STEPS.find((s) => s.id === id)!;
const cp = (id: string, state: Checkpoint["state"]): Checkpoint => ({ id, state, startedAt: "t", updatedAt: "t", txs: [], outputs: {} });
const doneUntil = (id: string) => new Map(STEPS.slice(0, STEPS.findIndex((s) => s.id === id)).map((s) => [s.id, cp(s.id, "done")] as const));

test("the plan covers handoff §8.2–8.9 then pause and standby, with CVM steps handed to the operator", () => {
  expect(STEPS.map((s) => s.id)).toEqual(["preflight", "deploy", "verify-deployment", "identities", "env-files", "fund", "cvm-prepare", "configure", "enrollment", "cvm-enroll", "activate", "cvm-active", "canary", "pause", "cvm-standby"]);
  expect(STEPS.filter((s) => s.kind === "operator").map((s) => s.id)).toEqual(["cvm-prepare", "cvm-enroll", "cvm-active", "cvm-standby"]);
  expect(cvmDeployCommand("21dfb9d71c8d72522bb4372657b96308a190daaa", "/h/evidence-ea9a453/compose.yml", "/o/cvm-prepare.env"))
    .toBe("phala deploy --cvm-id 21dfb9d71c8d72522bb4372657b96308a190daaa -c /h/evidence-ea9a453/compose.yml -e /o/cvm-prepare.env --public-logs --wait --timeout 600");
});

test("resume policy: done steps never rerun; an interrupted deploy resumes only from deploy-local's journal; other steps resume from chain state", () => {
  expect(decideStep(step("deploy"), cp("deploy", "done"), {})).toEqual({ action: "skip" });
  expect(decideStep(step("deploy"), cp("deploy", "done"), { deployJournal: true })).toEqual({ action: "skip" });
  expect(decideStep(step("deploy"), undefined, {})).toEqual({ action: "run", resumed: false });
  expect(decideStep(step("deploy"), cp("deploy", "started"), {}).action).toBe("blocked");
  expect(decideStep(step("deploy"), cp("deploy", "failed"), {}).action).toBe("blocked");
  expect(decideStep(step("deploy"), cp("deploy", "failed"), {})).toMatchObject({ reason: expect.stringContaining("left no deploy-local journal") });
  // deploy-local --resume checks the journal against the chain and refuses on a contradiction, so no --force-step is needed.
  expect(decideStep(step("deploy"), cp("deploy", "started"), { deployJournal: true })).toEqual({ action: "run", resumed: true });
  expect(decideStep(step("deploy"), cp("deploy", "failed"), { deployJournal: true })).toEqual({ action: "run", resumed: true });
  expect(decideStep(step("deploy"), cp("deploy", "started"), { forceStep: "deploy" })).toEqual({ action: "run", resumed: true });
  for (const id of ["configure", "enrollment", "activate", "fund", "pause", "canary"]) expect(decideStep(step(id), cp(id, "started"), {})).toEqual({ action: "run", resumed: true });
  expect(decideStep(step("cvm-prepare"), undefined, {})).toEqual({ action: "await-operator" });
  expect(decideStep(step("cvm-prepare"), cp("cvm-prepare", "awaiting-operator"), {})).toEqual({ action: "await-operator" });
  expect(decideStep(step("cvm-prepare"), cp("cvm-prepare", "awaiting-operator"), { continueStep: "cvm-prepare" })).toEqual({ action: "verify-operator" });
  expect(decideStep(step("cvm-prepare"), cp("cvm-prepare", "done"), { continueStep: "cvm-prepare" })).toEqual({ action: "skip" });
});

test("--continue only for the operator step the rehearsal is waiting on", () => {
  const waiting = doneUntil("cvm-prepare"); waiting.set("cvm-prepare", cp("cvm-prepare", "awaiting-operator"));
  expect(nextPendingStep(waiting)?.id).toBe("cvm-prepare");
  expect(() => validateContinue("cvm-prepare", waiting)).not.toThrow();
  expect(() => validateContinue("cvm-enroll", waiting)).toThrow("the rehearsal is at cvm-prepare");
  expect(() => validateContinue("deploy", waiting)).toThrow("--continue takes an operator step");
  expect(() => validateContinue("cvm-prepare", doneUntil("cvm-prepare"))).toThrow("has not been handed to the lead agent");
  expect(() => validateContinue("cvm-prepare", doneUntil("fund"))).toThrow("the rehearsal is at fund");
  expect(nextPendingStep(new Map(STEPS.map((s) => [s.id, cp(s.id, "done")])))).toBeUndefined();
});

test("top-ups send only the shortfall", () => {
  expect(topUpPlan([{ role: "owner", address: a(1), balance: 5n, target: 3n }, { role: "orchestrator", address: a(2), balance: 1n, target: 10n }]).map((x) => x.amount)).toEqual([0n, 9n]);
});

const dep = (overrides: Partial<RehearsalDeployment> = {}): RehearsalDeployment => ({
  chainId: 46630, rehearsal: true, rpcUrl: "https://rpc.testnet.chain.robinhood.com/rpc", startBlock: "1", panelEscalation: "off", tokenSource: { kind: "external" }, paused: true, minJurorBond: "0",
  owner: a(1), guardian: a(1), deployer: a(2), contracts: { timelock: a(9) } as never, privacy: { entrypoint: a(8) } as never, ...overrides,
});

test("only a chain 46630 rehearsal deployment with panel off, stand-in token, paused and zero bond is usable", () => {
  expect(() => assertRehearsalDeployment(dep(), { owner: a(1), deployer: a(2) })).not.toThrow();
  for (const [label, bad, message] of [
    ["mainnet", dep({ chainId: 4663, rehearsal: false }), "chain 46630"],
    ["not marked rehearsal", dep({ rehearsal: false }), "chain 46630"],
    ["panel on", dep({ panelEscalation: "on" }), "panelEscalation must be off"],
    ["test token", dep({ tokenSource: { kind: "test-deployment" } }), "external"],
    ["unpaused", dep({ paused: false }), "paused=true"],
    ["bonded", dep({ minJurorBond: "25000000000000000000000" }), "minJurorBond"],
    ["guardian elsewhere", dep({ guardian: a(7) }), "guardian must be the owner"],
  ] as const) expect(() => assertRehearsalDeployment(bad, { owner: a(1) }), label).toThrow(message);
  expect(() => assertRehearsalDeployment(dep(), { owner: a(5) })).toThrow("owner differs");
  expect(() => assertRehearsalDeployment(dep(), { deployer: a(5) })).toThrow("deployer differs");
});

test("runtime copies change only the mode", () => {
  const runtime = { mode: "prepare", deployment: { chainId: 46630 }, jurors: [{ a: 1 }] };
  const enroll = runtimeForMode(runtime, "enroll");
  expect(enroll).toEqual({ ...runtime, mode: "enroll" });
  expect(enroll.jurors).not.toBe(runtime.jurors);
  expect(() => runtimeForMode({ mode: "active" }, "enroll")).toThrow("prepare-mode runtime");
});

test("timelock operation state", () => {
  expect(timelockState(0n, 100n)).toBe("unscheduled");
  expect(timelockState(1n, 100n)).toBe("done");
  expect(timelockState(150n, 100n)).toBe("pending");
  expect(timelockState(100n, 100n)).toBe("ready");
});

test("configuration is fixed per --out", () => {
  const existing = { measurement: `0x${"b7".repeat(32)}`, owner: a(1) } as unknown as RehearsalConfig;
  expect(mergeConfig(existing, { measurement: `0x${"b7".repeat(32)}` })).toBe(existing);
  expect(() => mergeConfig(existing, { measurement: `0x${"00".repeat(32)}` })).toThrow("different measurement");
  expect(mergeConfig(undefined, { owner: a(1) })).toEqual({ owner: a(1) });
});

test("CLI: --status needs no keys or network; --continue is refused when nothing is waiting", () => {
  const out = mkdtempSync(join(tmpdir(), "rehearsal-cli-"));
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "scripts/dress-rehearsal.ts", "--out", out, ...args], { cwd: join(import.meta.dir, ".."), env: { PATH: process.env.PATH } });
  const status = run("--status");
  expect(status.exitCode).toBe(0);
  expect(status.stdout.toString()).toContain("[ ] cvm-prepare");
  const early = run("--continue", "cvm-prepare");
  expect(early.exitCode).toBe(2);
  expect(early.stderr.toString()).toContain("the rehearsal is at preflight");
  mkdirSync(join(out, "checkpoints"), { recursive: true });
  writeFileSync(join(out, "checkpoints", "preflight.json"), JSON.stringify(cp("preflight", "done")));
  writeFileSync(join(out, "checkpoints", "deploy.json"), JSON.stringify(cp("deploy", "started")));
  expect(run("--status").stdout.toString()).toMatch(/\[!\] deploy .*started/);
});

test("deploy-local's printed plan must match the rehearsal configuration before --yes", () => {
  const config = { owner: a(1), usdg: a(2), mochiToken: a(3), timelockDelay: "60" };
  const plan = { mode: "mainnet rehearsal", chainId: 46630, owner: a(1), guardian: a(1), usdg: a(2), mochiToken: a(3), panelEscalation: "off", minJurorBondMochi: "0", timelockDelay: "60", shielded: "privacy-pools", randomness: "drand" };
  expect(deployPlanProblems(plan, config)).toEqual([]);
  expect(deployPlanProblems({ ...plan, mode: "mainnet", chainId: 4663 }, config)).toContain("not a chain 46630 mainnet rehearsal");
  expect(deployPlanProblems({ ...plan, guardian: a(9) }, config)).toContain("owner/guardian");
  expect(deployPlanProblems({ ...plan, panelEscalation: "on" }, config)).toContain("panel/bond/delay");
  expect(deployPlanProblems({ ...plan, mochiToken: "test-only token deployed for rehearsal" }, config)).toContain("tokens");
});

test("a failed child is summarised by its error lines, not its stack frames", () => {
  const output = ["{", "  \"mode\": \"mainnet rehearsal\"", "}", " 6 |  const cause = getNodeError(err, args);", "TransactionExecutionError: The request took too long to respond.", "Details: The request timed out.", "      at request (/x/viem/http.js:46:40)"].join("\n");
  expect(failureSummary(output)).toBe("    TransactionExecutionError: The request took too long to respond.\n    Details: The request timed out.");
  expect(failureSummary("a\nb\nc")).toBe("    a\n    b\n    c");
});
