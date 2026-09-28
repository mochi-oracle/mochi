import { expect, test } from "bun:test";
import { buildProductionRelease, runReadOnlyPreflight, type ProductionDeployment, type ReadOnlyReader, type ReleaseInput } from "./production-release.ts";
import type { Input } from "./phala-batch.ts";
import type { Address, Hex } from "viem";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const valid = (): ReleaseInput => ({
  chainId: 4663,
  mochiToken: null,
  usdg: addr(1),
  roles: { owner: addr(2), guardian: addr(3), tokenRecipient: addr(4), feeTreasury: addr(5), attestor: addr(6), feedRunner: addr(7), orchestrator: addr(8), indexer: addr(9), postman: addr(10) },
  timelockDelaySeconds: 86400,
  jurorCount: 9,
  jurorClassCounts: [2, 2, 2, 1, 2],
  minimumJurorBondMochi: 25000,
  initialFeedBudgetUsdg: 10,
});

test("missing external CA still produces dry-run plan and identifies token-only dependency", () => {
  const plan = buildProductionRelease(valid());
  expect(plan.target.externalMochiToken).toBeNull();
  expect(plan.safety).toMatchObject({ transactionsSent: false, tokenCreated: false, mainnetExecutionEnabled: false });
  expect(plan.phases.map((p) => p.id)).toEqual(["validate", "deploy-paused", "configure", "enroll-and-verify", "activate", "paid-smoke-and-release"]);
  expect(plan.blockers.some((b) => b.includes("external MOCHI CA"))).toBe(true);
  expect(plan.blockers.some((b) => b.includes("identities"))).toBe(true);
});

test("rejects wrong chain and malformed/zero external CA", () => {
  expect(() => buildProductionRelease({ ...valid(), chainId: 46630 })).toThrow("chainId must be Robinhood Chain mainnet 4663");
  expect(() => buildProductionRelease({ ...valid(), mochiToken: addr(0) })).toThrow("mochiToken (team-created external MOCHI CA) must be a valid nonzero EVM address");
});

test("rejects role collisions and incomplete or invalid role addresses", () => {
  expect(() => buildProductionRelease({ ...valid(), roles: { ...valid().roles, guardian: addr(2) } })).toThrow("roles.owner and roles.guardian must be distinct");
  expect(() => buildProductionRelease({ ...valid(), roles: { ...valid().roles, postman: "bad" } })).toThrow("roles.postman must be a valid nonzero EVM address");
  expect(buildProductionRelease({ ...valid(), roles: { ...valid().roles, indexer: null } }).blockers.some((b) => b.includes("roles.indexer"))).toBe(true);
});

test("rejects invalid launch counts, bond and too-short timelock", () => {
  expect(() => buildProductionRelease({ ...valid(), jurorClassCounts: [3, 2, 2, 1, 1] })).toThrow("class counts 2/2/2/1/2");
  expect(() => buildProductionRelease({ ...valid(), minimumJurorBondMochi: 20000 })).toThrow("at least 25000");
  expect(() => buildProductionRelease({ ...valid(), timelockDelaySeconds: 172800 })).toThrow("86400 to match");
});

test("activation phase is ordered after execution, enrollment and service readiness", () => {
  const phases = buildProductionRelease(valid()).phases;
  expect(phases.find((p) => p.id === "configure")!.order).toBeLessThan(phases.find((p) => p.id === "enroll-and-verify")!.order);
  expect(phases.find((p) => p.id === "enroll-and-verify")!.order).toBeLessThan(phases.find((p) => p.id === "activate")!.order);
  expect(phases.find((p) => p.id === "activate")!.requires).toContain("phase enroll-and-verify complete");
  expect(phases.find((p) => p.id === "configure")!.payload).toBeUndefined();
});

const deploymentFixture = (): ProductionDeployment => ({
  chainId: 4663, owner: addr(2), guardian: addr(3), paused: true, tokenSource: { kind: "test-deployment" },
  contracts: { mochiToken: addr(20), randomness: addr(21), schemaRegistry: addr(22), jurorRegistry: addr(23), queryEscrow: addr(24), verdicts: addr(25), feeds: addr(26), stockTokenCrosscheck: addr(27), panel: addr(28), staking: addr(29), receiptAnchor: addr(30), usdg: addr(31), shielded: addr(32), timelock: addr(33) },
  privacy: { entrypoint: addr(34) },
} as ProductionDeployment);
const identitiesFixture = (): Input => ({
  salt: `0x${"ab".repeat(32)}` as Hex,
  intake: { address: addr(40), operator: addr(140), measurement: `0x${"41".repeat(32)}` as Hex },
  consensus: { address: addr(42), operator: addr(141), measurement: `0x${"43".repeat(32)}` as Hex },
  jurors: [0, 0, 1, 1, 2, 2, 3, 4, 4].map((cls, i) => ({ address: addr(50 + i), operator: addr(150 + i), measurement: `0x${String(60 + i).padStart(2, "0").repeat(32)}` as Hex, class: cls })),
  attestor: addr(6), feedRunner: addr(7), orchestrator: addr(8), indexer: addr(9), postman: addr(10),
});

