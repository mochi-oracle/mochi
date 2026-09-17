import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bls12_381 } from "../../../node_modules/@noble/curves/bls12-381.js";

const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const word = (n: bigint) => n.toString(16).padStart(128, "0");
const g1 = (point: { toAffine(): { x: bigint; y: bigint } }) => {
  const { x, y } = point.toAffine();
  return word(x) + word(y);
};
const g2 = (point: { toAffine(): { x: { c0: bigint; c1: bigint }; y: { c0: bigint; c1: bigint } } }) => {
  const { x, y } = point.toAffine();
  return word(x.c0) + word(x.c1) + word(y.c0) + word(y.c1);
};
const fromHex = (v: string) => Uint8Array.from(Buffer.from(v.replace(/^0x/, ""), "hex"));
const hashRound = (round: number) => createHash("sha256").update(Buffer.from(BigInt(round).toString(16).padStart(16, "0"), "hex")).digest();
const bls = bls12_381.shortSignatures;
const pair = bls12_381;

const chain = JSON.parse(readFileSync("test/fixtures/drand-quicknet.json", "utf8"));
const quicknetPk = pair.G2.Point.fromHex(chain.chain.publicKey);
const quicknetBeacons = chain.beacons.map((beacon: { round: number; signature: string }) => {
  const message = hashRound(beacon.round);
  const signature = bls.Signature.fromHex(beacon.signature);
  return {
    round: beacon.round,
    message: hex(message),
    signature: g1(signature),
    hashToG1: g1(bls.hash(message, DST)),
  };
});

const testKey = bls.keygen(new Uint8Array(48).map((_, i) => i + 1));
const testRounds = Array.from({ length: 64 }, (_, i) => i + 1).map((round) => {
  const message = hashRound(round);
  const hashed = bls.hash(message, DST);
  return { round, message: hex(message), signature: g1(bls.sign(hashed, testKey.secretKey)), hashToG1: g1(hashed) };
});

// RFC 9380 Appendix J.1.1 has vectors for this expander; include the well-known QUUX cases.
const xmdDst = "QUUX-V01-CS02-with-expander-SHA256-128";
const expandXmd = (msg: Uint8Array, dst: string, len: number) => {
  const bInBytes = 64;
  const ell = Math.ceil(len / 32);
  const dstBytes = Buffer.from(dst);
  const dstPrime = Buffer.concat([dstBytes, Buffer.from([dstBytes.length])]);
  const zPad = Buffer.alloc(64);
  const libStr = Buffer.from([len >> 8, len & 255]);
  const b0 = createHash("sha256").update(Buffer.concat([zPad, msg, libStr, Buffer.from([0]), dstPrime])).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; i <= ell; i++) {
    const input = i === 1 ? b0 : Buffer.from(b0.map((v, j) => v ^ previous[j]!));
    previous = createHash("sha256").update(Buffer.concat([input, Buffer.from([i]), dstPrime])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, len);
};

const output = {
  quicknet: { publicKeyG2: g2(quicknetPk), beacons: quicknetBeacons },
  testKey: {
    publicKeyG2: g2(testKey.publicKey),
    rounds: testRounds,
  },
  negatedG2Generator: g2(pair.G2.Point.BASE.negate()),
  expandMessageXmd: [
    { dst: xmdDst, message: "", length: 128, output: hex(expandXmd(new Uint8Array(), xmdDst, 128)) },
    { dst: xmdDst, message: "abc", length: 128, output: hex(expandXmd(new TextEncoder().encode("abc"), xmdDst, 128)) },
    { dst: xmdDst, message: "abcdef0123456789", length: 128, output: hex(expandXmd(new TextEncoder().encode("abcdef0123456789"), xmdDst, 128)) },
  ],
};
writeFileSync("test/fixtures/drand-vectors.json", `${JSON.stringify(output, null, 2)}\n`);
console.log("wrote test/fixtures/drand-vectors.json");
