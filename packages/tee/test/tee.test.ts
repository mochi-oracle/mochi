import { afterEach, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { concat, encodeAbiParameters, hashDomain, hashStruct, hashTypedData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DcapQuoteVerifier, EnvelopeError, FileSealedStore, MemorySealedStore, MockQuoteVerifier, MockTeeProvider,
  NrasQuoteVerifier, decryptDocument, encryptDocument, keyBinding, open, quoteHash, rewrapDek, seal,
  signAnonymaVoucher, recoverAnonymaVoucher, signJurorAnswer, recoverJurorAnswer, signProvenance, recoverProvenance,
  signVerdictAttestation, recoverVerdictAttestation,
} from "../src/index.ts";
import { ANONYMA_VOUCHER_TYPES, escrowDomain, JUROR_ANSWER_TYPES, PROVENANCE_TYPES, verdictsDomain, VERDICT_ATTESTATION_TYPES } from "@mochi/core";
import type { AnonymaVoucher, Provenance, VerdictInput } from "@mochi/core";

const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
const verifier = new MockQuoteVerifier({ mockRootAddress: root.address });
const measurement = `0x${"ab".repeat(32)}` as Hex;
const mkProvider = (seed = `0x${"22".repeat(32)}` as Hex) => new MockTeeProvider({ seed, measurement, mockRoot: root });
const aad = new TextEncoder().encode("mochi/doc/v1|commit");
const equalBytes = (a: Uint8Array, b: Uint8Array) => expect([...a]).toEqual([...b]);

describe("mock enclave and quotes", () => {
  test("same seed is deterministic, different seed differs, and quote binds both keys", async () => {
    const a = mkProvider(), b = mkProvider(), c = mkProvider(`0x${"23".repeat(32)}`);
    expect(a.signer().address).toBe(b.signer().address);
    expect(a.encryptionPublicKey()).toBe(b.encryptionPublicKey());
    expect(a.signer().address).not.toBe(c.signer().address);
    expect(a.encryptionPublicKey()).not.toBe(c.encryptionPublicKey());
    const quote = await a.quote();
    expect(quote.reportData).toBe(keyBinding(a.signer().address, a.encryptionPublicKey()));
    expect(quoteHash(quote)).toBe(keccak256(quote.raw));
    expect(await verifier.verify(quote, { measurement, reportData: quote.reportData, maxAgeSec: 60 })).toMatchObject({ ok: true, measurement, reportData: quote.reportData });
  });
  test("tampered measurement, report data, root, and age are rejected with reasons", async () => {
    const quote = await mkProvider().quote();
    expect((await verifier.verify({ ...quote, measurement: `0x${"cd".repeat(32)}` as Hex })).reason).toContain("measurement field mismatch");
    expect((await verifier.verify({ ...quote, reportData: `0x${"cd".repeat(32)}` as Hex })).reason).toContain("reportData field mismatch");
    const quoteHashForSig = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }], ["MOCHI_MOCK_QUOTE_V1", quote.measurement, quote.reportData, BigInt(quote.issuedAt)]));
    const unauthorizedSig = await privateKeyToAccount(`0x${"33".repeat(32)}`).signMessage({ message: { raw: quoteHashForSig } });
    const rawDecoded = ["MOCHI_MOCK_QUOTE_V1", quote.measurement, quote.reportData, BigInt(quote.issuedAt), unauthorizedSig] as const;
    const tamperedRaw = encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], rawDecoded);
    expect((await verifier.verify({ ...quote, raw: tamperedRaw })).reason).toContain("invalid mock root signature");
    expect((await new MockQuoteVerifier({ mockRootAddress: privateKeyToAccount(`0x${"33".repeat(32)}`).address }).verify(quote)).reason).toContain("invalid mock root signature");
    const issuedAt = Math.floor(Date.now() / 1000) - 100;
    const rhash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }], ["MOCHI_MOCK_QUOTE_V1", quote.measurement, quote.reportData, BigInt(issuedAt)]));
    const sig = await root.signMessage({ message: { raw: rhash } });
    const raw = encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], ["MOCHI_MOCK_QUOTE_V1", quote.measurement, quote.reportData, BigInt(issuedAt), sig]);
    expect((await verifier.verify({ ...quote, issuedAt, raw }, { maxAgeSec: 10 })).reason).toContain("expired");
    expect((await verifier.verify(quote, { measurement: `0x${"cd".repeat(32)}` as Hex })).reason).toContain("unexpected measurement");
    expect((await verifier.verify(quote, { reportData: `0x${"cd".repeat(32)}` as Hex })).reason).toContain("unexpected reportData");
  });
  test("real verifier placeholders report that integration is required", async () => {
    expect((await new NrasQuoteVerifier().verify(await mkProvider().quote())).reason).toBe("NOT_IMPLEMENTED: integrate an NVIDIA NRAS verifier");
    expect((await new DcapQuoteVerifier().verify(await mkProvider().quote())).reason).toBe("wrong quote kind");
  });
});

