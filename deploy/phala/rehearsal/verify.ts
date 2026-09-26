import { docCommit, docHash, ZERO32 } from "@mochi/core";
import { aad, AttestationDocSchema, IntakeResultSchema } from "@mochi/protocol";
import { DcapQuoteVerifier, PcsCollateralSource, keyBinding, parseTdxQuote, parseTdxReportData, recoverProvenance, seal, tdxMeasurement, type Quote } from "@mochi/tee";
import { fromHex, type Hex } from "viem";

const REHEARSAL_CHAIN_ID = 31337;
const REHEARSAL_ESCROW = `0x${"00".repeat(20)}` as const;
const FIXTURE = "Synthetic hardware rehearsal document. It contains no user or production data.";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fail = (message: string): never => { throw new Error(message); };
const MAX_RESPONSE = 2 * 1024 * 1024;

function assertLocalOrTls(raw: string): URL {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) fail("Base URL must use HTTPS (HTTP is allowed only for loopback). ");
  if (url.username || url.password || url.search || url.hash) fail("Base URL must not include credentials, query, or fragment.");
  return url;
}

export function validatePinnedMeasurement(actual: string, expected: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(expected)) fail("An operator-pinned bytes32 measurement is required.");
  if (actual.toLowerCase() !== expected.toLowerCase()) fail("CVM measurement does not match the operator pin; upload was not attempted.");
}

export function parseVerifyArgs(args: string[]): { baseUrl: string; measurement: string } {
  let baseUrl = "http://127.0.0.1:8080";
  let baseUrlSet = false;
  let measurement: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && !baseUrlSet) {
      const value = args[++i];
      if (!value) throw new Error("--base-url requires a value.");
      baseUrl = value;
      baseUrlSet = true;
    } else if (args[i] === "--measurement" && !measurement) {
      measurement = args[++i];
    } else throw new Error("Unknown or duplicate verifier argument.");
  }
  if (!measurement || !/^0x[0-9a-fA-F]{64}$/u.test(measurement)) throw new Error("--measurement must be explicitly pinned as bytes32.");
  assertLocalOrTls(baseUrl);
  return { baseUrl, measurement };
}

async function boundedHttpsFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("HTTPS request rejected");
  const host = url.hostname.toLowerCase();
  const pcsHost = host === "api.trustedservices.intel.com" && /^\/(?:tdx|sgx)\/certification\/v4\//u.test(url.pathname);
  const rootHost = host === "certificates.trustedservices.intel.com" && url.pathname === "/IntelSGXRootCA.der";
  if (!pcsHost && !rootHost) throw new Error("Collateral host rejected");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok || response.redirected || !response.body) throw new Error("Collateral fetch failed");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE) throw new Error("Collateral response too large");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) { await reader.cancel(); throw new Error("Collateral response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  } finally { clearTimeout(timer); }
}

async function boundedEndpointFetch(url: URL, init?: RequestInit): Promise<Response> {
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Endpoint request rejected");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.redirected || !response.body) throw new Error("Endpoint response unavailable");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 128 * 1024) throw new Error("Endpoint response too large");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 128 * 1024) { await reader.cancel(); throw new Error("Endpoint response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  } finally { clearTimeout(timer); }
}

