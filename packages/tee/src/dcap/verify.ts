import { bytesToHex, hexToBytes } from "viem";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseCrl, verifyCrl } from "./crl.ts";
import { INTEL_SGX_ROOT_CA_DER } from "./intel-root.ts";
import { parseTdxQuote, type TdxQuote } from "./quote.ts";
import { equalBytes, parseCert, pemChain, verifyCertSignature, type Cert } from "./x509.ts";
import type { TdxCollateral } from "./collateral.ts";

export class DcapError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DcapError";
  }
}

export interface TdxVerification {
  status: string;
  advisoryIds: string[];
  fmspc: string;
  ca: "platform" | "processor";
  quoteVersion: number;
  td: TdxQuote["td"];
  qe: { isvSvn: number; mrSigner: Uint8Array };
}

type JsonObject = Record<string, unknown>;
type Level = { status: string; advisoryIds: string[] };
type ChainContext = {
  quote: TdxQuote;
  pck: Cert;
  intermediate: Cert;
  root: Cert;
  ca: "platform" | "processor";
};
type VerifiedChainContext = ChainContext & {
  rootCrl: ReturnType<typeof parseCrl>;
  pckCrl: ReturnType<typeof parseCrl>;
};

const fail = (code: string): never => {
  throw new DcapError(code);
};
const decodeHex = (value: string): Uint8Array => {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    return fail("collateral malformed");
  }
  return Uint8Array.from(value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
};
const hex = (value: Uint8Array): string => bytesToHex(value).slice(2).toUpperCase();
const date = (value: unknown): number => {
  if (typeof value !== "string") return fail("collateral malformed");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fail("collateral malformed");
  return parsed / 1000;
};
const isPlainObject = (value: unknown): value is JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function assertSerialNotRevoked(
  serial: bigint,
  crl: ReturnType<typeof parseCrl>,
  code = "certificate revoked",
): void {
  if (crl.revoked.has(serial)) fail(code);
}

function parseSignedObject(text: string, signature: string, key: Uint8Array, code: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("collateral JSON");
  }
  if (!isPlainObject(parsed)) fail("collateral JSON");
  verifySignature(signature, new TextEncoder().encode(text), key, code);
  return parsed as JsonObject;
}

function verifySignature(signature: string, message: Uint8Array, key: Uint8Array, code: string): void {
  try {
    if (!p256.verify(decodeHex(signature), message, key, { lowS: false, prehash: true })) fail(code);
  } catch {
    fail(code);
  }
}

function checkChain(chain: Cert[], rootDer: Uint8Array, now: number): Cert {
  if (chain.length !== 3) fail("certificate chain");
  const root = chain[2]!;
  if (!equalBytes(root.der, rootDer)) fail("untrusted root");
  if (!root.ca) fail("certificate CA");

  for (let index = 0; index < chain.length; index++) {
    const cert = chain[index]!;
    if (now < cert.notBefore || now > cert.notAfter) fail("certificate validity");
    if (index === 0 && cert.ca) fail("certificate CA");
    if (index > 0 && !cert.ca) fail("certificate CA");
    if (index < 2) {
      const issuer = chain[index + 1]!;
      if (!equalBytes(cert.issuerDer, issuer.subjectDer)) fail("certificate issuer");
      if (!verifyCertSignature(cert, issuer.publicKey)) fail("certificate signature");
    }
  }
  if (!verifyCertSignature(root, root.publicKey)) fail("root signature");
  return chain[0]!;
}

function verifyQuoteChain(rawQuote: Uint8Array, now: number, rootDer: Uint8Array): ChainContext {
  const quote = parseTdxQuote(rawQuote);
  const chain = pemChain(quote.pckPem);
  const pck = checkChain(chain, rootDer, now);
  const intermediate = chain[1]!;
  const root = chain[2]!;
  const sgx = pck.sgx;
  if (!sgx || pck.ca) fail("PCK extension");

  let ca: "platform" | "processor";
  if (intermediate.subjectCN === "Intel SGX PCK Platform CA") ca = "platform";
  else if (intermediate.subjectCN === "Intel SGX PCK Processor CA") ca = "processor";
  else return fail("PCK CA");

  return { quote, pck, intermediate, root, ca };
}