describe("X25519 envelopes and documents", () => {
  test("round trips empty, one-byte, and 1 MiB messages", () => {
    const pair = x25519.keygen();
    for (const payload of [new Uint8Array(), new Uint8Array([42]), new Uint8Array(1024 * 1024).map((_, i) => i % 251)]) {
      equalBytes(open(pair.secretKey, seal(toHex(pair.publicKey), payload, aad), aad), payload);
    }
  });
  test("rejects wrong recipient, AAD, modified ciphertext, and modified nonce", () => {
    const recipient = x25519.keygen(), other = x25519.keygen();
    const env = seal(toHex(recipient.publicKey), new Uint8Array([1, 2, 3]), aad);
    expect(() => open(other.secretKey, env, aad)).toThrow(EnvelopeError);
    expect(() => open(recipient.secretKey, env, new TextEncoder().encode("wrong"))).toThrow(EnvelopeError);
    const ct = Uint8Array.from(awaitableHex(env.ct)); ct[0] = ct[0]! ^ 1;
    expect(() => open(recipient.secretKey, { ...env, ct: toHex(ct) }, aad)).toThrow(EnvelopeError);
    const nonce = Uint8Array.from(awaitableHex(env.nonce)); nonce[0] = nonce[0]! ^ 1;
    expect(() => open(recipient.secretKey, { ...env, nonce: toHex(nonce) }, aad)).toThrow(EnvelopeError);
  });
  test("document DEK can be rewrapped and each recipient decrypts", () => {
    const recipients = [x25519.keygen(), x25519.keygen(), x25519.keygen()];
    const plaintext = new TextEncoder().encode("private document bytes");
    const encrypted = encryptDocument(plaintext, toHex(recipients[0]!.publicKey), aad);
    const dek = open(recipients[0]!.secretKey, encrypted.dekEnvelope, aad);
    const wrappers = rewrapDek(dek, recipients.map((r) => toHex(r.publicKey)), aad);
    for (let i = 0; i < recipients.length; i++) equalBytes(decryptDocument(wrappers[i]!, encrypted.docCt, recipients[i]!.secretKey, aad), plaintext);
  });
});

function awaitableHex(hex: Hex): Uint8Array { return Uint8Array.from(hex.slice(2).match(/.{2}/g)!.map((b) => Number.parseInt(b, 16))); }

