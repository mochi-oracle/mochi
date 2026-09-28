import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyBinding, type Quote, type QuoteVerifier } from "@mochi/tee";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_SERVICE_SPECS } from "../deploy/phala/production-identities/identities.ts";
import {
  comparePreviousKeys,
  fetchProductionIdentityReport,
  verifyProductionIdentityReport,
  writeReportNoOverwrite,
} from "./verify-production-identities.ts";
import type { Hex } from "viem";

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