function verifyCrls(
  collateral: TdxCollateral,
  context: ChainContext,
  now: number,
  rootDer: Uint8Array,
): VerifiedChainContext {
  const { root, intermediate, pck } = context;
  const rootCrl = parseCrl(hexToBytes(`0x${collateral.root_ca_crl}`));
  if (!verifyCrl(rootCrl, root, now)) fail("root CRL");
  assertSerialNotRevoked(intermediate.serial, rootCrl, "intermediate revoked");

  const pckIssuer = pemChain(collateral.pck_crl_issuer_chain);
  if (pckIssuer.length !== 2) fail("PCK CRL issuer");
  if (!equalBytes(pckIssuer[0]!.der, intermediate.der)) fail("PCK CRL issuer");
  if (!equalBytes(pckIssuer[1]!.der, rootDer)) fail("untrusted root");
  checkTwoCertChain(pckIssuer, rootDer, now);
  const pckCrl = parseCrl(hexToBytes(`0x${collateral.pck_crl}`));
  if (!verifyCrl(pckCrl, intermediate, now)) fail("PCK CRL");
  assertSerialNotRevoked(pck.serial, pckCrl, "PCK revoked");

  return { ...context, rootCrl, pckCrl };
}

function checkTwoCertChain(chain: Cert[], rootDer: Uint8Array, now: number, leafMustNotBeCa = false): Cert {
  if (chain.length !== 2) fail("certificate chain");
  const [leaf, root] = chain as [Cert, Cert];
  if (!equalBytes(root.der, rootDer)) fail("untrusted root");
  if (!root.ca || (leafMustNotBeCa && leaf.ca)) fail("certificate CA");
  for (const cert of chain) {
    if (now < cert.notBefore || now > cert.notAfter) fail("certificate validity");
  }
  if (!equalBytes(leaf.issuerDer, root.subjectDer)) fail("certificate issuer");
  if (!verifyCertSignature(leaf, root.publicKey)) fail("certificate signature");
  if (!verifyCertSignature(root, root.publicKey)) fail("root signature");
  return leaf;
}

function verifyTcbInfo(collateral: TdxCollateral, context: VerifiedChainContext, now: number): JsonObject {
  const chain = pemChain(collateral.tcb_info_issuer_chain);
  if (chain.length !== 2) fail("TCB signer chain");
  const signer = chain[0]!;
  if (signer.subjectCN !== "Intel SGX TCB Signing" || signer.ca) fail("TCB signer CN");
  const leaf = checkTwoCertChain(chain, context.root.der, now, true);
  assertSerialNotRevoked(leaf.serial, context.rootCrl, "TCB signer revoked");
  const tcb = parseSignedObject(collateral.tcb_info, collateral.tcb_info_signature, leaf.publicKey, "TCB signature");
  if (tcb.id !== "TDX" || tcb.version !== 3) fail("TCB schema");
  if (date(tcb.issueDate) > now || date(tcb.nextUpdate) < now) fail("TCB validity");
  const sgx = context.pck.sgx!;
  if (hex(sgx.fmspc) !== String(tcb.fmspc).toUpperCase() || hex(sgx.pceId) !== String(tcb.pceId).toUpperCase()) {
    fail("FMSPC mismatch");
  }
  return tcb;
}

function verifyQeIdentity(collateral: TdxCollateral, context: VerifiedChainContext, now: number): JsonObject {
  const chain = pemChain(collateral.qe_identity_issuer_chain);
  if (chain.length !== 2) fail("QE signer chain");
  const signer = chain[0]!;
  if (signer.subjectCN !== "Intel SGX TCB Signing" || signer.ca) fail("QE signer CN");
  const leaf = checkTwoCertChain(chain, context.root.der, now, true);
  assertSerialNotRevoked(leaf.serial, context.rootCrl, "QE signer revoked");
  const qe = parseSignedObject(
    collateral.qe_identity,
    collateral.qe_identity_signature,
    leaf.publicKey,
    "QE identity signature",
  );
  if (qe.id !== "TD_QE" || qe.version !== 2) fail("QE schema");
  if (date(qe.issueDate) > now || date(qe.nextUpdate) < now) fail("QE validity");
  return qe;
}

function verifyQuoteSignature(context: ChainContext): void {
  const quote = context.quote;
  const publicKey = Uint8Array.from([4, ...quote.attestationKey]);
  if (!p256.verify(quote.signature, quote.signed, publicKey, { lowS: false, prehash: true })) fail("quote signature");
}

