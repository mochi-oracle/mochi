import { describe, expect, test } from "bun:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, keccak256, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { answerHash as coreAnswerHash, PANEL_ROUND, privatePayloadHash, verdictId, ZERO32 } from "@mochi/core";
import { aad, DispatchPanelResSchema } from "@mochi/protocol";
import { seal } from "@mochi/tee";
import { buildPayload, normalizeValue, normalizeParams, resolveSchema } from "@mochi/schemas";
import { createPanelDeskApp } from "../src/app.ts";
import { assertPublicPayload, commitment, generateEvaluatorKey, openMaterials, payloadSig, bindKey, buildAnswer } from "../src/evaluator.ts";
import { feedRejection, PanelKeeper } from "../src/keeper.ts";
import { feedEntry } from "../src/adapters/chain.ts";
import type { ChainPort, DrawInfo, PanelCase, PanelDeps, Store } from "../src/ports.ts";
import { FeedsAbi, type DrandClient } from "@mochi/chain";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const caseId = H(1);
const queryId = caseId;
const evaluator = privateKeyToAccount(H(42) as Hex);
const payloadBytes = new Uint8Array([1, 2, 3, 4]);
const payload = toHex(payloadBytes);
const payloadHash = keccak256(payload);

function baseCase(overrides: Partial<PanelCase> = {}): PanelCase {
  return { queryId, status: 1, panelIndex: 0, sealBlock: 90n, commitDeadline: 0n, revealDeadline: 0n, appealDeadline: 0n,
    payer: A(3), fee: 1n, outcomeAnswerHash: H(11), outcomePayloadHash: payloadHash, drawDeadline: 1_000n, ...overrides };
}

function fakes(overrides: Partial<PanelDeps> = {}) {
  let panel = baseCase();
  let block = 1000n;
  let now = 100n;
  let simulated = false;
  let queryStatus = 3;
  let latest = verdictId(queryId, PANEL_ROUND);
  let drawInfo: DrawInfo = { eligible: 6, expiry: 10_000n, filled: 0 };
  let revealed = { answerHash: H(11), payloadHash };
  let prunable = 0n;
  const calls: string[] = [];
  const payloadRows = new Map<string, Uint8Array>();
  const store: Store = {
    getCursor: async () => null, setCursor: async () => {}, getFeedQuery: async () => ({ feedId: H(21), key: H(22) }),
    getPanelPayloadByHash: async (_case, hash) => { const v = payloadRows.get(hash); return v ? { payload: v } : null; },
    insertPanelPayload: async () => {}, getVerdict: async () => ({ verdict: { isPublic: true }, publicPart: { dissent: [{ field: "amount" }], fieldAgreement: [{ field: "amount", agreeBps: 6666 }] } }),
  };
  const chain: ChainPort = {
    dep: { startBlock: "0", contracts: { panel: A(4), feeds: A(5), randomness: A(6) } },
    beaconChain: { publicClient: { readContract: async () => { throw new Error("blockhash deployments must not read drand beacons"); } } } as never,
    blockNumber: async () => block, timestamp: async () => now,
    getPanelEvents: async () => [caseId], getCase: async () => panel, panelOf: async () => [evaluator.address as Address, A(2), A(3)],
    getQuery: async () => ({ schemaId: 1, schemaVersion: 1, isPublic: true, status: queryStatus, openedAt: 1_700_000_000n }), latestVerdictOf: async () => latest,
    simulateResolve: async () => simulated, drawState: async () => drawInfo, revealOf: async () => revealed,
    simulatePrune: async () => prunable, prune: async () => { calls.push("prune"); prunable = 0n; return H(29); },
    // A draw call seats the panel unless a test makes it resumable.
    draw: async () => { calls.push("draw"); panel = { ...panel, status: 2 }; return H(31); }, reseal: async () => { calls.push("reseal"); return H(32); },
    expireDraw: async () => { calls.push("expireDraw"); panel = { ...panel, status: 8 }; return H(30); },
    resolve: async () => { calls.push("resolve"); return H(33); }, finalize: async () => { calls.push("finalize"); panel = { ...panel, status: 7 }; return H(34); },
    feedsUpdate: async () => { calls.push("feedsUpdate"); return H(35); }, feedLatest: async () => null,
    panelStake: async () => 0n, approvePanel: async () => H(36), stake: async () => H(37), commit: async () => H(38), reveal: async () => H(39),
  };
  const deps: PanelDeps = { chain, store, intake: { dispatchPanel: async () => DispatchPanelResSchema.parse({ evaluators: [{ address: evaluator.address.toLowerCase(), docEnvelope: { v: 1, epk: H(50), nonce: `0x${"00".repeat(12)}`, ct: "0x01" } }] }) }, clock: { sleep: async () => {} }, config: { intakeUrl: "http://intake", pollMs: 1000 }, ...overrides };
  return { deps, calls, store, payloadRows, setCase: (x: PanelCase) => panel = x, setBlock: (x: bigint) => block = x, setNow: (x: bigint) => now = x,
    setSimulated: (x: boolean) => simulated = x, setQueryStatus: (x: number) => queryStatus = x, setLatest: (x: Hex) => latest = x,
    setDraw: (x: DrawInfo) => drawInfo = x, setRevealed: (x: { answerHash: Hex; payloadHash: Hex }) => revealed = x, setPrunable: (x: bigint) => prunable = x };
}

