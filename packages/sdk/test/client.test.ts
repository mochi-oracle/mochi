import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@mochi/core";
import { aad, type IntakeResult } from "@mochi/protocol";
import { createReceiptSigner, buildAnchorBatch, type VerdictReceiptInput } from "@mochi/receipts";
import { MockTeeProvider, MockQuoteVerifier, seal } from "@mochi/tee";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { Deployment } from "@mochi/chain";
import { MochiClient } from "../src/client.ts";

const measurement = `0x${"11".repeat(32)}` as Hex;
const root = privateKeyToAccount(`0x${"22".repeat(32)}`);
const intake = new MockTeeProvider({ seed: `0x${"33".repeat(32)}`, measurement, mockRoot: root });
const intakeResult: IntakeResult = {
  provenance: { docCommit: `0x${"44".repeat(32)}`, kind: 0, originId: `0x${"00".repeat(32)}`, fetchedAt: "1", tokensK: 1, transcriptHash: `0x${"55".repeat(32)}` },
  intakeSig: "0x", intake: intake.signer().address.toLowerCase() as Hex,
  docCommit: `0x${"44".repeat(32)}`, paramsHash: `0x${"66".repeat(32)}`, schemaId: 3, tokensK: 1,
};
const zeroAddress = "0x0000000000000000000000000000000000000001" as Hex;

