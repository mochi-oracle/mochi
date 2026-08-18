import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalBytes } from "@mochi/core";

export type ReceiptPublicKey = string | KeyObject;

function rawPublicBytes(key: KeyObject): Uint8Array {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  const der = publicKey.export({ type: "spki", format: "der" });
  if (der.length < 32) throw new TypeError("Invalid Ed25519 public key");
  return der.subarray(der.length - 32);
}

/** Anonyma key identifier: first 16 hex chars of SHA-256(raw Ed25519 public key). */
export function keyIdFor(rawPublicKey: Uint8Array): string {
  if (!(rawPublicKey instanceof Uint8Array) || rawPublicKey.length !== 32) {
    throw new TypeError("Ed25519 raw public key must be 32 bytes");
  }
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

/** Convert a 64-character raw public key hex string to a Node Ed25519 public KeyObject. */
export function publicKeyFromRaw(hex: string): KeyObject {
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(hex)) throw new TypeError("Invalid raw Ed25519 public key hex");
  const raw = Buffer.from(hex.replace(/^0x/i, ""), "hex");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

function asPublicKey(key: ReceiptPublicKey): KeyObject {
  if (typeof key !== "string") return key.type === "public" ? key : createPublicKey(key);
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(key)) return publicKeyFromRaw(key);
  return createPublicKey(key);
}

export interface ReceiptSigner {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  jwk: Record<string, string> & { kid: string; use: "sig"; alg: "EdDSA" };
  rawPublicKeyHex: string;
  sign(payload: object): string;
}

/** Generate a development key when no key is supplied. Production must pass a protected PKCS8 DER key. */
export function createReceiptSigner(opts: { pkcs8DerBase64?: string } = {}): ReceiptSigner {
  let privateKey: KeyObject;
  if (opts.pkcs8DerBase64 !== undefined) {
    const der = Buffer.from(opts.pkcs8DerBase64, "base64");
    if (der.length === 0 || der.toString("base64") !== opts.pkcs8DerBase64) {
      throw new TypeError("Invalid PKCS8 DER base64");
    }
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("Receipt signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const raw = rawPublicBytes(publicKey);
  const keyId = keyIdFor(raw);
  const exportedJwk = publicKey.export({ format: "jwk" });
  if (!exportedJwk.x) throw new TypeError("Unable to export Ed25519 public key");
  const jwk = { ...exportedJwk, kid: keyId, use: "sig" as const, alg: "EdDSA" as const } as Record<string, string> & { kid: string; use: "sig"; alg: "EdDSA" };
  return {
    keyId,
    algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    jwk,
    rawPublicKeyHex: Buffer.from(raw).toString("hex"),
    sign(payload: object): string {
      return cryptoSign(null, canonicalBytes(payload), privateKey).toString("base64");
    },
  };
}

/** Verify a receipt signature. Malformed keys, receipts, and signatures return false. */
export function verifyReceiptSignature(receipt: unknown, signatureB64: string, publicKey: ReceiptPublicKey): boolean {
  try {
    if (typeof signatureB64 !== "string" || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(signatureB64)) return false;
    const signature = Buffer.from(signatureB64, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== signatureB64) return false;
    return cryptoVerify(null, canonicalBytes(receipt), asPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}