describe("typed data signatures", () => {
  const chainId = 31337, escrow = `0x${"44".repeat(20)}` as const, verdicts = `0x${"55".repeat(20)}` as const;
  const prov: Provenance = {
    docCommit: `0x${"01".repeat(32)}`, kind: 1, originId: `0x${"02".repeat(32)}`, fetchedAt: 1700000000n, tokensK: 4, transcriptHash: `0x${"03".repeat(32)}`,
    opener: `0x${"06".repeat(20)}`, schemaId: 3, schemaVersion: 1, paramsHash: `0x${"07".repeat(32)}`, payerCommit: `0x${"08".repeat(32)}`,
    isPublic: false, allowPanelDisclosure: false, nonce: 9n, expiry: 1700000900n,
  };
  const voucher: AnonymaVoucher = { voucherId: `0x${"11".repeat(32)}`, queryId: `0x${"12".repeat(32)}`, schemaId: 3, n: 5, maxAmount: 123456n, tier: 2, expiry: 1700001000n };
  const answer = { queryId: `0x${"21".repeat(32)}` as Hex, docCommit: prov.docCommit, schemaId: 3, schemaVersion: 1, answerHash: `0x${"22".repeat(32)}` as Hex, spansRoot: `0x${"23".repeat(32)}` as Hex, quoteHash: `0x${"24".repeat(32)}` as Hex };
  const verdict: VerdictInput = { queryId: answer.queryId, round: 0, status: 1, agreementBps: 8000, dissentMask: 2, timeoutMask: 0, answerHash: answer.answerHash, payloadHash: `0x${"31".repeat(32)}`, evidenceRoot: `0x${"32".repeat(32)}` };
  const votes = `0x${"33".repeat(32)}` as Hex;
  test("all sign/recover pairs round trip; field edits invalidate recovery", async () => {
    const s1 = await signProvenance(root, chainId, escrow, prov);
    expect(await recoverProvenance(chainId, escrow, prov, s1)).toBe(root.address);
    expect(await recoverProvenance(chainId, escrow, { ...prov, tokensK: 5 }, s1)).not.toBe(root.address);
    expect(await recoverProvenance(chainId, escrow, { ...prov, opener: `0x${"0a".repeat(20)}` }, s1)).not.toBe(root.address);
    const s2 = await signAnonymaVoucher(root, chainId, escrow, voucher);
    expect(await recoverAnonymaVoucher(chainId, escrow, voucher, s2)).toBe(root.address);
    expect(await recoverAnonymaVoucher(chainId, escrow, { ...voucher, n: 7 }, s2)).not.toBe(root.address);
    expect(await recoverAnonymaVoucher(chainId, escrow, { ...voucher, queryId: `0x${"13".repeat(32)}` }, s2)).not.toBe(root.address);
    const s3 = await signJurorAnswer(root, chainId, verdicts, answer);
    expect(await recoverJurorAnswer(chainId, verdicts, answer, s3)).toBe(root.address);
    const changedAnswers = [
      { ...answer, queryId: `0x${"25".repeat(32)}` as Hex },
      { ...answer, docCommit: `0x${"25".repeat(32)}` as Hex },
      { ...answer, schemaId: answer.schemaId + 1 },
      { ...answer, schemaVersion: answer.schemaVersion + 1 },
      { ...answer, answerHash: `0x${"25".repeat(32)}` as Hex },
      { ...answer, spansRoot: `0x${"25".repeat(32)}` as Hex },
      { ...answer, quoteHash: `0x${"25".repeat(32)}` as Hex },
    ];
    for (const changed of changedAnswers) expect(await recoverJurorAnswer(chainId, verdicts, changed, s3)).not.toBe(root.address);
    const s4 = await signVerdictAttestation(root, chainId, verdicts, verdict, votes);
    expect(await recoverVerdictAttestation(chainId, verdicts, verdict, votes, s4)).toBe(root.address);
    expect(await recoverVerdictAttestation(chainId, verdicts, { ...verdict, round: 1 }, votes, s4)).not.toBe(root.address);
  });
  test("JurorAnswer digest matches domain/type hash construction for a fixed vector", () => {
    const domain = verdictsDomain(chainId, verdicts);
    const domainSeparator = hashDomain({ domain: { ...domain, chainId: BigInt(chainId) }, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ] } });
    const structHash = hashStruct({ data: answer, primaryType: "JurorAnswer", types: JUROR_ANSWER_TYPES });
    const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
    expect(digest).toBe(hashTypedData({ domain, types: JUROR_ANSWER_TYPES, primaryType: "JurorAnswer", message: answer }));
    expect(digest).toBe("0xe1088cdd39dd45490104edba9f901019a4d3091e2f8d6d5971c77402c6ffdb2c");
  });
});

describe("sealed stores", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    await rm(join(process.cwd(), ".tmp-test"), { recursive: true, force: true });
  });
  test("memory store copies values and file store persists encrypted values across instances", async () => {
    const memory = new MemorySealedStore(), bytes = new Uint8Array([5, 6, 7]);
    await memory.put("query-1", bytes); bytes[0] = 99;
    equalBytes((await memory.get("query-1"))!, new Uint8Array([5, 6, 7]));
    const tempRoot = join(process.cwd(), ".tmp-test");
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
    const dir = await mkdtemp(join(tempRoot, "tee-")); dirs.push(dir);
    const provider = mkProvider(), first = new FileSealedStore(dir, provider);
    await first.put("query-1", new Uint8Array([8, 9, 10]));
    expect(await first.has("query-1")).toBe(true);
    const filenames = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const disk = await readFile(join(dir, filenames[0]!), "utf8");
    expect(disk).not.toContain("8,9,10");
    const second = new FileSealedStore(dir, provider);
    equalBytes((await second.get("query-1"))!, new Uint8Array([8, 9, 10]));
    expect(await second.get("missing")).toBeUndefined();
  });
});
