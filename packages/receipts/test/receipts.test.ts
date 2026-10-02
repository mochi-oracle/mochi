import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { keccak256, toHex, type Hex } from "viem";
import { canonicalBytes, merkleRoot } from "@mochi/core";
import {
  AnchorWindow,
  answerMatches,
  buildAnchorBatch,
  buildVerdictReceipt,
  createReceiptSigner,
  keyIdFor,
  merkleProof,
  publicKeyFromRaw,
  receiptLeaf,
  signVerdictReceipt,
  verifyMerkleProof,
  verifyReceipt,
  verifyReceiptSignature,
} from "../src/index.ts";

const H = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const receiptInput = {
  verdictId: H(1), chainId: 4663, contract: "0xAbCd000000000000000000000000000000000001", txHash: H(2), queryId: H(3), round: 2,
  status: "VERDICT" as const, agreementBps: 8571, dissentMask: 2, timeoutMask: 0, schemaId: 6, schemaVersion: 1,
  docCommit: H(4), answerHash: H(5), payloadHash: H(6), evidenceRoot: H(7), attestationRoot: H(8), modelSetHash: H(9),
  provenanceKind: "FETCHED" as const, originId: H(10), isPublic: false, escalated: false,
  jurors: [{ seat: 0, juror: "0x1111000000000000000000000000000000000000", class: "LARGE_A", quoteHash: H(11) }],
};

function anonymaCanonical(value: any): any {
  if (Array.isArray(value)) return value.map(anonymaCanonical);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = anonymaCanonical(value[key]);
    return out;
  }, {} as Record<string, unknown>);
  return value;
}

describe("Anonyma-compatible verdict receipts", () => {
  test("signature round trip, canonical input order, and Anonyma verifier algorithm", () => {
    const signer = createReceiptSigner();
    const receipt = buildVerdictReceipt(receiptInput, { keyId: signer.keyId, issued: "2026-01-02T03:04:05.000Z" });
    const signature = signer.sign(receipt);
    expect(verifyReceiptSignature(receipt, signature, signer.publicKeyPem)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(receipt).reverse());
    expect(verifyReceiptSignature(reordered, signature, signer.publicKeyPem)).toBe(true);

    // The exact verifier operation used by Anonyma: JSON.stringify(recursively sorted receipt), Ed25519, base64 sig.
    const verifierInput = Buffer.from(JSON.stringify(anonymaCanonical(receipt)));
    expect(cryptoVerify(null, verifierInput, signer.publicKeyPem, Buffer.from(signature, "base64"))).toBe(true);
    expect(Buffer.from(canonicalBytes(receipt)).equals(verifierInput)).toBe(true);
  });

  test("tampering any signed field invalidates the signature", () => {
    const signer = createReceiptSigner();
    const receipt = buildVerdictReceipt(receiptInput, { keyId: signer.keyId, issued: "2026-01-02T03:04:05Z" });
    const signature = signer.sign(receipt);
    expect(verifyReceiptSignature({ ...receipt, status: "HUNG" }, signature, signer.publicKeyPem)).toBe(false);
    expect(verifyReceiptSignature(receipt, "broken", signer.publicKeyPem)).toBe(false);
  });

  test("key id matches SHA-256 and PKCS8 import preserves key id", () => {
    // Fixed RFC 8032 seed 00..1f; its public-key SHA-256 prefix is independently pinned below.
    const privateDer = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
    ]);
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    const rawExpected = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
    const pkcs8 = privateDer.toString("base64");
    const signer = createReceiptSigner({ pkcs8DerBase64: pkcs8 });
    const raw = Buffer.from(signer.rawPublicKeyHex, "hex");
    expect(raw.equals(rawExpected)).toBe(true);
    expect(signer.keyId).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 16));
    expect(signer.keyId).toBe("56475aa75463474c");
    expect(keyIdFor(raw)).toBe(signer.keyId);
    expect(createReceiptSigner({ pkcs8DerBase64: pkcs8 }).keyId).toBe(signer.keyId);
    const receipt = { v: 1, key_id: signer.keyId };
    expect(verifyReceiptSignature(receipt, signer.sign(receipt), publicKeyFromRaw(signer.rawPublicKeyHex))).toBe(true);
  });

  test("private receipt excludes private result and public receipt includes it", () => {
    expect(() => buildVerdictReceipt({ ...receiptInput, answer_json: "secret answer" }, { keyId: "k" })).toThrow();
    expect(() => buildVerdictReceipt({ ...receiptInput, payload: H(99) }, { keyId: "k" })).toThrow();
    const receipt = buildVerdictReceipt({ ...receiptInput, isPublic: true, answer_json: '{"answer":"yes"}', payload: "0x1234" }, { keyId: "k" });
    expect(receipt.public).toEqual({ answer_json: '{"answer":"yes"}', payload: "0x1234" });
    expect("answer_json" in receipt).toBe(false);
  });

  test("32-byte hex fields must be exactly 32 bytes", () => {
    for (const bad of [`0x${"ab".repeat(31)}`, `0x${"ab".repeat(33)}`, `0x${"ab".repeat(31)}a`, "0x", `0x${"zz".repeat(32)}`]) {
      expect(() => buildVerdictReceipt({ ...receiptInput, queryId: bad as Hex }, { keyId: "k" })).toThrow("queryId must be");
    }
    expect(buildVerdictReceipt({ ...receiptInput, queryId: `0x${"AB".repeat(32)}` }, { keyId: "k" }).query_id).toBe(`0x${"ab".repeat(32)}`);
  });

  test("validates numeric safety and verifies signatures through envelope lookup", () => {
    expect(() => buildVerdictReceipt({ ...receiptInput, round: Number.MAX_SAFE_INTEGER + 1 }, { keyId: "k" })).toThrow();
    const signer = createReceiptSigner();
    const { receipt, signature } = signVerdictReceipt(signer, receiptInput);
    expect(verifyReceipt({ receipt, signature, publicKeys: { [signer.keyId]: signer.publicKeyPem } })).toEqual({ valid: true, keyId: signer.keyId });
    expect(verifyReceipt({ receipt, signature, publicKeys: {} }).valid).toBe(false);
    const batch = buildAnchorBatch([receipt, { id: "another" }]);
    const leaf = receiptLeaf(receipt);
    expect(verifyReceipt({ receipt, signature, publicKeys: { [signer.keyId]: signer.publicKeyPem }, anchor: { root: batch.root, proof: batch.proofs.get(leaf)! } })).toEqual({ valid: true, keyId: signer.keyId, anchored: true });
    expect(verifyReceipt({ receipt, signature, publicKeys: { [signer.keyId]: signer.publicKeyPem }, anchor: { root: H(999), proof: batch.proofs.get(leaf)! } }).valid).toBe(false);
  });

  test("answerMatches hashes UTF-8 answer JSON", () => {
    const answer = '{"answer":"yes"}';
    const r = { answer_hash: keccak256(toHex(answer)) };
    expect(answerMatches(r, answer)).toBe(true);
    expect(answerMatches(r, "no")).toBe(false);
  });
});

