import { buildProductionRelease, type ReleaseInput } from "./production-release.ts";
import { loadDeployment, loadSteps } from "./owner-console.ts";
import { productionTimelockDelay } from "../deploy/production/chain-policy.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyBinding, type QuoteVerifier } from "@mochi/tee";
import { parseTdxQuote } from "@mochi/tee";
import { bytesToHex } from "viem";
import { aciOsMeasurement, reportData as aciReportData, workloadKeysetDigest } from "@mochi/aci";

const pinnedWorkload = (i: number) => `os:${(i + 1).toString(16).padStart(2, "0").repeat(32)}`;
import { readFile as readBytes } from "node:fs/promises";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_SERVICE_SPECS } from "../deploy/phala/production-identities/identities.ts";
import { validateLaunchConfig, PRODUCTION_PORTS } from "../deploy/production/runtime.ts";
import { verifyProductionIdentityReport } from "./verify-production-identities.ts";
import { discoverPhalaAciWorkload, prepareProductionLaunch, writeProductionLaunch, PRODUCTION_LAUNCH_FILES } from "./prepare-production-launch.ts";
import type { Address, Hex } from "viem";

const measurement = `0x${"aa".repeat(32)}` as Hex;
const now = 1_800_000_000;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

async function verified() {
  const identities = PRODUCTION_IDENTITY_SPECS.map((spec, i) => {
    const key = address(i + 1);
    const encryptionPublicKey = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;
    const binding = keyBinding(key, encryptionPublicKey);
    return {
      name: spec.name, role: spec.role, label: spec.label,
      ...( "jurorClass" in spec ? { jurorClass: spec.jurorClass, jurorSeat: spec.jurorSeat } : {}),
      address: key, encryptionPublicKey, keyBinding: binding, measurement,
      quote: { kind: "tdx" as const, measurement, reportData: binding, raw: "0x1234" as Hex, issuedAt: now - 1 },
    };
  });
  const serviceSigners = PRODUCTION_SERVICE_SPECS.map((spec, i) => ({ name: spec.name, label: spec.label, address: address(100 + i) }));
  const report = { ready: true as const, generatedAt: now - 1, identities, serviceSigners, receiptSigner: { name: "indexer-receipt", publicKey: `0x${"44".repeat(32)}` as Hex } };
  const verifier: QuoteVerifier = { verify: async (quote, expected) => ({ ok: true, measurement: expected?.measurement, reportData: expected?.reportData }) };
  return verifyProductionIdentityReport(report, { expectedMeasurement: measurement, quoteVerifier: verifier, now: () => now });
}

function deployment() {
  return {
    chainId: 4663, rpcUrl: "https://rpc.example", startBlock: "1",
    tokenSource: { kind: "external", decimals: 18 }, owner: address(201), guardian: address(202), timelock: address(203), paused: true,
    panelEscalation: "off" as const,
    contracts: {
      mochiToken: address(204), usdg: address(205), queryEscrow: address(206), jurorRegistry: address(207), verdicts: address(208),
      receiptAnchor: address(209), panel: address(210), timelock: address(203), schemaRegistry: address(211), randomness: address(212),
      feeds: address(213), stockTokenCrosscheck: address(214), staking: address(215), shielded: address(216),
      classMix: address(217), clerkVoting: address(218), disclosureRegistry: address(219),
    },
    privacy: { entrypoint: address(220), pool: address(221), adapter: address(222), withdrawalVerifier: address(223), commitmentVerifier: address(224), poseidonT3: address(225), poseidonT4: address(226), scope: "production" },
  };
}

function build(extra: Partial<Parameters<typeof prepareProductionLaunch>[0]> = {}) {
  return verified().then((checked) => prepareProductionLaunch({
    verified: checked, deployment: deployment(), operator: address(230),
    workloads: Object.fromEntries(PRODUCTION_IDENTITY_SPECS.filter((row) => row.role === "juror").map((row, i) => [row.name, pinnedWorkload(i)])),
    deploymentPath: "/protected/deployments/mainnet.json", outputDirectory: "/protected/new-launch", now: () => now,
    randomSalt: () => `0x${"55".repeat(32)}` as Hex,
    ...extra,
  }));
}

