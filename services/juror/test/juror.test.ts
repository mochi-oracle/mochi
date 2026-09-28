import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { answerHash as coreAnswerHash, canonicalJson, docCommit, docHash, Role, SchemaId } from "@mochi/core";
import { normalizeAnswer, normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { MockQuoteVerifier, MockTeeProvider, MemorySealedStore, recoverJurorAnswer, seal } from "@mochi/tee";
import { aad, AnswerReqSchema, JurorAttestationDocSchema, passportHash, SubmitAnswerReqSchema } from "@mochi/protocol";
import type { AnswerReq, Peer, SubmitAnswerReq } from "@mochi/protocol";
import { createJurorApp } from "../src/app.ts";
import type { Clock, HttpPoster, JurorChainPort } from "../src/ports.ts";
import { JurorEnclave, JurorError } from "../src/juror.ts";
import { OpenAICompatibleRunner, PhalaAciRunner, RunnerError, StubRunner } from "../src/runner.ts";
import type { ModelRunner } from "../src/runner.ts";
import { hashWeightsDirectory } from "../src/weights.ts";
import { loadConfig } from "../src/config.ts";

const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
const jurorTee = new MockTeeProvider({ seed: `0x${"22".repeat(32)}`, measurement: `0x${"aa".repeat(32)}`, mockRoot: root });
const registeredMeasurement = `0x${"bb".repeat(32)}` as const;
const consensusTee = new MockTeeProvider({ seed: `0x${"33".repeat(32)}`, measurement: registeredMeasurement, mockRoot: root });
const chainId = 31337;
const verdictsAddress = `0x${"44".repeat(20)}` as Address;
const queryId = `0x${"55".repeat(32)}` as Hex;
const documentText = "Acme announced a 2-for-1 split effective June 1, 2026.";
const documentBytes = new TextEncoder().encode(documentText);
const salt = `0x${"00".repeat(32)}` as Hex;
const schemaId = SchemaId.SPLIT;
const params = {};
const def = resolveSchema(schemaId, params);
const docHashHex = docHash(documentBytes);
const commit = docCommit(salt, docHashHex);
const pHashResult = normalizeParams(def, params);
if (!pHashResult.ok) throw new Error("test params unexpectedly invalid");
const pHash = paramsHash(pHashResult.params);
const tick = { now: () => Date.now(), sleep: async (_ms: number) => {} } satisfies Clock;

function makeReq(overrides: Partial<AnswerReq> = {}, plainOverrides: Record<string, unknown> = {}): AnswerReq {
  const plain = {
    v: 1,
    queryId,
    schemaId,
    docCommit: commit,
    paramsHash: pHash,
    salt,
    params,
    contentType: "text/plain",
    docB64: btoa(String.fromCharCode(...documentBytes)),
    text: documentText,
    ...plainOverrides,
  };
  const docEnvelope = seal(jurorTee.encryptionPublicKey(), new TextEncoder().encode(JSON.stringify(plain)), aad.doc(commit));
  const consensus: Peer = {
    address: consensusTee.signer().address.toLowerCase() as Address,
    encryptionPubKey: consensusTee.encryptionPublicKey(),
    quote: awaitQuotePlaceholder,
  };
  return {
    queryId,
    seat: 0,
    docEnvelope,
    consensus,
    consensusUrl: "http://consensus.test",
    ...overrides,
  };
}

// The peer quote is async; keeping request building async avoids test-only quote shortcuts.
const awaitQuotePlaceholder = { kind: "mock", measurement: `0x${"00".repeat(32)}`, reportData: `0x${"00".repeat(32)}`, raw: "0x", issuedAt: 0 } as Peer["quote"];
async function validReq(overrides: Partial<AnswerReq> = {}, plainOverrides: Record<string, unknown> = {}): Promise<AnswerReq> {
  const req = makeReq(overrides, plainOverrides);
  req.consensus.quote = await consensusTee.quote();
  return AnswerReqSchema.parse(req) as AnswerReq;
}

function fixture(raw: unknown = {
  fields: { ticker: "ACME", ratio_num: "2", ratio_den: "1", effective_date: "June 1, 2026" },
  evidence: { ticker: "Acme", ratio_num: "2", ratio_den: "1", effective_date: "June 1, 2026" },
  confidence: {},
}, runnerOverride?: ModelRunner) {
  const state = { runnerCalls: 0, sends: [] as SubmitAnswerReq[], failSends: 0, raw };
  const chain: JurorChainPort = {
    getQuery: async () => ({ status: 2, docCommit: commit, paramsHash: pHash, schemaId, schemaVersion: 1 }),
    jurorsOf: async () => [jurorTee.signer().address as Hex],
    isActive: async (_key, role) => role === Role.CONSENSUS,
    getJuror: async () => ({ measurement: registeredMeasurement }),
  };
  const http: HttpPoster = {
    post: async (_url, body) => {
      if (state.failSends-- > 0) throw new Error("offline");
      state.sends.push(body);
    },
  };
  const store = new MemorySealedStore();
  const enclave = new JurorEnclave({
    tee: jurorTee,
    jurorClass: 0,
    passport: {
      modelId: "test/model", lineage: "qwen", weightsSha256: `0x${"ab".repeat(32)}` as Hex,
      openWeights: true, provider: "test-provider", zdr: true,
    },
    runner: runnerOverride ?? new StubRunner(async () => { state.runnerCalls++; return state.raw; }),
    chain,
    store,
    quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }),
    http,
    chainId,
    verdictsAddress,
    clock: tick,
  });
  return { enclave, state, chain, store };
}

