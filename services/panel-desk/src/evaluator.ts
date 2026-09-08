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

export function buildAnswer(
  schemaId: number,
  schemaVersion: number,
  salt: Hex,
  params: Record<string, unknown>,
  rawFields: Record<string, unknown>,
  openedAt: bigint,
) {
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
  const payload = buildPayload(schema, fields, normalizedParams.params, { openedAt });
  const payloadHex = payload.payload as Hex;
  return { fields, answerHash: hash, answerJson: answer, payload: payloadHex, payloadHash: keccak256(payloadHex) };
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
