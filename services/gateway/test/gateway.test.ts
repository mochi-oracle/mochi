import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { decodeFunctionData, keccak256, toHex, zeroHash } from "viem";
import { QueryEscrowAbi } from "@mochi/chain";
import { canonicalJson } from "@mochi/core";
import { payerCommit, provenanceFromJson, recipientKeyHash, type ProvenanceJson } from "@mochi/protocol";
import { MochiClient } from "@mochi/sdk";
import { MockQuoteVerifier, signProvenance } from "@mochi/tee";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { GatewayDeps } from "../src/ports.ts";
import { createGatewayApp } from "../src/app.ts";
import { signAnonyma } from "../src/hmac.ts";

const addr = "0x1111111111111111111111111111111111111111" as const;
const key = `0x${"22".repeat(32)}` as const;
const bytes = `0x${"33".repeat(32)}` as const;
const CHAIN_ID = 31337;
/** The fixture's registered intake key (JurorRegistry INTAKE) and a key the registry does not know. */
const intakeKey = privateKeyToAccount(`0x${"44".repeat(32)}`);
const rogueKey = privateKeyToAccount(`0x${"45".repeat(32)}`);
/** An intake result whose signed grant names `addr` (also the fixture relayer) as opener; public unless overridden. */
const intakeFor = async (prov: Record<string, unknown> = {}, signer: PrivateKeyAccount = intakeKey, chainId = CHAIN_ID) => {
  const provenance = {
    docCommit: bytes, kind: 0, originId: zeroHash, fetchedAt: "1700000000", tokensK: 4, transcriptHash: zeroHash,
    opener: addr, schemaId: 3, schemaVersion: 1, paramsHash: zeroHash, payerCommit: zeroHash, isPublic: true,
    allowPanelDisclosure: false, nonce: "7", expiry: "1700000900", ...prov,
  } as ProvenanceJson;
  const intakeSig = await signProvenance(signer, chainId, addr, provenanceFromJson(provenance));
  return { provenance, intakeSig, intake: signer.address.toLowerCase(), docCommit: bytes, paramsHash: zeroHash, schemaId: 3, tokensK: 4 };
};
const result = await intakeFor();
const privateResult = await intakeFor({ isPublic: false, payerCommit: payerCommit(key) });
const voucher = { voucherId: bytes, queryId: bytes, schemaId: 3, n: 3, maxAmount: "500", tier: 1, expiry: "1700000300" };
const passport = { v: 1, juror: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", jurorClass: 0, modelId: "example/model", lineage: "example", weightsSha256: bytes, openWeights: true, provider: "test", zdr: true, tee: "mock" };

function fixture(overrides: Partial<GatewayDeps> = {}) {
  const calls: any = { stored: [], relayed: [], intake: [], simulated: [], sent: [] };
  const disclosureRows = new Map<string, Array<{ envelopeHash: string; envelope: Uint8Array; createdAt: Date }>>();
  const publicJuror = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
  const privateJuror = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
  const deps: GatewayDeps = {
    intake: {
      request: async (path, body: any) => {
        calls.intake.push([path, body]);
        if (path.endsWith("attestation")) return { encryptionPubKey: key };
        // MCP seals through the sealForIntake stub below: echo its binding the way the intake signs it.
        const open = body?.envelope?.plain?.open;
        return calls.intakeResult ?? (open ? await intakeFor({ opener: open.opener, payerCommit: open.payerCommit, isPublic: open.isPublic, allowPanelDisclosure: open.allowPanelDisclosure, nonce: open.nonce }) : result);
      },
      attestation: async () => ({ encryptionPubKey: key, quote: { test: true } }),
    },
    chain: {
      chainId: CHAIN_ID,
      escrow: addr,
      isActive: async (k, role) => { calls.isActive = (calls.isActive ?? 0) + 1; return role === 2 && k.toLowerCase() === intakeKey.address.toLowerCase(); },
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
      insertDisclosure: async (verdictId, keyHash, envelopeHash, envelope) => {
        const rows = disclosureRows.get(`${verdictId}:${keyHash}`) ?? [];
        if (!rows.some((row) => row.envelopeHash === envelopeHash)) rows.push({ envelopeHash, envelope, createdAt: new Date(1_700_000_000_000 + rows.length) });
        disclosureRows.set(`${verdictId}:${keyHash}`, rows);
      },
      getDisclosure: async (verdictId, keyHash, envelopeHash) => {
        const rows = disclosureRows.get(`${verdictId}:${keyHash}`) ?? [];
        return (envelopeHash === undefined ? rows[0] : rows.find((row) => row.envelopeHash === envelopeHash)) ?? null;
      },
      listDisclosures: async (verdictId, keyHash) => {
        const rows = disclosureRows.get(`${verdictId}:${keyHash}`) ?? [];
        return { envelopes: rows.map(({ envelopeHash, createdAt }) => ({ envelopeHash, createdAt })), total: rows.length };
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

  test("prepares USDG and shielded calldata from the signed grant, commits the private key, and rejects bad keys", async () => {
    const { app, calls } = fixture();
    const base = { intake: privateResult, n: 3, refundTo: addr, payerResultPubKey: key };
    for (const pay of [{ path: "usdg" }, { path: "shielded", nullifier: bytes, proof: "0xabcd" }]) {
      const response = await post(app, "/v1/query", { ...base, pay });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      const decoded = decodeFunctionData({ abi: QueryEscrowAbi, data: body.data });
      expect(decoded.functionName).toBe(pay.path === "usdg" ? "openWithUSDG" : "openShielded");
      const [params, prov] = decoded.args as unknown as any[];
      expect(params).toEqual({ n: 3, refundTo: addr });
      expect(prov).toMatchObject({ opener: addr, payerCommit: payerCommit(key), isPublic: false, nonce: 7n, expiry: 1700000900n, schemaVersion: 1 });
    }
    expect(calls.stored).toHaveLength(2);
    expect(calls.stored[0]).toEqual([payerCommit(key), key]);
    const missing = await post(app, "/v1/query", { ...base, payerResultPubKey: undefined, pay: { path: "usdg" } });
    expect(await missing.json()).toMatchObject({ error: { code: "PRIVATE_KEY_REQUIRED" } });
    // A key other than the one the grant commits to would never get the result; refuse it up front.
    const wrongKey = await post(app, "/v1/query", { ...base, payerResultPubKey: `0x${"23".repeat(32)}`, pay: { path: "usdg" } });
    expect(await wrongKey.json()).toMatchObject({ error: { code: "PAYER_KEY_MISMATCH" } });
    const expired = await post(app, "/v1/query", { ...base, intake: await intakeFor({ isPublic: false, payerCommit: payerCommit(key), expiry: "1699999999" }), pay: { path: "usdg" } });
    expect(await expired.json()).toMatchObject({ error: { code: "PROVENANCE_EXPIRED" } });
    const inconsistent = await post(app, "/v1/query", { ...base, intake: { ...privateResult, tokensK: 1 }, pay: { path: "usdg" } });
    expect(await inconsistent.json()).toMatchObject({ error: { code: "INCONSISTENT_INTAKE" } });
    expect(calls.stored).toHaveLength(2);
  });

  test("refuses grants not signed by an active intake key and stores nothing for them", async () => {
    const { app, calls } = fixture();
    const base = { n: 3, refundTo: addr, payerResultPubKey: key, pay: { path: "usdg" } };
    const priv = { isPublic: false, payerCommit: payerCommit(key) };
    const tampered = { ...privateResult, provenance: { ...privateResult.provenance, allowPanelDisclosure: true } };
    const forgedGrants = [
      await intakeFor(priv, rogueKey), // a valid signature from a key the registry does not list as INTAKE
      { ...privateResult, intake: rogueKey.address.toLowerCase() }, // the registered key's signature, another name
      tampered, // a member changed after signing
      await intakeFor(priv, intakeKey, CHAIN_ID + 1), // signed for another chain's escrow domain
      { ...privateResult, intakeSig: "0x1234" },
    ];
    for (const intake of forgedGrants) {
      const response = await post(app, "/v1/query", { ...base, intake });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "BAD_INTAKE_SIGNATURE" } });
      const relayed = await post(app, "/v1/relay/open-shielded", { ...base, pay: undefined, intake, nullifier: bytes, proof: "0xabcd" });
      expect(await relayed.json()).toMatchObject({ error: { code: "BAD_INTAKE_SIGNATURE" } });
    }
    expect(calls.stored).toHaveLength(0);
    expect(calls.sent).toHaveLength(0);
    expect((await post(app, "/v1/query", { ...base, intake: privateResult })).status).toBe(200);
    expect(calls.stored).toHaveLength(1);
  });

  test("public query uses the grant's zero payer commitment and queryId from opener + nonce", async () => {
    const { app, deps } = fixture();
    const seen: unknown[] = [];
    deps.chain.computeQueryId = async (...args) => { seen.push(args); return bytes; };
    const response = await post(app, "/v1/query", { intake: result, n: 3, refundTo: addr, pay: { path: "usdg" } });
    const body = await response.json() as any;
    const decoded = decodeFunctionData({ abi: QueryEscrowAbi, data: body.data });
    expect((decoded.args as unknown as any[])[1]).toMatchObject({ payerCommit: zeroHash, isPublic: true });
    expect(seen).toEqual([[addr, bytes, 7n]]);
  });

  test("shielded relay checks sender, simulates before sending, and reports reverts", async () => {
    const { app, deps, calls } = fixture();
    expect(await (await app.request("/v1/relayer")).json()).toEqual({ address: addr });
    const body = { intake: privateResult, n: 3, refundTo: addr, payerResultPubKey: key, nullifier: bytes, proof: "0xabcd" };
    // The relayer only sends grants issued for the relayer itself (anything else would revert on-chain anyway).
    const otherOpener = await post(app, "/v1/relay/open-shielded", { ...body, intake: await intakeFor({ isPublic: false, payerCommit: payerCommit(key), opener: "0x2222222222222222222222222222222222222222" }) });
    expect(await otherOpener.json()).toMatchObject({ error: { code: "SENDER_MISMATCH" } });
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
    const body = { intake: privateResult, n: 3, refundTo: addr, payerResultPubKey: key, nullifier: bytes, proof: "0xabcd" };
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
    expect(calls.relayed[0][0]).toEqual({ n: 3, refundTo: addr });
    expect(calls.relayed[0][1]).toMatchObject({ opener: addr, nonce: 7n, isPublic: true });
    expect(calls.voucher.queryId).toBe(bytes);
    // Anonyma's sealed binding must name this gateway's relayer.
    calls.intakeResult = await intakeFor({ opener: "0x2222222222222222222222222222222222222222" });
    const otherOpener = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "X-Mochi-Timestamp": timestamp, "X-Mochi-Signature": signAnonyma("test-secret", timestamp, body) }, body });
    expect(await otherOpener.json()).toMatchObject({ error: { code: "BINDING_MISMATCH" } });
    calls.intakeResult = undefined;
    expect(calls.relayed).toHaveLength(1);
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

  test("stores every distinct disclosure envelope by hash: a squatter posting first cannot displace the payer's", async () => {
    const { app } = fixture({ disclosureRateLimit: { capacity: 100, refillPerSecond: 0 } });
    const privateId = `0x${"00".repeat(31)}02`;
    const publicId = `0x${"00".repeat(31)}01`;
    const junk = { v: 1, epk: key, nonce: "0x", ct: "0xabcd" };
    const genuine = { v: 1, epk: bytes, nonce: "0x0102", ct: "0xef01" };
    const request = (verdictId: string, recipientPubKey: string, envelope: unknown = junk) => post(app, "/v1/disclosures", { verdictId, recipientPubKey, envelope });
    expect((await request(publicId, key)).status).toBe(400);
    const first = await request(privateId, key, junk); // the squatter
    expect(first.status).toBe(200);
    const { recipientKeyHash } = await first.json() as any;
    const second = await request(privateId, key, genuine); // the payer, after it
    expect(second.status).toBe(200);
    const stored = await second.json() as any;
    // The hash the SDK records on-chain in DisclosureRegistry: keccak256 of the envelope's canonical JSON.
    expect(stored).toEqual({ recipientKeyHash, envelopeHash: keccak256(toHex(canonicalJson(genuine))) });
    expect((await (await request(privateId, key, genuine)).json() as any).envelopeHash).toBe(stored.envelopeHash); // idempotent
    const listed = await (await app.request(`/v1/disclosures/${privateId}/${recipientKeyHash}`)).json() as any;
    expect(listed.total).toBe(2);
    expect(listed.envelopes.map((e: any) => e.envelopeHash)).toEqual([keccak256(toHex(canonicalJson(junk))), stored.envelopeHash]);
    expect(listed.envelope).toEqual(junk); // no anchor on-chain: the oldest
    expect(listed.anchoredBy).toBeNull();
    const exact = await app.request(`/v1/disclosures/${privateId}/${recipientKeyHash}?envelopeHash=${stored.envelopeHash}`);
    expect(await exact.json()).toEqual({ envelope: genuine, envelopeHash: stored.envelopeHash });
    expect((await app.request(`/v1/disclosures/${privateId}/${recipientKeyHash}?envelopeHash=${bytes}`)).status).toBe(404);
    expect((await app.request(`/v1/disclosures/${privateId}/${recipientKeyHash}?envelopeHash=0x12`)).status).toBe(400);
    // No per-verdict recipient cap to fill: 25 recipients are all stored.
    for (let index = 1; index <= 25; index++) {
      const recipient = `0x${index.toString(16).padStart(2, "0")}${"44".repeat(31)}`;
      expect((await request(privateId, recipient)).status).toBe(200);
    }
  });

  test("prefers the envelope the payer anchored in DisclosureRegistry over older ones", async () => {
    const payer = "0x5555555555555555555555555555555555555555";
    const anchors = new Map<string, string>();
    const { app, deps } = fixture({ disclosureRateLimit: { capacity: 100, refillPerSecond: 0 } });
    deps.chain.getQuery = async () => ({ payer, refundTo: "0x6666666666666666666666666666666666666666" });
    deps.chain.disclosedEnvelopeHash = async (verdictId, keyHash, discloser) => (anchors.get(`${verdictId}:${keyHash}:${discloser}`) ?? zeroHash) as `0x${string}`;
    const privateId = `0x${"00".repeat(31)}02`;
    const genuine = { v: 1, epk: bytes, nonce: "0x0102", ct: "0xef01" };
    for (const envelope of [{ v: 1, epk: key, nonce: "0x", ct: "0xabcd" }, genuine]) {
      expect((await post(app, "/v1/disclosures", { verdictId: privateId, recipientPubKey: key, envelope })).status).toBe(200);
    }
    const keyHash = recipientKeyHash(key);
    // A squatter's own anchor (another sender) changes nothing; the payer's does.
    anchors.set(`${privateId}:${keyHash}:0x7777777777777777777777777777777777777777`, keccak256(toHex(canonicalJson({ v: 1, epk: key, nonce: "0x", ct: "0xabcd" }))));
    expect((await (await app.request(`/v1/disclosures/${privateId}/${keyHash}`)).json() as any).anchoredBy).toBeNull();
    anchors.set(`${privateId}:${keyHash}:${payer}`, keccak256(toHex(canonicalJson(genuine))));
    const body = await (await app.request(`/v1/disclosures/${privateId}/${keyHash}`)).json() as any;
    expect(body).toMatchObject({ envelope: genuine, anchoredBy: payer, total: 2 });
    // An anchored hash that was never posted here falls back to the oldest stored envelope; a failing read too.
    anchors.set(`${privateId}:${keyHash}:${payer}`, bytes);
    expect((await (await app.request(`/v1/disclosures/${privateId}/${keyHash}`)).json() as any).anchoredBy).toBeNull();
    deps.chain.disclosedEnvelopeHash = async () => { throw new Error("rpc down"); };
    expect((await app.request(`/v1/disclosures/${privateId}/${keyHash}`)).status).toBe(200);
  });

  test("bounds disclosure writes per caller, globally and by body size", async () => {
    const privateId = `0x${"00".repeat(31)}02`;
    /** A request from another transport peer, i.e. another caller (caller-set headers are never trusted). */
    const postFrom = (app: ReturnType<typeof createGatewayApp>["app"], body: unknown, peer: string) =>
      app.fetch(new Request("http://gateway.test/v1/disclosures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { peer });
    const envelope = (n: number) => ({ v: 1, epk: key, nonce: "0x", ct: `0x${n.toString(16).padStart(4, "0")}` });
    const perCaller = fixture({ disclosureRateLimit: { capacity: 2, refillPerSecond: 0 } });
    for (const n of [1, 2]) expect((await post(perCaller.app, "/v1/disclosures", { verdictId: privateId, recipientPubKey: key, envelope: envelope(n) })).status).toBe(200);
    expect((await post(perCaller.app, "/v1/disclosures", { verdictId: privateId, recipientPubKey: key, envelope: envelope(3) })).status).toBe(429);
    expect((await post(perCaller.app, "/v1/disclosures", { verdictId: privateId, recipientPubKey: key, envelope: envelope(3) }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
    expect((await postFrom(perCaller.app, { verdictId: privateId, recipientPubKey: key, envelope: envelope(3) }, "203.0.113.9")).status).toBe(200);
    const global = fixture({ disclosureWriteLimit: { capacity: 1, refillPerSecond: 0 } });
    expect((await post(global.app, "/v1/disclosures", { verdictId: privateId, recipientPubKey: key, envelope: envelope(1) })).status).toBe(200);
    const busy = await postFrom(global.app, { verdictId: privateId, recipientPubKey: key, envelope: envelope(2) }, "203.0.113.9");
    expect(busy.status).toBe(429);
    expect(((await busy.json()) as any).error.code).toBe("RATE_LIMITED");
    const small = fixture({ disclosureBodyLimitBytes: 64 });
    expect((await post(small.app, "/v1/disclosures", { verdictId: privateId, recipientPubKey: key, envelope: envelope(1) })).status).toBe(413);
    expect((await small.app.request("/v1/disclosures", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  });

  test("the SDK's disclose and readDisclosure round-trip through the gateway", async () => {
    const { app } = fixture();
    const verdictId = `0x${"00".repeat(31)}02` as `0x${string}`;
    const auditor = x25519.keygen();
    const salt = `0x${"5e".repeat(32)}` as `0x${string}`;
    const result = { v: 1 as const, verdictId, salt, answerJson: canonicalJson({ salt, answer: 42 }), payload: "0x" as `0x${string}`, fields: [] };
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      return app.request(`${url.pathname}${url.search}`, init);
    }) as typeof fetch;
    const verdicts = "0x0000000000000000000000000000000000000abc";
    const publicClient = {
      getChainId: async () => CHAIN_ID,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName !== "getVerdict") throw new Error(`unexpected read ${functionName}`);
        return { queryId: bytes, isPublic: false, answerHash: keccak256(toHex(result.answerJson)), payloadHash: zeroHash };
      },
    };
    const client = new MochiClient({
      gatewayUrl: "https://gateway.test", fetch: fetcher, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: addr }), intakeMeasurement: bytes,
      chain: { deployment: { chainId: CHAIN_ID, rpcUrl: "http://127.0.0.1:1", startBlock: "0", contracts: { verdicts } }, publicClient },
    } as never);
    const disclosed = await client.disclose({ verdictId, result, auditorPublicKey: toHex(auditor.publicKey) });
    expect(disclosed.recipientKeyHash).toBe(recipientKeyHash(toHex(auditor.publicKey)));
    expect((await client.readDisclosure(verdictId, toHex(auditor.secretKey))).answerJson).toBe(result.answerJson);
  });

  test("serves tRPC, MCP methods, and unknown method errors", async () => {
    const { app, calls } = fixture();
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
    const prepared = JSON.parse((await tool.json() as any).result.content[0].text);
    expect(prepared.queryId).toBe(bytes);
    const sealedOpen = calls.intake.at(-1)[1].envelope.plain.open;
    expect(sealedOpen).toMatchObject({ opener: payer, payerCommit: zeroHash, isPublic: true, allowPanelDisclosure: false });
    expect((decodeFunctionData({ abi: QueryEscrowAbi, data: prepared.data }).args as unknown as any[])[1]).toMatchObject({ opener: payer, nonce: BigInt(sealedOpen.nonce) });
    const unknown = await (await call("bogus")).json() as any;
    expect(unknown.error.code).toBe(-32601);
  });
});

describe("public /v1/query bounds", () => {
  const privateQuery = async (i: number) => {
    const pub = `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;
    return { intake: await intakeFor({ isPublic: false, payerCommit: payerCommit(pub), nonce: String(i) }), n: 3, refundTo: addr, payerResultPubKey: pub, pay: { path: "usdg" } };
  };
  /** A request as the CVM public proxy sends it: from loopback, naming the caller in X-Mochi-Client. */
  const viaProxy = (app: ReturnType<typeof createGatewayApp>["app"], path: string, body: unknown, client: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://127.0.0.1:3200${path}`, { method: "POST", headers: { "content-type": "application/json", "x-mochi-client": client, ...headers }, body: JSON.stringify(body) }), { peer: "127.0.0.1" });
  const fromPeer = (app: ReturnType<typeof createGatewayApp>["app"], path: string, body: unknown, peer: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://gateway.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { peer });
  test("rate limits callers and rejects oversized bodies before parsing", async () => {
    const { app, calls } = fixture({ queryRateLimit: { capacity: 2, refillPerSecond: 0.000001 } });
    expect((await viaProxy(app, "/v1/query", await privateQuery(1), "203.0.113.9")).status).toBe(200);
    expect((await viaProxy(app, "/v1/query", await privateQuery(2), "203.0.113.9")).status).toBe(200);
    const limited = await viaProxy(app, "/v1/query", await privateQuery(3), "203.0.113.9");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await viaProxy(app, "/v1/query", await privateQuery(4), "203.0.113.10")).status).toBe(200);
    expect(calls.stored).toHaveLength(3);
    const big = await post(fixture().app, "/v1/query", { ...(await privateQuery(5)), padding: "x".repeat(70_000) });
    expect(big.status).toBe(413);
  });
  test("keys callers on the proxy's client header over loopback, else on the transport peer; never on caller-set headers", async () => {
    const { app } = fixture({ queryRateLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    // Behind the CVM proxy every request arrives from 127.0.0.1; the proxy's client key separates callers.
    expect((await viaProxy(app, "/v1/query", await privateQuery(1), "visitor:AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(200);
    expect((await viaProxy(app, "/v1/query", await privateQuery(2), "visitor:AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(429);
    expect((await viaProxy(app, "/v1/query", await privateQuery(3), "visitor:BBBBBBBBBBBBBBBBBBBBBB")).status).toBe(200);
    expect((await viaProxy(app, "/v1/query", await privateQuery(4), "2001:db8:1:2::/64")).status).toBe(200);
    // X-Forwarded-For, CF-Connecting-IP and X-Real-IP never vary the key.
    for (const [i, headers] of [[5, { "x-forwarded-for": "198.51.100.2" }], [6, { "cf-connecting-ip": "192.0.2.77" }], [7, { "x-real-ip": "192.0.2.78" }]] as const) {
      expect((await viaProxy(app, "/v1/query", await privateQuery(i), "visitor:AAAAAAAAAAAAAAAAAAAAAA", headers)).status).toBe(429);
      expect((await fromPeer(app, "/v1/query", await privateQuery(i + 10), "192.0.2.10", headers)).status).toBe(i === 5 ? 200 : 429);
    }
    // From a non-loopback peer the client header is ignored: the peer is the identity.
    expect((await fromPeer(app, "/v1/query", await privateQuery(20), "192.0.2.10", { "x-mochi-client": "visitor:CCCCCCCCCCCCCCCCCCCCCC" })).status).toBe(429);
    expect((await fromPeer(app, "/v1/query", await privateQuery(21), "192.0.2.11")).status).toBe(200);
    expect((await fromPeer(app, "/v1/query", await privateQuery(22), "2001:db8:1:2::1")).status).toBe(200);
    expect((await fromPeer(app, "/v1/query", await privateQuery(23), "2001:db8:1:2:ffff::9")).status).toBe(429);
    // Loopback without a valid client header: the loopback peer itself.
    expect((await viaProxy(app, "/v1/query", await privateQuery(24), "bad value")).status).toBe(200);
    expect((await fromPeer(app, "/v1/query", await privateQuery(25), "127.0.0.1")).status).toBe(429);
  });
  test("bounds payer-key writes globally while public queries still prepare", async () => {
    const { app, calls } = fixture({ payerKeyWriteLimit: { capacity: 2, refillPerSecond: 0.000001 } });
    for (let i = 1; i <= 2; i++) expect((await viaProxy(app, "/v1/query", await privateQuery(i), `198.51.100.${i}`)).status).toBe(200);
    expect((await viaProxy(app, "/v1/query", await privateQuery(3), "198.51.100.3")).status).toBe(429);
    expect(calls.stored).toHaveLength(2);
    const publicQuery = { intake: result, n: 3, refundTo: addr, pay: { path: "usdg" } };
    expect((await viaProxy(app, "/v1/query", publicQuery, "198.51.100.4")).status).toBe(200);
  });
  test("only a grant that passes every check spends the payer-key budget, and one grant cannot spend it alone", async () => {
    const { app, calls } = fixture({ payerKeyWriteLimit: { capacity: 3, refillPerSecond: 0.000001 } });
    // Forged, expired, foreign-key and mismatched grants are refused before any token is taken or row is stored.
    const junk = [
      { ...(await privateQuery(1)), intake: { ...(await privateQuery(1)).intake, intakeSig: "0x1234" } },
      { ...(await privateQuery(2)), intake: await intakeFor({ isPublic: false, payerCommit: payerCommit(key), nonce: "2" }, rogueKey), payerResultPubKey: key },
      { ...(await privateQuery(3)), intake: await intakeFor({ isPublic: false, payerCommit: payerCommit(key), nonce: "3", expiry: "1" }) , payerResultPubKey: key },
      { ...(await privateQuery(4)), payerResultPubKey: `0x${"ab".repeat(32)}` },
    ];
    for (let round = 0; round < 3; round++) for (const [i, body] of junk.entries()) expect((await viaProxy(app, "/v1/query", body, `198.51.100.${i}`)).status).toBe(400);
    expect(calls.stored).toHaveLength(0);
    // Replaying one valid grant spends at most its own share (3), from many callers.
    const replay = await privateQuery(10);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await viaProxy(app, "/v1/query", replay, `203.0.113.${i}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // The global budget (3) is now spent by that grant's share, so a new grant waits; the junk spent nothing.
    expect((await viaProxy(app, "/v1/query", await privateQuery(11), "203.0.113.50")).status).toBe(429);
    const fresh = fixture({ payerKeyWriteLimit: { capacity: 3, refillPerSecond: 0.000001 }, payerKeyGrantLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    for (let i = 0; i < 3; i++) await viaProxy(fresh.app, "/v1/query", replay, `203.0.113.${i}`);
    expect((await viaProxy(fresh.app, "/v1/query", await privateQuery(12), "203.0.113.60")).status).toBe(200);
    expect((await viaProxy(fresh.app, "/v1/query", await privateQuery(13), "203.0.113.61")).status).toBe(200);
  });
  test("tRPC prepareQuery shares /v1/query's body cap, per-caller and payer-key budgets and grant checks", async () => {
    const trpc = (app: ReturnType<typeof createGatewayApp>["app"], input: unknown, client: string) => app.fetch(new Request("http://127.0.0.1:3200/trpc/prepareQuery", { method: "POST", headers: { "content-type": "application/json", "x-mochi-client": client }, body: JSON.stringify(input) }), { peer: "127.0.0.1" });
    const perCaller = fixture({ queryRateLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    const first = await trpc(perCaller.app, await privateQuery(1), "203.0.113.20");
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).result.data.queryId).toBe(bytes);
    const again = await trpc(perCaller.app, await privateQuery(2), "203.0.113.20");
    expect(again.status).toBe(429);
    // One bucket per caller across both entry points.
    expect((await viaProxy(perCaller.app, "/v1/query", await privateQuery(3), "203.0.113.20")).status).toBe(429);
    const restFirst = fixture({ queryRateLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    expect((await viaProxy(restFirst.app, "/v1/query", await privateQuery(4), "203.0.113.21")).status).toBe(200);
    expect((await trpc(restFirst.app, await privateQuery(5), "203.0.113.21")).status).toBe(429);
    expect((await trpc(restFirst.app, await privateQuery(6), "203.0.113.22")).status).toBe(200);

    const keyBudget = fixture({ payerKeyWriteLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    expect((await trpc(keyBudget.app, await privateQuery(7), "198.51.100.30")).status).toBe(200);
    expect((await trpc(keyBudget.app, await privateQuery(8), "198.51.100.31")).status).toBe(429);
    expect((await viaProxy(keyBudget.app, "/v1/query", await privateQuery(9), "198.51.100.32")).status).toBe(429);
    expect(keyBudget.calls.stored).toHaveLength(1);

    const checks = fixture({ payerKeyWriteLimit: { capacity: 1, refillPerSecond: 0.000001 } });
    const forged = await trpc(checks.app, { ...(await privateQuery(10)), intake: await intakeFor({ isPublic: false, payerCommit: payerCommit(key) }, rogueKey), payerResultPubKey: key }, "198.51.100.40");
    expect(forged.status).toBe(400);
    expect(JSON.stringify(await forged.json())).toContain("BAD_INTAKE_SIGNATURE");
    expect(checks.calls.stored).toHaveLength(0);
    expect((await trpc(checks.app, { ...(await privateQuery(11)), padding: "x".repeat(70_000) }, "198.51.100.41")).status).toBe(413);
    expect(checks.calls.stored).toHaveLength(0);
    // The forged grant spent nothing: the one-row budget still admits a valid grant.
    expect((await trpc(checks.app, await privateQuery(12), "198.51.100.42")).status).toBe(200);
  });

  test("store purges unopened payer keys at most once per interval and never fails the write", async () => {
    const { createGatewayStore } = await import("../src/adapters/store.ts");
    const statements: string[] = []; let inserted = 0; let time = 0; let failPurge = false;
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => { inserted++; } }) }),
      execute: async (query: { queryChunks: Array<{ value?: string[] } | unknown> }) => {
        statements.push(query.queryChunks.map((chunk: any) => (chunk?.value ?? []).join("")).join(""));
        if (failPurge) throw new Error("db down");
        return [];
      },
    };
    const store = createGatewayStore(db as never, { now: () => time });
    const commit = `0x${"ab".repeat(32)}`, pub = `0x${"cd".repeat(32)}`;
    await store.putPayerResultKey(commit, pub);
    await store.putPayerResultKey(commit, pub);
    expect(inserted).toBe(2);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("DELETE FROM payer_result_keys");
    expect(statements[0]).toContain("NOT EXISTS (SELECT 1 FROM queries");
    time += 11 * 60 * 1000; failPurge = true;
    await store.putPayerResultKey(commit, pub);
    expect(statements).toHaveLength(2);
    expect(inserted).toBe(3);
  });
});

describe("intake refusals", () => {
  test("actionable intake refusals reach the caller with fixed messages; internal ones stay generic", async () => {
    const { IntakeHttpError } = await import("../src/adapters/intake.ts");
    const envelope = { v: 1, epk: key, nonce: "0x", ct: "0x" };
    const failing = (status: number, code: string | undefined) => fixture({
      intake: { request: async (path: string) => { if (path.endsWith("attestation")) return { encryptionPubKey: key }; throw new IntakeHttpError(status, code); }, attestation: async () => ({ encryptionPubKey: key }) } as never,
    });
    const full = await post(failing(503, "STORE_FULL").app, "/v1/intake/upload", { envelope });
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("600");
    expect((await full.json() as any).error.code).toBe("STORE_FULL");
    const empty = await post(failing(422, "EMPTY_DOCUMENT").app, "/v1/intake/upload", { envelope });
    expect(empty.status).toBe(422);
    expect((await empty.json() as any).error.code).toBe("EMPTY_DOCUMENT");
    // Internal intake refusals (attestation, panel, dispatch) and status/code mismatches are not exposed.
    for (const [status, code] of [[403, "BAD_ATTESTATION"], [409, "RECORD_MISMATCH"], [500, "STORE_FULL"], [502, undefined]] as const) {
      const res = await post(failing(status, code).app, "/v1/intake/upload", { envelope });
      expect(res.status).toBe(500);
      expect((await res.json() as any).error.code).toBe("INTERNAL");
    }
  });

  test("the intake adapter reads only the error code from a refusal", async () => {
    const { createIntakeClient, IntakeHttpError } = await import("../src/adapters/intake.ts");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { code: "DOCUMENT_TOO_LARGE", message: "do not echo this" } }, { status: 413 }) });
    try {
      const client = createIntakeClient(`http://127.0.0.1:${server.port}`, 5_000);
      const failure = await client.request("/v1/intake/upload", {}).then(() => undefined, (e) => e);
      expect(failure).toBeInstanceOf(IntakeHttpError);
      expect(failure.publicError).toEqual({ code: "DOCUMENT_TOO_LARGE", status: 413, message: "The document is too large" });
      expect(String(failure.message)).not.toContain("do not echo");
    } finally { server.stop(true); }
  });
});