function fixture(handler?: (url: string, init?: RequestInit) => unknown | Promise<unknown>, chain?: { deployment: Deployment; publicClient?: PublicClient }, extra: Record<string, unknown> = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    let data: unknown;
    if (url.endsWith("/v1/intake/attestation")) data = { role: "INTAKE", address: intake.signer().address.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement, quote: await intake.quote() };
    else if (url.includes("/v1/intake/")) data = intakeResult;
    else data = await handler?.(url, init) ?? {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { requests, client: new MochiClient({ gatewayUrl: "https://gateway.test", indexerUrl: "https://indexer.test", fetch: fetcher, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement, ...(chain ? { chain } : {}), ...extra } as never) };
}

describe("MochiClient", () => {
  test("validates intake measurement and report binding before sealing", async () => {
    const good = fixture();
    expect((await good.client.intakeAttestation()).role).toBe("INTAKE");
    const badFetch = (async () => {
      const q = await intake.quote();
      return Response.json({ role: "INTAKE", address: intake.signer().address.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement, quote: { ...q, measurement: `0x${"99".repeat(32)}` } });
    }) as unknown as typeof fetch;
    const bad = new MochiClient({ gatewayUrl: "https://gateway.test", fetch: badFetch, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement });
    await expect(bad.intakeAttestation()).rejects.toThrow("measurement field mismatch");
    const wrongBinding = new MochiClient({ gatewayUrl: "https://gateway.test", fetch: (async () => {
      const quote = await intake.quote();
      return Response.json({ role: "INTAKE", address: intake.signer().address.toLowerCase(), encryptionPubKey: `0x${"99".repeat(32)}`, measurement, quote });
    }) as unknown as typeof fetch, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement });
    await expect(wrongBinding.intakeAttestation()).rejects.toThrow("unexpected reportData");
  });

  test("prepares public and private envelopes without putting the private key in HTTP bodies", async () => {
    const { client, requests } = fixture(async (url) => url.endsWith("/v1/query") ? { queryId: `0x${"77".repeat(32)}`, to: zeroAddress, data: "0x1234", quote: { total: "123" } } : {});
    const pub = await client.prepareQuery({ schema: "EARNINGS", document: { bytes: new Uint8Array([7, 8]), contentType: "application/pdf" }, isPublic: true, sender: zeroAddress });
    expect(pub.secrets.salt).toBe(`0x${"00".repeat(32)}`);
    const priv = await client.prepareQuery({ schema: 3, document: { url: "https://docs.test/x.pdf" }, isPublic: false, sender: zeroAddress });
    expect(priv.secrets.salt).not.toBe(pub.secrets.salt);
    expect(priv.secrets.resultPrivateKey).toBeDefined();
    const qBody = JSON.parse(String(requests.filter((r) => r.url.endsWith("/v1/query")).at(-1)?.init?.body));
    expect(qBody.payerResultPubKey).toBeDefined();
    expect(JSON.stringify(requests.map((r) => r.init?.body))).not.toContain(priv.secrets.resultPrivateKey);
    const envelope = JSON.parse(String(requests.find((r) => r.url.includes("/v1/intake/url"))?.init?.body)).envelope;
    const opened = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake())));
    expect(opened).toMatchObject({ schemaId: 3, salt: priv.secrets.salt, url: "https://docs.test/x.pdf" });
  });

  test("waits for query result and returns the first available verdict when non-final", async () => {
    let polls = 0;
    const { client } = fixture(async () => ({ query: { status: 3 }, latestVerdictId: ++polls > 1 ? `0x${"88".repeat(32)}` : `0x${"00".repeat(32)}` }));
    expect(await client.waitForVerdict(`0x${"77".repeat(32)}`, { final: false, pollMs: 1 })).toBe(`0x${"88".repeat(32)}`);
  });

  test("ask sends the gateway transaction and waits for one confirmation", async () => {
    const hash = `0x${"89".repeat(32)}` as Hex;
    const publicClient = { waitForTransactionReceipt: async (args: { confirmations: number }) => { expect(args.confirmations).toBe(1); return { status: "success" }; } };
    const chain = { deployment: { contracts: { verdicts: zeroAddress, receiptAnchor: zeroAddress } }, publicClient } as never;
    const { client } = fixture(async () => ({ queryId: `0x${"77".repeat(32)}`, to: zeroAddress, data: "0x1234", quote: {} }), chain);
    let sent: unknown;
    const wallet = { account: root, chain: null, sendTransaction: async (args: unknown) => { sent = args; return hash; } } as never;
    const result = await client.ask({ schema: 3, document: { url: "https://docs.test/doc" }, isPublic: true, sender: zeroAddress }, wallet);
    expect(sent).toMatchObject({ to: zeroAddress, data: "0x1234" });
    expect(result).toMatchObject({ queryId: `0x${"77".repeat(32)}`, txHash: hash });
  });

  test("shielded-pool ask quotes as the relayer, proves the exact total, and relays without wallet submission", async () => {
    const queryId = `0x${"77".repeat(32)}` as Hex;
    const txHash = `0x${"99".repeat(32)}` as Hex;
    const pool = zeroAddress, entrypoint = "0x0000000000000000000000000000000000000002" as Hex;
    const adapter = "0x0000000000000000000000000000000000000003" as Hex;
    const publicClient = { readContract: async () => 0n, getLogs: async () => [] } as never;
    const deployment = { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", contracts: { queryEscrow: zeroAddress }, privacy: { entrypoint, pool, adapter, scope: "123" } } as unknown as Deployment;
    let proofAmount = 0n;
    let sentToRelayer = "";
    const newNote = { nullifier: 9n, secret: 10n, label: 11n, value: 12n };
    const helper = async (args: any) => {
      proofAmount = args.withdrawnValue;
      expect(args.withdrawal.processooor).toBe(adapter);
      expect(args.withdrawal.data).toContain(queryId.slice(2));
      return { proof: { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], pubSignals: [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n] }, newNote, seconds: 0.7 };
    };
    const { client, requests } = fixture(async (url, init) => {
      if (url.endsWith("/v1/relayer")) return { address: "0x0000000000000000000000000000000000000004" };
      if (url.endsWith("/v1/query")) { sentToRelayer = JSON.parse(String(init?.body)).sender; return { queryId, quote: { jurorFees: "100", protocolFee: "20" } }; }
      if (url.endsWith("/v1/relay/open-shielded")) return { queryId, txHash };
      return {};
    }, { deployment, publicClient }, { buildShieldedProof: helper });
    const wallet = { account: root, chain: null } as never;
    const result = await client.ask({ schema: "SPLIT", document: { bytes: new Uint8Array([4]), contentType: "text/plain" }, isPublic: false, sender: root.address as Address,
      pay: { path: "shielded-pool", note: { nullifier: 1n, secret: 2n }, depositInfo: { deposit: { commitment: 3n, label: 4n, value: 200n }, pool } } }, wallet);
    expect(sentToRelayer).toBe("0x0000000000000000000000000000000000000004");
    expect(proofAmount).toBe(120n);
    expect(result).toMatchObject({ queryId, txHash, changeNote: newNote, proofSeconds: 0.7 });
    const relay = JSON.parse(String(requests.find((r) => r.url.endsWith("/v1/relay/open-shielded"))?.init?.body));
    expect(relay).toMatchObject({ sender: sentToRelayer, nullifier: `0x${"00".repeat(31)}01` });
    expect(relay.proof).toMatch(/^0x[0-9a-f]+$/);
  });

  test("decrypts private result only when its answer hash matches", async () => {
    const verdictId = `0x${"aa".repeat(32)}` as Hex;
    const pair = (await import("@noble/curves/ed25519.js")).x25519.keygen();
    const plain = { v: 1, verdictId, salt: `0x${"00".repeat(32)}`, answerJson: "{\"x\":1}", payload: "0x", fields: [] };
    const encrypted = seal(toHex(pair.publicKey), new TextEncoder().encode(canonicalJson(plain)), aad.result(verdictId));
    const ciphertext = toHex(new TextEncoder().encode(JSON.stringify(encrypted)));
    const { client } = fixture(async () => ({ status: "VERDICT", ciphertext, chain: { answerHash: keccak256(toHex(plain.answerJson)) } }));
    expect((await client.decryptPrivateResult(verdictId, toHex(pair.secretKey))).answerJson).toBe(plain.answerJson);
    const mismatch = fixture(async () => ({ ciphertext, chain: { answerHash: `0x${"01".repeat(32)}` } })).client;
    await expect(mismatch.decryptPrivateResult(verdictId, toHex(pair.secretKey))).rejects.toThrow("answerHash mismatch");
  });

  test("verifies receipt signature and anchor and reports unknown keys", async () => {
    const signer = createReceiptSigner();
    const receipt: VerdictReceiptInput = {
      verdictId: `0x${"01".repeat(32)}`, chainId: 31337, contract: zeroAddress, txHash: `0x${"02".repeat(32)}`, queryId: `0x${"03".repeat(32)}`,
      round: 0, status: "VERDICT", agreementBps: 10000, dissentMask: 0, timeoutMask: 0, schemaId: 3, schemaVersion: 1,
      docCommit: `0x${"04".repeat(32)}`, answerHash: `0x${"05".repeat(32)}`, payloadHash: `0x${"06".repeat(32)}`, evidenceRoot: `0x${"07".repeat(32)}`,
      attestationRoot: `0x${"08".repeat(32)}`, modelSetHash: `0x${"09".repeat(32)}`, provenanceKind: "SUBMITTED", originId: `0x${"00".repeat(32)}`,
      isPublic: true, escalated: false, jurors: [], answer_json: "{}", payload: "0x",
    };
    const { buildVerdictReceipt } = await import("@mochi/receipts");
    const item = buildVerdictReceipt(receipt, { keyId: signer.keyId });
    const signature = signer.sign(item);
    const batch = buildAnchorBatch([item]);
    const { client } = fixture(async (url) => url.includes("/.well-known/") ? { key_id: signer.keyId, public_key_pem: signer.publicKeyPem } : { receipt: item, signature, anchor: { root: batch.root, proof: batch.proofs.get(batch.leaves[0]!) } });
    expect(await client.verifyReceipt(receipt.verdictId as Hex)).toMatchObject({ valid: true, anchored: true });
    const invalid = fixture(async (url) => url.includes("/.well-known/") ? { key_id: signer.keyId, public_key_pem: signer.publicKeyPem } : { receipt: item, signature: "AAAA" }).client;
    expect(await invalid.verifyReceipt(receipt.verdictId as Hex)).toMatchObject({ valid: false, reason: "invalid_signature" });
    const unknown = fixture(async (url) => url.includes("/.well-known/") ? { key_id: "unknown", public_key_pem: signer.publicKeyPem } : { receipt: item, signature }).client;
    expect(await unknown.verifyReceipt(receipt.verdictId as Hex)).toMatchObject({ valid: false, reason: "unknown_key" });
  });

  test("decodes feed payloads and seals disclosures only for the auditor", async () => {
    const verdictId = `0x${"ab".repeat(32)}` as Hex;
    const result = { v: 1 as const, verdictId, salt: `0x${"00".repeat(32)}` as Hex, answerJson: "{\"answer\":42}", payload: "0x" as Hex, fields: [] };
    const hash = keccak256(toHex(result.answerJson));
    const auditor = (await import("@noble/curves/ed25519.js")).x25519.keygen();
    const payer = (await import("@noble/curves/ed25519.js")).x25519.keygen();
    const feedBody = encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [
      `0x${"01".repeat(32)}`, 100n,
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" }], [`0x${"02".repeat(32)}`, 200n, 3, 2]),
    ]);
    let disclosureEnvelope: unknown;
    const { client } = fixture(async (url, init) => {
      if (url.includes("/v1/feeds/")) return { verdictId, asOf: "200", updatedAt: "201", schemaId: 2, payload: feedBody };
      if (url.endsWith("/v1/disclosures")) {
        const req = JSON.parse(String(init?.body));
        disclosureEnvelope = req.envelope;
        return { recipientKeyHash: req.recipientPubKey };
      }
      if (url.includes("/v1/disclosures/")) return { envelope: disclosureEnvelope };
      if (url.endsWith(`/v1/verdict/${verdictId}`)) return { chain: { answerHash: hash } };
      return {};
    });
    expect((await client.feed("split-feed", `0x${"03".repeat(32)}`)).body).toHaveProperty("body.ratioNum", 3);
    await client.disclose({ verdictId, result, auditorPublicKey: toHex(auditor.publicKey) });
    expect((await client.readDisclosure(verdictId, toHex(auditor.secretKey))).answerJson).toBe(result.answerJson);
    const parsedEnvelope = disclosureEnvelope as Parameters<typeof import("@mochi/tee").open>[1];
    await expect(Promise.resolve().then(() => import("@mochi/tee").then(({ open }) => open(payer.secretKey, parsedEnvelope, aad.disclosure(verdictId, toHex(auditor.publicKey)))))).rejects.toThrow();
  });
});
