import { createHash } from "node:crypto";
import { answerHash, canonicalJson, docCommit, docHash, verdictId, votesHash } from "@mochi/core";
import { aad, AttestationDocSchema, JurorAttestationDocSchema, PrivateResultPlainSchema, type JurorVoteJson } from "@mochi/protocol";
import { DcapQuoteVerifier, PcsCollateralSource, keyBinding, open, parseTdxQuote, parseTdxReportData, recoverProvenance, recoverJurorAnswer, recoverVerdictAttestation, seal, tdxMeasurement, type Quote } from "@mochi/tee";
import { fromHex, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { passportHash } from "@mochi/protocol";
import { ROUND_REHEARSAL_FIXTURE, ROUND_REHEARSAL_MODEL_OUTPUT } from "./round.ts";
import { normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { boundedHttpsFetch } from "../rehearsal/http.ts";
import { REAL_MODELS, REAL_ESTIMATED_COST_USD } from "./real-mode.ts";

const MAX_RESPONSE = 256 * 1024;
const MAX_REQUEST = 32 * 1024;
const FIXTURE_ESCROW = `0x${"00".repeat(20)}` as Address;
const EXPECTED_FIELDS = { answer: { t: "str", v: "42" } };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fail = (message: string): never => { throw new Error(message); };
const asRecord = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : fail("Round response malformed.");

function assertBaseUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) fail("Endpoint must use HTTPS (HTTP is allowed only for loopback).");
  if (url.username || url.password || url.search || url.hash) fail("Endpoint URL must not include credentials, query, or fragment.");
  return url;
}

export function parseRoundVerifyArgs(args: string[]): { baseUrl: string; measurement: Hex; mode: "synthetic" | "real-aci" } {
  let baseUrl = "http://127.0.0.1:8080", baseSet = false;
  let measurement: string | undefined;
  let mode: "synthetic" | "real-aci" = "synthetic";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && !baseSet) { const v = args[++i]; if (typeof v !== "string" || !v) fail("--base-url requires a value."); baseUrl = v as string; baseSet = true; }
    else if (args[i] === "--measurement" && !measurement) measurement = args[++i];
    else if (args[i] === "--mode" && mode === "synthetic") { const v = args[++i]; if (v !== "real-aci") fail("--mode only accepts real-aci when specified."); mode = "real-aci"; }
    else fail("Unknown or duplicate verifier argument.");
  }
  if (!measurement || !/^0x[0-9a-fA-F]{64}$/u.test(measurement)) fail("--measurement must be explicitly pinned as bytes32.");
  assertBaseUrl(baseUrl);
  return { baseUrl, measurement: measurement as Hex, mode };
}

export function validatePinnedMeasurement(actual: string, expected: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(expected) || actual.toLowerCase() !== expected.toLowerCase()) fail("CVM measurement pin mismatch; fixture was not submitted.");
}

async function boundedEndpointFetch(url: URL, init: RequestInit = {}, fetchImpl: typeof fetch = fetch, timeoutMs = 120_000): Promise<Response> {
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) fail("Endpoint request rejected.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.redirected || !response.body) fail("Endpoint response unavailable.");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE) fail("Endpoint response too large.");
    const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) { await reader.cancel(); fail("Endpoint response too large."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  } finally { clearTimeout(timer); }
}

export type RoundVerifyTestDependencies = { fetch: typeof fetch; verifyQuote: (quote: Quote, pin: Hex, binding: Hex) => Promise<{ ok: boolean; tcbStatus?: string; advisoryIds?: string[] }> };
function createProductionDeps(): RoundVerifyTestDependencies {
  const verifier = new DcapQuoteVerifier({ collateral: new PcsCollateralSource({ fetch: boundedHttpsFetch as typeof fetch }), policy: { allowedStatuses: ["UpToDate"], rejectAdvisories: ["*"], allowDebug: false } });
  return { fetch, async verifyQuote(quote, pin, binding) {
    const result = await verifier.verify(quote, { measurement: pin, reportData: binding, maxAgeSec: 300 });
    if (!result.ok) return { ok: false, tcbStatus: undefined, advisoryIds: [] };
    return { ...result, advisoryIds: result.advisoryIds };
  } };
}

