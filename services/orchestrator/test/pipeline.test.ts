import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { QueryStatus, VerdictStatus } from "@mochi/core";
import type { DecisionRes, Peer } from "@mochi/protocol";
import type { OrchestratorDeps, QueryLog } from "../src/ports.ts";
import { Orchestrator, PANEL_OFF_BACKOFF_MS } from "../src/pipeline.ts";
import { createOrchestratorApp } from "../src/app.ts";
import type { DrandClient } from "@mochi/chain";

const id = `0x${"11".repeat(32)}` as Hex, addr = `0x${"22".repeat(20)}` as Address, h = `0x${"33".repeat(32)}` as Hex;
const panel = `0x${"44".repeat(20)}` as Address, zeroAddress = `0x${"00".repeat(20)}` as Address;
const envelope = { v: 1 as const, epk: h, nonce: "0x00" as Hex, ct: "0x00" as Hex };
const quote = { kind: "mock" as const, measurement: h, reportData: h, raw: "0x" as Hex, issuedAt: 1 };
const peer: Peer = { address: addr, encryptionPubKey: h, quote };
const body = encodeAbiParameters([{ type: "tuple", components: [
  { name: "ticker", type: "bytes32" }, { name: "exDate", type: "uint64" }, { name: "recordDate", type: "uint64" }, { name: "payDate", type: "uint64" }, { name: "amountPerShareE8", type: "int256" }, { name: "currency", type: "bytes32" }, { name: "dividendType", type: "uint8" }, { name: "multiplierEffectExpected", type: "bool" },
] }], [{ ticker: h, exDate: 1n, recordDate: 0n, payDate: 0n, amountPerShareE8: 1n, currency: h, dividendType: 0, multiplierEffectExpected: false }]) as Hex;
const payload = encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [h, 1n, body]);

