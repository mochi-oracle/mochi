import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { answerHash, canonicalJson, docCommit, docHash, privatePayloadHash, ZERO32, votesHash, verdictId } from "@mochi/core";
import { aad, passportHash, payerCommit, provenanceFromJson, type ProvenanceJson } from "@mochi/protocol";
import { keyBinding, open, seal, signJurorAnswer, signProvenance, signVerdictAttestation, tdxMeasurement, type Quote } from "@mochi/tee";
import { privateKeyToAccount } from "viem/accounts";
import { fromHex, keccak256, toHex, type Hex } from "viem";
import { ROUND_REHEARSAL_FIXTURE } from "./round.ts";
import { getLastVerifierDiagnosticForTests, parseRoundVerifyArgs, validatePinnedMeasurement, verifyRoundRehearsalWithTestDependencies, type RoundVerifyTestDependencies } from "./verify.ts";
import { REAL_ESTIMATED_COST_USD, REAL_MODELS } from "./real-mode.ts";

const accounts = [1, 2, 3, 4, 5].map(i => privateKeyToAccount((`0x${String(i).padStart(64, "0")}`) as Hex));
const rawPath = new URL("../../../packages/tee/test/fixtures/intel-tdx/tdx_quote", import.meta.url);
const measurementPin = async () => {
  const raw = new Uint8Array(await readFile(rawPath));
  const quote = (await import("@mochi/tee")).parseTdxQuote(raw);
  return { raw, parsed: quote, measurement: tdxMeasurement({ mrtd: quote.td.mrTd, rtmr: quote.td.rtmr }) };
};

/** Encryption secret of the last fixture intake identity, so the fake server can open what the verifier sealed. */
let intakeSecret: Uint8Array | undefined;
async function fixtureAttestations(opts: { badIdentity?: boolean; badMeasurement?: boolean; badJurorClass?: boolean; realModels?: boolean } = {}) {
  const { raw: source, parsed, measurement } = await measurementPin();
  const issuedAt = Math.floor(Date.now() / 1000) - 10;
  const docs: any[] = [];
  for (let i = 0; i < 5; i++) {
    const account = accounts[i]!;
    const encSecret = crypto.getRandomValues(new Uint8Array(32));
    const encPub = toHex((await import("@noble/curves/ed25519.js")).x25519.getPublicKey(encSecret));
    if (i === 0) intakeSecret = encSecret;
    const bind = keyBinding(account.address, encPub);
    const raw = source.slice();
    const reportData = new Uint8Array(64);
    reportData.set(fromHex(bind, "bytes"));
    new DataView(reportData.buffer).setBigUint64(32, BigInt(issuedAt), false);
    raw.set(reportData, parsed.signed.length - 64);
    const q: Quote = { kind: "tdx", measurement, reportData: bind, raw: toHex(raw), issuedAt };
    const role = i === 0 ? "INTAKE" : i === 1 ? "CONSENSUS" : "JUROR";
    const jurorClass = opts.badJurorClass && i === 3 ? 1 : [0, 2, 4][i - 2];
    const receiptId = `receipt-${i}`, sessionId = `session-${i}`, workloadId = `workload-${i}`;
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
    const passport = role === "JUROR" ? {
      v: 1, juror: account.address.toLowerCase(), jurorClass,
      modelId: opts.realModels ? `${REAL_MODELS[i - 2]} [receipt=${digest(receiptId)};session=${digest(sessionId)};workload=${digest(workloadId)}]` : `fake-${i}`,
      lineage: opts.realModels ? REAL_MODELS[i - 2]!.split('/')[0]! : "synthetic",
      weightsSha256: opts.realModels ? `0x${"00".repeat(32)}` : `0x${String(i + 1).repeat(64)}`,
      openWeights: false, provider: opts.realModels ? "phala-aci" : "test", zdr: opts.realModels ? false : true, tee: "tdx",
    } : undefined;
    const passportSig = passport && opts.realModels ? await account.signMessage({ message: { raw: passportHash(passport as never) } }) : "0x";
    docs.push({ role, address: account.address.toLowerCase(), encryptionPubKey: encPub, measurement: opts.badMeasurement && i === 4 ? `0x${"ab".repeat(32)}` : measurement, quote: q,
      ...(role === "JUROR" ? { jurorClass, passport, passportSig } : {}) });
  }
  if (opts.badIdentity) docs[4] = { ...docs[4], address: docs[3].address };
  return { intake: docs[0], consensus: docs[1], jurors: docs.slice(2) };
}