async function checkAttestations(raw: unknown, pin: Hex, deps: RoundVerifyTestDependencies) {
  const all = asRecord(raw);
  const intake = AttestationDocSchema.parse(all.intake), consensus = AttestationDocSchema.parse(all.consensus);
  if (!Array.isArray(all.jurors) || all.jurors.length !== 3) fail("Expected three juror attestations.");
  const jurors = (all.jurors as unknown[]).map((v: unknown) => JurorAttestationDocSchema.parse(v));
  const docs = [intake, consensus, ...jurors];
  if (intake.role !== "INTAKE" || consensus.role !== "CONSENSUS" || jurors.some(x => x.role !== "JUROR")) fail("Attestation roles do not match the rehearsal topology.");
  if (jurors.some((juror, seat) => juror.jurorClass !== [0, 2, 4][seat])) fail("Juror classes do not match the expected N3 panel.");
  const addresses = docs.map(x => x.address.toLowerCase()), keys = docs.map(x => x.encryptionPubKey.toLowerCase());
  if (new Set(addresses).size !== 5 || new Set(keys).size !== 5) fail("Attestation identities and keys must be five distinct values.");
  const measurements = new Set(docs.map(x => x.measurement.toLowerCase()));
  if (measurements.size !== 1) fail("Rehearsal identities do not share one CVM measurement.");
  validatePinnedMeasurement(intake.measurement, pin);
  for (const doc of docs) {
    const quote = doc.quote as unknown as Quote;
    if (quote.kind !== "tdx") fail("Every identity must provide a TDX quote.");
    validatePinnedMeasurement(quote.measurement, pin);
    const binding = keyBinding(doc.address as Address, doc.encryptionPubKey as Hex);
    if (quote.reportData.toLowerCase() !== binding.toLowerCase()) fail("Quote identity binding mismatch.");
    const parsed = parseTdxQuote(fromHex(quote.raw as Hex, "bytes"));
    const report = parseTdxReportData(parsed.td.reportData) as { keyBinding: Hex; issuedAt: number } | undefined;
    if (!report) fail("TDX report data identity binding mismatch.");
    if (report!.keyBinding.toLowerCase() !== binding.toLowerCase() || report!.issuedAt !== quote.issuedAt) fail("TDX report data identity binding mismatch.");
    const measurement = tdxMeasurement({ mrtd: parsed.td.mrTd, rtmr: parsed.td.rtmr });
    if (measurement.toLowerCase() !== pin.toLowerCase() || measurement.toLowerCase() !== doc.measurement.toLowerCase()) fail("TDX measurement register mismatch.");
    const age = Math.floor(Date.now() / 1000) - report!.issuedAt;
    if (age < -5 || age > 300) fail("TDX quote freshness check failed.");
    const checked = await deps.verifyQuote(quote, pin, binding);
    if (!checked.ok || checked.tcbStatus !== "UpToDate" || (checked.advisoryIds?.length ?? 0) !== 0) fail("TDX DCAP verification failed.");
  }
  return { intake, consensus, jurors };
}