function fixture(opts: { private?: boolean; feed?: boolean; n?: number; status?: number; jurorFails?: boolean; firstClose409?: boolean } = {}) {
  const n = opts.n ?? 3;
  const query = { docCommit: h, schemaId: 1, schemaVersion: 1, n, round: 0, isPublic: !opts.private, allowPanelDisclosure: false, payPath: 0, status: opts.status ?? QueryStatus.OPEN, provenanceKind: 1, originId: h, tokensK: 1, provenanceHash: h, paramsHash: h, payerCommit: h, payer: addr, refundTo: addr, openedAt: 1n, deadline: 9999999999n, sealBlock: 0n, seed: h, paid: 1n, protocolFee: 1n };
  const jurors = Array.from({ length: 9 }, (_, i) => `0x${(i + 3).toString(16).padStart(40, "0")}` as Address);
  const calls = { seal: [] as unknown[], reseal: [] as unknown[], expand: [] as unknown[], escalate: [] as unknown[], approve: [] as unknown[], post: [] as unknown[], feed: [] as unknown[], dispatch: [] as unknown[], open: [] as unknown[], answer: [] as unknown[], insertedAnswers: [] as unknown[], verdicts: [] as unknown[], private: [] as unknown[], statuses: [] as unknown[], expired: [] as unknown[] };
  const state = { query: { ...query }, cursor: null as bigint | null, stored: false, closeCount: 0, blocks: 20n, lastVerdict: `0x${"00".repeat(32)}` as Hex, failInsertOnce: false, chainNowMs: 10_000,
    clockMs: 10_000, escrowPanel: panel, allowance: 0n, panelReads: 0, allowanceReads: 0 };
  const decision = (): DecisionRes => ({ verdictId: h, verdictInput: { queryId: id, round: state.query.round, status: VerdictStatus.VERDICT, agreementBps: 10000, dissentMask: 0, timeoutMask: 0, answerHash: h, payloadHash: h, evidenceRoot: h }, votes: jurors.slice(0, state.query.n).map((j, seat) => ({ juror: j, answerHash: h, spansRoot: h, quoteHash: h, sig: "0x12" })), consensusSig: "0x12", public: { answerJson: "{}", payload, fields: [], disagreement: [] }, ...(opts.private ? { privateResult: envelope } : {}) });
  const deps: OrchestratorDeps = {
    chain: {
      dep: { startBlock: "1", contracts: { randomness: addr, queryEscrow: addr, usdg: addr, panel, verdicts: addr } }, blockNumber: async () => state.blocks,
      latestTimestamp: async () => BigInt(Math.floor(state.chainNowMs / 1000)),
      getLogs: async (from, to) => state.cursor === null ? [{ queryId: id, blockNumber: 2n, kind: "opened" as const }] : [],
      getQuery: async () => ({ ...state.query }), jurorsOf: async () => jurors, prevNOf: async () => state.query.n === n ? 0 : 3,
      getJuror: async () => ({ operator: addr, measurement: h, role: 1, jurorClass: 2, bond: 1n, attestedUntil: 1n, exitRequestedAt: 0n, delisted: false, served: 0, timeouts: 0, lastTimeoutSlashAt: 0n }),
      getVerdict: async () => ({ queryId: id, round: state.query.round, status: 1, isPublic: !opts.private, escalated: false, provenanceKind: 1, schemaId: 1, schemaVersion: 1, agreementBps: 10000, dissentMask: 0, timeoutMask: 0, ts: 1n, docCommit: h, modelSetHash: h, evidenceRoot: h, attestationRoot: h, answerHash: h, payloadHash: h, paramsHash: h, provenanceHash: h, originId: h, payerCommit: h }),
      seal: async () => { calls.seal.push(id); state.query.status = QueryStatus.SEALED; return h; }, reseal: async () => { calls.reseal.push(id); state.query.status = QueryStatus.SEALED; return h; }, expire: async () => { calls.expired.push(id); state.query.status = QueryStatus.EXPIRED; return h; },
      expand: async (_id, newN) => { calls.expand.push(newN); state.query.n = newN; state.query.round++; state.query.status = QueryStatus.OPEN; state.query.sealBlock = 0n; return h; }, escalate: async () => { calls.escalate.push(id); return h; }, panelFee: async () => 50n, usdgApprove: async (spender, amount) => { calls.approve.push(amount); expect(spender).toBe(panel); state.allowance = amount; return h; },
      escrowPanel: async () => { state.panelReads++; return state.escrowPanel; }, usdgAllowance: async (spender) => { state.allowanceReads++; expect(spender).toBe(panel); return state.allowance; },
      latestVerdictOf: async () => state.lastVerdict, verdictTx: async () => h,
      post: async (...args) => { calls.post.push(args); state.lastVerdict = h; state.query.status = args[0].status === VerdictStatus.VERDICT ? QueryStatus.DECIDED : QueryStatus.HUNG; return h; }, feedsUpdate: async (...args) => { calls.feed.push(args); return h; },
    },
    intake: { attestation: async () => ({ role: "INTAKE", measurement: h, ...peer }), dispatch: async (_url, req) => { calls.dispatch.push(req); return { jurors: req.jurors.map(({ seat }) => ({ seat, address: jurors[seat]!, docEnvelope: envelope })), consensusSeed: envelope }; } },
    juror: { attestation: async (url) => ({ role: "JUROR", measurement: h, ...peer, address: url.split("/").at(-1) as Address }), answer: async (_url, req) => { calls.answer.push(req); if (opts.jurorFails && req.seat === 1) throw new Error("timeout"); return { seat: req.seat, vote: { juror: jurors[req.seat]!, answerHash: h, spansRoot: h, quoteHash: h, sig: "0x12" }, delivered: true }; } },
    consensus: { attestation: async () => ({ role: "CONSENSUS", measurement: h, ...peer }), open: async (_url, req) => { calls.open.push(req); return { deadlineMs: 130000 }; }, close: async () => { state.closeCount++; if (opts.firstClose409 && state.closeCount === 1) throw Object.assign(new Error("open"), { status: 409 }); return decision(); } },
    directory: { urlOf: async (address) => `http://juror.test/${address}` },
    store: {
      insertQuery: async () => { state.stored = true; }, setCursor: async (_n, v) => { state.cursor = v; }, getCursor: async () => state.cursor, queryIds: async () => state.stored ? [id] : [],
      getFeedQuery: async () => opts.feed ? { feedId: h, key: h } : null, getPayerResultKey: async () => opts.private ? h : null,
      insertJurorAnswer: async (v) => { calls.insertedAnswers.push(v); }, insertVerdict: async (v, p) => { if (state.failInsertOnce) { state.failInsertOnce = false; throw new Error("crash after post"); } calls.verdicts.push([v, p]); },
      hasVerdict: async () => calls.verdicts.length > 0, storePrivateResult: async (v, b) => { calls.private.push([v, b]); }, updateQueryStatus: async (_id, s) => { calls.statuses.push(s); }, statusCounts: async () => ({ "1": 1 }),
    }, clock: { now: () => state.clockMs, sleep: async () => {} }, config: { intakeUrl: "http://intake.test", consensusUrl: "http://consensus.test", jurorTimeoutMs: 100, closeMaxWaitMs: 2000, maxParallelQueries: 8 },
  };
  return { deps, calls, state, orchestrator: new Orchestrator(deps) };
}

