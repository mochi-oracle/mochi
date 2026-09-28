import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { answerHash, canonicalJson, docCommit, docHash, ZERO32, votesHash, verdictId } from "@mochi/core";
import { aad } from "@mochi/protocol";
import { keyBinding, seal, signJurorAnswer, signProvenance, signVerdictAttestation, tdxMeasurement, type Quote } from "@mochi/tee";
import { privateKeyToAccount } from "viem/accounts";
import { fromHex, keccak256, toHex, type Hex } from "viem";
import { ROUND_REHEARSAL_FIXTURE } from "./round.ts";
import { parseRoundVerifyArgs, validatePinnedMeasurement, verifyRoundRehearsalWithTestDependencies, type RoundVerifyTestDependencies } from "./verify.ts";

const accounts = [1, 2, 3, 4, 5].map(i => privateKeyToAccount((`0x${String(i).padStart(64, "0")}`) as Hex));
const rawPath = new URL("../../../../packages/tee/test/fixtures/intel-tdx/tdx_quote", import.meta.url);
const measurementPin = async () => {
  const raw = new Uint8Array(await readFile(rawPath));
  const quote = (await import("@mochi/tee")).parseTdxQuote(raw);
  return { raw, parsed: quote, measurement: tdxMeasurement({ mrtd: quote.td.mrTd, rtmr: quote.td.rtmr }) };
};

async function fixtureAttestations(opts: { badIdentity?: boolean; badMeasurement?: boolean; badJurorClass?: boolean } = {}) {
  const { raw: source, parsed, measurement } = await measurementPin();
  const issuedAt = Math.floor(Date.now() / 1000) - 10;
  const docs: any[] = [];
  for (let i = 0; i < 5; i++) {
    const account = accounts[i]!;
    const encSecret = crypto.getRandomValues(new Uint8Array(32));
    const encPub = toHex((await import("@noble/curves/ed25519.js")).x25519.getPublicKey(encSecret));
    const bind = keyBinding(account.address, encPub);
    const raw = source.slice();
    const reportData = new Uint8Array(64);
    reportData.set(fromHex(bind, "bytes"));
    new DataView(reportData.buffer).setBigUint64(32, BigInt(issuedAt), false);
    raw.set(reportData, parsed.signed.length - 64);
    const q: Quote = { kind: "tdx", measurement, reportData: bind, raw: toHex(raw), issuedAt };
    const role = i === 0 ? "INTAKE" : i === 1 ? "CONSENSUS" : "JUROR";
    docs.push({ role, address: account.address.toLowerCase(), encryptionPubKey: encPub, measurement: opts.badMeasurement && i === 4 ? `0x${"ab".repeat(32)}` : measurement, quote: q,
      ...(role === "JUROR" ? { jurorClass: opts.badJurorClass && i === 3 ? 1 : [0, 2, 4][i - 2], passport: { v: 1, juror: account.address.toLowerCase(), jurorClass: opts.badJurorClass && i === 3 ? 1 : [0, 2, 4][i - 2], modelId: `fake-${i}`, lineage: "synthetic", weightsSha256: `0x${String(i + 1).repeat(64)}`, openWeights: false, provider: "test", zdr: true, tee: "tdx" }, passportSig: "0x" } : {}) });
  }
  if (opts.badIdentity) docs[4] = { ...docs[4], address: docs[3].address };
  return { intake: docs[0], consensus: docs[1], jurors: docs.slice(2) };
}

