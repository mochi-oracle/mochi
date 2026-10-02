import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import {
  ANONYMA_VOUCHER_TYPES,
  JUROR_ANSWER_TYPES,
  PROVENANCE_TYPES,
  TYPE_STRINGS,
  VERDICT_ATTESTATION_TYPES,
  canonicalJson,
  classMix,
  docCommit,
  fetchedTranscriptHash,
  merkleRoot,
  requiredAgree,
  submittedTranscriptHash,
  tlsTranscriptHash,
  ZERO32,
  JurorClass,
} from "../src/index.ts";

const sol = readFileSync(new URL("../../../contracts/src/libraries/MochiTypes.sol", import.meta.url), "utf8");

function typeString(name: string, fields: readonly { name: string; type: string }[]) {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

describe("eip712 parity with Solidity", () => {
  const cases = [
    ["Provenance", PROVENANCE_TYPES.Provenance],
    ["AnonymaVoucher", ANONYMA_VOUCHER_TYPES.AnonymaVoucher],
    ["JurorAnswer", JUROR_ANSWER_TYPES.JurorAnswer],
    ["VerdictAttestation", VERDICT_ATTESTATION_TYPES.VerdictAttestation],
  ] as const;
  for (const [name, fields] of cases) {
    test(name, () => {
      const s = typeString(name, fields);
      expect(s).toBe(TYPE_STRINGS[name]);
      expect(sol.includes(`"${s}"`)).toBe(true);
    });
  }
});

describe("jury math", () => {
  test("k(N)", () => {
    expect([3, 5, 7, 9].map(requiredAgree)).toEqual([3, 4, 6, 7]);
  });
  test("nested mixes", () => {
    expect(classMix(3)).toEqual([JurorClass.LARGE_A, JurorClass.DOC_SPECIALIST, JurorClass.DISSENTER]);
    expect(classMix(5).slice(0, 3)).toEqual(classMix(3));
    expect(classMix(9).slice(0, 7)).toEqual(classMix(7));
  });
});

describe("canonical json", () => {
  test("sorted keys, bigint as string, drops undefined props", () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: [true, null] }, z: undefined })).toBe('{"a":{"c":[true,null],"d":"2"},"b":1}');
  });
  test("rejects NaN and Date", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: new Date() })).toThrow();
  });
  test("keeps a parsed __proto__ key instead of dropping it", () => {
    const withProto = JSON.parse('{"b":2,"__proto__":{"a":1}}');
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"a":1},"b":2}');
    expect(canonicalJson(withProto)).not.toBe(canonicalJson({ b: 2 }));
    expect(canonicalJson({ x: JSON.parse('{"__proto__":7}') })).toBe('{"x":{"__proto__":7}}');
    expect(Object.getPrototypeOf(withProto)).toBe(Object.prototype);
  });
});

describe("hashes", () => {
  test("docCommit public salt", () => {
    const dh = keccak256(toHex("doc"));
    expect(docCommit(ZERO32, dh)).toBe(keccak256(`0x${"00".repeat(32)}${dh.slice(2)}`));
  });
  test("submitted transcript hash binds salt, content type, text and raw params", () => {
    const salt = `0x${"5a".repeat(32)}` as const;
    const base = { salt, contentType: "text/html", text: "Revenue was 10.", params: { b: 1, a: "x" } };
    const h = submittedTranscriptHash(base);
    expect(h).toBe(keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      ["mochi/submitted-transcript/v1", salt, keccak256(toHex("text/html")), keccak256(toHex("Revenue was 10.")), keccak256(toHex('{"a":"x","b":1}'))],
    )));
    // Key order of the raw params does not matter; every other input does.
    expect(submittedTranscriptHash({ ...base, params: { a: "x", b: 1 } })).toBe(h);
    for (const changed of [{ salt: ZERO32 }, { contentType: "text/plain" }, { text: "Revenue was 99." }, { params: { a: "x", b: 2 } }]) {
      expect(submittedTranscriptHash({ ...base, ...changed })).not.toBe(h);
    }
  });
  test("fetched transcript hash: public grants keep the TLS transcript, private ones bind it to the salt", () => {
    const fp = `0x${"ab".repeat(32)}` as const;
    const docH = keccak256(toHex("doc"));
    const tls = tlsTranscriptHash({ host: "docs.example", finalUrl: "https://docs.example/a", status: 200, contentType: "text/plain", docHash: docH, certFingerprints: [fp] });
    expect(tls).toBe(keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint16" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32[]" }],
      ["docs.example", "https://docs.example/a", 200, "text/plain", docH, [fp]],
    )));
    expect(fetchedTranscriptHash({ salt: ZERO32, tlsTranscriptHash: tls })).toBe(tls);
    const salt = `0x${"5a".repeat(32)}` as const;
    const salted = fetchedTranscriptHash({ salt, tlsTranscriptHash: tls });
    expect(salted).toBe(keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], ["mochi/fetched-transcript/v1", salt, tls])));
    expect(salted).not.toBe(tls);
    expect(fetchedTranscriptHash({ salt: `0x${"5b".repeat(32)}`, tlsTranscriptHash: tls })).not.toBe(salted);
  });
  test("merkle root is order independent", () => {
    const leaves = ["a", "b", "c"].map((x) => keccak256(toHex(x)));
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves].reverse()));
    expect(merkleRoot([])).toBe(ZERO32);
  });
});

describe("provenance struct hash", () => {
  test("provenanceHash equals keccak256(abi.encode(TYPEHASH, members...)) as QueryEscrow computes it", async () => {
    const { encodeAbiParameters } = await import("viem");
    const { provenanceHash } = await import("../src/index.ts");
    const prov = {
      docCommit: `0x${"01".repeat(32)}`, kind: 1, originId: `0x${"02".repeat(32)}`, fetchedAt: 5n, tokensK: 3, transcriptHash: `0x${"03".repeat(32)}`,
      opener: `0x${"04".repeat(20)}`, schemaId: 7, schemaVersion: 2, paramsHash: `0x${"05".repeat(32)}`, payerCommit: `0x${"06".repeat(32)}`,
      isPublic: false, allowPanelDisclosure: true, nonce: 9n, expiry: 10n,
    } as const;
    const typeHash = keccak256(toHex(TYPE_STRINGS.Provenance));
    const types = PROVENANCE_TYPES.Provenance.map((f) => ({ type: f.type }));
    const values = PROVENANCE_TYPES.Provenance.map((f) => prov[f.name]);
    expect(provenanceHash(prov)).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, ...types], [typeHash, ...values] as never)));
  });
});
