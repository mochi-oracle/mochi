// Test-only helpers that forge TDX quotes from the real Intel fixture: re-signed certificate chains, a bogus FMSPC, and a
// quote whose QE report and body are consistently signed by attacker keys. Nothing here is used outside tests.
import { readFile } from "node:fs/promises";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { children, readTlv } from "../src/dcap/der.ts";
import { parseTdxQuote, type TdxQuote } from "../src/dcap/quote.ts";
import { pemChain, type Cert } from "../src/dcap/x509.ts";

const fixtureDir = new URL("./fixtures/intel-tdx/", import.meta.url);
export const FIXTURE_NOW = 1752919234;
export const readFixture = async (name: string) => new Uint8Array(await readFile(new URL(name, fixtureDir)));
export const readFixtureJson = async (name: string) => JSON.parse(await readFile(new URL(name, fixtureDir), "utf8"));

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const u16 = (value: number) => Uint8Array.from([value & 0xff, (value >> 8) & 0xff]);
const u32 = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return out; };
function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Uint8Array) => concat(Uint8Array.from([tag]), derLength(content.length), content);

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export type KeyPair = { secret: Uint8Array; publicKey: Uint8Array };
export function keyPair(): KeyPair {
  const secret = p256.utils.randomSecretKey();
  return { secret, publicKey: p256.getPublicKey(secret, false) };
}

/** Rebuild `cert` with its subject key replaced and/or its TBS edited, signed by `signer` (any P-256 key). */
export function resignCert(cert: Cert, signer: Uint8Array, options: { publicKey?: Uint8Array; editTbs?: (tbs: Uint8Array) => void } = {}): Uint8Array {
  const tbs = cert.tbs.slice();
  if (options.publicKey) {
    const at = indexOfBytes(tbs, cert.publicKey);
    if (at < 0 || options.publicKey.length !== cert.publicKey.length) throw new Error("subject key not found");
    tbs.set(options.publicKey, at);
  }
  options.editTbs?.(tbs);
  const signature = p256.sign(tbs, signer, { prehash: true, format: "der" });
  const algorithm = children(readTlv(cert.der))[1]!.raw;
  return tlv(0x30, concat(tbs, algorithm, tlv(0x03, concat(Uint8Array.of(0), signature))));
}

/** Copy of `cert` with its TBS edited but Intel's original signature kept (so the signature no longer verifies). */
export function tamperCert(cert: Cert, editTbs: (tbs: Uint8Array) => void): Uint8Array {
  const der = cert.der.slice();
  const tbsAt = indexOfBytes(der, cert.tbs);
  const tbs = der.subarray(tbsAt, tbsAt + cert.tbs.length);
  editTbs(tbs);
  return der;
}

export function pem(ders: Uint8Array[]): string {
  return ders.map((der) => {
    const base64 = btoa(String.fromCharCode(...der));
    return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  }).join("");
}

/** Replace the 6-byte FMSPC OCTET STRING inside a PCK leaf TBS. */
export function setFmspc(tbs: Uint8Array, from: Uint8Array, to: Uint8Array): void {
  const at = indexOfBytes(tbs, concat(Uint8Array.of(0x04, 0x06), from));
  if (at < 0) throw new Error("FMSPC not found");
  tbs.set(to, at + 2);
}

const REPORT_DATA_OFFSET_V4 = 48 + 520;

/**
 * Serialize a v4 TDX quote. Overrides replace the PEM chain and, for a fully forged quote, re-sign the QE report with
 * `pckSigner` and the quote body with a fresh attestation key, after writing `reportData` into the TD report.
 */
export function buildQuote(original: Uint8Array, options: { pckPem?: string; reportData?: Uint8Array; pckSigner?: Uint8Array } = {}): Uint8Array {
  const quote: TdxQuote = parseTdxQuote(original);
  if (quote.version !== 4) throw new Error("v4 fixture expected");
  const signed = quote.signed.slice();
  if (options.reportData) signed.set(options.reportData, REPORT_DATA_OFFSET_V4);
  let { signature, attestationKey, qeReport, qeSignature } = quote;
  if (options.pckSigner) {
    const attestation = keyPair();
    attestationKey = attestation.publicKey.slice(1);
    qeReport = qeReport.slice();
    qeReport.set(sha256(concat(attestationKey, quote.qeAuthData)), 320);
    qeReport.fill(0, 352);
    qeSignature = p256.sign(qeReport, options.pckSigner, { prehash: true });
    signature = p256.sign(signed, attestation.secret, { prehash: true });
  }
  const pemBytes = new TextEncoder().encode(options.pckPem ?? quote.pckPem);
  const certification = concat(qeReport, qeSignature, u16(quote.qeAuthData.length), quote.qeAuthData, u16(5), u32(pemBytes.length), pemBytes);
  const signatureData = concat(signature, attestationKey, u16(6), u32(certification.length), certification);
  return concat(signed, u32(signatureData.length), signatureData);
}

/** A complete self-made chain (attacker root, CA and PCK) that copies Intel's names and the real leaf's SGX extension. */
export async function selfSignedChainQuote(options: { reportData?: Uint8Array } = {}) {
  const raw = await readFixture("tdx_quote");
  const [leaf, intermediate, root] = pemChain(parseTdxQuote(raw).pckPem) as [Cert, Cert, Cert];
  const rootKey = keyPair(), caKey = keyPair(), pckKey = keyPair();
  const chain = pem([
    resignCert(leaf, caKey.secret, { publicKey: pckKey.publicKey }),
    resignCert(intermediate, rootKey.secret, { publicKey: caKey.publicKey }),
    resignCert(root, rootKey.secret, { publicKey: rootKey.publicKey }),
  ]);
  return buildQuote(raw, { pckPem: chain, pckSigner: pckKey.secret, reportData: options.reportData });
}

/**
 * Real Intel root and CA, but a PCK leaf whose FMSPC was changed. `resign: true` signs the forged leaf with an attacker
 * key (so the QE report and quote verify against it); otherwise Intel's original leaf signature is kept.
 */
export async function bogusFmspcQuote(options: { resign?: boolean; reportData?: Uint8Array; fmspc?: Uint8Array } = {}) {
  const raw = await readFixture("tdx_quote");
  const [leaf, intermediate, root] = pemChain(parseTdxQuote(raw).pckPem) as [Cert, Cert, Cert];
  const bogus = options.fmspc ?? Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
  const edit = (tbs: Uint8Array) => setFmspc(tbs, leaf.sgx!.fmspc, bogus);
  if (!options.resign) {
    return buildQuote(raw, { pckPem: pem([tamperCert(leaf, edit), intermediate.der, root.der]), reportData: options.reportData });
  }
  const pckKey = keyPair();
  const forgedLeaf = resignCert(leaf, keyPair().secret, { publicKey: pckKey.publicKey, editTbs: edit });
  return buildQuote(raw, { pckPem: pem([forgedLeaf, intermediate.der, root.der]), pckSigner: pckKey.secret, reportData: options.reportData });
}