function verifyQeReport(
  quote: TdxQuote,
  qe: JsonObject,
  pck: Cert,
): { isvSvn: number; mrSigner: Uint8Array; status: Level } {
  const report = quote.qeReport;
  const view = new DataView(report.buffer, report.byteOffset, report.byteLength);
  const qeIsvSvn = view.getUint16(258, true);
  const qeMrSigner = report.slice(128, 160);
  const misc = view.getUint32(16, true) >>> 0;
  const attributes = report.slice(48, 64);
  const miscMask = parseU32Hex(qe.miscselectMask);
  const expectedMisc = parseU32Hex(qe.miscselect);
  if (hex(qeMrSigner) !== String(qe.mrsigner).toUpperCase()) fail("QE identity mismatch");
  if (view.getUint16(256, true) !== qe.isvprodid) fail("QE identity mismatch");
  if (((misc & miscMask) >>> 0) !== expectedMisc) fail("QE identity mismatch");
  const attributeMask = decodeHex(String(qe.attributesMask));
  const expectedAttributes = decodeHex(String(qe.attributes));
  if (attributeMask.length !== 16 || expectedAttributes.length !== 16) fail("QE identity malformed");
  for (let index = 0; index < 16; index++) {
    if ((attributes[index]! & attributeMask[index]!) !== expectedAttributes[index]) fail("QE identity mismatch");
  }
  if (!p256.verify(quote.qeSignature, report, pck.publicKey, { lowS: false, prehash: true })) {
    fail("QE report signature");
  }
  const bound = sha256(Uint8Array.from([...quote.attestationKey, ...quote.qeAuthData]));
  if (!equalBytes(bound, report.slice(320, 352)) || report.slice(352).some((byte) => byte !== 0)) {
    fail("QE report data");
  }

  const levels = objectArray(qe.tcbLevels, "QE TCB malformed");
  const qeLevel = levels.find((level) => nestedNumber(level, "tcb", "isvsvn") <= qeIsvSvn);
  if (!qeLevel) fail("QE TCB not supported");
  return { isvSvn: qeIsvSvn, mrSigner: qeMrSigner, status: levelStatus(qeLevel) };
}

function verifyPlatformTcb(tcb: JsonObject, context: ChainContext): Level {
  const levels = objectArray(tcb.tcbLevels, "TCB info malformed");
  const sgxComponents = context.pck.sgx!.tcb.compSvn;
  for (const level of levels) {
    const tcbLevel = asObject(level.tcb, "TCB info malformed");
    const sgx = objectArray(tcbLevel.sgxtcbcomponents, "TCB info malformed");
    const tdx = objectArray(tcbLevel.tdxtcbcomponents, "TCB info malformed");
    if (sgx.length !== 16 || tdx.length !== 16) fail("TCB info malformed");
    nestedNumber(tcbLevel, "", "pcesvn");
    for (const component of [...sgx, ...tdx]) nestedNumber(component, "", "svn");
  }
  const matches = levels.find((level) => {
    const tcbLevel = asObject(level.tcb, "TCB info malformed");
    const sgx = objectArray(tcbLevel.sgxtcbcomponents, "TCB info malformed");
    const tdx = objectArray(tcbLevel.tdxtcbcomponents, "TCB info malformed");
    if (sgx.length !== 16 || tdx.length !== 16) fail("TCB info malformed");
    if (Number(tcbLevel.pcesvn) > context.pck.sgx!.tcb.pceSvn) return false;
    if (!sgx.every((component, index) => nestedNumber(component, "", "svn") <= sgxComponents[index]!)) return false;
    return tdx.every((component, index) => nestedNumber(component, "", "svn") <= context.quote.td.teeTcbSvn[index]!);
  });
  if (!matches) fail("TCB not supported");
  return levelStatus(matches);
}

function verifyModuleIdentity(tcb: JsonObject, context: ChainContext): Level {
  const module = asObject(tcb.tdxModule, "TCB info malformed");
  const defaultIdentity = parseModuleIdentity(module);
  const moduleSvn = context.quote.td.teeTcbSvn[1]!;
  const identities = tcb.tdxModuleIdentities;
  if (moduleSvn === 0 || !Array.isArray(identities) || identities.length === 0) {
    checkModuleMeasurements(context.quote, defaultIdentity);
    return level("UpToDate", []);
  }

  const expectedId = `TDX_${moduleSvn.toString(16).padStart(2, "0")}`;
  const identity = identities.find((candidate: unknown) => isPlainObject(candidate)
    && typeof candidate.id === "string" && candidate.id.toUpperCase() === expectedId.toUpperCase());
  if (!identity || !isPlainObject(identity)) fail("TDX module identity not supported");
  const identityExpected = parseModuleIdentity(identity);
  checkModuleMeasurements(context.quote, identityExpected);
  const moduleLevels = objectArray(identity.tcbLevels, "TCB info malformed");
  const match = moduleLevels.find(
    (candidate) => nestedNumber(candidate, "tcb", "isvsvn") <= context.quote.td.teeTcbSvn[0]!,
  );
  if (!match) fail("TDX module TCB not supported");
  return levelStatus(match);
}

type ModuleIdentity = { signer: Uint8Array; attributes: Uint8Array; mask: Uint8Array };
function parseModuleIdentity(identity: JsonObject): ModuleIdentity {
  const signer = decodeHex(String(identity.mrsigner));
  const attributes = decodeHex(String(identity.attributes));
  const mask = decodeHex(String(identity.attributesMask));
  if (signer.length !== 48 || attributes.length !== 8 || mask.length !== 8) fail("TDX module identity malformed");
  return { signer, attributes, mask };
}

