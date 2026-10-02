import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { encodeFunctionData, toHex, type Address, type Hex } from "viem";
import * as A from "@mochi/chain";
import { payerCommit } from "@mochi/protocol";
import {
  canaryChainPolicy, checkpointGate, gasDeltas, maskSeats, reconcileCharge, resultPublicKey, verifyOpenCalldata, type CanaryCheckpoint,
} from "./canary-check.ts";
import { answerLabelFromJson, claimFixtureFrom, fixtureSecrets } from "./launch-ops/sdk-adapter.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ESCROW = a(0xe5);
const PAYER = a(0xaa);
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const pair = x25519.keygen();
const resultPrivateKey = toHex(pair.secretKey);
const resultPubKey = toHex(pair.publicKey);
const NOW = 1_800_000_000n;

function grant(overrides: Record<string, unknown> = {}) {
  return {
    docCommit: `0x${"11".repeat(32)}` as Hex, kind: 0, originId: `0x${"00".repeat(32)}` as Hex, fetchedAt: 0n, tokensK: 1, transcriptHash: `0x${"00".repeat(32)}` as Hex,
    opener: PAYER, schemaId: 7, schemaVersion: 1, paramsHash: `0x${"22".repeat(32)}` as Hex, payerCommit: payerCommit(resultPubKey), isPublic: false, allowPanelDisclosure: false,
    nonce: 42n, expiry: NOW + 900n, ...overrides,
  };
}
const openData = (params: { n: number; refundTo: Address } = { n: 3, refundTo: PAYER }, prov = grant()) =>
  encodeFunctionData({ abi: A.QueryEscrowAbi, functionName: "openWithUSDG", args: [params, prov, "0x1234"] as never });

test("the result public key derives from the in-memory result key", () => {
  expect(resultPublicKey(resultPrivateKey)).toBe(resultPubKey);
});

test("prepared openWithUSDG is accepted only for a private N3 FREEFORM_FACT grant opened and refunded by the payer", () => {
  const expect_ = { escrow: ESCROW, payer: PAYER, resultPubKey, nowSec: NOW };
  const call = verifyOpenCalldata({ to: ESCROW, data: openData() }, expect_);
  expect(call.params.n).toBe(3);
  expect(call.params.refundTo.toLowerCase()).toBe(PAYER);
  expect(call.provenance).toMatchObject({ schemaId: 7, nonce: 42n, expiry: NOW + 900n, tokensK: 1 });
  const rejects: Array<[string, { to: Address; data: Hex }, string]> = [
    ["other contract", { to: a(1), data: openData() }, "not addressed to the deployment's QueryEscrow"],
    ["other function", { to: ESCROW, data: encodeFunctionData({ abi: A.QueryEscrowAbi, functionName: "expire", args: [`0x${"01".repeat(32)}`] }) }, "expected openWithUSDG"],
    ["garbage", { to: ESCROW, data: "0xdeadbeef" }, "does not decode"],
    ["n5", { to: ESCROW, data: openData({ n: 5, refundTo: PAYER }) }, "n 5"],
    ["refund elsewhere", { to: ESCROW, data: openData({ n: 3, refundTo: a(2) }) }, "refundTo is not the payer"],
    ["other opener", { to: ESCROW, data: openData(undefined, grant({ opener: a(3) })) }, "grant opener is not the payer"],
    ["other schema", { to: ESCROW, data: openData(undefined, grant({ schemaId: 3 })) }, "schemaId 3"],
    ["public", { to: ESCROW, data: openData(undefined, grant({ isPublic: true })) }, "public query"],
    ["panel disclosure", { to: ESCROW, data: openData(undefined, grant({ allowPanelDisclosure: true })) }, "panel disclosure allowed"],
    ["foreign result key", { to: ESCROW, data: openData(undefined, grant({ payerCommit: payerCommit(toHex(x25519.keygen().publicKey)) })) }, "payerCommit is not bound"],
    ["fetched", { to: ESCROW, data: openData(undefined, grant({ kind: 1 })) }, "not SUBMITTED"],
    ["expired", { to: ESCROW, data: openData(undefined, grant({ expiry: NOW })) }, "already expired"],
  ];
  for (const [label, tx, message] of rejects) expect(() => verifyOpenCalldata(tx, expect_), label).toThrow(message);
});

