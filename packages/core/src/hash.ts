import { concat, encodeAbiParameters, keccak256, sha256, toHex, type Hex } from "viem";
import { canonicalJson } from "./canonical.ts";
import type { NormalizedValue, SchemaId, SpanRef } from "./types.ts";

export const ZERO32: Hex = `0x${"00".repeat(32)}`;

/** docHash = sha256(document bytes) as 0x-hex. */
export function docHash(bytes: Uint8Array): Hex {
  return sha256(bytes);
}

/** docCommit = keccak256(abi.encodePacked(bytes32 salt, bytes32 docHash)). salt = ZERO32 for public queries. */
export function docCommit(salt: Hex, docHashHex: Hex): Hex {
  return keccak256(concat([salt, docHashHex]));
}

/** originId = keccak256(utf8(lowercase host)), e.g. "www.sec.gov". */
export function originId(host: string): Hex {
  return keccak256(toHex(host.trim().toLowerCase()));
}

/** keccak256 of the canonical JSON string. */
export function hashCanonical(value: unknown): Hex {
  return keccak256(toHex(canonicalJson(value)));
}

/**
 * answerHash = keccak256(canonicalJSON({ salt, schemaId, schemaVersion, fields })).
 * Used for both a juror's own answer and the agreed verdict answer. `salt` is ZERO32 for public queries.
 * `fields` must contain every schema field (null for absent) so the hash is total.
 */
export function answerHash(args: {
  salt: Hex;
  schemaId: SchemaId;
  schemaVersion: number;
  fields: Record<string, NormalizedValue | null>;
}): Hex {
  return hashCanonical({
    salt: args.salt,
    schemaId: args.schemaId,
    schemaVersion: args.schemaVersion,
    fields: args.fields,
  });
}

/** Canonical JSON bytes of the answer — what `MochiVerdicts.verify(verdictId, answerJson)` checks. */
export function answerJson(args: {
  salt: Hex;
  schemaId: SchemaId;
  schemaVersion: number;
  fields: Record<string, NormalizedValue | null>;
}): string {
  return canonicalJson({
    salt: args.salt,
    schemaId: args.schemaId,
    schemaVersion: args.schemaVersion,
    fields: args.fields,
  });
}

/** Leaf for span merkle trees: keccak256(abi.encode(string field, uint256 start, uint256 end, bytes32 hash)). */
export function spanLeaf(span: SpanRef): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [span.field, BigInt(span.start), BigInt(span.end), span.hash],
    ),
  );
}

/**
 * Sorted-pair keccak merkle root (OpenZeppelin MerkleProof compatible: parent = keccak256(sort(a, b))).
 * Leaves are sorted before building so the root is order-independent. Empty → ZERO32. Odd node is promoted.
 */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return ZERO32;
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (b === undefined) {
        next.push(a);
        continue;
      }
      next.push(a < b ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
    }
    level = next;
  }
  return level[0]!;
}

export function spansRoot(spans: SpanRef[]): Hex {
  return merkleRoot(spans.map(spanLeaf));
}

/** verdictId = keccak256(abi.encode(bytes32 queryId, uint8 round)). */
export function verdictId(queryId: Hex, round: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }], [queryId, round]));
}

/** votesHash = keccak256(abi.encode(address[] jurors, bytes32[] answerHashes, bytes32[] spansRoots, bytes32[] quoteHashes)). */
export function votesHash(
  votes: readonly { juror: `0x${string}`; answerHash: Hex; spansRoot: Hex; quoteHash: Hex }[],
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "bytes32[]" }, { type: "bytes32[]" }, { type: "bytes32[]" }],
      [votes.map((v) => v.juror), votes.map((v) => v.answerHash), votes.map((v) => v.spansRoot), votes.map((v) => v.quoteHash)],
    ),
  );
}

/** attestationRoot = keccak256(abi.encode(bytes32[] quoteHashes)) in seat order (timed-out seats contribute ZERO32). */
export function attestationRoot(quoteHashes: readonly Hex[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [[...quoteHashes]]));
}

/** modelSetHash = keccak256(abi.encode(address[] jurors)) in seat order. */
export function modelSetHash(jurors: readonly `0x${string}`[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "address[]" }], [[...jurors]]));
}

/** payload = abi.encode(bytes32 subjectKey, uint64 asOf, bytes body). payloadHash = keccak256(payload). */
export function encodePayload(subjectKey: Hex, asOf: bigint, body: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [subjectKey, asOf, body]);
}

/** Left-aligned ASCII in bytes32 (uppercase is the caller's job). Throws if > 32 bytes. */
export function toBytes32String(s: string): Hex {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > 32) throw new RangeError(`string too long for bytes32: ${s}`);
  const out = new Uint8Array(32);
  out.set(bytes);
  return toHex(out);
}
