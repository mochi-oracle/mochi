import { open, readFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { keyBinding, quoteHash, quoteVerifierFromEnv, type Env, type Quote, type QuoteVerifier } from "@mochi/tee";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_RECEIPT_SIGNING_SPEC, PRODUCTION_SERVICE_SPECS } from "../deploy/phala/production-identities/identities.ts";
import type { Address, Hex } from "viem";

const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FRESHNESS_SEC = 300;
const FUTURE_SKEW_SEC = 30;
const HEX32 = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

type Identity = {
  name: string; role: string; label: string; jurorClass?: number; jurorSeat?: number;
  address: Address; encryptionPublicKey: Hex; keyBinding: Hex; measurement: Hex; quote: Quote;
};
type ServiceSigner = { name: string; label: string; address: Address };
type IdentityReport = {
  ready: true; generatedAt: number; identities: Identity[]; serviceSigners: ServiceSigner[];
  receiptSigner: { name: string; publicKey: Hex };
};

export type ProductionIdentitySummary = {
  ready: true;
  generatedAt: number;
  locallyVerifiedAt: number;
  expectedMeasurement: Hex;
  identities: Array<{ name: string; role: string; jurorClass?: number; jurorSeat?: number; address: Address; encryptionPublicKey: Hex; keyBinding: Hex; measurement: Hex; quoteHash: Hex; issuedAt: number; verified: true }>;
  serviceSigners: ServiceSigner[];
  receiptSigner: { name: string; publicKey: Hex };
};

export async function verifyProductionIdentityReport(
  payload: unknown,
  options: { expectedMeasurement: Hex; quoteVerifier: QuoteVerifier; now?: () => number },
): Promise<{ report: IdentityReport; summary: ProductionIdentitySummary }> {
  if (!HEX32.test(options.expectedMeasurement)) throw new Error("expected measurement must be bytes32 hex");
  const report = assertReport(payload);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const verifiedAt = now();
  const reportAge = verifiedAt - report.generatedAt;
  if (!Number.isSafeInteger(verifiedAt) || reportAge > MAX_FRESHNESS_SEC || reportAge < -FUTURE_SKEW_SEC) {
    throw new Error("identity report is stale or from the future");
  }

  const seenAddresses = new Set<string>();
  const seenEncryptionKeys = new Set<string>();
  const identities = await Promise.all(report.identities.map(async (identity, index) => {
    const spec = PRODUCTION_IDENTITY_SPECS[index]!;
    if (identity.name !== spec.name || identity.role !== spec.role || identity.label !== spec.label) {
      throw new Error(`identity ${index} does not match the expected production roster`);
    }
    const juror = "jurorClass" in spec;
    if (juror) {
      if (identity.jurorClass !== spec.jurorClass || identity.jurorSeat !== spec.jurorSeat) throw new Error(`identity ${spec.name} has an unexpected class or seat`);
    } else if (identity.jurorClass !== undefined || identity.jurorSeat !== undefined) {
      throw new Error(`identity ${spec.name} must not contain juror fields`);
    }
    if (!ADDRESS.test(identity.address) || !HEX32.test(identity.encryptionPublicKey) || !HEX32.test(identity.keyBinding) || !HEX32.test(identity.measurement)) {
      throw new Error(`identity ${spec.name} has malformed public keys`);
    }
    const address = identity.address.toLowerCase();
    const encryptionKey = identity.encryptionPublicKey.toLowerCase();
    if (seenAddresses.has(address)) throw new Error("production identity addresses are not unique");
    if (seenEncryptionKeys.has(encryptionKey)) throw new Error("production encryption public keys are not unique");
    seenAddresses.add(address);
    seenEncryptionKeys.add(encryptionKey);

    const binding = keyBinding(identity.address, identity.encryptionPublicKey);
    if (binding.toLowerCase() !== identity.keyBinding.toLowerCase()) throw new Error(`identity ${spec.name} key binding mismatch`);
    if (identity.measurement.toLowerCase() !== options.expectedMeasurement.toLowerCase()) throw new Error(`identity ${spec.name} measurement does not match the expected pin`);
    const quote = identity.quote;
    if (!quote || quote.kind !== "tdx" || !HEX32.test(quote.measurement) || !HEX32.test(quote.reportData)
      || typeof quote.raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(quote.raw)
      || !Number.isSafeInteger(quote.issuedAt) || quote.measurement.toLowerCase() !== options.expectedMeasurement.toLowerCase()
      || quote.reportData.toLowerCase() !== binding.toLowerCase()) {
      throw new Error(`identity ${spec.name} is missing valid TDX evidence`);
    }
    const verified = await options.quoteVerifier.verify(quote, {
      measurement: options.expectedMeasurement, reportData: binding, maxAgeSec: MAX_FRESHNESS_SEC,
    });
    if (!verified.ok || verified.measurement?.toLowerCase() !== options.expectedMeasurement.toLowerCase()
      || verified.reportData?.toLowerCase() !== binding.toLowerCase()) {
      throw new Error(`identity ${spec.name} failed local DCAP verification${verified.reason ? `: ${verified.reason}` : ""}`);
    }
    const { quote: _quote, ...publicIdentity } = identity;
    return {
      ...publicIdentity,
      quoteHash: quoteHash(quote),
      issuedAt: quote.issuedAt,
      verified: true as const,
    };
  }));

  const serviceAddresses = new Set<string>();
  for (const [index, signer] of report.serviceSigners.entries()) {
    const spec = PRODUCTION_SERVICE_SPECS[index]!;
    if (signer.name !== spec.name || signer.label !== spec.label || !ADDRESS.test(signer.address)) throw new Error(`service signer ${index} is malformed or unexpected`);
    const address = signer.address.toLowerCase();
    if (seenAddresses.has(address) || serviceAddresses.has(address)) throw new Error("production service signer addresses are not unique");
    serviceAddresses.add(address);
  }
  const receipt = report.receiptSigner;
  if (receipt.name !== PRODUCTION_RECEIPT_SIGNING_SPEC.name || !HEX32.test(receipt.publicKey)) throw new Error("receipt signer public key is malformed or unexpected");

  return {
    report,
    summary: {
      ready: true,
      generatedAt: report.generatedAt,
      locallyVerifiedAt: verifiedAt,
      expectedMeasurement: options.expectedMeasurement,
      identities,
      serviceSigners: report.serviceSigners,
      receiptSigner: report.receiptSigner,
    },
  };
}