describe("panel evaluator library", () => {
  test("generates and binds an evaluator key, then opens the evaluator envelope", async () => {
    const keys = generateEvaluatorKey();
    const keySig = await bindKey(evaluator, queryId, 0, keys.pubKey);
    expect(keySig.startsWith("0x")).toBe(true);
    const plain = { v: 1, queryId, schemaId: 7, schemaVersion: 1, docCommit: H(3), salt: H(4), params: { question: "What?", answer_type: "STRING" }, contentType: "text/plain", docB64: "eA==", text: "x" };
    const env = seal(keys.pubKey, new TextEncoder().encode(JSON.stringify(plain)), aad.panel(queryId, evaluator.address.toLowerCase() as Hex));
    expect(openMaterials({ queryId, evaluator: evaluator.address.toLowerCase() as Hex, docEnvelope: env }, keys.privKey).text).toBe("x");
  });

  test("answer and payload hashes match the shared core and schemas packages (public query: zero record salt)", () => {
    const schema = resolveSchema(7, { question: "What?", answer_type: "STRING" });
    const params = normalizeParams(schema, { question: "What?", answer_type: "STRING" });
    expect(params.ok).toBe(true);
    const normalized = normalizeValue(schema.fields[0]!, "A finding");
    expect(normalized.ok).toBe(true);
    const fields = { answer: normalized.ok ? normalized.value : null };
    const built = buildAnswer(7, 1, ZERO32, { question: "What?", answer_type: "STRING" }, { answer: "A finding" }, 1n, { isPublic: true });
    expect(built.answerHash).toBe(coreAnswerHash({ salt: ZERO32, schemaId: schema.id, schemaVersion: 1, fields }));
    const expectedPayload = buildPayload(schema, fields, params.ok ? params.params : {}, { openedAt: 1n }).payload;
    expect(built.payload).toBe(expectedPayload);
    expect(built.payloadHash).toBe(keccak256(expectedPayload));
    expect(buildAnswer(7, 1, ZERO32, { question: "What?", answer_type: "STRING" }, { answer: "A finding" }, 1n).payloadHash).toBe(built.payloadHash);
  });

  test("a private query's panel answer commits the salted payload hash, as consensus posts it", () => {
    const salt = H(9);
    const built = buildAnswer(7, 1, salt, { question: "Were reserves backed?", answer_type: "BOOL" }, { answer: true }, 1n, { isPublic: false });
    expect(built.payloadHash).toBe(privatePayloadHash(salt, built.payload));
    expect(built.payloadHash).not.toBe(keccak256(built.payload));
    // Matches the consensus builder for the same agreed fields.
    const schema = resolveSchema(7, { question: "Were reserves backed?", answer_type: "BOOL" });
    const params = normalizeParams(schema, { question: "Were reserves backed?", answer_type: "BOOL" });
    const consensusSide = buildPayload(schema, built.fields, params.ok ? params.params : {}, { openedAt: 1n, privateSalt: salt });
    expect(built.payloadHash).toBe(consensusSide.payloadHash);
    // Without the flag the record salt decides; with it, a mismatch fails closed.
    expect(buildAnswer(7, 1, salt, { question: "Were reserves backed?", answer_type: "BOOL" }, { answer: true }, 1n).payloadHash).toBe(built.payloadHash);
    expect(() => buildAnswer(7, 1, salt, { question: "Q", answer_type: "BOOL" }, { answer: true }, 1n, { isPublic: true })).toThrow("non-zero record salt");
    expect(() => buildAnswer(7, 1, ZERO32, { question: "Q", answer_type: "BOOL" }, { answer: true }, 1n, { isPublic: false })).toThrow("without a record salt");
    // The commitment binds the salted hash.
    const c = commitment(caseId, 0, evaluator.address, built.answerHash, built.payloadHash, H(8));
    expect(c).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [caseId, 0, evaluator.address, built.answerHash, built.payloadHash, H(8)])));
  });

  test("commitment equals a hand-computed ABI encoding and payload signature is EIP-191", async () => {
    const salt = H(8);
    const answer = H(6);
    const expected = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [caseId, 1, evaluator.address, answer, payloadHash, salt]));
    expect(commitment(caseId, 1, evaluator.address, answer, payloadHash, salt)).toBe(expected);
    const sig = await payloadSig(evaluator, caseId, 1, payload);
    expect(sig.length).toBe(132);
  });
});

