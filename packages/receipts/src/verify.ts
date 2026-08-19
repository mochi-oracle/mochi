import { keccak256, toHex, type Hex } from "viem";
import type { VerdictReceipt } from "./receipt.ts";
import { verifyMerkleProof } from "./anchor.ts";
import { receiptLeaf } from "./anchor.ts";
import { verifyReceiptSignature } from "./signer.ts";
import type { ReceiptPublicKey } from "./signer.ts";

export interface VerifyReceiptInput {
  receipt: unknown;
  signature: string;
  publicKeys: Record<string, ReceiptPublicKey>;
  anchor?: { root: Hex; proof: Hex[] };
}

export function verifyReceipt(input: VerifyReceiptInput): { valid: boolean; keyId: string; reason?: string; anchored?: boolean } {
  const r = input.receipt as Partial<VerdictReceipt> | null;
  const keyId = typeof r?.key_id === "string" ? r.key_id : "";
  if (!r || typeof r !== "object" || r.v !== 1 || r.kind !== "verdict") return { valid: false, keyId, reason: "invalid_envelope" };
  if (!keyId || !Object.prototype.hasOwnProperty.call(input.publicKeys, keyId)) return { valid: false, keyId, reason: "unknown_key" };
  if (!verifyReceiptSignature(input.receipt, input.signature, input.publicKeys[keyId]!)) return { valid: false, keyId, reason: "invalid_signature" };
  if (input.anchor) {
    try {
      const anchored = verifyMerkleProof(receiptLeaf(input.receipt), input.anchor.proof, input.anchor.root);
      if (!anchored) return { valid: false, keyId, reason: "invalid_anchor", anchored: false };
      return { valid: true, keyId, anchored: true };
    } catch {
      return { valid: false, keyId, reason: "invalid_anchor", anchored: false };
    }
  }
  return { valid: true, keyId };
}

export function answerMatches(receipt: unknown, answerJson: string): boolean {
  try {
    const verdict = (receipt as Partial<VerdictReceipt>)?.answer_hash;
    return typeof verdict === "string" && keccak256(toHex(answerJson)) === verdict.toLowerCase();
  } catch {
    return false;
  }
}