export async function fetchProductionIdentityReport(urlInput: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let url: URL;
  try { url = new URL(urlInput); } catch { throw new Error("--url must be a valid HTTPS endpoint URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/production/identities") {
    throw new Error("--url must be an HTTPS URL ending in /production/identities with no credentials, query, or fragment");
  }
  const response = await fetchImpl(url, {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", cache: "no-store",
    redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`identity endpoint returned HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) throw new Error("identity response exceeds the size limit");
  if (!response.body) throw new Error("identity endpoint returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("identity response exceeds the size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error("identity endpoint returned invalid UTF-8"); }
  try { return JSON.parse(json) as unknown; }
  catch { throw new Error("identity endpoint returned invalid JSON"); }
}

export async function comparePreviousKeys(previousInput: unknown, current: IdentityReport): Promise<void> {
  const previous = assertReport(previousInput);
  const keys = (report: IdentityReport) => ({
    identities: Object.fromEntries(report.identities.map(({ name, address, encryptionPublicKey }) => [name, [address.toLowerCase(), encryptionPublicKey.toLowerCase()]])),
    serviceSigners: Object.fromEntries(report.serviceSigners.map(({ name, address }) => [name, address.toLowerCase()])),
    receiptSigner: report.receiptSigner.publicKey.toLowerCase(),
  });
  if (JSON.stringify(keys(previous)) !== JSON.stringify(keys(current))) throw new Error("production identity keys changed since the previous report");
}

export async function writeReportNoOverwrite(path: string, report: unknown): Promise<void> {
  const target = resolve(path);
  const file = await open(target, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" }); }
  finally { await file.close(); }
  // Keep reports private even when the process umask is permissive.
  await chmod(target, 0o600);
}

function assertReport(value: unknown): IdentityReport {
  if (!value || typeof value !== "object") throw new Error("identity endpoint payload must be an object");
  const obj = value as Record<string, unknown>;
  if (obj.ready !== true || !Number.isSafeInteger(obj.generatedAt) || !Array.isArray(obj.identities)
    || !Array.isArray(obj.serviceSigners) || !obj.receiptSigner || typeof obj.receiptSigner !== "object") {
    throw new Error("identity endpoint payload is incomplete or not ready");
  }
  if (obj.identities.length !== PRODUCTION_IDENTITY_SPECS.length || obj.serviceSigners.length !== PRODUCTION_SERVICE_SPECS.length) {
    throw new Error("identity endpoint payload has an unexpected roster size");
  }
  return value as IdentityReport;
}

function parseArgs(argv: string[]): { url: string; measurement: Hex; out?: string; previous?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!["--url", "--measurement", "--out", "--previous"].includes(arg) || values.has(arg)) throw new Error("usage: bun scripts/verify-production-identities.ts --url https://host/production/identities --measurement 0x<64-hex> [--out path] [--previous path]");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
  }
  const url = values.get("--url");
  const measurement = values.get("--measurement");
  if (!url || !measurement || !HEX32.test(measurement)) throw new Error("--url and a 32-byte --measurement are required");
  return { url, measurement: measurement as Hex, ...(values.has("--out") ? { out: values.get("--out")! } : {}), ...(values.has("--previous") ? { previous: values.get("--previous")! } : {}) };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const env: Env = { ...process.env, QUOTE_VERIFIER: "dcap" };
    const verifier = quoteVerifierFromEnv(env);
    const payload = await fetchProductionIdentityReport(args.url);
    const { report, summary } = await verifyProductionIdentityReport(payload, { expectedMeasurement: args.measurement, quoteVerifier: verifier });
    if (args.previous) await comparePreviousKeys(JSON.parse(await readFile(resolve(args.previous), "utf8")) as unknown, report);
    const persisted = { ...report, locallyVerifiedAt: summary.locallyVerifiedAt, expectedMeasurement: summary.expectedMeasurement };
    if (args.out) await writeReportNoOverwrite(args.out, persisted);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
