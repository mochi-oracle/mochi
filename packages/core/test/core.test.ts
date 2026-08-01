import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import {
  ANONYMA_VOUCHER_TYPES,
  JUROR_ANSWER_TYPES,
  PROVENANCE_TYPES,
  TYPE_STRINGS,
  VERDICT_ATTESTATION_TYPES,
  canonicalJson,
  classMix,
  docCommit,
  merkleRoot,
  requiredAgree,
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
});

describe("hashes", () => {
  test("docCommit public salt", () => {
    const dh = keccak256(toHex("doc"));
    expect(docCommit(ZERO32, dh)).toBe(keccak256(`0x${"00".repeat(32)}${dh.slice(2)}`));
  });
  test("merkle root is order independent", () => {
    const leaves = ["a", "b", "c"].map((x) => keccak256(toHex(x)));
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves].reverse()));
    expect(merkleRoot([])).toBe(ZERO32);
  });
});