test("Phala verified answer is used and signed passport carries receipt metadata; verification failure sends no answer", async () => {
  let aciOptions: { signal?: AbortSignal; requireUpToDate?: boolean; maxResponseBytes?: number } | undefined;
  const verifiedRunner = new PhalaAciRunner({ client: {
    chat: async (_body: unknown, options: typeof aciOptions) => { aciOptions = options; return ({
      json: { choices: [{ message: { content: JSON.stringify({ fields: { ticker: "ACME", ratio_num: "2", ratio_den: "1", effective_date: "June 1, 2026" }, evidence: { ticker: "Acme", ratio_num: "2", ratio_den: "1", effective_date: "June 1, 2026" }, confidence: {} }) } }] },
      receipt: { receiptId: "rcpt-123", sessionId: "session-456", workloadId: "phala-juror", modelId: "provider/model", provider: "phala-aci" },
      established: { workloadId: "phala-juror", tcbStatus: "UpToDate" },
    }); },
  } as never, model: "provider/model", timeoutMs: 1000 });
  const good = fixture(undefined, verifiedRunner);
  const result = await good.enclave.answer(await validReq());
  expect(result.vote.answerHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(good.state.sends).toHaveLength(1);
  expect(aciOptions?.signal).toBeInstanceOf(AbortSignal);
  expect(aciOptions?.requireUpToDate).toBe(true);
  expect(aciOptions?.maxResponseBytes).toBe(256 * 1024);
  const passport = (await good.enclave.attestation()).passport;
  expect(passport.modelId).toContain("receipt=rcpt-123");
  expect(passport.modelId).toContain("session=session-456");
  expect(passport.modelId).toContain("workload=phala-juror");

  const failedRunner = new PhalaAciRunner({ client: { chat: async () => { throw new Error("receipt was not verified"); } } as never, model: "provider/model", timeoutMs: 1000 });
  const bad = fixture(undefined, failedRunner);
  await expect(bad.enclave.answer(await validReq())).rejects.toMatchObject({ code: "RUNNER_FAILED" });
  expect(bad.state.sends).toHaveLength(0);
});

test("Phala TCB status outside TDX_ALLOWED_TCB_STATUSES produces no juror answer", async () => {
  const prior = process.env.TDX_ALLOWED_TCB_STATUSES;
  process.env.TDX_ALLOWED_TCB_STATUSES = "UpToDate";
  try {
    const runner = new PhalaAciRunner({ client: { chat: async () => ({
      json: { choices: [{ message: { content: "{}" } }] },
      receipt: { receiptId: "rcpt", sessionId: "session", workloadId: "workload", modelId: "model", provider: "phala" },
      established: { workloadId: "workload", tcbStatus: "OutOfDate" },
    }) } as never, model: "provider/model", timeoutMs: 1000 });
    const f = fixture(undefined, runner);
    await expect(f.enclave.answer(await validReq())).rejects.toMatchObject({ code: "RUNNER_FAILED" });
    expect(f.state.sends).toHaveLength(0);
  } finally {
    if (prior === undefined) delete process.env.TDX_ALLOWED_TCB_STATUSES;
    else process.env.TDX_ALLOWED_TCB_STATUSES = prior;
  }
});

test("Phala ACI runner enforces configured output and exact request-size bounds", async () => {
  let calls = 0;
  let body: Record<string, any> | undefined;
  const runner = new PhalaAciRunner({ client: { chat: async (request: unknown) => {
    calls++; body = request as Record<string, any>;
    return { json: { choices: [{ message: { content: "{}" } }] }, receipt: { receiptId: "r", sessionId: "s", workloadId: "w", modelId: "provider/model" }, established: { workloadId: "w", tcbStatus: "UpToDate" } } as never;
  } } as never, model: "provider/model", timeoutMs: 1000, maxTokens: 1024, maxInputBytes: 2048 });
  await runner.run({ system: "s", user: "u", document: "d", jsonSchema: { type: "object" }, maxTokens: 4096 });
  expect(body?.max_tokens).toBe(1024);
  await expect(runner.run({ system: "s", user: "u", document: "d".repeat(3000), jsonSchema: {}, maxTokens: 1 })).rejects.toBeInstanceOf(RunnerError);
  expect(calls).toBe(1);
});

test("Phala ACI runner keeps long provider receipt identifiers boundable in passports", async () => {
  const rawReceipt = { receiptId: "r".repeat(64), sessionId: "s".repeat(64), workloadId: "w".repeat(64), modelId: "gemma4-31b-it", requestedModelId: "google/gemma-4-31b-it" };
  const runner = new PhalaAciRunner({ client: { chat: async () => ({
    json: { choices: [{ message: { content: "{}" } }] }, receipt: rawReceipt,
    established: { workloadId: rawReceipt.workloadId, tcbStatus: "UpToDate" },
  }) } as never, model: rawReceipt.requestedModelId, timeoutMs: 1000, compactReceiptMetadata: true });
  await runner.run({ system: "s", user: "u", document: "d", jsonSchema: {}, maxTokens: 4 });
  expect(runner.lastProviderReceipt).toEqual({ receiptId: rawReceipt.receiptId, sessionId: rawReceipt.sessionId, workloadId: rawReceipt.workloadId, modelId: rawReceipt.requestedModelId, upstreamModelId: rawReceipt.modelId });
  expect(runner.lastReceipt?.receiptId).toMatch(/^sha256:[0-9a-f]{32}$/u);
  const passportModelId = `${runner.lastReceipt!.modelId} [receipt=${runner.lastReceipt!.receiptId};session=${runner.lastReceipt!.sessionId};workload=${runner.lastReceipt!.workloadId}]`;
  expect(passportModelId.length).toBeLessThanOrEqual(200);
});

test("Phala ACI runner exposes only allowlisted provider HTTP diagnostics", async () => {
  const failure = Object.assign(new Error("provider body and private prompt must stay hidden"), { code: "inference_http", httpStatus: 429, retryAfterMs: 5000 });
  const runner = new PhalaAciRunner({ client: { chat: async () => { throw failure; } } as never, model: "m", timeoutMs: 1000 });
  await expect(runner.run({ system: "secret", user: "secret", document: "secret", jsonSchema: {}, maxTokens: 8 })).rejects.toBeInstanceOf(RunnerError);
  expect(runner.lastFailure).toEqual({ causeCode: "inference_http", httpStatus: 429 });
  expect(JSON.stringify(runner.lastFailure)).not.toContain("private prompt");
});

describe("OpenAI compatible runner", () => {
  test("sends constrained request, wraps document, and parses content", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const runner = new OpenAICompatibleRunner({
      baseUrl: "http://model.test/",
      model: "model-1",
      timeoutMs: 1000,
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: '{"fields":{}}' } }] });
      },
    });
    const result = await runner.run({ system: "extract", user: "fields", document: "private doc", jsonSchema: { type: "object" }, maxTokens: 88 });
    expect(result).toEqual({ fields: {} });
    expect(requestBody?.response_format).toEqual({ type: "json_schema", json_schema: { name: "mochi_extraction", schema: { type: "object" }, strict: true } });
    expect(requestBody?.temperature).toBe(0);
    expect(requestBody?.max_tokens).toBe(88);
    expect(requestBody?.messages).toEqual([
      { role: "system", content: "extract" },
      { role: "user", content: "fields\n\n<document>\nprivate doc\n</document>" },
    ]);
  });

  test("rejects non-200, invalid content JSON, and timeout", async () => {
    const input = { system: "", user: "", document: "", jsonSchema: {}, maxTokens: 10 };
    const badStatus = new OpenAICompatibleRunner({ baseUrl: "http://x", model: "m", timeoutMs: 50, fetch: async () => new Response("", { status: 503 }) });
    const badJson = new OpenAICompatibleRunner({ baseUrl: "http://x", model: "m", timeoutMs: 50, fetch: async () => Response.json({ choices: [{ message: { content: "nope" } }] }) });
    const timeout = new OpenAICompatibleRunner({ baseUrl: "http://x", model: "m", timeoutMs: 5, fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
    await expect(badStatus.run(input)).rejects.toBeInstanceOf(RunnerError);
    await expect(badJson.run(input)).rejects.toBeInstanceOf(RunnerError);
    await expect(timeout.run(input)).rejects.toThrow("timed out");
  });
});