test("offline no-CA fixture creates separate configure and activation review payloads without readiness", () => {
  const deployment = deploymentFixture();
  const identities = identitiesFixture();
  const plan = buildProductionRelease({ ...valid(), usdg: addr(31), deploymentFile: "offline fixture", identitiesFile: "offline fixture", roles: { owner: addr(2), guardian: addr(3) } }, { deployment, identities });
  expect(plan.reviewPayloads.configuration).toMatchObject({ status: "built-offline-not-scheduled", phase: "configure", action: "schedule" });
  expect(plan.reviewPayloads.activation).toMatchObject({ status: "built-offline-not-ready-to-schedule", phase: "activate", readiness: { caAddressAndDecimalsChecked: false, readyToSchedule: false } });
  expect((plan.reviewPayloads.configuration as unknown as { operationId: string }).operationId).not.toBe((plan.reviewPayloads.activation as unknown as { operationId: string }).operationId);
  const configure = plan.reviewPayloads.configuration as unknown as { callCount: number; payloads: Hex[]; targets: Address[]; delaySeconds: number };
  const activate = plan.reviewPayloads.activation as unknown as { callCount: number; payloads: Hex[]; targets: Address[]; delaySeconds: number };
  expect(configure.callCount).toBeGreaterThan(1);
  expect(configure.delaySeconds).toBe(86400);
  expect(configure.payloads).not.toContain(encodeFunctionData({ abi: parseAbi(["function unpause()"]), functionName: "unpause" }));
  expect(activate.callCount).toBe(1);
  expect(activate.delaySeconds).toBe(86400);
  expect(decodeFunctionData({ abi: parseAbi(["function unpause()"]), data: activate.payloads[0]! }).functionName).toBe("unpause");
  expect(activate.targets[0]).toBe(deployment.contracts.queryEscrow);
  expect(plan.safety).toMatchObject({ transactionsSent: false, tokenCreated: false, mainnetExecutionEnabled: false });
});

test("deployment and identities must agree with the planned CA, roles and chain", () => {
  const deployment = deploymentFixture();
  expect(() => buildProductionRelease({ ...valid(), mochiToken: addr(99) }, { deployment, identities: identitiesFixture() })).toThrow("does not match deployment contracts.mochiToken");
  expect(() => buildProductionRelease({ ...valid(), chainId: 46630 }, { deployment, identities: identitiesFixture() })).toThrow("chainId must be Robinhood Chain mainnet 4663");
  expect(() => buildProductionRelease({ ...valid(), usdg: addr(31), roles: { ...valid().roles, attestor: addr(99) } }, { deployment, identities: identitiesFixture() })).toThrow("identities.attestor does not match roles.attestor");
});

test("read-only preflight checks chain, code, token precision, configured roles and funding through injected reader", async () => {
  const deployment = deploymentFixture();
  const input = { ...valid(), mochiToken: addr(20), usdg: addr(31) };
  let reads = 0;
  const reader: ReadOnlyReader = {
    async chainId() { reads++; return 4663; },
    async code() { reads++; return "0x6000"; },
    async decimals(token) { reads++; return token.toLowerCase() === addr(31) ? 6 : 18; },
    async hasRole() { reads++; return true; },
    async nativeBalance() { reads++; return 1n; },
    async jurorInfo(key) { reads++; const ids = identitiesFixture(); const identity = [ids.intake, ids.consensus, ...ids.jurors].find((x) => x.address.toLowerCase() === key.toLowerCase())!; const role = key === ids.intake.address ? 2 : key === ids.consensus.address ? 3 : 1; return { operator: identity.operator, measurement: identity.measurement, role, jurorClass: (identity as { class?: number }).class ?? 0, bond: role === 1 ? 25_000n * 10n ** 18n : 0n }; },
    async isActive() { reads++; return true; },
    async feedBudget() { reads++; return 10_000_000n; },
    async paused() { reads++; return true; },
  };
  const result = await runReadOnlyPreflight(deployment, input, reader, identitiesFixture());
  expect(result.checksPassed).toBe(true);
  expect(result.failed).toBe(0);
  expect(reads).toBeGreaterThan(result.checked);
});