type Tamper = "forged" | "ciphertext" | "public" | "wrong-answer" | "unsalted-payload" | "other-opener";
async function makeResult(payerPub: Hex, answer = "42", tamper?: Tamper) {
  const fixture = ROUND_REHEARSAL_FIXTURE;
  const params = (await import("@mochi/schemas")).normalizeParams((await import("@mochi/schemas")).resolveSchema(fixture.schemaId as never, fixture.params), fixture.params);
  if (!params.ok) throw new Error("fixture param error");
  const paramsHash = (await import("@mochi/schemas")).paramsHash(params.params);
  const prov: ProvenanceJson = {
    docCommit: docCommit(fixture.salt as Hex, docHash(new TextEncoder().encode(fixture.evidence))), kind: 0, originId: ZERO32, fetchedAt: "0", tokensK: 1, transcriptHash: ZERO32,
    ...fixture.open, ...(tamper === "other-opener" ? { opener: `0x${"00".repeat(19)}09` } : {}), payerCommit: payerCommit(payerPub),
    schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, paramsHash, expiry: "1800000900",
  };
  const intakeSig = await signProvenance(accounts[0]!, fixture.chainId, `0x${"00".repeat(20)}`, provenanceFromJson(prov));
  const fields = { answer: { t: "str", v: answer } };
  const aHash = answerHash({ salt: fixture.salt as Hex, schemaId: fixture.schemaId as never, schemaVersion: fixture.schemaVersion, fields: fields as never });
  const id = verdictId(fixture.queryId as Hex, 0);
  const voteList: any[] = [];
  for (let i = 0; i < 3; i++) {
    const vote = { juror: accounts[i + 2]!.address.toLowerCase() as `0x${string}`, answerHash: aHash, spansRoot: ZERO32, quoteHash: `0x${String(i + 1).repeat(64)}` as Hex };
    const sig = await signJurorAnswer(accounts[i + 2]!, fixture.chainId, fixture.verdictsAddress as `0x${string}`, { queryId: fixture.queryId as Hex, docCommit: prov.docCommit as Hex, schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, answerHash: aHash, spansRoot: vote.spansRoot, quoteHash: vote.quoteHash });
    voteList.push({ ...vote, sig });
  }
  const payload = "0x1234" as Hex;
  const payloadHash = tamper === "unsalted-payload" ? keccak256(payload) : privatePayloadHash(fixture.salt as Hex, payload);
  const verdictInput = { queryId: fixture.queryId as Hex, round: 0, status: 1, agreementBps: 10_000, dissentMask: 0, timeoutMask: 0, answerHash: aHash, payloadHash, evidenceRoot: ZERO32 };
  const sig = await signVerdictAttestation(accounts[1]!, fixture.chainId, fixture.verdictsAddress as `0x${string}`, verdictInput as never, votesHash(voteList));
  const rows = [{ field: "answer", required: true, agreeBps: 10_000, hung: false, value: fields.answer, dissent: {} }];
  const envelope = seal(payerPub, new TextEncoder().encode(canonicalJson({ v: 1, verdictId: id, salt: fixture.salt, answerJson: canonicalJson({ salt: fixture.salt, schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, fields }), payload, fields: rows })), aad.result(id));
  return { fixture: { schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, queryId: fixture.queryId, chainId: 31337, verdictsAddress: fixture.verdictsAddress, sourceProvenance: "SUBMITTED" }, intake: { docCommit: prov.docCommit, paramsHash, provenance: prov, intakeSig, identity: accounts[0]!.address.toLowerCase() }, decision: { verdictId: id, verdictInput, votes: voteList, consensusSig: sig, privateResult: envelope } };
}