test("charge reconciliation: VERDICT, HUNG, expiry and the problems it catches", () => {
  const total = 100_000n; const fee = 20_000n;
  const verdict = reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, payerBalanceBefore: 5_000_000n, payerBalanceAfter: 4_900_000n, refundedToPayer: 0n, settlement: { status: 1, round: 0, jurorsPaid: 80_000n, refunded: 0n } });
  expect(verdict.ok).toBe(true);
  expect(verdict.lines.join("\n")).toContain("jurorsPaid 0.08 + refunded 0 + protocol fee 0.02");
  expect(verdict.lines.join("\n")).toContain("payer net debit 0.1 USDG");
  // One juror timed out: its 0.022 seat fee comes back to the payer.
  const timeout = reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, payerBalanceBefore: 5_000_000n, payerBalanceAfter: 4_922_000n, refundedToPayer: 22_000n, settlement: { status: 1, round: 0, jurorsPaid: 58_000n, refunded: 22_000n } });
  expect(timeout.ok).toBe(true);
  const hung = reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, refundedToPayer: 20_000n, settlement: { status: 2, round: 0, jurorsPaid: 80_000n, refunded: 20_000n } });
  expect(hung.ok).toBe(true);
  const expired = reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, payerBalanceBefore: 1n + total, payerBalanceAfter: 1n + total, refundedToPayer: total, expiredRefund: total });
  expect(expired.ok).toBe(true);
  const pending = reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, refundedToPayer: 0n });
  expect(pending.ok).toBe(true);
  expect(pending.lines.join("\n")).toContain("escrow still holds the payment");
  expect(reconcileCharge({ expectedTotal: total, quotedTotal: 50_000n, paid: 50_000n, protocolFee: fee, transferredAtOpen: 50_000n, refundedToPayer: 0n }).problems.join()).toContain("differs from expected");
  expect(reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: 90_000n, refundedToPayer: 0n }).problems.join()).toContain("disagree");
  expect(reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, refundedToPayer: 0n, settlement: { status: 1, round: 0, jurorsPaid: 70_000n, refunded: 0n } }).problems.join()).toContain("does not add up");
  expect(reconcileCharge({ expectedTotal: total, quotedTotal: total, paid: total, protocolFee: fee, transferredAtOpen: total, payerBalanceBefore: 200_000n, payerBalanceAfter: 0n, refundedToPayer: 0n, settlement: { status: 1, round: 0, jurorsPaid: 80_000n, refunded: 0n } }).problems.join()).toContain("payer net debit");
});

test("seat masks, gas deltas", () => {
  expect(maskSeats(0b101)).toEqual([0, 2]);
  expect(maskSeats(undefined)).toEqual([]);
  expect(gasDeltas({ orchestrator: a(1), indexer: a(2) }, { orchestrator: 10n, indexer: 5n }, { orchestrator: 4n, indexer: 5n })).toEqual([
    { role: "orchestrator", address: a(1), before: 10n, after: 4n, spentWei: 6n }, { role: "indexer", address: a(2), before: 5n, after: 5n, spentWei: 0n }]);
});