describe("panel API", () => {
  test("serves materials only while the seated panel votes (not while a draw is still choosing seats)", async () => {
    const state = fakes();
    const app = createPanelDeskApp(state.deps).app;
    const ask = () => app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: evaluator.address.toLowerCase(), encryptionPubKey: H(5), keySig: "0x01" }) });
    for (const status of [1, 4, 5, 7, 8]) { state.setCase(baseCase({ status })); expect((await ask()).status).toBe(409); }
    for (const status of [2, 3]) { state.setCase(baseCase({ status })); expect((await ask()).status).toBe(200); }
  });

  test("rejects non-panelists and shows public juror split only on public queries", async () => {
    const state = fakes();
    state.setCase(baseCase({ status: 2 }));
    const app = createPanelDeskApp(state.deps).app;
    const bad = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: A(99), encryptionPubKey: H(5), keySig: "0x01" }) });
    expect(bad.status).toBe(403);
    const good = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: evaluator.address.toLowerCase(), encryptionPubKey: H(5), keySig: "0x01" }) });
    expect(good.status).toBe(200);
    const goodBody = await good.json() as { jurorSummary: unknown; isPublic: boolean; openedAt: string };
    expect(goodBody.jurorSummary).toEqual({ dissent: [{ field: "amount" }], agreement: [{ field: "amount", agreeBps: 6666 }] });
    expect(goodBody.isPublic).toBe(true);
    // The query's on-chain open time, which buildAnswer needs as `openedAt`.
    expect(goodBody.openedAt).toBe("1700000000");
    state.deps.chain.getQuery = async () => ({ schemaId: 1, schemaVersion: 1, isPublic: false, status: 5, openedAt: 1_700_000_000n });
    const privateResponse = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: evaluator.address.toLowerCase(), encryptionPubKey: H(5), keySig: "0x01" }) });
    const privateBody = await privateResponse.json() as { jurorSummary: unknown; isPublic: boolean };
    expect(privateBody.jurorSummary).toBeNull();
    expect(privateBody.isPublic).toBe(false);
  });

  test("checks payload signer and current panel, and stores only the payload revealed on chain, after the reveal", async () => {
    let inserts = 0;
    const state = fakes({ store: { ...fakes().store, insertPanelPayload: async () => { inserts++; } } });
    const app = createPanelDeskApp(state.deps).app;
    const sig = await payloadSig(evaluator, caseId, 0, payload);
    const request = (who: string, signature: string) => app.request(`/v1/panel/${caseId}/payload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: who, panelIndex: 0, payload, answerJson: "{}", sig: signature }) });
    const code = async (response: Response) => (await response.json() as { error?: { code: string } }).error?.code;
    expect((await request(A(88), sig)).status).toBe(403);
    expect((await request(evaluator.address.toLowerCase(), "0x01")).status).toBe(403);
    // Not revealed on chain yet: refused, nothing stored (the answer is still hidden behind its commitment).
    state.setRevealed({ answerHash: ZERO32 as Hex, payloadHash: ZERO32 as Hex });
    const early = await request(evaluator.address.toLowerCase(), sig);
    expect(early.status).toBe(409);
    expect(await code(early)).toBe("NOT_REVEALED");
    // Revealed a different payload: refused.
    state.setRevealed({ answerHash: H(11), payloadHash: H(12) });
    const mismatch = await request(evaluator.address.toLowerCase(), sig);
    expect(mismatch.status).toBe(409);
    expect(await code(mismatch)).toBe("PAYLOAD_MISMATCH");
    expect(inserts).toBe(0);
    state.setRevealed({ answerHash: H(11), payloadHash });
    const publicResponse = await request(evaluator.address.toLowerCase(), sig);
    expect(publicResponse.status).toBe(201);
    expect((await publicResponse.json() as { payloadHash?: string }).payloadHash).toBe(payloadHash);
    expect(inserts).toBe(1);
    // A private payload is refused outright (its CLI never sends one) and never stored.
    state.deps.chain.getQuery = async () => ({ schemaId: 1, schemaVersion: 1, isPublic: false, status: 5, openedAt: 1n });
    const privateResponse = await request(evaluator.address.toLowerCase(), sig);
    expect(privateResponse.status).toBe(409);
    expect(await code(privateResponse)).toBe("PRIVATE_QUERY");
    expect(inserts).toBe(1);
    expect(() => assertPublicPayload(false)).toThrow("refusing to submit");
    expect(() => assertPublicPayload(true)).not.toThrow();
  });
});

describe("panel keeper", () => {
  test("keeper posts drand before draw, waits for unpublished rounds, and blockhash skips drand", async () => {
    const state = fakes(); state.deps.chain.dep.randomness = { kind: "drand", chainHash: "fake" };
    let posted = false;
    // The keeper must use the adapter's `beaconChain` (a regression: it used to pass the whole port, which lacks clients).
    state.deps.chain.beaconChain = {
      publicClient: { readContract: async () => posted ? H(40) : H(0), waitForTransactionReceipt: async () => ({ status: "success" }) },
      walletClient: { writeContract: async () => { state.calls.push("postBeacon"); posted = true; return H(41); } }, account: {},
    } as never;
    state.deps.drand = { getBeacon: async () => ({ round: 1, randomness: "", signature: "0xb55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b" }) } as unknown as DrandClient;
    await new PanelKeeper(state.deps).tick();
    expect(state.calls.slice(-2)).toEqual(["postBeacon", "draw"]);
    const pending = fakes(); pending.deps.chain.dep.randomness = { kind: "drand", chainHash: "fake" };
    Object.assign(pending.deps.chain, { publicClient: { readContract: async () => H(0) }, walletClient: { writeContract: async () => H(42) }, account: {} });
    pending.deps.drand = { getBeacon: async () => "not-published" } as unknown as DrandClient;
    await new PanelKeeper(pending.deps).tick(); expect(pending.calls).not.toContain("draw");
    const blockhash = fakes(); let drandCalls = 0; blockhash.deps.drand = { getBeacon: async () => { drandCalls++; return "not-published"; } } as unknown as DrandClient;
    await new PanelKeeper(blockhash.deps).tick(); expect(blockhash.calls).toContain("draw"); expect(drandCalls).toBe(0);
  });
  test("draws when the seed is ready, waits on SeedNotReady, reseals on SeedWindowMissed (no L1/L2 block compare)", async () => {
    const drawState = fakes(); drawState.setCase(baseCase({ status: 1, sealBlock: 900n }));
    await new PanelKeeper(drawState.deps).tick();
    expect(drawState.calls).toContain("draw");
    const notReady = fakes(); notReady.setCase(baseCase({ status: 1, sealBlock: 900n }));
    notReady.deps.chain.draw = async () => { throw new Error("execution reverted: custom error 0x484e3916"); };
    await new PanelKeeper(notReady.deps).tick();
    expect(notReady.calls).not.toContain("reseal");
    const resealState = fakes(); resealState.setCase(baseCase({ status: 1, sealBlock: 700n }));
    resealState.deps.chain.draw = async () => { throw new Error("SeedWindowMissed(700, 1000)"); };
    await new PanelKeeper(resealState.deps).tick();
    expect(resealState.calls).toContain("reseal");
  });

  test("expires a draw past its deadline instead of drawing, and leaves an expired case alone", async () => {
    const late = fakes(); late.setCase(baseCase({ status: 1, drawDeadline: 99n }));
    await new PanelKeeper(late.deps).tick();
    expect(late.calls).toEqual(["expireDraw"]);
    await new PanelKeeper(late.deps).tick();
    expect(late.calls).toEqual(["expireDraw"]);
    const app = createPanelDeskApp(late.deps).app;
    const closed = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: evaluator.address.toLowerCase(), encryptionPubKey: H(5), keySig: "0x01" }) });
    expect(closed.status).toBe(409);
    const view = await app.request(`/v1/panel/${caseId}`);
    expect((await view.json() as { drawDeadline: string }).drawDeadline).toBe("99");
  });

  test("continues a draw that spans calls within a tick, and expires a draw that cannot seat a panel without a seed", async () => {
    // Resumable: each call keeps progress; the keeper calls again until the panel is seated.
    const resumable = fakes(); resumable.setCase(baseCase({ status: 1 }));
    let left = 3;
    resumable.deps.chain.draw = async () => { resumable.calls.push("draw"); if (--left === 0) resumable.setCase(baseCase({ status: 2 })); return H(31); };
    await new PanelKeeper(resumable.deps).tick();
    expect(resumable.calls.filter((c) => c === "draw")).toHaveLength(3);
    // Past the draw's expiry (drand: no beacon was ever posted) expireDraw ends it without touching drand.
    const expired = fakes(); expired.deps.chain.dep.randomness = { kind: "drand", chainHash: "fake" };
    let drandCalls = 0; expired.deps.drand = { getBeacon: async () => { drandCalls++; return "not-published"; } } as unknown as DrandClient;
    expired.setCase(baseCase({ status: 1, drawDeadline: 50n })); expired.setDraw({ eligible: 6, expiry: 99n, filled: 0 });
    await new PanelKeeper(expired.deps).tick();
    expect(expired.calls).toEqual(["expireDraw"]);
    expect(drandCalls).toBe(0);
    // Impossible from the seal (two eligible): no draw call; expireDraw once the deadline passed.
    const impossible = fakes(); impossible.setDraw({ eligible: 2, expiry: 10_000n, filled: 0 });
    impossible.setCase(baseCase({ status: 1, drawDeadline: 500n }));
    const keeper = new PanelKeeper(impossible.deps);
    await keeper.tick();
    expect(impossible.calls).toEqual([]);
    impossible.setNow(501n);
    await keeper.tick();
    expect(impossible.calls).toEqual(["expireDraw"]);
  });

  test("drops terminal cases from the set it reads each tick, and prunes kept positions when that removes any", async () => {
    const state = fakes(); state.setCase(baseCase({ status: 8 }));
    let reads = 0;
    const getCase = state.deps.chain.getCase;
    state.deps.chain.getCase = async (id) => { reads++; return getCase(id); };
    const keeper = new PanelKeeper(state.deps);
    await keeper.tick();
    expect(keeper.openCases).toBe(0);
    await keeper.tick(); await keeper.tick();
    expect(reads).toBe(1);
    // FINAL without a posted verdict (a final HUNG) has nothing to do either.
    const hung = fakes(); hung.setCase(baseCase({ status: 7, outcomeAnswerHash: ZERO32 as Hex, outcomePayloadHash: ZERO32 as Hex }));
    const hungKeeper = new PanelKeeper(hung.deps);
    await hungKeeper.tick();
    expect(hungKeeper.openCases).toBe(0);
    // A FINAL case waiting for its payload stays until the feed is updated.
    const waiting = fakes(); waiting.setCase(baseCase({ status: 7 }));
    const waitingKeeper = new PanelKeeper(waiting.deps);
    await waitingKeeper.tick();
    expect(waitingKeeper.openCases).toBe(1);
    // prune only when the eth_call says it removes something.
    expect(state.calls).not.toContain("prune");
    state.setPrunable(5n);
    await keeper.tick();
    expect(state.calls.filter((c) => c === "prune")).toHaveLength(1);
    await keeper.tick();
    expect(state.calls.filter((c) => c === "prune")).toHaveLength(1);
  });

  test("resolves after deadline or early when simulate succeeds", async () => {
    const timed = fakes(); timed.setCase(baseCase({ status: 2, revealDeadline: 99n }));
    await new PanelKeeper(timed.deps).tick(); expect(timed.calls).toContain("resolve");
    const early = fakes(); early.setCase(baseCase({ status: 3, revealDeadline: 500n })); early.setSimulated(true);
    await new PanelKeeper(early.deps).tick(); expect(early.calls).toContain("resolve");
  });

  test("finalizes each majority/no-majority branch", async () => {
    for (const item of [
      baseCase({ status: 4, panelIndex: 0, appealDeadline: 99n }),
      baseCase({ status: 4, panelIndex: 1 }), baseCase({ status: 5, panelIndex: 1 }), baseCase({ status: 5, panelIndex: 0 }),
    ]) {
      const state = fakes(); state.setCase(item); await new PanelKeeper(state.deps).tick(); expect(state.calls).toContain("finalize");
    }
  });

  test("updates a feed after posted finalize and retries if evaluator payload is missing", async () => {
    const missing = fakes(); missing.setCase(baseCase({ status: 7 }));
    await new PanelKeeper(missing.deps).tick(); expect(missing.calls).not.toContain("feedsUpdate");
    missing.payloadRows.set(payloadHash, payloadBytes);
    await new PanelKeeper(missing.deps).tick(); expect(missing.calls).toContain("feedsUpdate");
    const wrongVerdict = fakes(); wrongVerdict.setCase(baseCase({ status: 7 })); wrongVerdict.setLatest(H(91));
    await new PanelKeeper(wrongVerdict.deps).tick(); expect(wrongVerdict.calls).not.toContain("feedsUpdate");
    const privateQuery = fakes(); privateQuery.setCase(baseCase({ status: 7 })); privateQuery.payloadRows.set(payloadHash, payloadBytes);
    privateQuery.deps.chain.getQuery = async () => ({ schemaId: 1, schemaVersion: 1, isPublic: false, status: 3, openedAt: 1n });
    await new PanelKeeper(privateQuery.deps).tick(); expect(privateQuery.calls).not.toContain("feedsUpdate");
  });
});

describe("feed update after a panel verdict (Feeds revert rules)", () => {
  const panelVerdict = verdictId(queryId, PANEL_ROUND);
  /** The error viem throws when simulateContract hits a Feeds custom error. */
  const feedsRevert = (errorName: "VerdictAlreadyApplied" | "StaleCorrection" | "StaleAsOf" | "AsOfTooFarAhead" | "VerdictBarred", args: readonly unknown[]) => {
    const data = encodeErrorResult({ abi: FeedsAbi, errorName, args: args as never });
    const cause = new ContractFunctionRevertedError({ abi: FeedsAbi, data, functionName: "update" });
    return new ContractFunctionExecutionError(cause, { abi: FeedsAbi, functionName: "update", args: [H(21), H(22), panelVerdict, payload], contractAddress: A(5) });
  };
  const setup = (failure: () => Error | undefined) => {
    const state = fakes(); state.setCase(baseCase({ status: 7 })); state.payloadRows.set(payloadHash, payloadBytes);
    let reads = 0, attempts = 0;
    const getCase = state.deps.chain.getCase;
    state.deps.chain.getCase = async (id) => { reads++; return getCase(id); };
    state.deps.chain.feedsUpdate = async () => { attempts++; const error = failure(); if (error) throw error; state.calls.push("feedsUpdate"); return H(35); };
    return { state, keeper: new PanelKeeper(state.deps), reads: () => reads, attempts: () => attempts };
  };
  const captureLogs = async (fn: () => Promise<void>) => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await fn(); } finally { process.stdout.write = write; }
    return { events: lines.map((line) => JSON.parse(line) as Record<string, unknown>), raw: lines.join("") };
  };

  test("reads Feeds.latest() with verdictTs (object or tuple), and an empty key as null", () => {
    expect(feedEntry({ verdictId: H(7), asOf: 10n, updatedAt: 12n, verdictTs: 11n, payload: "0x" })).toEqual({ verdictId: H(7), asOf: 10n, updatedAt: 12n, verdictTs: 11n });
    expect(feedEntry([H(7), 10n, 12n, 11n, "0x"])).toEqual({ verdictId: H(7), asOf: 10n, updatedAt: 12n, verdictTs: 11n });
    expect(feedEntry({ verdictId: H(0), asOf: 0n, updatedAt: 0n, verdictTs: 0n, payload: "0x" })).toBeNull();
  });

  test("classifies the Feeds custom errors from viem errors, error names and raw selectors", () => {
    expect(feedRejection(feedsRevert("AsOfTooFarAhead", [500n, 200n]))).toEqual({ name: "AsOfTooFarAhead", args: [500n, 200n] });
    expect(feedRejection(feedsRevert("StaleCorrection", [9n, 8n]))?.name).toBe("StaleCorrection");
    expect(feedRejection(new Error("execution reverted: VerdictAlreadyApplied(0x01)"))?.name).toBe("VerdictAlreadyApplied");
    expect(feedRejection(new Error(`execution reverted: custom error ${toFunctionSelector("StaleAsOf(uint64,uint64)")}`))?.name).toBe("StaleAsOf");
    expect(feedRejection(feedsRevert("VerdictBarred", [H(78)]))).toEqual({ name: "VerdictBarred", args: [H(78)] });
    expect(feedRejection(new Error(`execution reverted: custom error ${toFunctionSelector("VerdictBarred(bytes32)")}`))?.name).toBe("VerdictBarred");
    expect(feedRejection(new Error("fetch failed"))).toBeNull();
  });

  // AsOfTooFarAhead is terminal too: Feeds bounds asOf by the verdict's own on-chain time (verdict.ts + maxLead), so
  // chain time catching up never admits it. VerdictBarred: cleared by governance or replaced in a same-second tie.
  for (const [name, args] of [["VerdictAlreadyApplied", [H(77)]], ["StaleCorrection", [200n, 100n]], ["StaleAsOf", [300n, 100n]], ["AsOfTooFarAhead", [5_000n, 1_100n]], ["VerdictBarred", [H(77)]]] as const) {
    test(`${name} is terminal for the verdict: logged without content, never retried`, async () => {
      const t = setup(() => feedsRevert(name, args));
      const { events, raw } = await captureLogs(() => t.keeper.tick());
      expect(t.attempts()).toBe(1);
      expect(events.filter((e) => e.event === "panel_feed_update_rejected")).toEqual([{ level: "warn", event: "panel_feed_update_rejected", caseId, verdictId: panelVerdict, reason: name }]);
      expect(raw).not.toContain(payload.slice(2));
      expect(events.some((e) => e.event === "panel_keeper_action_failed")).toBe(false);
      const readsAfterFirst = t.reads();
      for (let i = 0; i < 5; i++) { t.state.setNow(100n + BigInt(i) * 1000n); await t.keeper.tick(); }
      expect(t.attempts()).toBe(1);
      expect(t.reads()).toBe(readsAfterFirst); // the case is not even re-read
    });
  }

  test("other failures (RPC) are still retried on the next tick; an applied verdict stops further reads", async () => {
    let fail = true;
    const t = setup(() => fail ? new Error("fetch failed") : undefined);
    await captureLogs(() => t.keeper.tick());
    fail = false;
    await t.keeper.tick();
    expect(t.attempts()).toBe(2);
    const reads = t.reads();
    await t.keeper.tick();
    expect(t.reads()).toBe(reads);
    // A feed that already carries the panel verdict settles the case without a write.
    const current = setup(() => undefined);
    current.state.deps.chain.feedLatest = async () => ({ verdictId: panelVerdict, asOf: 1n, updatedAt: 2n, verdictTs: 2n });
    await current.keeper.tick(); await current.keeper.tick();
    expect(current.attempts()).toBe(0);
    expect(current.reads()).toBe(1);
  });
});
