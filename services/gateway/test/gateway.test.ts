import { describe, expect, test } from "bun:test";
import { decodeFunctionData, zeroHash } from "viem";
import { QueryEscrowAbi } from "@mochi/chain";
import type { GatewayDeps } from "../src/ports.ts";
import { createGatewayApp } from "../src/app.ts";
import { signAnonyma } from "../src/hmac.ts";

const addr = "0x1111111111111111111111111111111111111111" as const;
const key = `0x${"22".repeat(32)}` as const;
const bytes = `0x${"33".repeat(32)}` as const;
const result = {
  provenance: { docCommit: bytes, kind: 0, originId: zeroHash, fetchedAt: "1700000000", tokensK: 4, transcriptHash: zeroHash },
  intakeSig: "0x1234", intake: addr, docCommit: bytes, paramsHash: zeroHash, schemaId: 3, tokensK: 4,
};
const voucher = { voucherId: bytes, docCommit: bytes, schemaId: 3, n: 3, maxAmount: "500", tier: 1, expiry: "1700000300" };
const passport = { v: 1, juror: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", jurorClass: 0, modelId: "example/model", lineage: "example", weightsSha256: bytes, openWeights: true, provider: "test", zdr: true, tee: "mock" };

function fixture(overrides: Partial<GatewayDeps> = {}) {
  const calls: any = { stored: [], relayed: [], intake: [], simulated: [], sent: [] };
  const disclosureRows = new Map<string, Uint8Array>();
  const publicJuror = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
  const privateJuror = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
  const deps: GatewayDeps = {
    intake: {
      request: async (path, body) => { calls.intake.push([path, body]); return path.endsWith("attestation") ? { encryptionPubKey: key } : result; },
      attestation: async () => ({ encryptionPubKey: key, quote: { test: true } }),
    },
    chain: {
      escrow: addr,
      quote: async () => ({ jurorFees: 100n, protocolFee: 20n }),
      computeQueryId: async () => bytes,
      relayer: addr,
      getQuery: async (id) => ({ id, status: 2 }),
      latestVerdictOf: async () => bytes,
      getVerdict: async () => ({ schemaId: 3, status: 1 }),
      jurorsOf: async (queryId) => queryId.endsWith("01") ? [publicJuror] : [privateJuror],
      getJuror: async (juror) => ({ jurorClass: juror === publicJuror ? 0 : 3 }),
      feedLatest: async (feedId, k) => ({ verdictId: bytes, asOf: 10n, updatedAt: 11n, payload: "0x" }),
      openWithVoucher: async () => bytes,
      simulateOpenShielded: async (...args) => { calls.simulated.push(args); if (calls.failSimulation) throw new Error("MockProofRejected: invalid proof"); },
      relayOpenShielded: async (...args) => { calls.sent.push(args); return `0x${"99".repeat(32)}`; },
      simulateExpandShielded: async (...args) => { calls.simulated.push(args); if (calls.failSimulation) throw new Error("MockExpansionRejected: invalid proof"); },
      relayExpandShielded: async (...args) => { calls.sent.push(args); return `0x${"99".repeat(32)}`; },
    },
    store: {
      getVerdict: async (id) => id.endsWith("01")
        ? { verdict: { queryId: id, isPublic: true, status: 1, agreementBps: 9000, schemaId: 3 }, publicPart: { answer: { eps: 2 }, payload: new Uint8Array(), dissent: [], fieldAgreement: [] } }
        : { verdict: { queryId: id, isPublic: false, status: 1, agreementBps: 9000, dissentMask: 0, timeoutMask: 0 }, publicPart: null },
      getPrivateResult: async () => ({ ciphertext: new Uint8Array([1, 2, 3]) }),
      disagreementSeries: async () => [{ disagreeRate: "0.2" }],
      modelDisagreementSeries: async () => [{ modelId: "example/model", disagreeRate: "0.2" }],
      getJurorPassports: async (keys) => keys.includes(publicJuror) ? [{ key: publicJuror, passport }] : [],
      paidVerdictCounts: async (_from, _to, payers) => { calls.internalPayers = payers; return { external: 5000, total: 5010 }; },
      activeFeedSubscribers: async () => 10,
      insertDisclosure: async (verdictId, keyHash, envelope) => {
        const key = `${verdictId}:${keyHash}`;
        if (disclosureRows.has(key)) return true;
        if ([...disclosureRows.keys()].filter((stored) => stored.startsWith(`${verdictId}:`)).length >= 20) return false;
        disclosureRows.set(key, envelope);
        return true;
      },
      getDisclosure: async (verdictId, keyHash) => {
        const envelope = disclosureRows.get(`${verdictId}:${keyHash}`);
        return envelope ? { envelope } : null;
      },
      listFeeds: async () => [],
      putPayerResultKey: async (payerCommit, pub) => { calls.stored.push([payerCommit, pub]); },
      insertAnonymaVoucher: async (input) => { calls.voucher = input; },
    },
    relayer: { sender: addr, openWithVoucher: async (p, prov, sig, v, sigVoucher) => { calls.relayed.push([p, prov, sig, v, sigVoucher]); return bytes; } },
    clock: { nowSeconds: () => 1700000000 }, anonymaSecret: "test-secret", sealForIntake: async (_attestation, plain) => ({ envelope: "sealed", plain }),
    ...overrides,
  };
  return { ...createGatewayApp(deps), deps, calls };
}

const post = (app: ReturnType<typeof createGatewayApp>["app"], path: string, body: unknown, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("gateway", () => {
  test("proxies attestation, upload, and URL intake", async () => {
    const { app, calls } = fixture();
    const attestation = await app.request("/v1/intake/attestation");
    expect(((await attestation.json()) as any).encryptionPubKey).toBe(key);
    expect((await post(app, "/v1/intake/upload?n=3", { envelope: { v: 1, epk: key, nonce: "0x", ct: "0x" } })).status).toBe(200);
    expect((await post(app, "/v1/intake/url", { envelope: { v: 1, epk: key, nonce: "0x", ct: "0x" } })).status).toBe(200);
    expect(calls.intake.map((x: any) => x[0])).toEqual(["/v1/intake/upload", "/v1/intake/url"]);
  });

  test("prepares USDG and shielded calldata, commits private key, and rejects missing private key", async () => {
    const { app, calls } = fixture();
    const base = { intake: result, n: 3, isPublic: false, refundTo: addr, nonce: "7", sender: addr, payerResultPubKey: key };
    for (const pay of [{ path: "usdg" }, { path: "shielded", nullifier: bytes, proof: "0xabcd" }]) {
      const response = await post(app, "/v1/query", { ...base, pay });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      const decoded = decodeFunctionData({ abi: QueryEscrowAbi, data: body.data });
      expect(decoded.functionName).toBe(pay.path === "usdg" ? "openWithUSDG" : "openShielded");
      expect((decoded.args as unknown as any[])[0].payerCommit).not.toBe(zeroHash);
    }
    expect(calls.stored).toHaveLength(2);
    expect(calls.stored[0][1]).toBe(key);
    const missing = await post(app, "/v1/query", { ...base, payerResultPubKey: undefined, pay: { path: "usdg" } });
    expect(missing.status).toBe(400);
  });

  test("public query uses zero payer commitment", async () => {
    const { app } = fixture();
    const response = await post(app, "/v1/query", { intake: result, n: 3, isPublic: true, refundTo: addr, nonce: "7", sender: addr, pay: { path: "usdg" } });
    const body = await response.json() as any;
    const decoded = decodeFunctionData({ abi: QueryEscrowAbi, data: body.data });
    expect((decoded.args as unknown as any[])[0].payerCommit).toBe(zeroHash);
  });

  test("shielded relay checks sender, simulates before sending, and reports reverts", async () => {
    const { app, deps, calls } = fixture();
    expect(await (await app.request("/v1/relayer")).json()).toEqual({ address: addr });
    const body = { intake: result, n: 3, isPublic: false, refundTo: addr, nonce: "7", sender: addr, payerResultPubKey: key, nullifier: bytes, proof: "0xabcd" };
    expect((await post(app, "/v1/relay/open-shielded", { ...body, sender: "0x2222222222222222222222222222222222222222" })).status).toBe(400);
    calls.failSimulation = true;
    const bad = await post(app, "/v1/relay/open-shielded", body);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "SIMULATION_FAILED", message: "MockProofRejected: invalid proof" } });
    expect(calls.sent).toHaveLength(0);
    calls.failSimulation = false;
    const success = await post(app, "/v1/relay/open-shielded", body);
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ queryId: bytes, txHash: `0x${"99".repeat(32)}` });
    expect(calls.simulated).toHaveLength(2);
    expect(calls.sent).toHaveLength(1);
    const expansion = await post(app, "/v1/relay/expand-shielded", { queryId: bytes, newN: 5, nullifier: `0x${"44".repeat(32)}`, proof: "0xabcd" });
    expect(expansion.status).toBe(200);
    expect(calls.sent).toHaveLength(2);
    calls.failSimulation = true;
    const failedExpansion = await post(app, "/v1/relay/expand-shielded", { queryId: bytes, newN: 7, nullifier: `0x${"55".repeat(32)}`, proof: "0xabcd" });
    expect(failedExpansion.status).toBe(400);
    expect(calls.sent).toHaveLength(2);
    deps.relayer = undefined;
    expect((await app.request("/v1/relayer")).status).toBe(503);
    expect((await post(app, "/v1/relay/open-shielded", body)).status).toBe(503);
  });

  test("shielded relay enforces body cap and per-IP token bucket", async () => {
    const capped = fixture({ relayBodyLimitBytes: 20 });
    const huge = await post(capped.app, "/v1/relay/open-shielded", { payload: "too large" });
    expect(huge.status).toBe(413);
    const limited = fixture({ relayRateLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    const body = { intake: result, n: 3, isPublic: false, refundTo: addr, nonce: "7", sender: addr, payerResultPubKey: key, nullifier: bytes, proof: "0xabcd" };
    expect((await post(limited.app, "/v1/relay/open-shielded", body)).status).toBe(200);
    expect((await post(limited.app, "/v1/relay/open-shielded", body)).status).toBe(429);
  });

  test("authenticates Anonyma, relays a matching voucher, and rejects bad or stale signatures", async () => {
    const { app, calls } = fixture();
    const body = JSON.stringify({ envelope: { v: 1, epk: key, nonce: "0x", ct: "0x" }, schemaId: 3, n: 3, voucher, voucherSig: "0xaabb", refundTo: addr, isPublic: true });
    const timestamp = "1700000000";
    const path = "/v1/anonyma/send-to-jury";
    const good = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "X-Mochi-Timestamp": timestamp, "X-Mochi-Signature": signAnonyma("test-secret", timestamp, body) }, body });
    expect(good.status).toBe(200);
    expect(calls.relayed).toHaveLength(1);
    expect(calls.voucher.queryId).toBe(bytes);
    const bad = await app.request(path, { method: "POST", headers: { "X-Mochi-Timestamp": timestamp, "X-Mochi-Signature": `0x${"00".repeat(32)}` }, body });
    expect(bad.status).toBe(401);
    const staleTimestamp = "1699990000";
    const stale = await app.request(path, { method: "POST", headers: { "X-Mochi-Timestamp": staleTimestamp, "X-Mochi-Signature": signAnonyma("test-secret", staleTimestamp, body) }, body });
    expect(stale.status).toBe(401);
  });

  test("serves public verdict fields and only ciphertext for private verdicts", async () => {
    const { app } = fixture();
    const pub = await (await app.request(`/v1/verdict/${`0x${"00".repeat(31)}01`}`)).json() as any;
    expect(pub.answer).toEqual({ eps: 2 });
    expect(pub.jurors).toEqual([{ seat: 0, juror: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", class: 0, passport }]);
    const priv = await (await app.request(`/v1/verdict/${`0x${"00".repeat(31)}02`}`)).json() as any;
    expect(priv.ciphertext).toBe("0x010203");
    expect(priv.answer).toBeUndefined();
    expect(priv.jurors).toEqual([{ seat: 0, juror: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", class: 3, passport: null }]);
  });

  test("private verdict remains unavailable until its ciphertext has been stored", async () => {
    const { app, deps } = fixture();
    const path = `/v1/verdict/${`0x${"00".repeat(31)}02`}`;
    deps.store.getPrivateResult = async () => null;
    expect((await app.request(path)).status).toBe(404);
    deps.store.getPrivateResult = async () => ({ ciphertext: new Uint8Array() });
    expect((await app.request(path)).status).toBe(404);
    deps.store.getPrivateResult = async () => ({ ciphertext: new Uint8Array([1, 2, 3]) });
    const ready = await app.request(path);
    expect(ready.status).toBe(200);
    expect((await ready.json() as { ciphertext: string }).ciphertext).toBe("0x010203");
  });

  test("resolves named feeds and disagreement series", async () => {
    const { app } = fixture();
    expect((await app.request("/v1/feeds/earnings@RHC/NVDA")).status).toBe(200);
    // Feed keys are left-aligned ASCII bytes32 (not hashes); schemaId comes from the Feeds contract.
    const byName = await (await app.request("/v1/feeds/corp-actions.split@RHC/acme")).json() as { key: string; schemaId?: number };
    expect(byName.key).toBe(`0x41434d45${"00".repeat(28)}`);
    expect((await app.request("/v1/disagreement?schema=3&field=eps&window=1d")).status).toBe(200);
    expect((await app.request("/v1/disagreement/models?schema=3&field=eps&window=1d")).status).toBe(200);
  });

  test("counts external paid verdict stats and computes kill criteria", async () => {
    const { app, deps, calls } = fixture();
    deps.internalPayers = ["0x1111111111111111111111111111111111111111"];
    const response = await app.request("/v1/stats");
    const stats = await response.json() as any;
    expect(response.status).toBe(200);
    expect(stats.paidVerdicts).toEqual({ external: 5000, total: 5010 });
    expect(stats.activeFeedSubscribers).toBe(10);
    expect(stats.killCriteria.day14).toEqual({ metric: "external paid verdicts / week", threshold: 5000, met: true });
    expect(stats.killCriteria.day30.met).toBe(true);
    expect(calls.internalPayers).toEqual(deps.internalPayers);
  });

  test("stores and fetches private disclosures, rejects public verdicts, and caps at 20", async () => {
    const { app } = fixture();
    const privateId = `0x${"00".repeat(31)}02`;
    const publicId = `0x${"00".repeat(31)}01`;
    const request = (verdictId: string, recipientPubKey: string) => post(app, "/v1/disclosures", {
      verdictId, recipientPubKey, envelope: { v: 1, epk: key, nonce: "0x", ct: "0xabcd" },
    });
    expect((await request(publicId, key)).status).toBe(400);
    const first = await request(privateId, key);
    expect(first.status).toBe(200);
    const { recipientKeyHash } = await first.json() as any;
    const fetched = await app.request(`/v1/disclosures/${privateId}/${recipientKeyHash}`);
    expect(await fetched.json()).toEqual({ envelope: { v: 1, epk: key, nonce: "0x", ct: "0xabcd" } });
    for (let index = 1; index < 20; index++) {
      const recipient = `0x${index.toString(16).padStart(2, "0")}${"44".repeat(31)}`;
      expect((await request(privateId, recipient)).status).toBe(200);
    }
    expect((await request(privateId, `0x${"55".repeat(32)}`)).status).toBe(409);
  });

  test("serves tRPC, MCP methods, and unknown method errors", async () => {
    const { app } = fixture();
    const query = await app.request(`/trpc/query?input=${encodeURIComponent(JSON.stringify({ queryId: bytes }))}`);
    expect(query.status).toBe(200);
    const stats = await app.request(`/trpc/stats?input=${encodeURIComponent(JSON.stringify({}))}`);
    expect(stats.status).toBe(200);
    expect(JSON.stringify(await stats.json())).toContain("paidVerdicts");
    const byModel = await app.request(`/trpc/disagreementByModel?input=${encodeURIComponent(JSON.stringify({ schema: 3, field: "eps", window: "1d" }))}`);
    expect(byModel.status).toBe(200);
    expect(JSON.stringify(await byModel.json())).toContain("example/model");
    const disclosure = await app.request(`/trpc/disclosure?input=${encodeURIComponent(JSON.stringify({ verdictId: bytes, recipientKeyHash: bytes }))}`);
    expect(disclosure.status).toBe(200);
    const call = async (method: string, params?: unknown) => app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    expect((await (await call("initialize")).json() as any).result.protocolVersion).toBe("2024-11-05");
    const tools = (await (await call("tools/list")).json() as any).result.tools;
    expect(tools.some((tool: any) => tool.name === "mochi.stats")).toBe(true);
    const statsTool = await call("tools/call", { name: "mochi.stats", arguments: {} });
    expect((await statsTool.json() as any).result.content[0].text).toContain("paidVerdicts");
    const missing = await call("tools/call", { name: "mochi.ask", arguments: { schema: "EARNINGS", docUrl: "https://example.com/doc" } });
    expect((await missing.json() as any).error.message).toContain("sender and refundTo");
    const payer = `0x${"12".repeat(20)}`;
    const tool = await call("tools/call", { name: "mochi.ask", arguments: { schema: "EARNINGS", docUrl: "https://example.com/doc", sender: payer, refundTo: payer } });
    expect((await tool.json() as any).result.content[0].text).toContain("queryId");
    const unknown = await (await call("bogus")).json() as any;
    expect(unknown.error.code).toBe(-32601);
  });
});
