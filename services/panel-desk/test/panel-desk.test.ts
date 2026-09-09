import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { answerHash as coreAnswerHash, PANEL_ROUND, verdictId } from "@mochi/core";
import { aad, DispatchPanelResSchema } from "@mochi/protocol";
import { seal } from "@mochi/tee";
import { buildPayload, normalizeValue, normalizeParams, resolveSchema } from "@mochi/schemas";
import { createPanelDeskApp } from "../src/app.ts";
import { commitment, generateEvaluatorKey, openMaterials, payloadSig, bindKey, buildAnswer } from "../src/evaluator.ts";
import { PanelKeeper } from "../src/keeper.ts";
import type { ChainPort, PanelCase, PanelDeps, Store } from "../src/ports.ts";
import type { DrandClient } from "@mochi/chain";

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
    payer: A(3), fee: 1n, outcomeAnswerHash: H(11), outcomePayloadHash: payloadHash, ...overrides };
}

function fakes(overrides: Partial<PanelDeps> = {}) {
  let panel = baseCase();
  let block = 1000n;
  let now = 100n;
  let simulated = false;
  let queryStatus = 3;
  let latest = verdictId(queryId, PANEL_ROUND);
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
    getQuery: async () => ({ schemaId: 1, schemaVersion: 1, isPublic: true, status: queryStatus }), latestVerdictOf: async () => latest,
    simulateResolve: async () => simulated, draw: async () => { calls.push("draw"); return H(31); }, reseal: async () => { calls.push("reseal"); return H(32); },
    resolve: async () => { calls.push("resolve"); return H(33); }, finalize: async () => { calls.push("finalize"); panel = { ...panel, status: 7 }; return H(34); },
    feedsUpdate: async () => { calls.push("feedsUpdate"); return H(35); }, feedLatest: async () => null,
    panelStake: async () => 0n, approvePanel: async () => H(36), stake: async () => H(37), commit: async () => H(38), reveal: async () => H(39),
  };
  const deps: PanelDeps = { chain, store, intake: { dispatchPanel: async () => DispatchPanelResSchema.parse({ evaluators: [{ address: evaluator.address.toLowerCase(), docEnvelope: { v: 1, epk: H(50), nonce: `0x${"00".repeat(12)}`, ct: "0x01" } }] }) }, clock: { sleep: async () => {} }, config: { intakeUrl: "http://intake", pollMs: 1000 }, ...overrides };
  return { deps, calls, store, payloadRows, setCase: (x: PanelCase) => panel = x, setBlock: (x: bigint) => block = x, setNow: (x: bigint) => now = x,
    setSimulated: (x: boolean) => simulated = x, setQueryStatus: (x: number) => queryStatus = x, setLatest: (x: Hex) => latest = x };
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

  test("answer and payload hashes match the shared core and schemas packages", () => {
    const schema = resolveSchema(7, { question: "What?", answer_type: "STRING" });
    const params = normalizeParams(schema, { question: "What?", answer_type: "STRING" });
    expect(params.ok).toBe(true);
    const normalized = normalizeValue(schema.fields[0]!, "A finding");
    expect(normalized.ok).toBe(true);
    const fields = { answer: normalized.ok ? normalized.value : null };
    const built = buildAnswer(7, 1, H(9), { question: "What?", answer_type: "STRING" }, { answer: "A finding" }, 1n);
    expect(built.answerHash).toBe(coreAnswerHash({ salt: H(9), schemaId: schema.id, schemaVersion: 1, fields }));
    const expectedPayload = buildPayload(schema, fields, params.ok ? params.params : {}, { openedAt: 1n }).payload;
    expect(built.payload).toBe(expectedPayload);
    expect(built.payloadHash).toBe(keccak256(expectedPayload));
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
  test("rejects non-panelists and shows public juror split only on public queries", async () => {
    const state = fakes();
    const app = createPanelDeskApp(state.deps).app;
    const bad = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: A(99), encryptionPubKey: H(5), keySig: "0x01" }) });
    expect(bad.status).toBe(403);
    const good = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: evaluator.address.toLowerCase(), encryptionPubKey: H(5), keySig: "0x01" }) });
    expect(good.status).toBe(200);
    expect((await good.json() as { jurorSummary: unknown }).jurorSummary).toEqual({ dissent: [{ field: "amount" }], agreement: [{ field: "amount", agreeBps: 6666 }] });
    state.deps.chain.getQuery = async () => ({ schemaId: 1, schemaVersion: 1, isPublic: false, status: 5 });
    const privateResponse = await app.request(`/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: evaluator.address.toLowerCase(), encryptionPubKey: H(5), keySig: "0x01" }) });
    expect((await privateResponse.json() as { jurorSummary: unknown }).jurorSummary).toBeNull();
  });

  test("checks payload signer and current panel before storing", async () => {
    let inserts = 0;
    const state = fakes({ store: { ...fakes().store, insertPanelPayload: async () => { inserts++; } } });
    const app = createPanelDeskApp(state.deps).app;
    const sig = await payloadSig(evaluator, caseId, 0, payload);
    const request = (who: string, signature: string) => app.request(`/v1/panel/${caseId}/payload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: who, panelIndex: 0, payload, answerJson: "{}", sig: signature }) });
    expect((await request(A(88), sig)).status).toBe(403);
    expect((await request(evaluator.address.toLowerCase(), "0x01")).status).toBe(403);
    expect((await request(evaluator.address.toLowerCase(), sig)).status).toBe(201);
    expect(inserts).toBe(1);
    state.deps.chain.getQuery = async () => ({ schemaId: 1, schemaVersion: 1, isPublic: false, status: 5 });
    expect((await request(evaluator.address.toLowerCase(), sig)).status).toBe(201);
    expect(inserts).toBe(1);
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
  });
});
