import { p256 } from "@noble/curves/nist.js";
import { children, integer, oid, readTlv, time, hex, bitString, type Tlv } from "./der.ts";

export interface Cert {
  der: Uint8Array;
  tbs: Uint8Array;
  serial: bigint;
  issuerDer: Uint8Array;
  subjectDer: Uint8Array;
  issuerCN: string;
  subjectCN: string;
  notBefore: number;
  notAfter: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
  ca: boolean;
  sgx?: {
    fmspc: Uint8Array;
    pceId: Uint8Array;
    tcb: { compSvn: number[]; pceSvn: number; cpuSvn: Uint8Array };
  };
}

const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  basicConstraints: "2.5.29.19",
  sgx: "1.2.840.113741.1.13.1",
};

function commonName(name: Tlv): string {
  for (const set of children(name)) {
    for (const attribute of children(set)) {
      const parts = children(attribute);
      if (parts.length === 2 && oid(parts[0]!) === "2.5.4.3") {
        return new TextDecoder().decode(parts[1]!.content);
      }
    }
  }
  return "";
}

function parseSgxExtension(der: Uint8Array): Cert["sgx"] {
  const root = readTlv(der);
  if (root.end !== der.length) throw new Error("SGX extension trailing DER");
  const values = new Map<string, Tlv>();

  const visit = (node: Tlv): void => {
    for (const item of children(node)) {
      const parts = children(item);
      if (parts.length !== 2 || parts[0]!.tag !== 6) continue;
      const id = oid(parts[0]!);
      if (parts[1]!.tag === 2 || parts[1]!.tag === 4) values.set(id, parts[1]!);
      else if (parts[1]!.tag === 0x30) visit(parts[1]!);
    }
  };

  visit(root);
  const get = (suffix: string) => values.get(`${OID.sgx}.${suffix}`);
  const fmspc = get("4");
  const pceId = get("3");
  const cpuSvn = get("2.18");
  if (!fmspc || !pceId || !cpuSvn) return undefined;
  if (fmspc.content.length !== 6 || pceId.content.length !== 2 || cpuSvn.content.length !== 16) {
    throw new Error("SGX extension length");
  }

  const componentSvn = (index: number): number => {
    const value = get(`2.${index}`);
    return value ? Number(integer(value)) : 0;
  };
  return {
    fmspc: fmspc.content,
    pceId: pceId.content,
    tcb: {
      compSvn: Array.from({ length: 16 }, (_, index) => componentSvn(index + 1)),
      pceSvn: componentSvn(17),
      cpuSvn: cpuSvn.content,
    },
  };
}

/** Parse a DER X.509 certificate and the Intel SGX TCB extension. */
export function parseCert(der: Uint8Array): Cert {
  const root = readTlv(der);
  if (root.end !== der.length) throw new Error("X509 trailing garbage");
  const certificate = children(root);
  if (certificate.length !== 3) throw new Error("X509 malformed certificate");

  const tbs = certificate[0]!;
  const fields = children(tbs);
  let index = fields[0]!.tag === 0xa0 ? 1 : 0;
  const serial = integer(fields[index++]!);
  const tbsAlgorithm = children(fields[index++]!);
  if (oid(tbsAlgorithm[0]!) !== OID.ecdsaSha256) throw new Error("X509 signature algorithm");
  const issuer = fields[index++]!;
  const validity = children(fields[index++]!);
  const subject = fields[index++]!;
  const spki = children(fields[index++]!);
  const publicKeyAlgorithm = children(spki[0]!);
  if (oid(publicKeyAlgorithm[0]!) !== OID.ecPublicKey || oid(publicKeyAlgorithm[1]!) !== OID.p256) {
    throw new Error("X509 unsupported public key");
  }
  const publicKey = bitString(spki[1]!);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("X509 invalid P-256 key");

  const outerAlgorithm = children(certificate[1]!);
  if (oid(outerAlgorithm[0]!) !== OID.ecdsaSha256 || oid(tbsAlgorithm[0]!) !== oid(outerAlgorithm[0]!)) {
    throw new Error("X509 signature algorithm");
  }

  let ca = false;
  let sgx: Cert["sgx"];
  for (const extensions of fields.filter((field) => field.tag === 0xa3)) {
    for (const extension of children(children(extensions)[0]!)) {
      const parts = children(extension);
      const id = oid(parts[0]!);
      const value = parts[parts.length - 1]!;
      if (id === OID.basicConstraints) {
        const constraints = children(readTlv(value.content));
        ca = constraints.some((entry) => entry.tag === 1 && entry.content[0] !== 0);
      }
      if (id === OID.sgx) sgx = parseSgxExtension(value.content);
    }
  }

  return {
    der,
    tbs: tbs.raw,
    serial,
    issuerDer: issuer.raw,
    subjectDer: subject.raw,
    issuerCN: commonName(issuer),
    subjectCN: commonName(subject),
    notBefore: time(validity[0]!),
    notAfter: time(validity[1]!),
    publicKey,
    signature: bitString(certificate[2]!),
    ca,
    sgx,
  };
}

/** Parse a PEM chain while preserving certificate order. */
export function pemChain(text: string): Cert[] {
  const normalized = text.replace(/\0+$/, "");
  const blocks = [...normalized.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  const remaining = normalized.replace(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    "",
  ).trim();
  if (!blocks.length || remaining) {
    throw new Error("X509 malformed PEM chain");
  }
  return blocks.map((block) => {
    const base64 = block[1]!.replace(/\s/g, "");
    return parseCert(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
  });
}

/** Verify a certificate's ECDSA-SHA256 signature, accepting Intel's high-S signatures. */
export function verifyCertSignature(cert: Cert, issuerPublicKey: Uint8Array): boolean {
  try {
    return p256.verify(cert.signature, cert.tbs, issuerPublicKey, {
      lowS: false,
      prehash: true,
      format: "der",
    });
  } catch {
    return false;
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function certHex(cert: Cert): string {
  return hex(cert.der);
}