async function verifyRound(baseUrl: string, pin: Hex, deps: RoundVerifyTestDependencies, mode: "synthetic" | "real-aci" = "synthetic", roundAuthSecret?: string): Promise<Record<string, unknown>> {
  const base = assertBaseUrl(baseUrl);
  // Fetch and fully verify all five real TDX identities before creating or submitting any fixture data.
  const attestRes = await boundedEndpointFetch(new URL("/v1/attestations", base), {}, deps.fetch, 40_000);
  if (!attestRes.ok) fail("Attestation endpoint did not return success.");
  const attestations = await checkAttestations(await attestRes.json(), pin, deps);

  const fixture = ROUND_REHEARSAL_FIXTURE;
  const payerSecret = crypto.getRandomValues(new Uint8Array(32));
  const payerPub = (await import("@noble/curves/ed25519.js")).x25519.getPublicKey(payerSecret);
  const payerPubHex = `0x${Array.from(payerPub, b => b.toString(16).padStart(2, "0")).join("")}` as Hex;
  const docBytes = new TextEncoder().encode(fixture.evidence);
  const expectedDocCommit = docCommit(fixture.salt as Hex, docHash(docBytes));
  const normalizedParams = normalizeParams(resolveSchema(fixture.schemaId as never, fixture.params), fixture.params);
  if (normalizedParams.ok !== true) fail("Fixed fixture parameters failed schema normalization.");
  const expectedParamsHash = paramsHash((normalizedParams as { ok: true; params: Record<string, never> }).params as never);
  const upload = { v: 1, schemaId: fixture.schemaId, salt: fixture.salt, params: fixture.params, contentType: "text/plain", docB64: Buffer.from(docBytes).toString("base64") };
  const envelope = seal(attestations.intake.encryptionPubKey as Hex, encode(upload), aad.intake());
  const body = JSON.stringify({ envelope, payerResultPubKey: payerPubHex });
  if (Buffer.byteLength(body) > MAX_REQUEST) fail("Synthetic round request exceeds the request limit.");
  const response = await boundedEndpointFetch(new URL("/v1/rehearsal/round", base), { method: "POST", headers: { "content-type": "application/json", ...(mode === "real-aci" && roundAuthSecret ? { authorization: `Bearer ${roundAuthSecret}` } : {}) }, body }, deps.fetch, 120_000);
  if (!response.ok) fail("Encrypted private round did not return success.");
  const result = asRecord(await response.json()), intake = asRecord(result.intake), decision = asRecord(result.decision);
  let reportedReceipts: unknown[] = [];
  if (mode === "real-aci") {
    if (!roundAuthSecret || !result.realInference || result.realInference.provider !== "phala-aci" || JSON.stringify(result.realInference.models) !== JSON.stringify(REAL_MODELS) || result.realInference.estimatedCostUsd !== REAL_ESTIMATED_COST_USD || result.realInference.costEstimateBasis !== "catalog token rates; requested max_tokens and input-byte reservation; actual provider usage may differ" || result.realInference.receiptVerification !== "server-side ACI verification; response metadata is not an independent proof") fail("Real inference metadata is missing or does not match the pinned run.");
    const receipts = result.realInference.receipts;
    if (!Array.isArray(receipts) || receipts.length !== 3) fail("Expected three real provider receipts.");
    reportedReceipts = receipts;
    for (let i = 0; i < 3; i++) {
      const receipt = asRecord(receipts[i]);
      if (receipt.seat !== i || receipt.modelId !== REAL_MODELS[i] || typeof receipt.receiptId !== "string" || !receipt.receiptId || typeof receipt.sessionId !== "string" || !receipt.sessionId || typeof receipt.workloadId !== "string" || !receipt.workloadId || receipt.verification !== "ACI client verified provider signature and exact request/response body hashes in server process") fail("Provider receipt metadata did not match the allowed model set.");
    }
  }
  if (intake.docCommit?.toLowerCase() !== expectedDocCommit.toLowerCase() || intake.paramsHash?.toLowerCase() !== expectedParamsHash.toLowerCase()) fail("Intake fixture commitment mismatch.");
  if (intake.identity?.toLowerCase() !== attestations.intake.address.toLowerCase()) fail("Intake provenance identity mismatch.");
  const provenance = asRecord(intake.provenance);
  if (provenance.kind !== 0 || provenance.tokensK !== 1 || !/^0x[0-9a-f]{64}$/.test(provenance.originId) || !/^0x[0-9a-f]{64}$/.test(provenance.transcriptHash) || !/^\d+$/.test(provenance.fetchedAt)) fail("Intake provenance is malformed.");
  const recoveredIntake = await recoverProvenance(fixture.chainId, FIXTURE_ESCROW, { docCommit: expectedDocCommit, kind: provenance.kind, originId: provenance.originId, fetchedAt: BigInt(provenance.fetchedAt), tokensK: provenance.tokensK, transcriptHash: provenance.transcriptHash }, intake.intakeSig as Hex);
  if (recoveredIntake.toLowerCase() !== attestations.intake.address.toLowerCase()) fail("Intake provenance signature mismatch.");

  const id = verdictId(fixture.queryId as Hex, 0);
  if (decision.verdictId?.toLowerCase() !== id.toLowerCase() || decision.public !== undefined || !decision.privateResult) fail("Decision is not the expected private round result.");
  const vi = asRecord(decision.verdictInput);
  if (vi.queryId?.toLowerCase() !== fixture.queryId.toLowerCase() || vi.round !== 0 || vi.status !== 1 || vi.timeoutMask !== 0 || vi.agreementBps !== 10_000 || vi.dissentMask !== 0) fail("Verdict is not a completed synthetic round.");
  if (!Array.isArray(decision.votes) || decision.votes.length !== 3) fail("Expected three signed juror votes.");
  const votes = decision.votes.map((v: unknown) => asRecord(v));
  const expectedJurors = attestations.jurors.map((j: { address: string }) => j.address.toLowerCase());
  for (let i = 0; i < votes.length; i++) {
    const vote = votes[i]!;
    if (vote.juror?.toLowerCase() !== expectedJurors[i]) fail("Vote signer does not match its attested juror seat.");
    const recovered = await recoverJurorAnswer(fixture.chainId, fixture.verdictsAddress as Address, { queryId: fixture.queryId as Hex, docCommit: expectedDocCommit, schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, answerHash: vote.answerHash as Hex, spansRoot: vote.spansRoot as Hex, quoteHash: vote.quoteHash as Hex }, vote.sig as Hex);
    if (recovered.toLowerCase() !== expectedJurors[i]) fail("Juror vote signature mismatch.");
  }
  const votesDigest = votesHash(votes.map((v: Record<string, any>) => ({ juror: v.juror as Address, answerHash: v.answerHash as Hex, spansRoot: v.spansRoot as Hex, quoteHash: v.quoteHash as Hex })));
  const recoveredConsensus = await recoverVerdictAttestation(fixture.chainId, fixture.verdictsAddress as Address, vi as never, votesDigest, decision.consensusSig as Hex);
  if (recoveredConsensus.toLowerCase() !== attestations.consensus.address.toLowerCase()) fail("Consensus decision signature mismatch.");
  const decisionHash = answerHash({ salt: fixture.salt as Hex, schemaId: fixture.schemaId as never, schemaVersion: fixture.schemaVersion, fields: EXPECTED_FIELDS as never });
  if (vi.answerHash?.toLowerCase() !== decisionHash.toLowerCase() || votes.some((v: Record<string, any>) => v.answerHash?.toLowerCase() !== decisionHash.toLowerCase())) fail("Decision answer hash does not match the fixed fixture answer.");
  if (result.fixture?.chainId !== 31337 || result.fixture?.queryId !== fixture.queryId || result.fixture?.schemaId !== fixture.schemaId || result.fixture?.schemaVersion !== fixture.schemaVersion || result.fixture?.verdictsAddress?.toLowerCase() !== fixture.verdictsAddress.toLowerCase() || result.fixture?.sourceProvenance !== "SUBMITTED") fail("Response fixture identity mismatch.");

  const plainBytes = open(payerSecret, decision.privateResult, aad.result(id));
  const privateResult = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(plainBytes)));
  if (privateResult.verdictId.toLowerCase() !== id.toLowerCase() || privateResult.salt.toLowerCase() !== fixture.salt.toLowerCase()) fail("Private result body mismatch.");
  const parsedAnswer = JSON.parse(privateResult.answerJson);
  if (answerHash({ salt: parsedAnswer.salt, schemaId: parsedAnswer.schemaId, schemaVersion: parsedAnswer.schemaVersion, fields: parsedAnswer.fields }) !== vi.answerHash) fail("Private answer hash mismatch.");
  const field = privateResult.fields[0];
  if (privateResult.fields.length !== 1 || field?.field !== "answer" || field.required !== true || field.agreeBps !== 10_000 || field.hung) fail("Private result does not contain the expected answer.");
  if (privateResult.answerJson !== canonicalJson({ salt: fixture.salt, schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, fields: EXPECTED_FIELDS }) || JSON.stringify(field?.value) !== JSON.stringify(EXPECTED_FIELDS.answer) || ROUND_REHEARSAL_MODEL_OUTPUT.fields.answer !== "42") fail("Private result does not contain the expected fixed-fixture answer.");
  if (keccak256(privateResult.payload as Hex).toLowerCase() !== String(vi.payloadHash).toLowerCase()) fail("Private payload hash mismatch.");
  let realModelPassports: unknown;
  if (mode === "real-aci") {
    const post = await boundedEndpointFetch(new URL("/v1/attestations", base), {}, deps.fetch, 40_000);
    if (!post.ok) fail("Post-inference attestation endpoint did not return success.");
    const postDocs = await checkAttestations(await post.json(), pin, deps);
    realModelPassports = await Promise.all(postDocs.jurors.map(async (doc, index) => {
      if (doc.passport.provider !== "phala-aci" || !doc.passport.modelId.includes(`${REAL_MODELS[index]} [receipt=`) || !doc.passport.modelId.includes(";session=") || !doc.passport.modelId.includes(";workload=")) fail("Post-inference signed model passport is missing expected receipt metadata.");
      if ((doc.passport.weightsSha256 as string) !== `0x${"00".repeat(32)}` || doc.passport.openWeights !== false || doc.passport.zdr !== false) fail("Model passport contains unsupported provider or weights claims.");
      const signer = await recoverMessageAddress({ message: { raw: passportHash(doc.passport) }, signature: doc.passportSig as Hex });
      if (signer.toLowerCase() !== doc.address.toLowerCase()) fail("Post-inference model passport signature mismatch.");
      const metadata = asRecord(reportedReceipts[index]);
      const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
      if (typeof metadata.receiptId !== "string" || typeof metadata.sessionId !== "string" || typeof metadata.workloadId !== "string" || !doc.passport.modelId.includes(`${REAL_MODELS[index]} [receipt=${digest(metadata.receiptId)};session=${digest(metadata.sessionId)};workload=${digest(metadata.workloadId)}]`)) fail("Signed model passport does not bind to the returned receipt metadata.");
      return { seat: index, modelId: doc.passport.modelId, weightsHash: "unavailable; all-zero sentinel", openWeights: "not claimed", zdr: "not claimed" };
    }));
  }
  return {
    ok: true,
    verifiedIdentities: 5,
    rolesAndDistinctKeys: "matched",
    tdxDcap: "fresh; UpToDate; no advisories; debug disabled",
    pinnedMeasurement: "matched",
    enclaveTopology: "five identities share one pinned CVM measurement; co-resident keys, not independent enclaves",
    intakeCommitmentAndProvenance: "matched synthetic fixture and signature",
    jurorVotesAndConsensusSignature: "matched fixed query, schema, answer hash, and signer identities",
    privateCiphertext: mode === "synthetic" ? "decrypted by ephemeral payer key; answer hash and expected synthetic answer matched" : "decrypted by ephemeral payer key; model result was produced by the bounded real-ACI test",
    ...(mode === "real-aci" ? { realInference: { models: REAL_MODELS, passports: realModelPassports, providerReceipts: "verified by server ACI client; client sees signed passport metadata but does not independently verify provider receipt proofs" } } : {}),
    limitations: ["chainId 31337 with synthetic contract domains", mode === "synthetic" ? "synthetic model output" : "fixed public synthetic evidence; real provider inference; server-side receipt proof verification only", "co-resident keys", "no production enrollment, payment, settlement, or model independence"],
  };
}

