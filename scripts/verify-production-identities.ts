import { open, readFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DSTACK_RUNTIME_EVENT_TYPE, dstackMrConfigIdV1, dstackMrConfigIdV2, dstackMrConfigIdV3, dstackMrConfigV3Document,
  dstackMrConfigVersion, dstackRuntimeEventDigest, keyBinding, parseTdxQuote, quoteHash, quoteVerifierFromEnv,
  replayDstackRtmr3, type DstackKeyProvider, type DstackRuntimeEvent, type Env, type Quote, type QuoteVerifier, type TdReport,
} from "@mochi/tee";
import { sha256 } from "@noble/hashes/sha2.js";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_RECEIPT_SIGNING_SPEC, PRODUCTION_SERVICE_SPECS } from "../deploy/phala/production-identities/identities.ts";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";

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
  identities: Array<{
    name: string; role: string; jurorClass?: number; jurorSeat?: number; address: Address; encryptionPublicKey: Hex; keyBinding: Hex;
    measurement: Hex; quoteHash: Hex; issuedAt: number; verified: true;
    /** dstack MRCONFIGID version byte (0 = no config id) and register, present whenever the raw quote parses. */
    configVersion?: number; mrConfigId?: Hex;
  }>;
  serviceSigners: ServiceSigner[];
  receiptSigner: { name: string; publicKey: Hex };
  configBinding?: ConfigBindingSummary;
};

/**
 * Offline recomputation of the quoted MRCONFIGID. `attestation` is `phala cvms attestation <app-id> --json` from the
 * same boot as the identity report: its RTMR3 event log is replayed and must equal the RTMR3 of every DCAP-verified
 * quote, which authenticates the app-id, compose-hash, instance-id and key-provider boot events and the app-compose.
 */
export type ConfigBindingInput = {
  attestation: unknown;
  /** Expected dstack app id (20 bytes hex). */
  appId?: string;
  /** Expected key provider id: the KMS root CA SubjectPublicKeyInfo DER (hex). */
  keyProviderId?: string;
  /** Exact docker compose text the app-compose must carry. */
  reviewedCompose?: string;
};

export type ConfigBindingSummary = {
  configVersion: number; mrConfigId: Hex; composeHash: Hex; appId: Hex; instanceId: Hex;
  keyProvider: { name: string; id: Hex }; composeKeyProvider: DstackKeyProvider; composeKeyProviderId: Hex;
  rtmr3: Hex; reviewedComposeMatches?: true;
};

export async function verifyProductionIdentityReport(
  payload: unknown,
  options: {
    expectedMeasurement: Hex; quoteVerifier: QuoteVerifier; now?: () => number;
    /** Fail unless every quote's MRCONFIGID version is one of these (e.g. [2, 3] to require app and KMS binding). */
    requireConfigVersions?: readonly number[];
    configBinding?: ConfigBindingInput;
  },
): Promise<{ report: IdentityReport; summary: ProductionIdentitySummary }> {
  if (!HEX32.test(options.expectedMeasurement)) throw new Error("expected measurement must be bytes32 hex");
  const requireVersions = options.requireConfigVersions;
  if (requireVersions && (requireVersions.length === 0 || requireVersions.some((version) => ![1, 2, 3].includes(version)))) {
    throw new Error("required config versions must be a non-empty subset of 1, 2, 3");
  }
  const needRegisters = requireVersions !== undefined || options.configBinding !== undefined;
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
    let td: TdReport | undefined;
    try { td = parseTdxQuote(hexToBytes(quote.raw)).td; }
    catch { if (needRegisters) throw new Error(`identity ${spec.name} quote cannot be parsed for its config identity`); }
    if (td && requireVersions) {
      let version: number;
      try { version = dstackMrConfigVersion(td.mrConfigId); } catch { version = td.mrConfigId[0]!; }
      if (!requireVersions.includes(version)) {
        throw new Error(`identity ${spec.name} has dstack config version ${version}; required ${requireVersions.join(" or ")}`);
      }
    }
    const { quote: _quote, ...publicIdentity } = identity;
    return {
      identity: {
        ...publicIdentity,
        quoteHash: quoteHash(quote),
        issuedAt: quote.issuedAt,
        verified: true as const,
        ...(td ? { configVersion: td.mrConfigId.every((byte) => byte === 0) ? 0 : td.mrConfigId[0]!, mrConfigId: bytesToHex(td.mrConfigId) } : {}),
      },
      td,
    };
  }));
  const configBinding = options.configBinding
    ? verifyConfigBinding(identities.map(({ td }) => td!), options.configBinding)
    : undefined;

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
      identities: identities.map(({ identity }) => identity),
      serviceSigners: report.serviceSigners,
      receiptSigner: report.receiptSigner,
      ...(configBinding ? { configBinding } : {}),
    },
  };
}

