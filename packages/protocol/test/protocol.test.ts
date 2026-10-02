import { describe, expect, test } from "bun:test";
import { keccak256, encodePacked, toHex } from "viem";
import { docCommit, privatePayloadHash, provenanceHash, ZERO32 } from "@mochi/core";
import {
  AttestationDocSchema, IntakeUploadPlainSchema, IntakeUrlPlainSchema, aad, maskDocHash, payerCommit, privateResultMismatch, provenanceFromJson,
  provenanceMatchesBinding, type OpenBinding, type ProvenanceJson,
} from "../src/index.ts";

const binding: OpenBinding = { opener: `0x${"0b".repeat(20)}`, payerCommit: `0x${"0c".repeat(32)}`, isPublic: false, allowPanelDisclosure: false, nonce: "18446744073709551615" };

describe("protocol", () => {
  test("payerCommit binds the result key", () => {
    const key = `0x${"11".repeat(32)}` as const;
    expect(payerCommit(key)).toBe(keccak256(encodePacked(["string", "bytes32"], ["mochi/payer/v1", key])));
    expect(payerCommit(key)).not.toBe(payerCommit(`0x${"12".repeat(32)}`));
  });
  test("schemas reject uppercase hex", () => {
    const bad = AttestationDocSchema.safeParse({
      role: "JUROR", address: `0x${"AB".repeat(20)}`, encryptionPubKey: `0x${"00".repeat(32)}`,
      measurement: `0x${"00".repeat(32)}`, quote: { kind: "mock", measurement: `0x${"00".repeat(32)}`,
      reportData: `0x${"00".repeat(32)}`, raw: "0x", issuedAt: 1 },
    });
    expect(bad.success).toBe(false);
  });
  test("intake plain defaults params", () => {
    const p = IntakeUploadPlainSchema.parse({ v: 1, schemaId: 2, salt: `0x${"00".repeat(32)}`, contentType: "text/plain", docB64: "", open: binding });
    expect(p.params).toEqual({});
  });
  test("intake requests must carry the sealed open binding (uint64 nonce, lowercase opener)", () => {
    const url = { v: 1, schemaId: 2, salt: ZERO32, url: "https://docs.example/x" };
    expect(IntakeUrlPlainSchema.safeParse(url).success).toBe(false);
    expect(IntakeUrlPlainSchema.safeParse({ ...url, open: binding }).success).toBe(true);
    expect(IntakeUrlPlainSchema.safeParse({ ...url, open: { ...binding, nonce: (1n << 64n).toString() } }).success).toBe(false);
    expect(IntakeUrlPlainSchema.safeParse({ ...url, open: { ...binding, opener: `0x${"0B".repeat(20)}` } }).success).toBe(false);
  });
  test("provenance JSON converts to the EIP-712 message and matches only its own binding", () => {
    const json: ProvenanceJson = {
      docCommit: `0x${"01".repeat(32)}`, kind: 0, originId: ZERO32, fetchedAt: "0", tokensK: 1, transcriptHash: ZERO32,
      schemaId: 7, schemaVersion: 1, paramsHash: ZERO32, expiry: "1700000900", ...binding,
    };
    const prov = provenanceFromJson(json);
    expect(prov.nonce).toBe((1n << 64n) - 1n);
    expect(prov.expiry).toBe(1700000900n);
    expect(provenanceHash(prov)).not.toBe(provenanceHash({ ...prov, nonce: 1n }));
    expect(provenanceMatchesBinding(json, binding)).toBe(true);
    for (const change of [{ opener: `0x${"0d".repeat(20)}` }, { payerCommit: ZERO32 }, { isPublic: true }, { allowPanelDisclosure: true }, { nonce: "1" }]) {
      expect(provenanceMatchesBinding({ ...json, ...change } as ProvenanceJson, binding)).toBe(false);
    }
  });
  test("private result check: answerHash, salted payloadHash, and HUNG", () => {
    const salt = `0x${"5a".repeat(32)}` as const;
    const payload = `0x${"ab".repeat(96)}` as const;
    const answerJson = '{"answer":1}';
    const answerHash = keccak256(toHex(answerJson));
    expect(privatePayloadHash(salt, payload)).toBe(keccak256(encodePacked(["string", "bytes32", "bytes32"], ["mochi/private-payload/v1", salt, keccak256(payload)])));
    expect(() => privatePayloadHash(ZERO32, payload)).toThrow();
    expect(privateResultMismatch({ salt, answerJson, payload }, { answerHash, payloadHash: privatePayloadHash(salt, payload) })).toBeUndefined();
    expect(privateResultMismatch({ salt, answerJson, payload }, { answerHash, payloadHash: keccak256(payload) })).toBe("payloadHash");
    expect(privateResultMismatch({ salt, answerJson: "{}", payload }, { answerHash, payloadHash: privatePayloadHash(salt, payload) })).toBe("answerHash");
    expect(privateResultMismatch({ salt, answerJson, payload: "0x" }, { answerHash, payloadHash: ZERO32 })).toBeUndefined();
    expect(privateResultMismatch({ salt, answerJson, payload }, { answerHash, payloadHash: ZERO32 })).toBe("payloadHash");
  });
  test("masked docHash: plain for public, salt-masked for private, and only the requester's salt recovers docCommit", () => {
    const docHash = keccak256(toHex("document bytes"));
    expect(maskDocHash(ZERO32, docHash)).toBe(docHash);
    const salt = `0x${"5e".repeat(32)}` as const;
    const masked = maskDocHash(salt, docHash);
    expect(masked).toMatch(/^0x[0-9a-f]{64}$/);
    expect(masked).not.toBe(docHash);
    expect(maskDocHash(salt, masked)).toBe(docHash);
    expect(docCommit(salt, maskDocHash(salt, masked))).toBe(docCommit(salt, docHash));
    expect(docCommit(`0x${"5f".repeat(32)}`, maskDocHash(`0x${"5f".repeat(32)}`, masked))).not.toBe(docCommit(salt, docHash));
  });
  test("aad strings are distinct per purpose", () => {
    const q = `0x${"aa".repeat(32)}` as const;
    const s = new Set([aad.doc(q), aad.consensusSeed(q), aad.result(q)].map((b) => new TextDecoder().decode(b)));
    expect(s.size).toBe(3);
  });
  test("aad is case-insensitive for addresses (checksummed vs lowercase)", () => {
    const q = `0x${"ab".repeat(32)}` as const;
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(dec(aad.answer(q, "0xAbCdEf0000000000000000000000000000000001"))).toBe(dec(aad.answer(q, "0xabcdef0000000000000000000000000000000001")));
  });
});

test('quote transport preserves the explicit stable dstack measurement scheme', async () => {
  const { QuoteSchema, PeerSchema } = await import('../src/index.ts');
  const quote = {kind:'tdx',measurement:`0x${'11'.repeat(32)}`,reportData:`0x${'22'.repeat(32)}`,raw:'0xaabb',issuedAt:1,measurementScheme:'dstack-config-v1'};
  expect(QuoteSchema.parse(quote).measurementScheme).toBe('dstack-config-v1');
  expect(PeerSchema.parse({address:`0x${'33'.repeat(20)}`,encryptionPubKey:`0x${'44'.repeat(32)}`,quote}).quote.measurementScheme).toBe('dstack-config-v1');
  expect(()=>QuoteSchema.parse({...quote,measurementScheme:'unknown'})).toThrow();
  expect(()=>QuoteSchema.parse({...quote,kind:'mock'})).toThrow();
});