/** Test-only injection seam. The CLI uses production dependencies directly and cannot enable this seam. */
export function verifyRoundRehearsalWithTestDependencies(baseUrl: string, expectedMeasurement: Hex, deps: RoundVerifyTestDependencies, mode: "synthetic" | "real-aci" = "synthetic", roundAuthSecret?: string): Promise<Record<string, unknown>> {
  return verifyRound(baseUrl, expectedMeasurement, deps, mode, roundAuthSecret);
}
export function verifyRoundRehearsal(baseUrl: string, expectedMeasurement: Hex, mode: "synthetic" | "real-aci" = "synthetic", roundAuthSecret?: string): Promise<Record<string, unknown>> {
  return verifyRound(baseUrl, expectedMeasurement, createProductionDeps(), mode, roundAuthSecret);
}

if (import.meta.main) {
  let args: ReturnType<typeof parseRoundVerifyArgs> | undefined;
  try { args = parseRoundVerifyArgs(Bun.argv.slice(2)); }
  catch { process.stderr.write("Usage: bun deploy/phala/round-rehearsal/verify.ts --measurement 0x<64 hex> [--base-url https://HOST]\n"); process.exitCode = 2; }
  if (args) try { process.stdout.write(`${JSON.stringify(await verifyRoundRehearsal(args.baseUrl, args.measurement, args.mode, args.mode === "real-aci" ? process.env.MOCHI_ROUND_AUTH_SECRET : undefined), null, 2)}\n`); }
  catch { process.stderr.write("Confidential round rehearsal verification failed; response data is suppressed.\n"); process.exitCode = 1; }
}
