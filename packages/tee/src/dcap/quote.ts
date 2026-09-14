export interface TdReport {
  teeTcbSvn: Uint8Array;
  mrSeam: Uint8Array;
  mrSignerSeam: Uint8Array;
  seamAttributes: Uint8Array;
  tdAttributes: Uint8Array;
  xfam: Uint8Array;
  mrTd: Uint8Array;
  mrConfigId: Uint8Array;
  mrOwner: Uint8Array;
  mrOwnerConfig: Uint8Array;
  rtmr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  reportData: Uint8Array;
  teeTcbSvn2?: Uint8Array;
  mrServiceTd?: Uint8Array;
}

export interface TdxQuote {
  version: number;
  header: {
    version: number;
    attestationKeyType: number;
    teeType: number;
    qeSvn: number;
    pceSvn: number;
    qeVendorId: Uint8Array;
    userData: Uint8Array;
  };
  bodyType: number;
  bodySize: number;
  td: TdReport;
  signed: Uint8Array;
  signature: Uint8Array;
  attestationKey: Uint8Array;
  qeReport: Uint8Array;
  qeSignature: Uint8Array;
  qeAuthData: Uint8Array;
  pckPem: string;
}

const INTEL_QE_VENDOR = Uint8Array.from([
  0x93, 0x9a, 0x72, 0x33, 0xf7, 0x9c, 0x4c, 0xa9,
  0x94, 0x0a, 0x0d, 0xb3, 0x95, 0x7f, 0x06, 0x07,
]);
const copy = (bytes: Uint8Array): Uint8Array => bytes.slice();

/** Parse the signed TDX quote body and nested QE certification data. */
export function parseTdxQuote(raw: Uint8Array): TdxQuote {
  let offset = 0;
  const readU16 = (): number => {
    if (offset + 2 > raw.length) throw new Error("quote truncated");
    const value = raw[offset]! | (raw[offset + 1]! << 8);
    offset += 2;
    return value;
  };
  const readU32 = (): number => {
    if (offset + 4 > raw.length) throw new Error("quote truncated");
    const value = new DataView(raw.buffer, raw.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    return value;
  };
  const take = (length: number): Uint8Array => {
    if (length < 0 || offset + length > raw.length) throw new Error("quote truncated");
    const value = copy(raw.subarray(offset, offset + length));
    offset += length;
    return value;
  };

  const version = readU16();
  const keyType = readU16();
  const teeType = readU32();
  if (version !== 4 && version !== 5) throw new Error("quote version");
  if (keyType !== 2) throw new Error("quote key type");
  if (teeType !== 0x81) throw new Error("quote TEE type");

  const qeSvn = readU16();
  const pceSvn = readU16();
  const qeVendorId = take(16);
  if (!qeVendorId.every((byte, index) => byte === INTEL_QE_VENDOR[index])) throw new Error("quote vendor");
  const userData = take(20);
  const header = { version, attestationKeyType: keyType, teeType, qeSvn, pceSvn, qeVendorId, userData };

  let bodyType = 2;
  let bodySize = 584;
  if (version === 5) {
    bodyType = readU16();
    bodySize = readU32();
    if (!((bodyType === 2 && bodySize === 584) || (bodyType === 3 && bodySize === 648))) {
      throw new Error("quote body descriptor");
    }
  }

  const bodyStart = offset;
  const td: TdReport = {
    teeTcbSvn: take(16),
    mrSeam: take(48),
    mrSignerSeam: take(48),
    seamAttributes: take(8),
    tdAttributes: take(8),
    xfam: take(8),
    mrTd: take(48),
    mrConfigId: take(48),
    mrOwner: take(48),
    mrOwnerConfig: take(48),
    rtmr: [take(48), take(48), take(48), take(48)],
    reportData: take(64),
  };
  if (bodySize === 648) {
    td.teeTcbSvn2 = take(16);
    td.mrServiceTd = take(48);
  }
  if (offset - bodyStart !== bodySize) throw new Error("quote body size");

  const signed = copy(raw.subarray(0, offset));
  const signatureDataSize = readU32();
  const signatureDataEnd = offset + signatureDataSize;
  if (signatureDataEnd > raw.length) throw new Error("quote truncated");

  const signature = take(64);
  const attestationKey = take(64);
  const certificationType = readU16();
  const certificationSize = readU32();
  if (certificationType !== 6) throw new Error("quote certification type");
  if (offset + certificationSize !== signatureDataEnd) throw new Error("quote certification length");

  const qeReport = take(384);
  const qeSignature = take(64);
  const authDataSize = readU16();
  const qeAuthData = take(authDataSize);
  const nestedType = readU16();
  const nestedSize = readU32();
  if (nestedType !== 5 || nestedSize !== signatureDataEnd - offset) {
    throw new Error("quote nested certification type");
  }
  const pckPem = new TextDecoder().decode(take(nestedSize));
  if (offset !== signatureDataEnd) throw new Error("quote trailing bytes");

  // Producers may pad fixed quote buffers; bytes outside every signed structure must all be zero.
  const trailing = raw.subarray(signatureDataEnd);
  if (trailing.some((byte) => byte !== 0)) throw new Error("quote trailing bytes");

  return {
    version,
    header,
    bodyType,
    bodySize,
    td,
    signed,
    signature,
    attestationKey,
    qeReport,
    qeSignature,
    qeAuthData,
    pckPem,
  };
}
