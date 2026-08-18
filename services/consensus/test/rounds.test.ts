import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { x25519 } from "@noble/curves/ed25519.js";
import { answerHash, canonicalJson, spansRoot, ZERO32, votesHash, VerdictStatus } from "@mochi/core";
import { normalizeAnswer, resolveSchema } from "@mochi/schemas";
import { aad, payerCommit, type ConsensusSeedPlain } from "@mochi/protocol";
import { MemorySealedStore, MockTeeProvider, MockQuoteVerifier, recoverVerdictAttestation, seal, signJurorAnswer } from "@mochi/tee";
import { ConsensusEnclave, type ConsensusEnclaveDeps } from "../src/rounds.ts";
import { createConsensusApp } from "../src/app.ts";

const chainId = 31337;
const verdicts = "0x00000000000000000000000000000000000000aa" as Address;
const root = privateKeyToAccount(`0x${"77".repeat(32)}`);
const jurors = Array.from({ length: 5 }, (_, i) => privateKeyToAccount(`0x${String(i + 1).padStart(2, "0").repeat(32)}`));
const quote = keccak256(toHex("quote"));

class Harness {
  now = 1_000;
  n = 3;
  round = 0;
  queryId = `0x${"ab".repeat(32)}` as Hex;
  docCommit = `0x${"cd".repeat(32)}` as Hex;
  public = true;
  salt: Hex = ZERO32;
  payerPub?: Hex;
  tee = new MockTeeProvider({ seed: `0x${"55".repeat(32)}`, measurement: `0x${"44".repeat(32)}`, mockRoot: root });
  store = new MemorySealedStore();
  query = () => ({ docCommit: this.docCommit, schemaId: 2, schemaVersion: 1, n: this.n, round: this.round, isPublic: this.public, allowPanelDisclosure: false, payPath: 0, status: 2, provenanceKind: 0, originId: ZERO32, tokensK: 1, provenanceHash: ZERO32, paramsHash: ZERO32, payerCommit: this.payerPub ? payerCommit(this.payerPub) : ZERO32, payer: jurors[0]!.address, refundTo: jurors[0]!.address, openedAt: 1n, deadline: 0n, sealBlock: 0n, seed: ZERO32, paid: 0n, protocolFee: 0n });
  chain = {
    getQuery: async () => this.query() as never,
    jurorsOf: async () => jurors.slice(0, this.n).map((a) => a.address.toLowerCase() as Address),
    getJuror: async (address: Address) => ({ jurorClass: Math.max(0, jurors.findIndex((a) => a.address.toLowerCase() === address.toLowerCase())) % 5 }) as never,
  };
  enclave = new ConsensusEnclave({ tee: this.tee, chain: this.chain, store: this.store, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), chainId, verdictsAddress: verdicts, clock: { now: () => this.now }, roundTimeoutMs: 100 } satisfies ConsensusEnclaveDeps);
  seed(): ConsensusSeedPlain { return { v: 1, queryId: this.queryId, schemaId: 2, docCommit: this.docCommit, paramsHash: ZERO32, salt: this.salt, params: {} }; }
  async open(key = this.payerPub) {
    return this.enclave.openRound({ queryId: this.queryId, round: this.round, consensusSeed: seal(this.tee.encryptionPublicKey(), new TextEncoder().encode(canonicalJson(this.seed())), aad.consensusSeed(this.queryId)), ...(key ? { payerResultPubKey: key } : {}) });
  }
  body(diff = false) {
    const def = resolveSchema(2);
    const line = diff ? "ticker ZZZZ ratio_num 3 ratio_den 1 effective_date 2026-01-02" : "ticker ACME ratio_num 2 ratio_den 1 effective_date 2026-01-01";
    return normalizeAnswer(def, { fields: diff ? { ticker: "ZZZZ", ratio_num: 3, ratio_den: 1, effective_date: "2026-01-02" } : { ticker: "ACME", ratio_num: 2, ratio_den: 1, effective_date: "2026-01-01" }, evidence: diff ? { ticker: "ZZZZ", ratio_num: "num 3", ratio_den: "den 1", effective_date: "2026-01-02" } : { ticker: "ACME", ratio_num: "num 2", ratio_den: "den 1", effective_date: "2026-01-01" } }, line);
  }
  async answer(seat: number, diff = false, tamper = false, claimedSeat = seat, badSig = false) {
    const account = jurors[seat]!;
    const who = { ...account, address: account.address.toLowerCase() as Address };
    const body = this.body(diff);
    const hash = answerHash({ salt: this.salt, schemaId: body.schemaId, schemaVersion: body.schemaVersion, fields: body.fields });
    const spans = spansRoot(body.spans);
    const signature = await signJurorAnswer(who, chainId, verdicts, { queryId: this.queryId, docCommit: this.docCommit, schemaId: 2, schemaVersion: 1, answerHash: hash, spansRoot: spans, quoteHash: quote });
    const vote = { juror: who.address, answerHash: hash, spansRoot: spans, quoteHash: quote, sig: badSig ? `0x${"00".repeat(65)}` as Hex : signature };
    const answerEnvelope = seal(this.tee.encryptionPublicKey(), new TextEncoder().encode(canonicalJson(tamper ? { ...body, fields: { ...body.fields, ratio_num: { t: "int", v: "999" } } } : body)), aad.answer(this.queryId, who.address));
    return this.enclave.submitAnswer({ queryId: this.queryId, seat: claimedSeat, vote, answerEnvelope });
  }
}