function checkModuleMeasurements(quote: TdxQuote, expected: ModuleIdentity): void {
  if (!equalBytes(quote.td.mrSignerSeam, expected.signer)) fail("TDX module identity");
  for (let index = 0; index < 8; index++) {
    const actual = quote.td.seamAttributes[index]!;
    const mask = expected.mask[index]!;
    if ((actual & mask) !== (expected.attributes[index]! & mask) || (actual & (~mask & 0xff)) !== 0) {
      fail("TDX module identity");
    }
  }
}

function mergeStatuses(platform: Level, module: Level, qe: Level): Level {
  const status = convergeTcbStatus(convergeTcbStatus(platform.status, module.status), qe.status);
  const advisoryIds = [...new Set([...platform.advisoryIds, ...module.advisoryIds, ...qe.advisoryIds])].sort();
  return { status, advisoryIds };
}

const statusSeverity = new Map([
  ["UpToDate", 0],
  ["SWHardeningNeeded", 1],
  ["ConfigurationNeeded", 2],
  ["ConfigurationAndSWHardeningNeeded", 3],
  ["OutOfDate", 4],
  ["OutOfDateConfigurationNeeded", 5],
  ["Revoked", 6],
]);

export function convergeTcbStatus(platform: string, component: string): string {
  const platformSeverity = statusSeverity.get(platform);
  const componentSeverity = statusSeverity.get(component);
  if (platformSeverity === undefined || componentSeverity === undefined) return fail("unknown TCB status");
  if (
    component === "OutOfDate"
    && (platform === "ConfigurationNeeded" || platform === "ConfigurationAndSWHardeningNeeded")
  ) {
    return "OutOfDateConfigurationNeeded";
  }
  return platformSeverity >= componentSeverity ? platform : component;
}

function level(status: string, advisoryIds: string[]): Level {
  if (!statusSeverity.has(status)) fail("unknown TCB status");
  return { status, advisoryIds };
}

function levelStatus(value: unknown): Level {
  const levelValue = asObject(value, "TCB info malformed");
  const advisoryIds = Array.isArray(levelValue.advisoryIDs) ? levelValue.advisoryIDs.map(String) : [];
  return level(String(levelValue.tcbStatus), advisoryIds);
}

function asObject(value: unknown, code: string): JsonObject {
  if (!isPlainObject(value)) return fail(code);
  return value as JsonObject;
}

function objectArray(value: unknown, code: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isPlainObject(entry))) fail(code);
  return value as JsonObject[];
}

function nestedNumber(value: JsonObject, outer: string, inner: string): number {
  const target = outer === "" ? value : asObject(value[outer], "TCB info malformed");
  const number = Number(target[inner]);
  if (!Number.isSafeInteger(number) || number < 0) fail("TCB info malformed");
  return number;
}

function parseU32Hex(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9a-f]{1,8}$/i.test(value)) return fail("QE identity malformed");
  return Number.parseInt(value, 16) >>> 0;
}

/** Verify the quote chain, collateral signatures, QE evidence, and Intel TCB levels. */
export function verifyTdxQuote(
  rawQuote: Uint8Array,
  collateral: TdxCollateral,
  now: number,
  options: { trustedRootDer?: Uint8Array } = {},
): TdxVerification {
  try {
    const rootDer = options.trustedRootDer ?? INTEL_SGX_ROOT_CA_DER;
    // Intel's quote verification starts by authenticating the quote PCK chain and revocation lists.
    const quoteContext = verifyQuoteChain(rawQuote, now, rootDer);
    const context = verifyCrls(collateral, quoteContext, now, rootDer);
    // Intel's TCB info and QE identity signatures cover their complete supplied body text.
    const tcb = verifyTcbInfo(collateral, context, now);
    const qeIdentity = verifyQeIdentity(collateral, context, now);
    // Intel authenticates the QE report and binds its report data to the quote key and auth data.
    const qe = verifyQeReport(context.quote, qeIdentity, context.pck);
    verifyQuoteSignature(context);
    // Intel platform TCB levels compare every component SVN and PCESVN against the PCK values.
    const platform = verifyPlatformTcb(tcb, context);
    // Intel TDX module identity can add a separate status when module SVN2 is nonzero.
    const module = verifyModuleIdentity(tcb, context);
    // Intel converges platform, module, and QE statuses in that order.
    const merged = mergeStatuses(platform, module, qe.status);
    return {
      status: merged.status,
      advisoryIds: merged.advisoryIds,
      fmspc: hex(context.pck.sgx!.fmspc),
      ca: context.ca,
      quoteVersion: context.quote.version,
      td: context.quote.td,
      qe: { isvSvn: qe.isvSvn, mrSigner: qe.mrSigner },
    };
  } catch (error) {
    if (error instanceof DcapError) throw error;
    throw new DcapError(error instanceof Error ? error.message : "invalid quote");
  }
}
