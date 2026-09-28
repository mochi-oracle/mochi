import { describe, expect, test } from "bun:test";
import { keccak256, encodePacked } from "viem";
import { AttestationDocSchema, IntakeUploadPlainSchema, aad, payerCommit } from "../src/index.ts";

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
    const p = IntakeUploadPlainSchema.parse({ v: 1, schemaId: 2, salt: `0x${"00".repeat(32)}`, contentType: "text/plain", docB64: "" });
    expect(p.params).toEqual({});
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