describe("ConsensusEnclave", () => {
  test("unanimous SPLIT creates signed VERDICT and public decision", async () => {
    const h = new Harness(); await h.open(); await Promise.all([0, 1, 2].map((i) => h.answer(i)));
    const result = await h.enclave.closeRound(h.queryId);
    expect(result.verdictInput.status).toBe(VerdictStatus.VERDICT);
    expect(keccak256(result.public!.payload as Hex)).toBe(result.verdictInput.payloadHash as Hex);
    expect(result.public!.disagreement.length).toBe(12);
    expect(await recoverVerdictAttestation(chainId, verdicts, result.verdictInput as never, votesHash(result.votes as never), result.consensusSig as Hex)).toBe(h.tee.signer().address);
  });

  test("N=5 unanimous SPLIT creates verdict", async () => {
    const h = new Harness(); h.n = 5; await h.open(); await Promise.all([0, 1, 2, 3, 4].map((i) => h.answer(i)));
    const result = await h.enclave.closeRound(h.queryId);
    expect(result.verdictInput.status).toBe(VerdictStatus.VERDICT);
    expect(result.verdictInput.agreementBps).toBe(10000);
    expect(result.votes).toHaveLength(5);
  });

  test("2 of 3 hangs, then nested expansion reuses prior answers to reach verdict", async () => {
    const h = new Harness(); await h.open(); await h.answer(0); await h.answer(1); await h.answer(2, true);
    const hung = await h.enclave.closeRound(h.queryId);
    expect(hung.verdictInput.status).toBe(VerdictStatus.HUNG); expect(hung.verdictInput.payloadHash).toBe(ZERO32);
    h.round = 1; h.n = 5; await h.open(); await h.answer(3); await h.answer(4);
    const result = await h.enclave.closeRound(h.queryId);
    expect(result.verdictInput.status).toBe(VerdictStatus.VERDICT);
    expect(result.votes).toHaveLength(5);
  });

  test("missing seat closes only after enclave deadline and is marked timed out", async () => {
    const h = new Harness(); await h.open(); await h.answer(0); await h.answer(1);
    await expect(h.enclave.closeRound(h.queryId)).rejects.toMatchObject({ code: "ROUND_OPEN", status: 409 });
    h.now += 101;
    const result = await h.enclave.closeRound(h.queryId);
    expect(result.verdictInput.timeoutMask).toBe(4); expect(result.verdictInput.dissentMask & 4).toBe(4);
    expect(result.votes[2]).toMatchObject({ sig: "0x", answerHash: ZERO32 });
  });

  test("tampered body keeps the signed vote but marks every field invalid", async () => {
    const h = new Harness(); await h.open(); await h.answer(0, false, true);
    const info = await h.store.get(`consensus:${h.queryId}`);
    expect(info).toBeDefined();
    await h.answer(1); await h.answer(2);
    const closed = await h.enclave.closeRound(h.queryId);
    expect(closed.public!.disagreement.filter((r) => r.seat === 0).every((r) => r.disagreed)).toBe(true);
    expect(closed.votes[0]!.sig).not.toBe("0x");
  });

  test("private payer key commitment gates opening and private result decrypts", async () => {
    const h = new Harness(); const kp = x25519.keygen(); h.public = false; h.salt = `0x${"12".repeat(32)}`; h.payerPub = toHex(kp.publicKey);
    await expect(h.open(`0x${"99".repeat(32)}`)).rejects.toMatchObject({ code: "PAYER_KEY_MISMATCH", status: 400 });
    await h.open(); await Promise.all([0, 1, 2].map((i) => h.answer(i)));
    const response = await h.enclave.closeRound(h.queryId);
    expect(response.public).toBeUndefined(); expect(response.privateResult).toBeDefined();
    const { open } = await import("@mochi/tee");
    const plaintext = JSON.parse(new TextDecoder().decode(open(kp.secretKey, response.privateResult! as never, aad.result(response.verdictId as Hex))));
    expect(plaintext.answerJson).toContain('"ticker":{"t":"str","v":"ACME"}');
  });

  test("idempotent open, identical resubmission, and repeated close", async () => {
    const h = new Harness(); await h.open(); await h.open(); await h.answer(0); await h.answer(0); await h.answer(1); await h.answer(2);
    const first = await h.enclave.closeRound(h.queryId); const second = await h.enclave.closeRound(h.queryId);
    expect(second).toEqual(first);
  });

  test("non-selected juror, wrong seat, and bad signature are rejected", async () => {
    const h = new Harness(); await h.open();
    await expect(h.answer(3)).rejects.toMatchObject({ code: "WRONG_SEAT", status: 400 });
    await expect(h.answer(1, false, false, 0)).rejects.toMatchObject({ code: "WRONG_SEAT", status: 400 });
    await expect(h.answer(0, false, false, 0, true)).rejects.toBeDefined();
  });

  test("routes validate requests and expose health", async () => {
    const h = new Harness(); const { app } = createConsensusApp(h.enclave);
    expect((await app.request("/healthz")).status).toBe(200);
    const attestation = await app.request("/v1/attestation");
    expect(attestation.status).toBe(200); expect((await attestation.json() as { role: string }).role).toBe("CONSENSUS");
    const bad = await app.request("/v1/rounds", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
  });
});