test("prepares public CA-bound runtime, batch and disabled website inputs", async () => {
  const prepared = await build();
  expect(prepared.salt).toBe(`0x${"55".repeat(32)}`);
  expect(prepared.runtime.mode).toBe("prepare");
  expect(prepared.runtime.enabled).toBe(true);
  expect(prepared.runtime.databaseUrlEnv).toBe("MOCHI_PRODUCTION_DATABASE_URL");
  expect(prepared.runtime.aciApiKeyEnv).toBe("PHALA_API_KEY");
  expect(prepared.runtime.attestorAdminTokenEnv).toBe("MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN");
  expect(prepared.runtime.tdxAllowedTcbStatuses).toEqual(["UpToDate"]);
  expect(prepared.runtime.endpoints.jurors).toEqual(PRODUCTION_PORTS.jurors.map((port) => `http://127.0.0.1:${port}`));
  expect(prepared.runtime.identities.jurors.map((row) => [row.passport?.modelId, row.passport?.lineage, row.passport?.workload])).toEqual([
    ["qwen/qwen3.6-35b-a3b", "qwen", pinnedWorkload(0)],
    ["qwen/qwen3.6-35b-a3b", "qwen", pinnedWorkload(1)],
    ["deepseek/deepseek-v4-flash-0731", "deepseek", pinnedWorkload(2)],
    ["deepseek/deepseek-v4-flash-0731", "deepseek", pinnedWorkload(3)],
    ["google/gemma-4-31b-it", "gemma", pinnedWorkload(4)],
    ["google/gemma-4-31b-it", "gemma", pinnedWorkload(5)],
    ["moonshotai/kimi-k2.6", "kimi", pinnedWorkload(6)],
    ["openai/gpt-oss-120b", "gpt-oss", pinnedWorkload(7)],
    ["openai/gpt-oss-120b", "gpt-oss", pinnedWorkload(8)],
  ]);
  expect(prepared.runtime.identities.jurors.every((row) => row.passport?.weightsSha256 === `0x${"00".repeat(32)}` && row.passport.openWeights === false && row.passport.zdr === false && row.passport.provider === "phala-aci")).toBe(true);
  expect(prepared.identities.jurors.map((row) => row.class)).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 4]);
  expect(prepared.identities.salt).toBe(prepared.salt);
  expect(prepared.releaseInput.deploymentFile).toBe("/protected/deployments/mainnet.json");
  expect(prepared.releaseInput.identitiesFile).toBe("/protected/new-launch/production-identities.json");
  expect((prepared.releaseInput.roles as any).owner).toBe(address(201));
  expect((prepared.releaseInput.roles as any).guardian).toBe(address(202));
  expect(prepared.website.enabled).toBe(false);
  expect((prepared.website as any).receiptPublicKey).toBe((await verified()).report.receiptSigner.publicKey);
  expect(() => validateLaunchConfig(prepared.runtime)).not.toThrow();
});

test("refuses stale reports, missing reviewed owner/guardian and missing workload IDs", async () => {
  const checked = await verified();
  expect(() => prepareProductionLaunch({
    verified: checked, deployment: deployment(), operator: address(230), workloads: {}, deploymentPath: "/d.json", outputDirectory: "/out", now: () => now + 301,
  })).toThrow("stale");
  expect(() => prepareProductionLaunch({
    verified: checked, deployment: { ...deployment(), owner: undefined }, operator: address(230), workloads: {}, deploymentPath: "/d.json", outputDirectory: "/out", now: () => now,
  })).toThrow("deployment.owner");
  await expect(build({ workloads: {} })).rejects.toThrow("workload ID is required");
});