async function makeResult(payerPub: Hex) {
  const fixture = ROUND_REHEARSAL_FIXTURE;
  const prov = { docCommit: docCommit(fixture.salt as Hex, docHash(new TextEncoder().encode(fixture.evidence))), kind: 0 as const, originId: ZERO32, fetchedAt: "1", tokensK: 1, transcriptHash: ZERO32 };
  const params = (await import("@mochi/schemas")).normalizeParams((await import("@mochi/schemas")).resolveSchema(fixture.schemaId as never, fixture.params), fixture.params);
  if (!params.ok) throw new Error("fixture param error");
  const paramsHash = (await import("@mochi/schemas")).paramsHash(params.params);
  const intakeSig = await signProvenance(accounts[0]!, fixture.chainId, `0x${"00".repeat(20)}`, { docCommit: prov.docCommit, kind: 0, originId: ZERO32, fetchedAt: 1n, tokensK: 1, transcriptHash: ZERO32 });
  const fields = { answer: { t: "str", v: "42" } };
  const aHash = answerHash({ salt: fixture.salt as Hex, schemaId: fixture.schemaId as never, schemaVersion: fixture.schemaVersion, fields: fields as never });
  const id = verdictId(fixture.queryId as Hex, 0);
  const voteList: any[] = [];
  for (let i = 0; i < 3; i++) {
    const vote = { juror: accounts[i + 2]!.address.toLowerCase() as `0x${string}`, answerHash: aHash, spansRoot: ZERO32, quoteHash: `0x${String(i + 1).repeat(64)}` as Hex };
    const sig = await signJurorAnswer(accounts[i + 2]!, fixture.chainId, fixture.verdictsAddress as `0x${string}`, { queryId: fixture.queryId as Hex, docCommit: prov.docCommit, schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, answerHash: aHash, spansRoot: vote.spansRoot, quoteHash: vote.quoteHash });
    voteList.push({ ...vote, sig });
  }
  const payload = "0x1234" as Hex;
  const verdictInput = { queryId: fixture.queryId as Hex, round: 0, status: 1, agreementBps: 10_000, dissentMask: 0, timeoutMask: 0, answerHash: aHash, payloadHash: keccak256(payload), evidenceRoot: ZERO32 };
  const sig = await signVerdictAttestation(accounts[1]!, fixture.chainId, fixture.verdictsAddress as `0x${string}`, verdictInput as never, votesHash(voteList));
  const rows = [{ field: "answer", required: true, agreeBps: 10_000, hung: false, value: fields.answer, dissent: {} }];
  const envelope = seal(payerPub, new TextEncoder().encode(canonicalJson({ v: 1, verdictId: id, salt: fixture.salt, answerJson: canonicalJson({ salt: fixture.salt, schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, fields }), payload, fields: rows })), aad.result(id));
  return { fixture: { schemaId: fixture.schemaId, schemaVersion: fixture.schemaVersion, queryId: fixture.queryId, chainId: 31337, verdictsAddress: fixture.verdictsAddress, sourceProvenance: "SUBMITTED" }, intake: { docCommit: prov.docCommit, paramsHash, provenance: { kind: 0, originId: ZERO32, fetchedAt: "1", tokensK: 1, transcriptHash: ZERO32 }, intakeSig, identity: accounts[0]!.address.toLowerCase() }, decision: { verdictId: id, verdictInput, votes: voteList, consensusSig: sig, privateResult: envelope } };
}

function fakeDeps(attestations: unknown, tamper?: "forged" | "ciphertext" | "public") {
  let postCount = 0;
  const deps: RoundVerifyTestDependencies = { verifyQuote: async () => ({ ok: true, tcbStatus: "UpToDate", advisoryIds: [] }), fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.pathname === "/v1/attestations") return Response.json(attestations);
    postCount++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const result = await makeResult(body.payerResultPubKey);
    if (tamper === "forged") result.decision.verdictInput.answerHash = ZERO32;
    if (tamper === "ciphertext") result.decision.privateResult.ct = `${result.decision.privateResult.ct.slice(0, -2)}00` as Hex;
    if (tamper === "public") (result.decision as any).public = {};
    return Response.json(result);
  }) as typeof fetch };
  return { deps, postCount: () => postCount };
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
    const { deps } = fakeDeps(attestations);
    const report = await verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, deps);
    expect(report).toMatchObject({ ok: true, verifiedIdentities: 5, pinnedMeasurement: "matched" });
  });
  test("rejects forged decision, modified private ciphertext, and public projection", async () => {
    const pin = (await measurementPin()).measurement;
    const attestations = await fixtureAttestations();
    for (const tamper of ["forged", "ciphertext", "public"] as const) {
      await expect(verifyRoundRehearsalWithTestDependencies("http://127.0.0.1:8080", pin, fakeDeps(attestations, tamper).deps)).rejects.toThrow();
    }
  });
});
