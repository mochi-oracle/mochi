import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { concat, fromHex, toHex, type Hex } from "viem";

export type Envelope = { v: 1; epk: Hex; nonce: Hex; ct: Hex };
export class EnvelopeError extends Error {
  constructor(message = "Envelope authentication failed") { super(message); this.name = "EnvelopeError"; }
}

const bytes = (hex: Hex) => fromHex(hex, "bytes");
const utf8 = (value: string) => new TextEncoder().encode(value);
function derive(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat([epk, recipient]), utf8("mochi/envelope/v1"), 32);
}

/** Seal bytes to an X25519 public key. Document AAD: `utf8("mochi/doc/v1|" + docCommit)`; private result AAD: `utf8("mochi/result/v1|" + verdictId)`. */
export function seal(recipientPub: Hex, plaintext: Uint8Array, aad: Uint8Array): Envelope {
  try {
    const recipient = bytes(recipientPub);
    if (recipient.length !== 32) throw new Error("recipient key must be 32 bytes");
    const eph = x25519.keygen();
    const epk = eph.publicKey;
    const key = derive(x25519.getSharedSecret(eph.secretKey, recipient), epk, recipient);
    const nonce = randomBytes(12);
    return { v: 1, epk: toHex(epk), nonce: toHex(nonce), ct: toHex(gcm(key, nonce, aad).encrypt(plaintext)) };
  } catch (error) { throw new EnvelopeError(error instanceof Error ? error.message : undefined); }
}

/** Open an envelope with the recipient's 32-byte X25519 private key. */
export function open(recipientPriv: Uint8Array, env: Envelope, aad: Uint8Array): Uint8Array {
  try {
    if (env.v !== 1 || recipientPriv.length !== 32) throw new Error("invalid envelope");
    const epk = bytes(env.epk), nonce = bytes(env.nonce), ct = bytes(env.ct);
    if (epk.length !== 32 || nonce.length !== 12) throw new Error("invalid envelope dimensions");
    const recipient = x25519.getPublicKey(recipientPriv);
    const key = derive(x25519.getSharedSecret(recipientPriv, epk), epk, recipient);
    return gcm(key, nonce, aad).decrypt(ct);
  } catch { throw new EnvelopeError(); }
}

export interface EncryptedDocument { dekEnvelope: Envelope; docCt: Hex }
/** Encrypt document bytes under a random DEK and seal that DEK to one recipient. */
export function encryptDocument(doc: Uint8Array, recipientPub: Hex, aad: Uint8Array): EncryptedDocument {
  const dek = randomBytes(32), nonce = randomBytes(12);
  const docCt = toHex(concat([nonce, gcm(dek, nonce, aad).encrypt(doc)]));
  return { dekEnvelope: seal(recipientPub, dek, aad), docCt };
}
/** Seal an existing document key independently for each recipient. */
export function rewrapDek(dek: Uint8Array, recipients: Hex[], aad: Uint8Array): Envelope[] {
  if (dek.length !== 32) throw new EnvelopeError("DEK must be 32 bytes");
  return recipients.map((recipient) => seal(recipient, dek, aad));
}
/** Decrypt a document using its recipient-specific wrapped DEK and nonce-prefixed ciphertext. */
export function decryptDocument(wrappedDek: Envelope, docCt: Hex, recipientPriv: Uint8Array, aad: Uint8Array): Uint8Array {
  try {
    const dek = open(recipientPriv, wrappedDek, aad), packed = bytes(docCt);
    if (dek.length !== 32 || packed.length < 28) throw new Error("invalid document ciphertext");
    const nonce = packed.slice(0, 12);
    return gcm(dek, nonce, aad).decrypt(packed.slice(12));
  } catch { throw new EnvelopeError(); }
}