test("writes only into a new output directory and records actual artifact paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "prepare-launch-"));
  dirs.push(parent);
  const out = join(parent, "candidate");
  const prepared = await build({ outputDirectory: out });
  const files = await writeProductionLaunch(out, prepared);
  expect(Object.values(files).map((path) => path.split("/").at(-1))).toEqual(Object.values(PRODUCTION_LAUNCH_FILES));
  const release = JSON.parse(await readFile(files.releaseInput!, "utf8"));
  expect(release.identitiesFile).toBe(files.identities);
  await expect(writeProductionLaunch(out, prepared)).rejects.toThrow();
});

test("workload policies must carry an attested pin; a bare workload ID is refused", async () => {
  const names = PRODUCTION_IDENTITY_SPECS.filter((row) => row.role === "juror").map((row) => row.name);
  const unpinned = Object.fromEntries(names.map((name, i) => [name, `aci-workload-${i}`]));
  await expect(build({ workloads: unpinned })).rejects.toThrow("needs an attested os: or compose: pin");
  const malformed = Object.fromEntries(names.map((name) => [name, "os:not-a-digest"]));
  await expect(build({ workloads: malformed })).rejects.toThrow("needs an attested os: or compose: pin");
  const composeOnly = Object.fromEntries(names.map((name) => [name, `compose:${"cd".repeat(32)}`]));
  expect((await build({ workloads: composeOnly })).runtime.identities.jurors[0]!.passport!.workload).toBe(`compose:${"cd".repeat(32)}`);
});

test("discovers a shared ACI workload only from a fresh nonce-bound TDX report without credentials", async () => {
  const fixture = await readBytes(new URL("../packages/tee/test/fixtures/intel-tdx/tdx_quote", import.meta.url));
  let seenRequest: URL | undefined;
  let seenInit: RequestInit | undefined;
  let expectedWorkloadId = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seenRequest = new URL(input.toString());
    seenInit = init;
    const nonce = seenRequest.searchParams.get("nonce")!;
    const keyset = { not_after: now + 300, receipt_signing_keys: [] };
    const digest = workloadKeysetDigest(keyset);
    expectedWorkloadId = digest;
    const reportHash = aciReportData(digest, nonce);
    const quote = fixture.slice();
    quote.set(Buffer.from(reportHash, "hex"), 568);
    quote.fill(0, 600, 632);
    return Response.json({
      api_version: "aci/1", workload_keyset_digest: digest,
      attestation: { tee_type: "tdx", workload_keyset: keyset, report_data: reportHash, evidence: { quote: bytesToHex(quote) } },
    });
  }) as unknown as typeof fetch;
  const workload = await discoverPhalaAciWorkload({
    baseUrl: "https://inference.example/v1", fetchImpl, now: () => now,
    dcap: (quote) => ({ ok: true, status: "UpToDate", reportType: "tdx", reportData: parseTdxQuote(quote).td.reportData, tdReport: parseTdxQuote(quote).td }),
  });
  // The discovered policy pins the quoted TD's OS measurement, not the unsigned workload_id.
  const td = parseTdxQuote(fixture).td;
  expect(workload).toBe(`os:${aciOsMeasurement(td)}`);
  expect(workload).not.toContain(expectedWorkloadId);
  expect(seenRequest?.pathname).toBe("/v1/aci/attestation");
  expect(seenRequest?.searchParams.get("nonce")).toMatch(/^[0-9a-f]{64}$/);
  expect(seenInit?.method).toBe("GET");
  expect(seenInit?.headers).toEqual({ accept: "application/json" });
  expect(seenInit?.credentials).toBe("omit");
});