test("preflight reports wrong chain, missing code, invalid decimals, role gaps and underfunding", async () => {
  const reader: ReadOnlyReader = {
    async chainId() { return 46630; }, async code() { return "0x"; }, async decimals() { return 9; },
    async hasRole() { return false; }, async nativeBalance() { return 0n; },
    async jurorInfo(key) { const ids = identitiesFixture(); const identity = [ids.intake, ids.consensus, ...ids.jurors].find((x) => x.address.toLowerCase() === key.toLowerCase())!; return { operator: identity.operator, measurement: identity.measurement, role: 0, jurorClass: 0, bond: 0n }; },
    async isActive() { return false; }, async feedBudget() { return 0n; }, async paused() { return false; },
  };
  const result = await runReadOnlyPreflight(deploymentFixture(), { ...valid(), mochiToken: addr(20), usdg: addr(31) }, reader, identitiesFixture());
  expect(result.checksPassed).toBe(false);
  expect(result.checks.map((x) => x.id)).toContain("chain-id");
  expect(result.checks.find((x) => x.id === "paused")?.ok).toBe(false);
  expect(result.checks.some((x) => x.id.startsWith("code:") && !x.ok)).toBe(true);
  expect(result.checks.find((x) => x.id === "mochi-decimals")?.ok).toBe(false);
  expect(result.checks.some((x) => x.id.startsWith("enrollment:juror:") && !x.ok)).toBe(true);
  expect(result.checks.find((x) => x.id === "feed-budget")?.ok).toBe(false);
});

test("preflight suppresses provider errors that may contain RPC credentials", async () => {
  const reader: ReadOnlyReader = {
    async chainId() { return 4663; }, async code() { throw new Error("https://rpc.example/private?token=do-not-leak"); },
    async decimals() { return 18; }, async hasRole() { return true; }, async nativeBalance() { return 1n; },
    async jurorInfo() { throw new Error("unneeded"); }, async isActive() { return true; }, async feedBudget() { return 1n; }, async paused() { return true; },
  };
  const result = await runReadOnlyPreflight(deploymentFixture(), { ...valid(), mochiToken: addr(20), usdg: addr(31) }, reader, identitiesFixture());
  const failure = result.checks.find((x) => x.id === "code:randomness")!;
  expect(failure.detail).toBe("read failed; provider details suppressed");
  expect(failure.detail).not.toContain("do-not-leak");
});

test("plan displays only RPC origin and rejects userinfo credentials", () => {
  const plan = buildProductionRelease({ ...valid(), rpcUrl: "https://rpc.example:443/rpc?token=do-not-leak" });
  expect(plan.target.rpcOrigin).toBe("https://rpc.example");
  expect(JSON.stringify(plan)).not.toContain("do-not-leak");
  expect(() => buildProductionRelease({ ...valid(), rpcUrl: "https://user:password@127.0.0.1/rpc" })).toThrow("must not contain username or password");
});

test("CA address/decimals check requires successful chain, code and precision reads", async () => {
  const deployment = { ...deploymentFixture(), tokenSource: { kind: "external" } };
  const input = { ...valid(), mochiToken: addr(20), usdg: addr(31) };
  const reader: ReadOnlyReader = {
    async chainId() { return 4663; }, async code() { return "0x6000"; }, async decimals(token) { return token === addr(31) ? 6 : 18; },
    async hasRole() { return true; }, async nativeBalance() { return 1n; },
    async jurorInfo(key) { const ids = identitiesFixture(); const identity = [ids.intake, ids.consensus, ...ids.jurors].find((x) => x.address.toLowerCase() === key.toLowerCase())!; const role = key === ids.intake.address ? 2 : key === ids.consensus.address ? 3 : 1; return { operator: identity.operator, measurement: identity.measurement, role, jurorClass: (identity as { class?: number }).class ?? 0, bond: role === 1 ? 25_000n * 10n ** 18n : 0n }; },
    async isActive() { return true; }, async feedBudget() { return 10_000_000n; }, async paused() { return true; },
  };
  const preflight = await runReadOnlyPreflight(deployment, input, reader, identitiesFixture());
  const plan = buildProductionRelease(input, { deployment, identities: identitiesFixture(), preflight });
  expect(plan.reviewPayloads.activation).toMatchObject({ readiness: { caAddressAndDecimalsChecked: true } });
  const wrongChain = { ...preflight, checks: preflight.checks.map((x) => x.id === "chain-id" ? { ...x, ok: false } : x) };
  const blocked = buildProductionRelease(input, { deployment, identities: identitiesFixture(), preflight: wrongChain });
  expect(blocked.reviewPayloads.activation).toMatchObject({ readiness: { caAddressAndDecimalsChecked: false } });
});