test("attestation publishes a signed, schema-valid Passport cached for the process", async () => {
  const { enclave } = fixture();
  const first = await enclave.attestation();
  const second = await enclave.attestation();
  const doc = JurorAttestationDocSchema.parse(first);
  expect(second.passport).toEqual(doc.passport);
  expect(second.passportSig as Hex).toBe(doc.passportSig as Hex);
  expect(doc.passport.juror).toBe(jurorTee.signer().address.toLowerCase());
  expect(await recoverMessageAddress({ message: { raw: passportHash(doc.passport) }, signature: doc.passportSig as Hex }))
    .toBe(jurorTee.signer().address);
});

test("weights directory digest is path-order stable and changes when a file changes", async () => {
  const rootDir = join(import.meta.dir, "..", ".tmp-test");
  const firstDir = join(rootDir, "weights-first");
  const secondDir = join(rootDir, "weights-second");
  await rm(rootDir, { recursive: true, force: true });
  try {
    await mkdir(join(firstDir, "nested"), { recursive: true });
    await mkdir(join(secondDir, "nested"), { recursive: true });
    await writeFile(join(firstDir, "z.bin"), "last");
    await writeFile(join(firstDir, "nested", "a.bin"), "first");
    await writeFile(join(secondDir, "nested", "a.bin"), "first");
    await writeFile(join(secondDir, "z.bin"), "last");
    const firstHash = await hashWeightsDirectory(firstDir);
    expect(await hashWeightsDirectory(secondDir)).toBe(firstHash);
    await writeFile(join(secondDir, "nested", "a.bin"), "changed");
    expect(await hashWeightsDirectory(secondDir)).not.toBe(firstHash);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("Passport config defaults stub identity and requires production model metadata", () => {
  const stub = loadConfig({ MODEL_PROVIDER: "test-provider" });
  expect(stub.MODEL_ID).toBe("stub-model");
  expect(stub.MODEL_OPEN_WEIGHTS).toBe(true);
  expect(stub.ZDR).toBe(true);
  expect(() => loadConfig({ RUNNER: "openai", MODEL_PROVIDER: "host", MODEL_WEIGHTS_SHA256: `0x${"aa".repeat(32)}` })).toThrow("MODEL_ID is required");
  expect(() => loadConfig({ RUNNER: "openai", MODEL_ID: "org/model", MODEL_PROVIDER: "host" })).toThrow("MODEL_WEIGHTS_SHA256 or MODEL_WEIGHTS_DIR is required");
});

describe("juror answer flow", () => {
  test("signs normalized answer and delivers encrypted SubmitAnswerReq", async () => {
    const { enclave, state } = fixture();
    const req = await validReq();
    const response = await enclave.answer(req);
    const body = normalizeAnswer(def, state.raw as Parameters<typeof normalizeAnswer>[1], documentText);
    expect(response.delivered).toBe(true);
    expect(response.vote.answerHash).toBe(coreAnswerHash({ salt, schemaId, schemaVersion: 1, fields: body.fields }));
    expect(await recoverJurorAnswer(chainId, verdictsAddress, {
      queryId, docCommit: commit, schemaId, schemaVersion: 1,
      answerHash: response.vote.answerHash as Hex, spansRoot: response.vote.spansRoot as Hex, quoteHash: response.vote.quoteHash as Hex,
    }, response.vote.sig as Hex)).toBe(jurorTee.signer().address);
    expect(SubmitAnswerReqSchema.safeParse(state.sends[0]).success).toBe(true);
    const opened = consensusTee.decryptEnvelope(
      state.sends[0]!.answerEnvelope as never,
      aad.answer(queryId, state.sends[0]!.vote.juror as Hex),
    );
    expect(new TextDecoder().decode(opened)).toBe(canonicalJson(body));
  });

  test("replays persisted answer without calling the runner again", async () => {
    const { enclave, state } = fixture();
    const req = await validReq();
    const first = await enclave.answer(req);
    state.raw = { fields: { nonsense: true } };
    const second = await enclave.answer(req);
    expect(second.vote).toEqual(first.vote);
    expect(second).toEqual(first);
    expect(state.runnerCalls).toBe(1);
  });

  test("serializes concurrent dispatches for one queryId", async () => {
    const { enclave, state } = fixture();
    const req = await validReq();
    const [first, second] = await Promise.all([enclave.answer(req), enclave.answer(req)]);
    expect(first.vote).toEqual(second.vote);
    expect(state.runnerCalls).toBe(1);
  });

  test("rejections cover unselected seat, binding mismatch, inactive or invalid consensus, and runner failure", async () => {
    const wrongSeatFixture = fixture();
    const wrongSeatReq = await validReq({ seat: 1 });
    await expect(wrongSeatFixture.enclave.answer(wrongSeatReq)).rejects.toMatchObject({ code: "NOT_SELECTED" });
    expect(await wrongSeatFixture.store.has(`answer:${queryId}`)).toBe(false);

    const badBindingFixture = fixture();
    const badBinding = await validReq({}, { salt: `0x${"77".repeat(32)}` });
    await expect(badBindingFixture.enclave.answer(badBinding)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(await badBindingFixture.store.has(`answer:${queryId}`)).toBe(false);

    const tamperedDocFixture = fixture();
    const tamperedDoc = await validReq({}, { docB64: btoa("different document") });
    await expect(tamperedDocFixture.enclave.answer(tamperedDoc)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(await tamperedDocFixture.store.has(`answer:${queryId}`)).toBe(false);

    const wrongParamsFixture = fixture();
    const wrongParams = await validReq({}, { params: { unexpected: "private" } });
    await expect(wrongParamsFixture.enclave.answer(wrongParams)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(await wrongParamsFixture.store.has(`answer:${queryId}`)).toBe(false);

    const inactiveFixture = fixture();
    inactiveFixture.chain.isActive = async () => false;
    await expect(inactiveFixture.enclave.answer(await validReq())).rejects.toMatchObject({ code: "INACTIVE_CONSENSUS" });
    expect(await inactiveFixture.store.has(`answer:${queryId}`)).toBe(false);

    const badQuoteFixture = fixture();
    const badQuote = await validReq();
    badQuote.consensus.quote = { ...badQuote.consensus.quote, reportData: `0x${"99".repeat(32)}` };
    await expect(badQuoteFixture.enclave.answer(badQuote)).rejects.toMatchObject({ code: "BAD_CONSENSUS_QUOTE" });
    expect(await badQuoteFixture.store.has(`answer:${queryId}`)).toBe(false);

    const runnerFixture = fixture(new Error("fixture runner failure"));
    runnerFixture.enclave = new JurorEnclave({
      tee: jurorTee, jurorClass: 0,
      passport: { modelId: "test/model", lineage: "qwen", weightsSha256: `0x${"ab".repeat(32)}` as Hex, openWeights: true, provider: "test-provider", zdr: true },
      runner: new StubRunner(() => { throw new Error("runner failed"); }),
      chain: runnerFixture.chain, store: new MemorySealedStore(), quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }),
      http: { post: async () => {} }, chainId, verdictsAddress, clock: tick,
    });
    await expect(runnerFixture.enclave.answer(await validReq())).rejects.toMatchObject({ code: "RUNNER_FAILED" });
    expect(await runnerFixture.store.has(`answer:${queryId}`)).toBe(false);
  });

  test("delivery failure returns stored vote and retry reuses it", async () => {
    const { enclave, state } = fixture();
    state.failSends = 4;
    const req = await validReq();
    const first = await enclave.answer(req);
    expect(first.delivered).toBe(false);
    const second = await enclave.answer(req);
    expect(second.delivered).toBe(true);
    expect(second.vote).toEqual(first.vote);
    expect(state.runnerCalls).toBe(1);
  });
});

test("Hono validates body and returns structured errors", async () => {
  const { enclave } = fixture();
  const { app } = createJurorApp(enclave);
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  const invalid = await app.request("/v1/answer", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: { code: "INVALID_REQUEST", message: "request body is invalid" } });
});

test("rejects a consensus quote whose measurement differs from the on-chain registration", async () => {
  const f = fixture();
  f.chain.getJuror = async () => ({ measurement: `0x${"cc".repeat(32)}` });
  await expect(f.enclave.answer(await validReq())).rejects.toMatchObject({ code: "BAD_CONSENSUS_QUOTE" });
  expect(await f.store.has(`answer:${queryId}`)).toBe(false);
});
