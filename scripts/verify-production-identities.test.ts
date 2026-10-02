import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DSTACK_RUNTIME_EVENT_TYPE, dstackMrConfigIdV1, dstackMrConfigIdV2, dstackMrConfigIdV3, dstackMrConfigV3Document,
  dstackRuntimeEventDigest, keyBinding, replayDstackRtmr3, type Quote, type QuoteVerifier,
} from "@mochi/tee";
import { sha256 } from "@noble/hashes/sha2.js";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_SERVICE_SPECS } from "../deploy/phala/production-identities/identities.ts";
import {
  comparePreviousKeys,
  fetchProductionIdentityReport,
  parseArgs,
  verifyProductionIdentityReport,
  writeReportNoOverwrite,
  type ConfigBindingInput,
} from "./verify-production-identities.ts";
import { bytesToHex, hexToBytes, type Hex } from "viem";

const measurement = `0x${"aa".repeat(32)}` as Hex;
const now = 1_800_000_000;
const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function validReport() {
  const identities = PRODUCTION_IDENTITY_SPECS.map((spec, index) => {
    const address = `0x${(index + 1).toString(16).padStart(40, "0")}` as Hex;
    const encryptionPublicKey = `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex;
    const binding = keyBinding(address, encryptionPublicKey);
    const quote: Quote = { kind: "tdx", measurement, reportData: binding, raw: "0x1234", issuedAt: now - 2 };
    return {
      name: spec.name, role: spec.role, label: spec.label,
      ...( "jurorClass" in spec ? { jurorClass: spec.jurorClass, jurorSeat: spec.jurorSeat } : {}),
      address, encryptionPublicKey, keyBinding: binding, measurement, quote,
    };
  });
  const serviceSigners = PRODUCTION_SERVICE_SPECS.map((spec, index) => ({
    name: spec.name, label: spec.label, address: `0x${(index + 101).toString(16).padStart(40, "0")}` as Hex,
  }));
  return { ready: true as const, generatedAt: now - 3, identities, serviceSigners, receiptSigner: { name: "indexer-receipt", publicKey: `0x${"33".repeat(32)}` as Hex } };
}

function verifier(calls: Quote[] = []): QuoteVerifier {
  return {
    async verify(quote, expected) {
      calls.push(quote);
      if (quote.kind !== "tdx" || quote.measurement.toLowerCase() !== expected?.measurement?.toLowerCase()
        || quote.reportData.toLowerCase() !== expected?.reportData?.toLowerCase()) return { ok: false, reason: "mismatch" };
      return { ok: true, measurement: quote.measurement, reportData: quote.reportData };
    },
  };
}

test("verifies all pinned TDX identities locally and returns public-only summary", async () => {
  const calls: Quote[] = [];
  const report = validReport();
  const result = await verifyProductionIdentityReport(report, { expectedMeasurement: measurement, quoteVerifier: verifier(calls), now: () => now });
  expect(calls).toHaveLength(11);
  expect(result.summary.identities).toHaveLength(11);
  expect(result.summary.identities.every(({ verified }) => verified)).toBe(true);
  expect(JSON.stringify(result.summary)).not.toContain('"raw"');
  expect(result.summary.serviceSigners).toHaveLength(5);
  expect(result.summary.receiptSigner.publicKey).toBe(report.receiptSigner.publicKey);
});

test("rejects stale, unpinned, mock, incomplete and duplicate identity reports", async () => {
  const verify = verifier();
  const base = validReport();
  await expect(verifyProductionIdentityReport({ ...base, generatedAt: now - 301 }, { expectedMeasurement: measurement, quoteVerifier: verify, now: () => now })).rejects.toThrow("stale");
  await expect(verifyProductionIdentityReport(base, { expectedMeasurement: `0x${"bb".repeat(32)}` as Hex, quoteVerifier: verify, now: () => now })).rejects.toThrow("measurement");
  const mock = validReport();
  mock.identities[0]!.quote.kind = "mock";
  await expect(verifyProductionIdentityReport(mock, { expectedMeasurement: measurement, quoteVerifier: verify, now: () => now })).rejects.toThrow("valid TDX evidence");
  const missing = validReport();
  missing.identities[0]!.quote = undefined as never;
  await expect(verifyProductionIdentityReport(missing, { expectedMeasurement: measurement, quoteVerifier: verify, now: () => now })).rejects.toThrow("valid TDX evidence");
  const duplicate = validReport();
  duplicate.identities[1]!.encryptionPublicKey = duplicate.identities[0]!.encryptionPublicKey;
  await expect(verifyProductionIdentityReport(duplicate, { expectedMeasurement: measurement, quoteVerifier: verify, now: () => now })).rejects.toThrow("not unique");
  const wrongClass = validReport();
  wrongClass.identities[2]!.jurorClass = 4;
  await expect(verifyProductionIdentityReport(wrongClass, { expectedMeasurement: measurement, quoteVerifier: verify, now: () => now })).rejects.toThrow("class or seat");
});

test("previous-report check ignores measurement updates and rejects public-key rotation", async () => {
  const previous = validReport();
  const current = validReport();
  current.identities.forEach((identity) => { identity.measurement = `0x${"bb".repeat(32)}` as Hex; });
  await expect(comparePreviousKeys(previous, current)).resolves.toBeUndefined();
  current.identities[3]!.address = `0x${"ed".repeat(20)}` as Hex;
  await expect(comparePreviousKeys(previous, current)).rejects.toThrow("keys changed");
  current.identities[3]!.address = previous.identities[3]!.address;
  current.identities[3]!.encryptionPublicKey = `0x${"fe".repeat(32)}` as Hex;
  await expect(comparePreviousKeys(previous, current)).rejects.toThrow("keys changed");
  current.identities[3]!.encryptionPublicKey = previous.identities[3]!.encryptionPublicKey;
  current.serviceSigners[0]!.address = `0x${"ee".repeat(20)}` as Hex;
  await expect(comparePreviousKeys(previous, current)).rejects.toThrow("keys changed");
  current.serviceSigners[0]!.address = previous.serviceSigners[0]!.address;
  current.receiptSigner.publicKey = `0x${"ff".repeat(32)}` as Hex;
  await expect(comparePreviousKeys(previous, current)).rejects.toThrow("keys changed");
});

test("fetch is HTTPS-only, bounded and sends an unauthenticated GET", async () => {
  let request: Request | URL | string | undefined;
  let init: RequestInit | undefined;
  const mockFetch = (async (url: string | URL | Request, options?: RequestInit) => {
    request = url as URL;
    init = options;
    return Response.json({ ok: true });
  }) as typeof fetch;
  await expect(fetchProductionIdentityReport("http://example.test/production/identities", mockFetch)).rejects.toThrow("HTTPS");
  await fetchProductionIdentityReport("https://example.test/production/identities", mockFetch);
  expect(request?.toString()).toBe("https://example.test/production/identities");
  expect(init?.method).toBe("GET");
  expect(init?.credentials).toBe("omit");
  expect(init?.cache).toBe("no-store");
  expect(init?.redirect).toBe("error");
  expect(init?.headers).toEqual({ accept: "application/json" });
  const oversized = (async () => new Response(new Uint8Array(1_000_001))) as unknown as typeof fetch;
  await expect(fetchProductionIdentityReport("https://example.test/production/identities", oversized)).rejects.toThrow("size limit");
});

test("report output is private and never overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "identity-report-"));
  tempDirs.push(dir);
  const path = join(dir, "report.json");
  await writeReportNoOverwrite(path, validReport());
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(writeReportNoOverwrite(path, validReport())).rejects.toThrow();
});

// --- dstack configuration identity -------------------------------------------------------------------------------
// A real DCAP fixture quote with MRCONFIGID and RTMR3 patched; the stub verifier above does not check signatures.
const FIXTURE_QUOTE = new Uint8Array(await readFile(new URL("../packages/tee/test/fixtures/intel-tdx/tdx_quote", import.meta.url)));
const MRCONFIGID_OFFSET = 48 + 184;
const RTMR3_OFFSET = 48 + 472;
const APP_ID = "21dfb9d71c8d72522bb4372657b96308a190daaa";
const INSTANCE_ID = "a860de12f1343b31164d9b34f17218f583cb7ad2";
const KMS_ID = "3059301306072a8648ce3d020106082a8648ce3d030107034200048844eb42ccdf8c52fd4f174f362fcb9bbd19c45fd48f1edec2d8f1ca23536ec1a74021b4cee610c074f8294d431b2b7fee2c39e5333fdaf0a4522d43fb159d9f";
const OTHER_KMS_ID = `3059301306072a8648ce3d020106082a8648ce3d03010703420004${"ab".repeat(64)}`;
const DOCKER_COMPOSE = "services:\n  app:\n    image: example@sha256:" + "11".repeat(32) + "\n";
const bytes = (hex: string) => hexToBytes(`0x${hex}` as Hex);
const utf8 = (text: string) => new TextEncoder().encode(text);

function appCompose(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    allowed_envs: ["A"], docker_compose_file: DOCKER_COMPOSE, features: ["kms", "tproxy-net"], kms_enabled: true,
    local_key_provider_enabled: false, manifest_version: 2, name: "", no_instance_id: false, runner: "docker-compose", ...extra,
  });
}

function bootEvents(compose: string, keyProviderId = KMS_ID, instanceId = INSTANCE_ID) {
  return [
    ["system-preparing", new Uint8Array()], ["app-id", bytes(APP_ID)], ["compose-hash", sha256(utf8(compose))],
    ["instance-id", bytes(instanceId)], ["boot-mr-done", new Uint8Array()], ["mr-kms", new Uint8Array(32).fill(7)],
    ["key-provider", utf8(JSON.stringify({ name: "kms", id: keyProviderId }))], ["system-ready", new Uint8Array()],
  ].map(([event, payload]) => ({ event: event as string, payload: payload as Uint8Array }));
}

function attestationFor(compose: string, events = bootEvents(compose)) {
  const eventLog = [
    { imr: 0, event_type: 1, digest: "00".repeat(48), event: "", event_payload: "" },
    ...events.map((event) => ({
      imr: 3, event_type: DSTACK_RUNTIME_EVENT_TYPE, digest: bytesToHex(dstackRuntimeEventDigest(event)).slice(2),
      event: event.event, event_payload: bytesToHex(event.payload).slice(2),
    })),
  ];
  return { attestation: { tcb_info: { app_compose: compose, event_log: eventLog } }, rtmr3: replayDstackRtmr3(events) };
}

function reportWithRegisters(mrConfigId: Uint8Array, rtmr3: Uint8Array = new Uint8Array(48).fill(3)) {
  const raw = FIXTURE_QUOTE.slice();
  raw.set(mrConfigId, MRCONFIGID_OFFSET);
  raw.set(rtmr3, RTMR3_OFFSET);
  const report = validReport();
  for (const identity of report.identities) identity.quote.raw = bytesToHex(raw);
  return report;
}

const verifyWith = (report: unknown, extra: { requireConfigVersions?: number[]; configBinding?: ConfigBindingInput } = {}) =>
  verifyProductionIdentityReport(report, { expectedMeasurement: measurement, quoteVerifier: verifier(), now: () => now, ...extra });

function registerFor(version: 1 | 2 | 3, compose: string, options: { instanceId?: Uint8Array } = {}): Uint8Array {
  const composeHash = sha256(utf8(compose));
  if (version === 1) return dstackMrConfigIdV1(composeHash);
  if (version === 2) return dstackMrConfigIdV2({ composeHash, appId: bytes(APP_ID), keyProvider: "kms", keyProviderId: bytes(KMS_ID) });
  return dstackMrConfigIdV3(dstackMrConfigV3Document({
    appId: bytes(APP_ID), composeHash, keyProvider: "kms", keyProviderId: bytes(KMS_ID), instanceId: options.instanceId ?? bytes(INSTANCE_ID),
  }));
}

test("reports each quote's dstack config version and enforces the required set", async () => {
  const compose = appCompose();
  const v1 = reportWithRegisters(registerFor(1, compose));
  const { summary } = await verifyWith(v1);
  expect(summary.identities.every(({ configVersion }) => configVersion === 1)).toBe(true);
  expect(summary.identities[0]!.mrConfigId).toBe(bytesToHex(registerFor(1, compose)));
  expect(summary.configBinding).toBeUndefined();
  await expect(verifyWith(v1, { requireConfigVersions: [2, 3] })).rejects.toThrow("dstack config version 1; required 2 or 3");
  await expect(verifyWith(v1, { requireConfigVersions: [1] })).resolves.toBeDefined();
  const v3 = reportWithRegisters(registerFor(3, appCompose({ key_provider: "kms", key_provider_id: KMS_ID })));
  expect((await verifyWith(v3, { requireConfigVersions: [2, 3] })).summary.identities[10]!.configVersion).toBe(3);
  const unknown = registerFor(1, compose); unknown[0] = 4;
  await expect(verifyWith(reportWithRegisters(unknown), { requireConfigVersions: [1, 2, 3] })).rejects.toThrow("config version 4");
  await expect(verifyWith(v1, { requireConfigVersions: [4] })).rejects.toThrow("subset of 1, 2, 3");
  // Unparseable evidence keeps the previous default behaviour, but cannot satisfy a config requirement.
  const legacy = validReport();
  expect((await verifyWith(legacy)).summary.identities[0]!.configVersion).toBeUndefined();
  await expect(verifyWith(legacy, { requireConfigVersions: [1] })).rejects.toThrow("cannot be parsed");
});

test("recomputes V1, V2 and V3 registers offline from the attested app-compose, app id and KMS id", async () => {
  const cases = [
    { version: 1 as const, compose: appCompose() },
    { version: 2 as const, compose: appCompose({ key_provider: "kms", key_provider_id: KMS_ID }) },
    { version: 3 as const, compose: appCompose({ key_provider: "kms", key_provider_id: KMS_ID }) },
  ];
  for (const { version, compose } of cases) {
    const { attestation, rtmr3 } = attestationFor(compose);
    const report = reportWithRegisters(registerFor(version, compose), rtmr3);
    const { summary } = await verifyWith(report, {
      requireConfigVersions: [version],
      configBinding: { attestation, appId: `0x${APP_ID}`, keyProviderId: KMS_ID, reviewedCompose: DOCKER_COMPOSE },
    });
    expect(summary.configBinding).toEqual({
      configVersion: version, mrConfigId: bytesToHex(registerFor(version, compose)), composeHash: bytesToHex(sha256(utf8(compose))),
      appId: `0x${APP_ID}`, instanceId: `0x${INSTANCE_ID}`, keyProvider: { name: "kms", id: `0x${KMS_ID}` }, composeKeyProvider: "kms",
      composeKeyProviderId: version === 1 ? "0x" : `0x${KMS_ID}`, rtmr3: bytesToHex(rtmr3), reviewedComposeMatches: true,
    });
  }
  // no_instance_id drops instance_id from the V3 document.
  const compose = appCompose({ key_provider: "kms", key_provider_id: KMS_ID, no_instance_id: true });
  const events = bootEvents(compose, KMS_ID, "");
  const { attestation, rtmr3 } = attestationFor(compose, events);
  const report = reportWithRegisters(registerFor(3, compose, { instanceId: new Uint8Array() }), rtmr3);
  expect((await verifyWith(report, { configBinding: { attestation } })).summary.configBinding?.configVersion).toBe(3);
});

test("rejects config evidence that does not bind the quotes to the expected app, KMS and compose", async () => {
  const compose = appCompose();
  const { attestation, rtmr3 } = attestationFor(compose);
  const good = reportWithRegisters(registerFor(1, compose), rtmr3);
  const bind = (overrides: Partial<ConfigBindingInput> = {}): ConfigBindingInput => ({ attestation, appId: APP_ID, keyProviderId: KMS_ID, ...overrides });
  await expect(verifyWith(good, { configBinding: bind() })).resolves.toBeDefined();
  await expect(verifyWith(reportWithRegisters(registerFor(1, compose)), { configBinding: bind() })).rejects.toThrow("same boot");
  await expect(verifyWith(good, { configBinding: bind({ keyProviderId: OTHER_KMS_ID }) })).rejects.toThrow("expected KMS");
  await expect(verifyWith(good, { configBinding: bind({ appId: "00".repeat(20) }) })).rejects.toThrow("expected app id");
  await expect(verifyWith(good, { configBinding: bind({ reviewedCompose: "services: {}\n" }) })).rejects.toThrow("reviewed compose");
  const otherCompose = appCompose({ allowed_envs: ["B"] });
  await expect(verifyWith(reportWithRegisters(registerFor(1, otherCompose), rtmr3), { configBinding: bind() })).rejects.toThrow("does not match the attested app-compose");
  const swapped = { tcb_info: { ...attestation.tcb_info, app_compose: otherCompose } };
  await expect(verifyWith(good, { configBinding: bind({ attestation: swapped }) })).rejects.toThrow("does not hash");
  const tampered = structuredClone(attestation);
  tampered.tcb_info.event_log[7]!.event_payload = bytesToHex(utf8(JSON.stringify({ name: "kms", id: OTHER_KMS_ID }))).slice(2);
  await expect(verifyWith(good, { configBinding: bind({ attestation: tampered }) })).rejects.toThrow("digest does not match");
  // A KMS that differs from the one the boot event names is caught even when the register itself is consistent.
  const rogue = attestationFor(compose, bootEvents(compose, OTHER_KMS_ID));
  await expect(verifyWith(reportWithRegisters(registerFor(1, compose), rogue.rtmr3), { configBinding: bind({ attestation: rogue.attestation }) }))
    .rejects.toThrow("expected KMS");
  // A V2 register only verifies when the compose itself pins the key provider id.
  await expect(verifyWith(reportWithRegisters(registerFor(2, compose), rtmr3), { configBinding: bind() })).rejects.toThrow("version 2");
  await expect(verifyWith(good, { configBinding: bind({ attestation: { tcb_info: {} } }) })).rejects.toThrow("tcb_info.app_compose");
});

test("CLI flags stay backward compatible and validate config options", () => {
  const base = ["--url", "https://example.test/production/identities", "--measurement", measurement];
  expect(parseArgs(base)).toEqual({ url: "https://example.test/production/identities", measurement });
  expect(parseArgs([...base, "--require-config-version", "2,3"]).requireConfigVersions).toEqual([2, 3]);
  expect(() => parseArgs([...base, "--require-config-version", "2,4"])).toThrow("comma-separated");
  expect(() => parseArgs([...base, "--key-provider-id", KMS_ID])).toThrow("need --attestation");
  expect(parseArgs([...base, "--attestation", "a.json", "--app-id", APP_ID, "--key-provider-id", KMS_ID, "--reviewed-compose", "c.yml"]))
    .toMatchObject({ attestation: "a.json", appId: APP_ID, keyProviderId: KMS_ID, reviewedCompose: "c.yml" });
  expect(() => parseArgs([...base, "--unknown", "x"])).toThrow("usage");
});