describe("orchestrator lifecycle", () => {
  test("discovers, seals, dispatches, collects, retries close, posts and stores public verdict", async () => {
    const f = fixture({ firstClose409: true }); await f.orchestrator.tick(); await f.orchestrator.waitForIdle();
    expect(f.state.stored).toBe(true); expect(f.calls.seal).toHaveLength(1); expect(f.calls.dispatch).toHaveLength(1);
    expect(f.calls.open).toHaveLength(1); expect(f.calls.answer).toHaveLength(3); expect(f.calls.post).toHaveLength(1);
    expect(f.state.closeCount).toBe(2); expect((f.calls.verdicts[0] as unknown[])[1]).toBeDefined();
  });
  test("feed HUNG expands to five, dispatches only seats 3–4 next round, then updates feed", async () => {
    const f = fixture({ feed: true, status: QueryStatus.HUNG }); f.state.stored = true;
    await f.orchestrator.advance(id); expect(f.calls.expand).toEqual([5]);
    await f.orchestrator.advance(id); expect((f.calls.dispatch[0] as { jurors: unknown[] }).jurors).toHaveLength(2);
    expect(f.calls.feed).toHaveLength(1); expect((f.calls.feed[0] as unknown[])[0]).toBe(h); expect((f.calls.feed[0] as unknown[])[1]).toBe(h);
  });
  test("feed HUNG at nine approves panel fee and escalates", async () => {
    const f = fixture({ feed: true, n: 9, status: QueryStatus.HUNG }); f.state.stored = true;
    await f.orchestrator.advance(id); expect(f.calls.approve).toEqual([50n]); expect(f.calls.escalate).toEqual([id]);
  });
  test("feed HUNG at nine approves only when the allowance does not cover the panel fee", async () => {
    const covered = fixture({ feed: true, n: 9, status: QueryStatus.HUNG }); covered.state.stored = true; covered.state.allowance = 50n;
    await covered.orchestrator.advance(id);
    expect(covered.calls.approve).toEqual([]); expect(covered.calls.escalate).toEqual([id]);
    // A failing escalate (e.g. the payer's USDG is short) does not cost another approve on the next tick.
    const failing = fixture({ feed: true, n: 9, status: QueryStatus.HUNG }); failing.state.stored = true; failing.state.allowance = 49n;
    failing.deps.chain.escalate = async () => { throw new Error("escalate reverted"); };
    await expect(failing.orchestrator.advance(id)).rejects.toThrow("escalate reverted");
    await expect(failing.orchestrator.advance(id)).rejects.toThrow("escalate reverted");
    expect(failing.calls.approve).toEqual([50n]);
  });
  for (const [label, wired] of [["unset (escalation off)", zeroAddress], ["another contract", addr]] as const) {
    test(`feed HUNG at nine with QueryEscrow.panel ${label}: no transaction, logged, backs off, then escalates once wired`, async () => {
      const f = fixture({ feed: true, n: 9, status: QueryStatus.HUNG }); f.state.stored = true; f.state.escrowPanel = wired;
      const lines: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
      try { await f.orchestrator.advance(id); } finally { process.stdout.write = write; }
      expect(f.calls.approve).toEqual([]); expect(f.calls.escalate).toEqual([]); expect(f.state.allowanceReads).toBe(0);
      const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === "orchestrator.panel_escalation_off");
      expect(event).toMatchObject({ level: "warn", queryId: id, reason: wired === zeroAddress ? "escrow_panel_unset" : "escrow_panel_mismatch", retryInMs: PANEL_OFF_BACKOFF_MS });
      // Within the backoff not even the wiring is re-read.
      for (let i = 0; i < 5; i++) { f.state.clockMs += 60_000; await f.orchestrator.advance(id); }
      expect(f.state.panelReads).toBe(1); expect(f.calls.approve).toEqual([]); expect(f.calls.escalate).toEqual([]);
      // After the backoff it reads again; governance has switched escalation on in the meantime.
      f.state.escrowPanel = panel; f.state.clockMs = 10_000 + PANEL_OFF_BACKOFF_MS;
      await f.orchestrator.advance(id);
      expect(f.state.panelReads).toBe(2); expect(f.calls.approve).toEqual([50n]); expect(f.calls.escalate).toEqual([id]);
    });
  }
  test("private payer key is passed to consensus and only ciphertext is stored", async () => {
    const f = fixture({ private: true }); await f.orchestrator.tick(); await f.orchestrator.waitForIdle();
    expect((f.calls.open[0] as { payerResultPubKey?: Hex }).payerResultPubKey).toBe(h);
    expect(f.calls.private).toHaveLength(1); expect((f.calls.verdicts[0] as unknown[])[1]).toBeUndefined();
  });
  test("reseals missed seed window and expires queries past deadline", async () => {
    const r = fixture(); r.state.query.status = QueryStatus.OPEN; r.deps.chain.seal = async () => { throw new Error("SeedWindowMissed"); };
    await r.orchestrator.advance(id); expect(r.calls.reseal).toHaveLength(1);
    const e = fixture(); e.state.query.status = QueryStatus.OPEN; e.state.query.deadline = 1n; await e.orchestrator.advance(id); expect(e.calls.expired).toHaveLength(1);
  });
  test("posts a drand ticket before sealing, skips an existing beacon, and retries unpublished tickets", async () => {
    const f = fixture(); f.state.query.sealBlock = 1n;
    f.deps.chain.dep.randomness = { kind: "drand", chainHash: "fake" };
    const order: string[] = []; let posted = false; let published = true; let gets = 0;
    Object.assign(f.deps.chain, {
      publicClient: { readContract: async () => posted ? h : `0x${"00".repeat(32)}` },
      walletClient: { writeContract: async () => { order.push("postBeacon"); posted = true; return h; } }, account: {},
      publicClientWait: undefined,
    });
    // ensureBeacon waits for the receipt on publicClient after sending.
    (f.deps.chain as unknown as { publicClient: { waitForTransactionReceipt(args: unknown): Promise<{ status: string }> } }).publicClient.waitForTransactionReceipt = async () => ({ status: "success" });
    f.deps.drand = { getBeacon: async () => { gets++; return published ? { round: 1, randomness: "", signature: "0xb55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b" } : "not-published"; } } as unknown as DrandClient;
    const seal = f.deps.chain.seal;
    f.deps.chain.seal = async (queryId) => { order.push("seal"); return seal(queryId); };
    await f.orchestrator.advance(id);
    expect(order).toEqual(["postBeacon", "seal"]);
    expect(gets).toBe(1);
    posted = false; // the next open ticket is already posted on-chain in the separate case below
    const already = fixture(); already.state.query.sealBlock = 1n; already.state.query.status = QueryStatus.OPEN;
    already.deps.chain.dep.randomness = { kind: "drand", chainHash: "fake" };
    let relayCalls = 0;
    Object.assign(already.deps.chain, { publicClient: { readContract: async () => h }, walletClient: { writeContract: async () => { throw new Error("must skip"); } }, account: {} });
    (already.deps.chain as unknown as { publicClient: { waitForTransactionReceipt(args: unknown): Promise<{ status: string }> } }).publicClient.waitForTransactionReceipt = async () => ({ status: "success" });
    already.deps.drand = { getBeacon: async () => { relayCalls++; throw new Error("must skip"); } } as unknown as DrandClient;
    await already.orchestrator.advance(id); expect(relayCalls).toBe(0); expect(already.calls.seal).toHaveLength(1);
    const wait = fixture(); wait.state.query.sealBlock = 1n; wait.deps.chain.dep.randomness = { kind: "drand", chainHash: "fake" };
    Object.assign(wait.deps.chain, { publicClient: { readContract: async () => `0x${"00".repeat(32)}` }, walletClient: { writeContract: async () => h }, account: {} });
    (wait.deps.chain as unknown as { publicClient: { waitForTransactionReceipt(args: unknown): Promise<{ status: string }> } }).publicClient.waitForTransactionReceipt = async () => ({ status: "success" });
    wait.deps.drand = { getBeacon: async () => "not-published" } as unknown as DrandClient;
    await wait.orchestrator.advance(id); expect(wait.calls.seal).toHaveLength(0);
    await wait.orchestrator.advance(id); expect(wait.calls.seal).toHaveLength(0); // each polling tick retries the same ticket
    published = false;
  });
  test("blockhash deployments do not consult the configured drand client", async () => {
    const f = fixture(); let calls = 0;
    f.deps.drand = { getBeacon: async () => { calls++; throw new Error("must not be called"); } } as unknown as DrandClient;
    await f.orchestrator.advance(id);
    expect(f.calls.seal).toHaveLength(1); expect(calls).toBe(0);
  });
  test("fresh instance resumes without posting twice and juror timeout does not block", async () => {
    const f = fixture({ jurorFails: true }); f.state.stored = true; await f.orchestrator.advance(id);
    expect(f.calls.post).toHaveLength(1); expect(f.calls.insertedAnswers).toHaveLength(2);
    const restarted = new Orchestrator(f.deps); await restarted.advance(id); expect(f.calls.post).toHaveLength(1);
  });
  test("admin app exposes health and persisted state counts", async () => {
    const f = fixture(); const { app } = createOrchestratorApp({ orchestrator: f.orchestrator, store: f.deps.store });
    expect((await app.request("/healthz")).status).toBe(200);
    expect(await (await app.request("/v1/status")).json()).toEqual({ counts: { "1": 1 }, lastBlockProcessed: "0" });
  });
  test("recovers a verdict posted on-chain but not persisted (crash after post): persists and updates the feed", async () => {
    const f = fixture({ feed: true });
    f.state.failInsertOnce = true;
    await f.orchestrator.tick().catch(() => {}); await f.orchestrator.waitForIdle();
    expect(f.calls.post).toHaveLength(1);
    expect(f.calls.verdicts).toHaveLength(0);
    expect(f.calls.feed).toHaveLength(0);
    await f.orchestrator.advance(id);
    expect(f.calls.post).toHaveLength(1); // never re-posted
    expect(f.calls.verdicts).toHaveLength(1);
    expect(f.calls.feed).toHaveLength(1);
    expect(f.calls.statuses.at(-1)).toBe(QueryStatus.DECIDED);
  });
  test("seed not ready (raw selector from the randomness contract) just waits; no reseal", async () => {
    const f = fixture(); f.state.query.status = QueryStatus.OPEN;
    f.deps.chain.seal = async () => { throw new Error("execution reverted: custom error 0x484e3916"); };
    await f.orchestrator.advance(id);
    expect(f.calls.reseal).toHaveLength(0);
    expect(f.calls.dispatch).toHaveLength(0);
  });
});

test("all seats receive the same consensus absolute deadline and round", async () => {
  const f = fixture(); await f.orchestrator.tick(); await f.orchestrator.waitForIdle();
  expect(f.calls.answer).toHaveLength(3);
  for (const req of f.calls.answer) expect(req).toMatchObject({ deadlineMs: 130000, round: 0 });
});
