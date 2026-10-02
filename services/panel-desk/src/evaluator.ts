import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { encodeAbiParameters, encodePacked, fromHex, keccak256, toHex, type Hex } from "viem";
import type { Account } from "viem/accounts";
import { answerHash, answerJson as serializeAnswer, type NormalizedValue, type SchemaDef } from "@mochi/core";
import { aad, evaluatorKeyDigest, PanelDocPlainSchema, type PanelDocPlain } from "@mochi/protocol";
import { open } from "@mochi/tee";
import { buildPayload, normalizeValue, normalizeParams, resolveSchema } from "@mochi/schemas";

export function generateEvaluatorKey() {
  const key = x25519.keygen();
  return { privKey: toHex(key.secretKey), pubKey: toHex(key.publicKey) };
}

type SigningAccount = { signMessage: NonNullable<Account["signMessage"]> };
export async function bindKey(account: SigningAccount, queryId: Hex, panelIndex: number, pub: Hex): Promise<Hex> {
  const digest = evaluatorKeyDigest(queryId, panelIndex, pub);
  return account.signMessage({ message: { raw: digest } });
}

export function openMaterials(materials: { queryId: Hex; evaluator: Hex; docEnvelope: { v: 1; epk: Hex; nonce: Hex; ct: Hex } }, privKey: Uint8Array | Hex): PanelDocPlain {
  const privateBytes = typeof privKey === "string" ? fromHex(privKey, "bytes") : privKey;
  const plain = open(privateBytes, materials.docEnvelope, aad.panel(materials.queryId, materials.evaluator));
  return PanelDocPlainSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
}

/**
 * Builds an evaluator's answer for the panel document. `salt` is the record salt from the panel document: ZERO32 for a
 * public query, non-zero for a private one (intake enforces this). `payloadHash` is the value committed, revealed and
 * posted on-chain, computed like consensus does: keccak256(payload) for a public query, and
 * privatePayloadHash(salt, payload) for a private one, so a private outcome cannot be found by hashing the few
 * candidate payloads. Pass `isPublic` (the query's on-chain flag, also in the materials response) to cross-check.
 */
export function buildAnswer(
  schemaId: number,
  schemaVersion: number,
  salt: Hex,
  params: Record<string, unknown>,
  rawFields: Record<string, unknown>,
  openedAt: bigint,
  options: { isPublic?: boolean } = {},
) {
  const isPrivate = !/^0x0{64}$/i.test(salt);
  if (options.isPublic !== undefined && options.isPublic === isPrivate) {
    throw new Error(options.isPublic ? "public query with a non-zero record salt" : "private query without a record salt");
  }
  const schema = resolveSchema(schemaId as SchemaDef["id"], params);
  const normalizedParams = normalizeParams(schema, params);
  if (!normalizedParams.ok) throw new Error("invalid schema parameters");
  const fields: Record<string, NormalizedValue | null> = {};
  for (const spec of schema.fields) {
    const normalized = normalizeValue(spec, rawFields[spec.name]);
    if (!normalized.ok || (spec.required && normalized.value === null)) throw new Error(`invalid field: ${spec.name}`);
    fields[spec.name] = normalized.value;
  }
  const hash = answerHash({ salt, schemaId: schema.id, schemaVersion, fields });
  const answer = serializeAnswer({ salt, schemaId: schema.id, schemaVersion, fields });
  const payload = buildPayload(schema, fields, normalizedParams.params, { openedAt, ...(isPrivate ? { privateSalt: salt } : {}) });
  return { fields, answerHash: hash, answerJson: answer, payload: payload.payload as Hex, payloadHash: payload.payloadHash as Hex };
}

export function commitment(caseId: Hex, panelIndex: number, evaluator: Hex, answerHashValue: Hex, payloadHash: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [caseId, panelIndex, evaluator, answerHashValue, payloadHash, salt],
  ));
}

export async function payloadSig(account: SigningAccount, caseId: Hex, panelIndex: number, payload: Hex): Promise<Hex> {
  const digest = keccak256(encodePacked(["string", "bytes32", "uint8", "bytes32"], ["mochi/panel-payload/v1", caseId, panelIndex, keccak256(payload)]));
  return account.signMessage({ message: { raw: digest } });
}

export function evaluatorSalt(): Hex { return toHex(randomBytes(32)); }

/** The evaluator CLI command that abstains on chain for a case (PanelEscalation.abstain). */
export function abstainCommand(caseId: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(caseId)) throw new Error("invalid case id");
  return `bun services/panel-desk/bin/evaluator.ts abstain --case-id ${caseId}`;
}

/**
 * What to tell an evaluator whose materials request failed with `code`, or undefined when there is nothing to add.
 * MATERIALS_UNAVAILABLE is permanent (the intake no longer holds the document): the seat cannot evaluate the case and
 * should abstain before the commit deadline rather than be slashed for not revealing.
 */
export function materialsFailureAdvice(code: string | undefined, caseId: Hex): string | undefined {
  if (code !== "MATERIALS_UNAVAILABLE") return undefined;
  return [
    "The intake can no longer serve this case's document (MATERIALS_UNAVAILABLE). It will not come back, so you cannot evaluate the case.",
    "Abstain on chain before the commit deadline instead of committing. If at least two of the three seats abstain the panel is void:",
    "nobody is slashed, the fee is refunded and a new panel may be drawn. A lone abstainer is slashed like a seat that does not reveal.",
    "",
    `  ${abstainCommand(caseId)}`,
  ].join("\n");
}

/** A private query's payload carries private field values and never leaves the evaluator: refuse to submit it. */
export function assertPublicPayload(isPublic: boolean): void {
  if (!isPublic) throw new Error("refusing to submit: the query is private, so its payload stays with the evaluator");
}