function fakeDeps(attestations: unknown, tamper?: Tamper, realMode = false) {
  let postCount = 0;
  const uploads: Record<string, unknown>[] = [];
  const deps: RoundVerifyTestDependencies = { verifyQuote: async () => ({ ok: true, tcbStatus: "UpToDate", advisoryIds: [] }), fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.pathname === "/v1/attestations") return Response.json(attestations);
    postCount++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    uploads.push(JSON.parse(new TextDecoder().decode(open(intakeSecret!, body.envelope, aad.intake()))));
    const result = await makeResult(body.payerResultPubKey, tamper === "wrong-answer" ? "41" : "42", tamper);
    if (tamper === "forged") result.decision.verdictInput.answerHash = ZERO32;
    if (tamper === "ciphertext") result.decision.privateResult.ct = `${result.decision.privateResult.ct.slice(0, -2)}00` as Hex;
    if (tamper === "public") (result.decision as any).public = {};
    if (realMode) Object.assign(result, { realInference: {
      provider: "phala-aci", models: REAL_MODELS, estimatedCostUsd: REAL_ESTIMATED_COST_USD,
      costEstimateBasis: "catalog token rates; requested max_tokens and input-byte reservation; actual provider usage may differ",
      receiptVerification: "server-side ACI verification; response metadata is not an independent proof",
      receipts: [2, 3, 4].map((i, index) => ({ seat: index, modelId: REAL_MODELS[index], upstreamModelId: `provider-alias-${index}`, receiptId: `receipt-${i}`, sessionId: `session-${i}`, workloadId: `workload-${i}`, verification: "ACI client verified provider signature and exact request/response body hashes in server process" })),
    } });
    return Response.json(result);
  }) as typeof fetch };
  return { deps, postCount: () => postCount, uploads };
}

describe("external private round verifier", () => {
  test("requires an explicit bytes32 measurement pin", () => {
    expect(() => parseRoundVerifyArgs([])).toThrow();
    expect(() => validatePinnedMeasurement(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)).toThrow();
  });
  test("rejects duplicate identity or a different enclave measurement before fixture POST", async () => {
    const pin = (await measurementPin()).measurement;
    for (const options of [{ badIdentity: true }, { badMeasurement: true }, { badJurorClass: true }]) {
      const { deps, postCount } = fakeDeps(await fixtureAttestations(options));
      await expect(verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, deps)).rejects.toThrow();
      expect(postCount()).toBe(0);
    }
  });
  test("accepts a valid signed, encrypted private fixture round", async () => {
    const pin = (await measurementPin()).measurement;
    const attestations = await fixtureAttestations();
    const { deps, uploads } = fakeDeps(attestations);
    const report = await verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, deps);
    expect(report).toMatchObject({ ok: true, verifiedIdentities: 5, pinnedMeasurement: "matched" });
    // The verifier sealed the fixed private open binding, committed to its own ephemeral payer key.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.open).toEqual({ ...ROUND_REHEARSAL_FIXTURE.open, payerCommit: (uploads[0]!.open as { payerCommit: string }).payerCommit });
    expect((uploads[0]!.open as { payerCommit: string }).payerCommit).toMatch(/^0x[0-9a-f]{64}$/);
    expect((uploads[0]!.open as { payerCommit: string }).payerCommit).not.toBe(ZERO32);
  });
  test("rejects forged decision, modified private ciphertext, and public projection", async () => {
    const pin = (await measurementPin()).measurement;
    const attestations = await fixtureAttestations();
    for (const tamper of ["forged", "ciphertext", "public", "unsalted-payload", "other-opener"] as const) {
      await expect(verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, fakeDeps(attestations, tamper).deps)).rejects.toThrow();
    }
  });
  test("real ACI verification rejects a validly signed unanimous but incorrect fixture answer", async () => {
    const pin = (await measurementPin()).measurement;
    const attestations = await fixtureAttestations({ realModels: true });
    const valid = await verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, fakeDeps(attestations, undefined, true).deps, "real-aci", "x".repeat(40));
    expect(valid).toMatchObject({ ok: true, verifiedIdentities: 5 });
    const { deps } = fakeDeps(attestations, "wrong-answer", true);
    await expect(verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, deps, "real-aci", "x".repeat(40))).rejects.toThrow("Decision answer hash does not match the fixed fixture answer.");
    expect(getLastVerifierDiagnosticForTests()).toEqual({ stage: "round_result", causeCode: "result_verification" });
  });
});
