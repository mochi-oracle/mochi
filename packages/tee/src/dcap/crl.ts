import { p256 } from "@noble/curves/nist.js";
import { children, integer, oid, readTlv, time, bitString } from "./der.ts";
import { equalBytes, type Cert } from "./x509.ts";

export interface ParsedCrl {
  tbs: Uint8Array;
  issuerDer: Uint8Array;
  thisUpdate: number;
  nextUpdate: number;
  revoked: Set<bigint>;
  signature: Uint8Array;
}

/** Parse a DER CRL, retaining the exact signed tbsCertList bytes. */
export function parseCrl(der: Uint8Array): ParsedCrl {
  const certificateList = children(readTlv(der));
  if (certificateList.length !== 3) throw new Error("CRL malformed");
  const tbs = certificateList[0]!;
  const fields = children(tbs);
  let index = fields[0]!.tag === 2 ? 1 : 0;
  const algorithm = children(fields[index++]!);
  if (oid(algorithm[0]!) !== "1.2.840.10045.4.3.2") throw new Error("CRL algorithm");

  const issuer = fields[index++]!;
  const thisUpdate = time(fields[index++]!);
  const nextUpdate = time(fields[index++]!);
  const revoked = new Set<bigint>();
  if (fields[index]?.tag === 0x30) {
    for (const revokedCertificate of children(fields[index]!)) {
      revoked.add(integer(children(revokedCertificate)[0]!));
    }
  }

  const signatureAlgorithm = children(certificateList[1]!);
  if (oid(signatureAlgorithm[0]!) !== "1.2.840.10045.4.3.2") throw new Error("CRL algorithm");
  return {
    tbs: tbs.raw,
    issuerDer: issuer.raw,
    thisUpdate,
    nextUpdate,
    revoked,
    signature: bitString(certificateList[2]!),
  };
}

/** Check CRL issuer, ECDSA signature, and freshness at the supplied time. */
export function verifyCrl(crl: ParsedCrl, issuer: Cert, now: number): boolean {
  return equalBytes(crl.issuerDer, issuer.subjectDer)
    && crl.thisUpdate <= now
    && now <= crl.nextUpdate
    && p256.verify(crl.signature, crl.tbs, issuer.publicKey, {
      lowS: false,
      prehash: true,
      format: "der",
    });
}
