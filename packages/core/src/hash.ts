import { concat, encodeAbiParameters, encodePacked, keccak256, sha256, toHex, type Hex } from "viem";
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
 * Provenance.transcriptHash of a SUBMITTED document: what the intake recorded for the grant, beyond the bytes and salt
 * that docCommit already binds.
 *   keccak256(abi.encode("mochi/submitted-transcript/v1", bytes32 salt, keccak256(utf8 contentType),
 *                        keccak256(utf8 extracted text), keccak256(utf8 canonicalJson(raw params))))
 * The intake signs it into the grant and re-derives it from its sealed record before releasing the document, so the
 * record a query's jurors read is fixed by the signature, not only by first-write-wins storage. The query salt makes it
 * useless for confirming a guessed private document (it is ZERO32, like docCommit's, for public queries).
 */
export function submittedTranscriptHash(args: { salt: Hex; contentType: string; text: string; params: Record<string, unknown> }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    ["mochi/submitted-transcript/v1", args.salt, keccak256(toHex(args.contentType)), keccak256(toHex(args.text)), hashCanonical(args.params)],
  ));
}

/**
 * What the intake's pinned fetch of a FETCHED document observed:
 *   keccak256(abi.encode(string host, string finalUrl, uint16 status, string contentType, bytes32 sha256(bytes),
 *                        bytes32[] SPKI sha256 fingerprints of the certificate chains, in fetch order))
 * Public FETCHED grants sign it as their transcriptHash unchanged (feeds and their crosschecks rely on public
 * provenance); private ones sign the salted form (`fetchedTranscriptHash`).
 */
export function tlsTranscriptHash(args: { host: string; finalUrl: string; status: number; contentType: string; docHash: Hex; certFingerprints: readonly Hex[] }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint16" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32[]" }],
    [args.host, args.finalUrl, args.status, args.contentType, args.docHash, [...args.certFingerprints]],
  ));
}

/**
 * Provenance.transcriptHash of a FETCHED document. Public (salt = ZERO32): the TLS transcript hash itself. Private:
 *   keccak256(abi.encode("mochi/fetched-transcript/v1", bytes32 salt, bytes32 tlsTranscriptHash))
 * The unsalted hash covers the URL, status, content type, document hash and certificate pins, so on a private grant
 * it would let anyone confirm a guessed URL and document from the chain; the query salt prevents that, as it does for
 * docCommit and the SUBMITTED transcript. The intake re-derives it from its sealed record before release.
 */
export function fetchedTranscriptHash(args: { salt: Hex; tlsTranscriptHash: Hex }): Hex {
  if (/^0x0{64}$/i.test(args.salt)) return args.tlsTranscriptHash;
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }],
    ["mochi/fetched-transcript/v1", args.salt, args.tlsTranscriptHash],
  ));
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

/**
 * QueryEscrow.computeQueryId: keccak256(abi.encode(uint256 chainId, address escrow, address opener, bytes32 docCommit,
 * uint64 nonce)). A grant fixes opener, docCommit and nonce, so a client can derive its query's id without asking a relay.
 */
export function computeQueryId(args: { chainId: number | bigint; escrow: `0x${string}`; opener: `0x${string}`; docCommit: Hex; nonce: bigint }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
    [BigInt(args.chainId), args.escrow, args.opener, args.docCommit, args.nonce],
  ));
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

/** payload = abi.encode(bytes32 subjectKey, uint64 asOf, bytes body). See publicPayloadHash / privatePayloadHash. */
export function encodePayload(subjectKey: Hex, asOf: bigint, body: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [subjectKey, asOf, body]);
}

/** On-chain payloadHash of a PUBLIC query: keccak256(payload). Feeds re-hashes the payload, so this stays unsalted. */
export function publicPayloadHash(payload: Hex): Hex {
  return keccak256(payload);
}

/**
 * On-chain payloadHash of a PRIVATE query:
 * keccak256(abi.encodePacked("mochi/private-payload/v1", bytes32 salt, keccak256(payload))), salt = the query's
 * secret seed salt. Payload bodies can have only a few possible values (e.g. one of four claim answers), so an
 * unsalted hash would let anyone recover a private outcome by hashing the candidates.
 */
export function privatePayloadHash(salt: Hex, payload: Hex): Hex {
  if (/^0x0{64}$/i.test(salt)) throw new RangeError("private payload hash requires a non-zero salt");
  return keccak256(encodePacked(["string", "bytes32", "bytes32"], ["mochi/private-payload/v1", salt, keccak256(payload)]));
}

/** Left-aligned ASCII in bytes32 (uppercase is the caller's job). Throws if > 32 bytes. */
export function toBytes32String(s: string): Hex {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > 32) throw new RangeError(`string too long for bytes32: ${s}`);
  const out = new Uint8Array(32);
  out.set(bytes);
  return toHex(out);
}