const HEX_BYTES = /^(?:0x)?((?:[0-9a-fA-F]{2})*)$/u;
function hexInput(value: unknown, name: string, length?: number): Uint8Array {
  const match = typeof value === "string" ? HEX_BYTES.exec(value) : null;
  if (!match) throw new Error(`${name} must be hex`);
  const bytes = hexToBytes(`0x${match[1]}`);
  if (length !== undefined && bytes.length !== length) throw new Error(`${name} must be ${length} bytes`);
  return bytes;
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** dstack AppCompose::key_provider(): explicit key_provider, else kms_enabled, else local_key_provider_enabled. */
function composeKeyProvider(compose: Record<string, unknown>): DstackKeyProvider {
  const explicit = compose.key_provider;
  if (explicit !== undefined && explicit !== null) {
    if (explicit !== "none" && explicit !== "kms" && explicit !== "local" && explicit !== "tpm") throw new Error("app-compose key_provider is unknown");
    return explicit;
  }
  return compose.kms_enabled === true ? "kms" : compose.local_key_provider_enabled === true ? "local" : "none";
}

export function verifyConfigBinding(quotes: readonly TdReport[], input: ConfigBindingInput): ConfigBindingSummary {
  const attestation = input.attestation as { tcb_info?: { app_compose?: unknown; event_log?: unknown } } | null;
  const appComposeText = attestation?.tcb_info?.app_compose;
  const eventLog = attestation?.tcb_info?.event_log;
  if (typeof appComposeText !== "string" || !Array.isArray(eventLog)) throw new Error("attestation must carry tcb_info.app_compose and tcb_info.event_log");
  if (quotes.length === 0) throw new Error("config binding needs at least one quote");

  const events: DstackRuntimeEvent[] = eventLog.filter((entry) => (entry as { imr?: unknown })?.imr === 3).map((entry) => {
    const { event_type: type, event, event_payload: payload, digest } = entry as Record<string, unknown>;
    if (type !== DSTACK_RUNTIME_EVENT_TYPE || typeof event !== "string") throw new Error("attestation RTMR3 event log has an unexpected event");
    const runtimeEvent = { event, payload: hexInput(payload, `event ${event} payload`) };
    if (digest !== undefined && !sameBytes(hexInput(digest, `event ${event} digest`), dstackRuntimeEventDigest(runtimeEvent))) {
      throw new Error(`attestation event ${event} digest does not match its payload`);
    }
    return runtimeEvent;
  });
  const rtmr3 = replayDstackRtmr3(events);
  if (quotes.some((td) => !sameBytes(td.rtmr[3], rtmr3))) {
    throw new Error("attestation event log does not replay to the quoted RTMR3; fetch it from the same boot as the identity report");
  }
  const single = (name: string): Uint8Array => {
    const found = events.filter(({ event }) => event === name);
    if (found.length !== 1) throw new Error(`attestation must carry exactly one ${name} event`);
    return found[0]!.payload;
  };
  const appId = single("app-id");
  const eventComposeHash = single("compose-hash");
  const instanceId = single("instance-id");
  if (appId.length !== 20 || eventComposeHash.length !== 32 || (instanceId.length !== 0 && instanceId.length !== 20)) {
    throw new Error("attestation boot events have unexpected lengths");
  }
  let keyProvider: { name: string; id: Hex };
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(single("key-provider"))) as { name?: unknown; id?: unknown };
    if (typeof parsed.name !== "string") throw new Error();
    keyProvider = { name: parsed.name, id: bytesToHex(hexInput(parsed.id, "key-provider id")) };
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("attestation") ? error : new Error("attestation key-provider event is malformed");
  }

  const composeHash = sha256(new TextEncoder().encode(appComposeText));
  if (!sameBytes(composeHash, eventComposeHash)) throw new Error("attested app-compose does not hash to the compose-hash boot event");
  if (input.appId !== undefined && !sameBytes(hexInput(input.appId, "expected app id", 20), appId)) throw new Error("quoted app id does not match the expected app id");
  let expectedKeyProviderId: Uint8Array | undefined;
  if (input.keyProviderId !== undefined) {
    expectedKeyProviderId = hexInput(input.keyProviderId, "expected key provider id");
    if (expectedKeyProviderId.length === 0) throw new Error("expected key provider id must be nonempty");
    if (keyProvider.name !== "kms" || !sameBytes(hexToBytes(keyProvider.id), expectedKeyProviderId)) {
      throw new Error("quoted key provider does not match the expected KMS");
    }
  }

  let compose: Record<string, unknown>;
  try { compose = JSON.parse(appComposeText) as Record<string, unknown>; } catch { throw new Error("attested app-compose is not JSON"); }
  if (!compose || typeof compose !== "object") throw new Error("attested app-compose is not an object");
  const kind = composeKeyProvider(compose);
  const composeKeyProviderId = compose.key_provider_id === undefined || compose.key_provider_id === null ? new Uint8Array() : hexInput(compose.key_provider_id, "app-compose key_provider_id");
  if (composeKeyProviderId.length > 0) {
    if (!sameBytes(composeKeyProviderId, hexToBytes(keyProvider.id))) throw new Error("app-compose key_provider_id does not match the key-provider boot event");
    if (expectedKeyProviderId && !sameBytes(composeKeyProviderId, expectedKeyProviderId)) throw new Error("app-compose key_provider_id does not match the expected KMS");
  }
  let reviewedComposeMatches: true | undefined;
  if (input.reviewedCompose !== undefined) {
    if (compose.docker_compose_file !== input.reviewedCompose) throw new Error("attested docker compose differs from the reviewed compose");
    reviewedComposeMatches = true;
  }

  const expectedFor = (version: number): Uint8Array => {
    if (version === 1) return dstackMrConfigIdV1(composeHash);
    if (version === 2) return dstackMrConfigIdV2({ composeHash, appId, keyProvider: kind, keyProviderId: composeKeyProviderId });
    if (version === 3) {
      const manifest = Number(compose.manifest_version);
      const scripts = compose.init_script ?? [];
      if (!Array.isArray(scripts) || scripts.some((script) => typeof script !== "string")) throw new Error("app-compose init_script must be a list of strings");
      return dstackMrConfigIdV3(dstackMrConfigV3Document({
        appId, composeHash, keyProvider: kind, keyProviderId: composeKeyProviderId,
        instanceId: compose.no_instance_id === true ? new Uint8Array() : instanceId,
        ...(manifest >= 3 ? { initScriptHashes: (scripts as string[]).map((script) => sha256(new TextEncoder().encode(script))) } : {}),
      }));
    }
    throw new Error(`dstack config version ${version} cannot be recomputed`);
  };
  const register = quotes[0]!.mrConfigId;
  const version = dstackMrConfigVersion(register);
  if (quotes.some((td) => !sameBytes(td.mrConfigId, register))) throw new Error("quotes carry different MRCONFIGID registers");
  if (!sameBytes(expectedFor(version), register)) {
    throw new Error(`quoted MRCONFIGID (version ${version}) does not match the attested app-compose, app id and key provider`);
  }
  return {
    configVersion: version, mrConfigId: bytesToHex(register), composeHash: bytesToHex(composeHash), appId: bytesToHex(appId),
    instanceId: bytesToHex(instanceId), keyProvider, composeKeyProvider: kind, composeKeyProviderId: bytesToHex(composeKeyProviderId),
    rtmr3: bytesToHex(rtmr3), ...(reviewedComposeMatches ? { reviewedComposeMatches } : {}),
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

const USAGE = "usage: bun scripts/verify-production-identities.ts --url https://host/production/identities --measurement 0x<64-hex>"
  + " [--out path] [--previous path] [--require-config-version 2,3]"
  + " [--attestation attestation.json [--app-id <40-hex>] [--key-provider-id <hex>] [--reviewed-compose compose.yml]]";
const FLAGS = ["--url", "--measurement", "--out", "--previous", "--require-config-version", "--attestation", "--app-id", "--key-provider-id", "--reviewed-compose"];

export type VerifyArgs = {
  url: string; measurement: Hex; out?: string; previous?: string; requireConfigVersions?: number[];
  attestation?: string; appId?: string; keyProviderId?: string; reviewedCompose?: string;
};

export function parseArgs(argv: string[]): VerifyArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!FLAGS.includes(arg) || values.has(arg)) throw new Error(USAGE);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
  }
  const url = values.get("--url");
  const measurement = values.get("--measurement");
  if (!url || !measurement || !HEX32.test(measurement)) throw new Error("--url and a 32-byte --measurement are required");
  const required = values.get("--require-config-version");
  let requireConfigVersions: number[] | undefined;
  if (required !== undefined) {
    requireConfigVersions = required.split(",").map((part) => (/^[123]$/u.test(part.trim()) ? Number(part.trim()) : Number.NaN));
    if (requireConfigVersions.some(Number.isNaN)) throw new Error("--require-config-version takes a comma-separated list of 1, 2 and 3");
  }
  if (!values.has("--attestation") && ["--app-id", "--key-provider-id", "--reviewed-compose"].some((flag) => values.has(flag))) {
    throw new Error("--app-id, --key-provider-id and --reviewed-compose need --attestation");
  }
  const optional = (flag: string, key: keyof VerifyArgs) => (values.has(flag) ? { [key]: values.get(flag)! } : {});
  return {
    url, measurement: measurement as Hex,
    ...optional("--out", "out"), ...optional("--previous", "previous"), ...(requireConfigVersions ? { requireConfigVersions } : {}),
    ...optional("--attestation", "attestation"), ...optional("--app-id", "appId"), ...optional("--key-provider-id", "keyProviderId"),
    ...optional("--reviewed-compose", "reviewedCompose"),
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const env: Env = { ...process.env, QUOTE_VERIFIER: "dcap" };
    const verifier = quoteVerifierFromEnv(env);
    const configBinding: ConfigBindingInput | undefined = args.attestation === undefined ? undefined : {
      attestation: JSON.parse(await readFile(resolve(args.attestation), "utf8")) as unknown,
      ...(args.appId !== undefined ? { appId: args.appId } : {}),
      ...(args.keyProviderId !== undefined ? { keyProviderId: args.keyProviderId } : {}),
      ...(args.reviewedCompose !== undefined ? { reviewedCompose: await readFile(resolve(args.reviewedCompose), "utf8") } : {}),
    };
    const payload = await fetchProductionIdentityReport(args.url);
    const { report, summary } = await verifyProductionIdentityReport(payload, {
      expectedMeasurement: args.measurement, quoteVerifier: verifier,
      ...(args.requireConfigVersions ? { requireConfigVersions: args.requireConfigVersions } : {}),
      ...(configBinding ? { configBinding } : {}),
    });
    if (args.previous) await comparePreviousKeys(JSON.parse(await readFile(resolve(args.previous), "utf8")) as unknown, report);
    const persisted = {
      ...report, locallyVerifiedAt: summary.locallyVerifiedAt, expectedMeasurement: summary.expectedMeasurement,
      ...(summary.configBinding ? { configBinding: summary.configBinding } : {}),
    };
    if (args.out) await writeReportNoOverwrite(args.out, persisted);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
