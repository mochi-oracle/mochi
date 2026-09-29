import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyBinding, type QuoteVerifier } from "@mochi/tee";
import { parseTdxQuote } from "@mochi/tee";
import { bytesToHex } from "viem";
import { reportData as aciReportData, workloadKeysetDigest } from "@mochi/aci";
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
    workloads: Object.fromEntries(PRODUCTION_IDENTITY_SPECS.filter((row) => row.role === "juror").map((row, i) => [row.name, `aci-workload-${i}`])),
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
  expect(prepared.runtime.endpoints.jurors).toEqual(PRODUCTION_PORTS.jurors.map((port) => `http://127.0.0.1:${port}`));
  expect(prepared.runtime.identities.jurors.map((row) => [row.passport?.modelId, row.passport?.lineage, row.passport?.workload])).toEqual([
    ["meta-llama/llama-3.3-70b-instruct", "llama", "aci-workload-0"],
    ["meta-llama/llama-3.3-70b-instruct", "llama", "aci-workload-1"],
    ["nvidia/nemotron-3.5-lightning", "nemotron", "aci-workload-2"],
    ["nvidia/nemotron-3.5-lightning", "nemotron", "aci-workload-3"],
    ["google/gemma-4-31b-it", "gemma", "aci-workload-4"],
    ["google/gemma-4-31b-it", "gemma", "aci-workload-5"],
    ["nvidia/nemotron-3.5-lightning", "nemotron", "aci-workload-6"],
    ["google/gemma-4-31b-it", "gemma", "aci-workload-7"],
    ["google/gemma-4-31b-it", "gemma", "aci-workload-8"],
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
    dcap: (quote) => ({ ok: true, status: "UpToDate", reportType: "tdx", reportData: parseTdxQuote(quote).td.reportData }),
  });
  expect(workload).toBe(expectedWorkloadId);
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
  const mainnet = await build({ deployment: { ...deployment(), timelockDelay: "86400", minJurorBond: (25_000n * 10n ** 18n).toString() } });
  expect(mainnet.releaseInput.timelockDelaySeconds).toBe(86400);
  expect((mainnet.runtime.deployment as any).rehearsal).toBeUndefined();
  await expect(build({ deployment: { ...deployment(), chainId: 46630 } })).rejects.toThrow("explicit testnet rehearsal");
});