test("chain policy: mainnet pays real USDG with typed yes only; testnet needs --rehearsal; other chains refused", () => {
  const ok = { chainId: 4663, rpcChainId: 4663, deploymentRehearsal: false, rehearsalFlag: false, yes: false, usdg: USDG, usdgName: "Global Dollar" };
  expect(() => canaryChainPolicy(ok)).not.toThrow();
  expect(() => canaryChainPolicy({ ...ok, yes: true })).toThrow("--yes is not accepted on chain 4663");
  expect(() => canaryChainPolicy({ ...ok, usdg: a(5) })).toThrow("real USDG");
  expect(() => canaryChainPolicy({ ...ok, usdgName: "Mock USDG" })).toThrow("real USDG");
  expect(() => canaryChainPolicy({ ...ok, rehearsalFlag: true })).toThrow("cannot run on chain 4663");
  expect(() => canaryChainPolicy({ ...ok, deploymentRehearsal: true })).toThrow("cannot run on chain 4663");
  expect(() => canaryChainPolicy({ ...ok, rpcChainId: 46630 })).toThrow("RPC is chain 46630");
  const testnet = { ...ok, chainId: 46630, rpcChainId: 46630, deploymentRehearsal: true, rehearsalFlag: true, yes: true, usdg: a(7), usdgName: "Mock USDG" };
  expect(() => canaryChainPolicy(testnet)).not.toThrow();
  expect(() => canaryChainPolicy({ ...testnet, rehearsalFlag: false })).toThrow("needs --rehearsal");
  expect(() => canaryChainPolicy({ ...testnet, chainId: 1, rpcChainId: 1 })).toThrow("refusing");
});

test("a paid but unfinished canary is never paid again blindly", () => {
  const opened = { status: "opened", queryId: `0x${"01".repeat(32)}` } as CanaryCheckpoint;
  expect(checkpointGate(undefined, false)).toBe("new");
  expect(() => checkpointGate(opened, false)).toThrow("did not finish; rerun with --resume");
  expect(checkpointGate(opened, true)).toBe("resume");
  expect(checkpointGate({ ...opened, status: "finished" }, false)).toBe("new");
  expect(() => checkpointGate(undefined, true)).toThrow("no canary checkpoint");
});

test("the bundled fixture is the harmless public claim, and only the enum label leaves a decrypted answer", () => {
  const fixture = claimFixtureFrom(JSON.parse(readFileSync(join(import.meta.dir, "launch-ops/canary-fixture.json"), "utf8")));
  expect(fixture.expected).toBe("contradicted");
  expect(fixture.evidence[0]!.url.startsWith("https://www.metzdowd.com/")).toBe(true);
  expect(fixtureSecrets(fixture)).toContain(fixture.claim);
  expect(fixtureSecrets(fixture)).toContain(fixture.evidence[0]!.excerpt);
  expect(answerLabelFromJson(JSON.stringify({ fields: { answer: { t: "str", v: "contradicted" } } }))).toBe("contradicted");
  expect(answerLabelFromJson(JSON.stringify({ fields: { answer: { t: "str", v: "free text answer" } } }))).toBeUndefined();
  expect(answerLabelFromJson("not json")).toBeUndefined();
  expect(() => claimFixtureFrom({ ...fixture, expected: "maybe" })).toThrow("expected must be one of");
});

test("canary output code never formats fixture text: only the adapter receives the fixture", () => {
  const source = readFileSync(join(import.meta.dir, "canary-check.ts"), "utf8");
  const uses = [...source.matchAll(/(?<![-\w])fixture\.(\w+)/g)].map((m) => m[1]);
  expect(new Set(uses)).toEqual(new Set(["expected"]));
  expect(source).not.toMatch(/\.claim\b|\.excerpt\b|answerJson/);
});

test("CLI refuses --yes on a chain 4663 deployment before touching the network or a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-cli-"));
  const deployment = join(dir, "deployment.json");
  writeFileSync(deployment, JSON.stringify({ chainId: 4663, rpcUrl: "https://127.0.0.1:1/never", startBlock: "0", contracts: { queryEscrow: a(1), usdg: USDG, verdicts: a(2), jurorRegistry: a(3) } }));
  const child = Bun.spawnSync([process.execPath, "scripts/canary-check.ts", "--deployment", deployment, "--payer-key-file", join(dir, "missing.json"), "--measurement", `0x${"b7".repeat(32)}`, "--out", join(dir, "out"), "--yes"], { cwd: join(import.meta.dir, ".."), env: { PATH: process.env.PATH } });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("--yes is not accepted on chain 4663");
});