test("a testnet rehearsal deployment keeps its flag, delay and bond through to the runtime and release input", async () => {
  const rehearsal = { ...deployment(), chainId: 46630, rehearsal: true, timelockDelay: "120", minJurorBond: (1_000n * 10n ** 18n).toString() };
  const prepared = await build({ deployment: rehearsal });
  expect(prepared.runtime.deployment.chainId).toBe(46630);
  expect((prepared.runtime.deployment as any).rehearsal).toBe(true);
  expect(() => validateLaunchConfig(prepared.runtime)).not.toThrow();
  expect(prepared.releaseInput.chainId).toBe(46630);
  expect(prepared.releaseInput.timelockDelaySeconds).toBe(120);
  expect(prepared.releaseInput.minimumJurorBondMochi).toBe(1000);
  expect(prepared.releaseInput.bondBelowSpecApproved).toBe(true);
  expect(prepared.website.chainId).toBe(46630);
  const mainnet = await build({ deployment: { ...deployment(), timelockDelay: "60", minJurorBond: (25_000n * 10n ** 18n).toString() } });
  expect(mainnet.releaseInput.timelockDelaySeconds).toBe(60);
  expect((mainnet.runtime.deployment as any).rehearsal).toBeUndefined();
  await expect(build({ deployment: { ...deployment(), chainId: 46630 } })).rejects.toThrow("explicit testnet rehearsal");
});


test("shared owner/guardian and team-operated zero bonds survive preparation and runtime validation", async () => {
  const prepared = await build({ deployment: { ...deployment(), guardian: address(201), minJurorBond: "0" } });
  expect(prepared.releaseInput.minimumJurorBondMochi).toBe(0);
  expect(prepared.releaseInput.bondBelowSpecApproved).toBe(false);
  expect(() => validateLaunchConfig(prepared.runtime)).not.toThrow();
  prepared.runtime.serviceRoleAddresses.postman = address(201);
  expect(() => validateLaunchConfig(prepared.runtime)).toThrow("distinct from external owner and guardian");
});


test("recorded mainnet delays reach release input, both schedule batches and owner console", async () => {
  expect(productionTimelockDelay({ chainId: 4663 })).toBe(60);
  for (const delay of [0, 60, 120, 3600]) {
    const deployed = { ...deployment(), timelockDelay: String(delay), minJurorBond: "0" };
    const prepared = await build({ deployment: deployed });
    expect(prepared.releaseInput.timelockDelaySeconds).toBe(delay);
    const plan = buildProductionRelease(prepared.releaseInput as ReleaseInput, { deployment: deployed, identities: prepared.identities });
    for (const batch of [plan.reviewPayloads.configuration, plan.reviewPayloads.activation]) {
      expect(batch).toMatchObject({ delaySeconds: delay });
      expect(loadSteps(loadDeployment(deployed), batch, "schedule.json", "schedule")[0]!.details.at(-1)).toBe(`Waiting period after scheduling: ${delay} seconds`);
    }
    expect(plan.phases.find(p => p.id === "configure")!.then).toContain(`${delay}-second delay`);
  }
  for (const chainId of [4663, 46630, 31337]) expect(() => productionTimelockDelay({ chainId, timelockDelay: "3601" })).toThrow("0 to 3600");
  await expect(build({ deployment: { ...deployment(), timelockDelay: "3601" } })).rejects.toThrow("0 to 3600");
});

test("launch inputs require panel escalation off when recorded and offer the N3 jury only", async () => {
  await expect(build({ deployment: { ...deployment(), panelEscalation: "on" } })).rejects.toThrow("--panel-escalation off");
  await expect(build({ deployment: { ...deployment(), panelEscalation: "maybe" } })).rejects.toThrow("must be off or on");
  const { panelEscalation: _unrecorded, ...legacy } = deployment();
  await expect(build({ deployment: legacy })).rejects.toThrow("does not record panelEscalation");
  const reprepared = await build({ deployment: { ...deployment(), panelEscalation: "on" }, allowPanelEscalationOn: true });
  expect((reprepared.runtime.deployment as any).panelEscalation).toBe("on");
  const prepared = await build({ deployment: { ...deployment(), panelEscalation: "off" } });
  expect((prepared.runtime.deployment as any).panelEscalation).toBe("off");
  expect(() => validateLaunchConfig(prepared.runtime)).not.toThrow();
  expect((prepared.website as any).jurySizes).toEqual([3]);
  expect((prepared.website as any).tdxAllowedTcbStatuses).toEqual(prepared.runtime.tdxAllowedTcbStatuses);
});