export async function verifyRehearsal(baseUrl = "http://127.0.0.1:8080", expectedMeasurement: string): Promise<Record<string, unknown>> {
  const base = assertLocalOrTls(baseUrl);
  if (!expectedMeasurement) fail("An operator-pinned measurement is required before verification.");
  const attestationResponse = await boundedEndpointFetch(new URL("/v1/attestation", base));
  if (!attestationResponse.ok) fail("Attestation endpoint did not return success.");
  const attestation = AttestationDocSchema.parse(await attestationResponse.json());
  const quote = attestation.quote;
  if (quote.kind !== "tdx") fail("Expected a TDX quote.");
  validatePinnedMeasurement(quote.measurement, expectedMeasurement);
  const typedQuote = quote as unknown as Quote;
  const publicKey = attestation.encryptionPubKey as Hex;
  const binding = keyBinding(attestation.address as Hex, publicKey);
  if (binding.toLowerCase() !== quote.reportData.toLowerCase()) fail("Quote key binding does not match the advertised identity.");
  const parsedQuote = parseTdxQuote(fromHex(quote.raw as Hex, "bytes"));
  const reportData = parseTdxReportData(parsedQuote.td.reportData);
  if (!reportData) throw new Error("TDX report data layout is invalid.");
  if (reportData.keyBinding.toLowerCase() !== binding.toLowerCase()) fail("TDX report data does not bind the advertised identity.");
  if (reportData.issuedAt !== quote.issuedAt) fail("TDX report timestamp does not match the quote metadata.");
  const measured = tdxMeasurement({ mrtd: parsedQuote.td.mrTd, rtmr: parsedQuote.td.rtmr });
  if (measured.toLowerCase() !== quote.measurement.toLowerCase() || measured.toLowerCase() !== attestation.measurement.toLowerCase()) fail("Quote measurement does not match its report registers.");
  const ageSec = Math.floor(Date.now() / 1000) - reportData.issuedAt;
  if (ageSec < -5 || ageSec > 300) fail("Quote is outside the 300-second freshness window.");
  const verifier = new DcapQuoteVerifier({
    collateral: new PcsCollateralSource({ fetch: boundedHttpsFetch as typeof fetch }),
    policy: { allowedStatuses: ["UpToDate"], rejectAdvisories: [], allowDebug: false },
  });
  const verification = await verifier.verify(typedQuote, { measurement: expectedMeasurement as Hex, reportData: binding, maxAgeSec: 300 });
  if (!verification.ok || verification.tcbStatus !== "UpToDate" || verification.advisoryIds.length !== 0) fail("Quote failed DCAP, TCB, advisory, debug, freshness, or key-binding verification.");

  const fixtureBytes = new TextEncoder().encode(FIXTURE);
  const expectedCommit = docCommit(ZERO32, docHash(fixtureBytes));
  const upload = {
    v: 1, schemaId: 7, salt: ZERO32,
    params: { question: "Does the synthetic fixture identify itself as a hardware rehearsal document?", answer_type: "BOOL" },
    contentType: "text/plain", docB64: Buffer.from(fixtureBytes).toString("base64"),
  };
  const envelope = seal(publicKey, encode(upload), aad.intake());
  const requestBody = JSON.stringify({ envelope });
  if (Buffer.byteLength(requestBody) > 32 * 1024) fail("Synthetic upload exceeds the server request limit.");
  const response = await boundedEndpointFetch(new URL("/v1/intake/upload", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: requestBody,
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) fail("Encrypted intake upload did not return success.");
  const result = IntakeResultSchema.parse(await response.json());
  if (result.docCommit.toLowerCase() !== expectedCommit.toLowerCase()) fail("Intake commitment does not match the synthetic upload.");
  if (result.intake.toLowerCase() !== attestation.address.toLowerCase()) fail("Upload was not handled by the attested intake identity.");
  const recovered = await recoverProvenance(REHEARSAL_CHAIN_ID, REHEARSAL_ESCROW, {
    docCommit: result.provenance.docCommit as Hex,
    kind: result.provenance.kind,
    originId: result.provenance.originId as Hex,
    fetchedAt: BigInt(result.provenance.fetchedAt),
    tokensK: result.provenance.tokensK,
    transcriptHash: result.provenance.transcriptHash as Hex,
  }, result.intakeSig as Hex);
  if (recovered.toLowerCase() !== attestation.address.toLowerCase()) fail("Intake provenance signature did not recover the advertised identity.");

  return {
    ok: true,
    identityAddress: attestation.address,
    measurement: attestation.measurement,
    quoteFreshnessSeconds: ageSec,
    identityKeyBinding: "matched",
    measurementRegisterBinding: "matched",
    intakeApiRoundTrip: "matched synthetic upload commitment and provenance signature",
    encryptedIntakeStore: "FileSealedStore (ciphertext only; tmpfs in this compose)",
    dcapCryptographicVerification: "valid; UpToDate; no advisories; debug disabled; operator measurement pin matched",
    fullProtocolAttestation: "not claimed",
  };
}

if (import.meta.main) {
  let parsed: ReturnType<typeof parseVerifyArgs> | undefined;
  try { parsed = parseVerifyArgs(Bun.argv.slice(2)); }
  catch {
    process.stderr.write("Usage: bun deploy/phala/rehearsal/verify.ts --measurement 0x<64 hex> [--base-url https://HOST]\n");
    process.exitCode = 2;
  }
  if (parsed) {
    try { process.stdout.write(`${JSON.stringify(await verifyRehearsal(parsed.baseUrl, parsed.measurement), null, 2)}\n`); }
    catch { process.stderr.write("Hardware rehearsal verification failed; response data is suppressed.\n"); process.exitCode = 1; }
  }
}