describe("receipt merkle anchors", () => {
  test("builds core-compatible roots and valid proofs for every leaf in batches 1..17", () => {
    for (let size = 1; size <= 17; size++) {
      const receipts = Array.from({ length: size }, (_, i) => ({ id: `r-${size}-${i}`, nested: { a: i, z: true } }));
      const batch = buildAnchorBatch(receipts);
      expect(batch.root).toBe(merkleRoot(batch.leaves));
      for (const leaf of batch.leaves) {
        const proof = batch.proofs.get(leaf)!;
        expect(verifyMerkleProof(leaf, proof, batch.root)).toBe(true);
      }
      const leaf = batch.leaves[0]!;
      expect(verifyMerkleProof(H(999), batch.proofs.get(leaf)!, batch.root)).toBe(false);
      expect(verifyMerkleProof(leaf, batch.proofs.get(leaf)!, H(999))).toBe(false);
    }
  });

  test("leaf is canonical JSON keccak", () => {
    expect(receiptLeaf({ b: 2, a: 1 })).toBe(keccak256(canonicalBytes({ a: 1, b: 2 })));
  });

  test("AnchorWindow flushes by time or capacity and resets after posting", async () => {
    const window = new AnchorWindow({ intervalMs: 100, maxLeaves: 2, now: 1000 });
    expect(window.shouldFlush(1099)).toBe(false);
    window.add({ id: "one" });
    expect(window.shouldFlush(1099)).toBe(false);
    expect(window.shouldFlush(1100)).toBe(true);
    const rootExpected = merkleRoot([receiptLeaf({ id: "one" })]);
    let posted: [Hex, number] | undefined;
    const result = await window.flush(async (root, count) => { posted = [root, count]; return H(55); });
    expect(posted).toEqual([rootExpected, 1]);
    expect(result).toEqual({ root: rootExpected, count: 1, txHash: H(55), proofs: new Map([[receiptLeaf({ id: "one" }), []]]) });
    expect(window.count).toBe(0);
    window.add({ id: "two" });
    window.add({ id: "three" });
    expect(window.shouldFlush(1100)).toBe(true);
    await window.flush(async () => H(56));
    expect(window.count).toBe(0);
    expect(window.shouldFlush(Date.now() + 1000)).toBe(false);
  });
});
