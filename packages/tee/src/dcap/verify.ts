import { bytesToHex, hexToBytes } from "viem";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseCrl, verifyCrl, type ParsedCrl } from "./crl.ts";
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
/** A TCB status with the advisory IDs Intel lists for it. */
export type TcbLevelStatus = { status: string; advisoryIds: string[] };
type Level = TcbLevelStatus;
type ChainContext = {
  quote: TdxQuote;
  pck: Cert;
  intermediate: Cert;
  root: Cert;
  ca: "platform" | "processor";
};
/** Quote evidence authenticated without any Intel collateral; `fmspc` comes from the Intel-signed PCK certificate. */
export interface TdxQuoteEvidence extends ChainContext {
  fmspc: string;
}
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

/**
 * Clock-independent checks of the quote's PCK chain (PCK leaf, Intel platform/processor CA, root) against the pinned
 * Intel root: shape, CA flags, issuer linkage and every signature. Certificate validity windows are checked separately
 * and last, so a chain that is forged and also out of date is still reported as forged.
 */
function checkPckChainSignatures(chain: Cert[], rootDer: Uint8Array): [Cert, Cert, Cert] {
  if (chain.length !== 3) fail("PCK chain");
  const [pck, intermediate, root] = chain as [Cert, Cert, Cert];
  if (!equalBytes(root.der, rootDer)) fail("PCK untrusted root");
  if (pck.ca || !intermediate.ca || !root.ca) fail("PCK certificate CA");
  if (!equalBytes(pck.issuerDer, intermediate.subjectDer) || !equalBytes(intermediate.issuerDer, root.subjectDer)) {
    fail("PCK certificate issuer");
  }
  if (!verifyCertSignature(pck, intermediate.publicKey) || !verifyCertSignature(intermediate, root.publicKey)) {
    fail("PCK certificate signature");
  }
  if (!verifyCertSignature(root, root.publicKey)) fail("PCK root signature");
  return [pck, intermediate, root];
}

/**
 * Authenticate everything in a TDX quote that needs no Intel collateral, in this order: the PCK chain to the pinned
 * Intel root, the QE report signature by the chain's leaf key, the QE report data binding of the attestation key, the
 * quote signature by that key, then the leaf's SGX extension and the CA name and, last, the PCK chain validity windows.
 *
 * The chain and the signatures are fixed by Intel, so their failures are positive evidence that the quote is not what a
 * genuine Intel QE produced. The extension and CA-name checks come after the signatures: a quote reaches them only
 * through an Intel-issued chain whose leaf key signed the QE report, so "PCK CA" (an Intel CA name this code does not
 * know yet) is a support gap, not forgery. "PCK certificate validity" (clock-dependent) and quote parse errors are not
 * forgery either. Callers run this before fetching collateral, so the FMSPC used to fetch it is Intel-signed rather
 * than attacker-chosen.
 */
export function verifyTdxQuoteEvidence(
  rawQuote: Uint8Array,
  now: number,
  options: { trustedRootDer?: Uint8Array } = {},
): TdxQuoteEvidence {
  try {
    const rootDer = options.trustedRootDer ?? INTEL_SGX_ROOT_CA_DER;
    const quote = parseTdxQuote(rawQuote);
    const chain = pemChain(quote.pckPem);
    const [pck, intermediate, root] = checkPckChainSignatures(chain, rootDer);
    // Intel authenticates the QE report with the PCK key and binds its report data to the quote key and auth data.
    verifyQeReportSignature(quote, pck);
    verifyQuoteSignature(quote);

    const sgx = pck.sgx;
    if (!sgx) return fail("PCK extension");
    let ca: "platform" | "processor";
    if (intermediate.subjectCN === "Intel SGX PCK Platform CA") ca = "platform";
    else if (intermediate.subjectCN === "Intel SGX PCK Processor CA") ca = "processor";
    else return fail("PCK CA");

    for (const cert of chain) if (now < cert.notBefore || now > cert.notAfter) fail("PCK certificate validity");
    return { quote, pck, intermediate, root, ca, fmspc: hex(sgx.fmspc) };
  } catch (error) {
    if (error instanceof DcapError) throw error;
    throw new DcapError(error instanceof Error ? error.message : "invalid quote");
  }
}

function verifyCrls(
  collateral: TdxCollateral,
  context: ChainContext,
  now: number,
  rootDer: Uint8Array,
  graceSec: number,
): VerifiedChainContext {
  const { root, intermediate, pck } = context;
  const rootCrl = parseCrl(hexToBytes(`0x${collateral.root_ca_crl}`));
  if (!verifyCrl(rootCrl, root, now, graceSec)) fail("root CRL");
  assertSerialNotRevoked(intermediate.serial, rootCrl, "intermediate revoked");

  const pckIssuer = pemChain(collateral.pck_crl_issuer_chain);
  if (pckIssuer.length !== 2) fail("PCK CRL issuer");
  if (!equalBytes(pckIssuer[0]!.der, intermediate.der)) fail("PCK CRL issuer");
  if (!equalBytes(pckIssuer[1]!.der, rootDer)) fail("untrusted root");
  checkTwoCertChain(pckIssuer, rootDer, now);
  const pckCrl = parseCrl(hexToBytes(`0x${collateral.pck_crl}`));
  if (!verifyCrl(pckCrl, intermediate, now, graceSec)) fail("PCK CRL");
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

/** Clock-independent check of a [leaf, root] chain anchored in the pinned root. Returns the leaf. */
function checkTwoCertChainSignatures(chain: Cert[], rootDer: Uint8Array, leafMustNotBeCa: boolean): Cert {
  if (chain.length !== 2) fail("certificate chain");
  const [leaf, root] = chain as [Cert, Cert];
  if (!equalBytes(root.der, rootDer)) fail("untrusted root");
  if (!root.ca || (leafMustNotBeCa && leaf.ca)) fail("certificate CA");
  if (!equalBytes(leaf.issuerDer, root.subjectDer)) fail("certificate issuer");
  if (!verifyCertSignature(leaf, root.publicKey)) fail("certificate signature");
  if (!verifyCertSignature(root, root.publicKey)) fail("root signature");
  return leaf;
}

function crlSignedBy(crl: ParsedCrl, issuer: Cert): boolean {
  try {
    return equalBytes(crl.issuerDer, issuer.subjectDer)
      && p256.verify(crl.signature, crl.tbs, issuer.publicKey, { lowS: false, prehash: true, format: "der" });
  } catch {
    return false;
  }
}

function tcbSigningLeaf(chainPem: string, rootDer: Uint8Array, kind: "TCB" | "QE"): Cert {
  const chain = pemChain(chainPem);
  if (chain.length !== 2) fail(`${kind} signer chain`);
  if (chain[0]!.subjectCN !== "Intel SGX TCB Signing" || chain[0]!.ca) fail(`${kind} signer CN`);
  return checkTwoCertChainSignatures(chain, rootDer, true);
}

const PCK_CA_NAMES = { platform: "Intel SGX PCK Platform CA", processor: "Intel SGX PCK Processor CA" } as const;
export type CollateralComponent = "tcb" | "qe" | "pckCrl" | "rootCrl";
export const COLLATERAL_COMPONENTS: readonly CollateralComponent[] = ["tcb", "qe", "pckCrl", "rootCrl"];

/**
 * Authenticate one component of a collateral set for an FMSPC and PCK CA without a quote and without the clock:
 * - tcb: TCB info signed by Intel's TCB Signing certificate under the pinned root, schema TDX v3, for this FMSPC;
 * - qe: QE identity signed the same way, schema TD_QE v2;
 * - pckCrl: PCK CRL signed by the Intel PCK CA named by `ca`, whose certificate chains to the pinned root;
 * - rootCrl: root CA CRL signed by the pinned root.
 * Validity windows and revocations are left to verifyTdxQuote. A collateral cache runs this before trusting anything
 * it stores or loads (in particular nextUpdate, which comes from these bodies). Throws DcapError.
 */
export function verifyCollateralComponent(
  component: CollateralComponent,
  collateral: Partial<TdxCollateral>,
  target: { fmspc: string; ca: "platform" | "processor" },
  options: { trustedRootDer?: Uint8Array } = {},
): void {
  try {
    const rootDer = options.trustedRootDer ?? INTEL_SGX_ROOT_CA_DER;
    const field = (name: keyof TdxCollateral): string => {
      const value = collateral[name];
      return typeof value === "string" ? value : fail("collateral malformed");
    };
    if (component === "rootCrl") {
      if (!crlSignedBy(parseCrl(decodeHex(field("root_ca_crl"))), parseCert(rootDer))) fail("root CRL");
    } else if (component === "pckCrl") {
      const chain = pemChain(field("pck_crl_issuer_chain"));
      if (chain.length !== 2) fail("PCK CRL issuer");
      const issuer = checkTwoCertChainSignatures(chain, rootDer, false);
      if (!issuer.ca || issuer.subjectCN !== PCK_CA_NAMES[target.ca]) fail("PCK CRL issuer");
      if (!crlSignedBy(parseCrl(decodeHex(field("pck_crl"))), issuer)) fail("PCK CRL");
    } else if (component === "tcb") {
      const leaf = tcbSigningLeaf(field("tcb_info_issuer_chain"), rootDer, "TCB");
      const tcb = parseSignedObject(field("tcb_info"), field("tcb_info_signature"), leaf.publicKey, "TCB signature");
      if (tcb.id !== "TDX" || tcb.version !== 3) fail("TCB schema");
      date(tcb.issueDate);
      date(tcb.nextUpdate);
      if (String(tcb.fmspc).toUpperCase() !== target.fmspc.toUpperCase()) fail("FMSPC mismatch");
    } else {
      const leaf = tcbSigningLeaf(field("qe_identity_issuer_chain"), rootDer, "QE");
      const qe = parseSignedObject(field("qe_identity"), field("qe_identity_signature"), leaf.publicKey, "QE identity signature");
      if (qe.id !== "TD_QE" || qe.version !== 2) fail("QE schema");
      date(qe.issueDate);
      date(qe.nextUpdate);
    }
  } catch (error) {
    if (error instanceof DcapError) throw error;
    throw new DcapError(error instanceof Error ? error.message : "collateral malformed");
  }
}

/** verifyCollateralComponent for all four components of a complete collateral set. */
export function verifyCollateralSignatures(
  collateral: TdxCollateral,
  target: { fmspc: string; ca: "platform" | "processor" },
  options: { trustedRootDer?: Uint8Array } = {},
): void {
  for (const component of COLLATERAL_COMPONENTS) verifyCollateralComponent(component, collateral, target, options);
}

/**
 * verifyTdxQuote codes that blame the collateral itself (signatures, issuer chains, schema, shape, validity windows)
 * rather than the quote or a revocation. A collateral source can drop such a copy and fetch it again.
 */
const COLLATERAL_INTEGRITY_CODES: ReadonlySet<string> = new Set([
  "root CRL", "PCK CRL", "PCK CRL issuer", "untrusted root", "certificate chain", "certificate CA", "certificate validity",
  "certificate issuer", "certificate signature", "root signature", "TCB signer chain", "TCB signer CN", "TCB signature",
  "TCB schema", "TCB validity", "FMSPC mismatch", "QE signer chain", "QE signer CN", "QE identity signature", "QE schema",
  "QE validity", "QE identity malformed", "QE TCB malformed", "TCB info malformed", "TDX module identity malformed",
  "collateral JSON", "collateral malformed", "CRL malformed", "CRL algorithm", "X509 malformed PEM chain",
]);

export function isCollateralIntegrityFailure(code: string): boolean {
  return COLLATERAL_INTEGRITY_CODES.has(code);
}

function verifyTcbInfo(collateral: TdxCollateral, context: VerifiedChainContext, now: number, graceSec: number): JsonObject {
  const chain = pemChain(collateral.tcb_info_issuer_chain);
  if (chain.length !== 2) fail("TCB signer chain");
  const signer = chain[0]!;
  if (signer.subjectCN !== "Intel SGX TCB Signing" || signer.ca) fail("TCB signer CN");
  const leaf = checkTwoCertChain(chain, context.root.der, now, true);
  assertSerialNotRevoked(leaf.serial, context.rootCrl, "TCB signer revoked");
  const tcb = parseSignedObject(collateral.tcb_info, collateral.tcb_info_signature, leaf.publicKey, "TCB signature");
  if (tcb.id !== "TDX" || tcb.version !== 3) fail("TCB schema");
  if (date(tcb.issueDate) > now || date(tcb.nextUpdate) + graceSec < now) fail("TCB validity");
  const sgx = context.pck.sgx!;
  if (hex(sgx.fmspc) !== String(tcb.fmspc).toUpperCase() || hex(sgx.pceId) !== String(tcb.pceId).toUpperCase()) {
    fail("FMSPC mismatch");
  }
  return tcb;
}

function verifyQeIdentity(collateral: TdxCollateral, context: VerifiedChainContext, now: number, graceSec: number): JsonObject {
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
  if (date(qe.issueDate) > now || date(qe.nextUpdate) + graceSec < now) fail("QE validity");
  return qe;
}

function verifyQuoteSignature(quote: TdxQuote): void {
  const publicKey = Uint8Array.from([4, ...quote.attestationKey]);
  if (!p256.verify(quote.signature, quote.signed, publicKey, { lowS: false, prehash: true })) fail("quote signature");
}

function verifyQeReportSignature(quote: TdxQuote, pck: Cert): void {
  const report = quote.qeReport;
  if (!p256.verify(quote.qeSignature, report, pck.publicKey, { lowS: false, prehash: true })) {
    fail("QE report signature");
  }
  const bound = sha256(Uint8Array.from([...quote.attestationKey, ...quote.qeAuthData]));
  if (!equalBytes(bound, report.slice(320, 352)) || report.slice(352).some((byte) => byte !== 0)) {
    fail("QE report data");
  }
}

function verifyQeIdentityMatch(quote: TdxQuote, qe: JsonObject): { isvSvn: number; mrSigner: Uint8Array; status: Level } {
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

  const levels = objectArray(qe.tcbLevels, "QE TCB malformed");
  const qeLevel = levels.find((level) => nestedNumber(level, "tcb", "isvsvn") <= qeIsvSvn);
  if (!qeLevel) fail("QE TCB not supported");
  return { isvSvn: qeIsvSvn, mrSigner: qeMrSigner, status: levelStatus(qeLevel, QE_STATUSES) };
}

/** Status values Intel's QVL (EvaluateTcb.cpp) accepts for each kind of TCB level; any other value fails. */
const TCB_INFO_STATUSES: ReadonlySet<string> = new Set([
  "UpToDate", "OutOfDate", "ConfigurationNeeded", "Revoked", "OutOfDateConfigurationNeeded", "SWHardeningNeeded",
  "ConfigurationAndSWHardeningNeeded",
]);
const QE_STATUSES: ReadonlySet<string> = new Set(["UpToDate", "OutOfDate", "ConfigurationNeeded", "Revoked", "OutOfDateConfigurationNeeded"]);
const TDX_MODULE_STATUSES: ReadonlySet<string> = new Set(["UpToDate", "OutOfDate", "Revoked"]);
/** TEE_TCB_SVN byte 1 is the TDX module major version, byte 0 its minor SVN (Intel TDX_MODULE_MAJOR/MINOR_SVN_INDEX). */
const TDX_MODULE_MAJOR = 1;
const TDX_MODULE_MINOR = 0;

/** The tdxModuleIdentities entry `TDX_<major as two hex digits>` (Intel findTdxModuleIdentity), if any. */
function findModuleIdentity(tcb: JsonObject, major: number): JsonObject | undefined {
  const identities = tcb.tdxModuleIdentities;
  if (!Array.isArray(identities)) return undefined;
  const expectedId = `TDX_${major.toString(16).padStart(2, "0")}`.toUpperCase();
  const identity = identities.find((candidate: unknown) => isPlainObject(candidate)
    && typeof candidate.id === "string" && candidate.id.toUpperCase() === expectedId);
  return identity === undefined ? undefined : asObject(identity, "TCB info malformed");
}

/**
 * Intel QVL QuoteVerifier 4.1.2.5.12: the TD report's MRSIGNERSEAM and SEAMATTRIBUTES must match the TDX module
 * identity for the module major version in TEE_TCB_SVN (the default tdxModule when it is 0).
 */
function verifyModuleIdentity(tcb: JsonObject, quote: TdxQuote): void {
  const major = quote.td.teeTcbSvn[TDX_MODULE_MAJOR]!;
  let expected = parseModuleIdentity(asObject(tcb.tdxModule, "TCB info malformed"));
  if (major > 0) {
    const identity = findModuleIdentity(tcb, major);
    if (!identity) fail("TDX module identity not supported");
    expected = parseModuleIdentity(identity!);
  }
  checkModuleMeasurements(quote, expected);
}

export interface TdxTcbInput {
  /** The 16 SGX TCB component SVNs and the PCESVN from the PCK certificate. */
  sgxTcbComponents: readonly number[];
  pceSvn: number;
  /** The QE's status and advisories from the QE identity TCB level matching its ISVSVN. */
  qe: TcbLevelStatus;
}

/**
 * Intel QVL tdxEvaluateTCB (EvaluateTcb.cpp, 4.1.2.5.2) for one TEE_TCB_SVN, exactly:
 * - the platform level is the first TCB level whose SGX components and PCESVN are all at most the PCK's and whose TDX
 *   components are at most TEE_TCB_SVN's, comparing from index 2 when the TDX module major version (byte 1) is above
 *   0 (bytes 0 and 1 are then rated by the module identity instead), else from index 0;
 * - when the module major version is above 0, the module identity `TDX_<major>` must exist and its first TCB level
 *   whose ISVSVN is at most the module minor SVN (byte 0) adds a component status (UpToDate, OutOfDate or Revoked);
 * - the QE status is the last component; statuses converge as in convergeTcbStatuses, advisories are merged.
 */
export function evaluateTdxTcb(tcb: Record<string, unknown>, input: TdxTcbInput, teeTcbSvn: Uint8Array): TcbLevelStatus {
  const levels = objectArray(tcb.tcbLevels, "TCB info malformed");
  const parsed = levels.map((level) => {
    const tcbLevel = asObject(level.tcb, "TCB info malformed");
    const sgx = objectArray(tcbLevel.sgxtcbcomponents, "TCB info malformed").map((component) => nestedNumber(component, "", "svn"));
    const tdx = objectArray(tcbLevel.tdxtcbcomponents, "TCB info malformed").map((component) => nestedNumber(component, "", "svn"));
    if (sgx.length !== 16 || tdx.length !== 16) fail("TCB info malformed");
    return { level, sgx, tdx, pceSvn: nestedNumber(tcbLevel, "", "pcesvn") };
  });
  if (input.sgxTcbComponents.length !== 16 || teeTcbSvn.length !== 16) fail("TCB info malformed");
  const major = teeTcbSvn[TDX_MODULE_MAJOR]!;
  const startIndex = major > 0 ? 2 : 0;
  const match = parsed.find((candidate) => candidate.sgx.every((svn, index) => input.sgxTcbComponents[index]! >= svn)
    && input.pceSvn >= candidate.pceSvn
    && candidate.tdx.every((svn, index) => index < startIndex || teeTcbSvn[index]! >= svn));
  if (!match) fail("TCB not supported");
  const platform = levelStatus(match!.level, TCB_INFO_STATUSES);

  const components: Level[] = [];
  if (major > 0) {
    const identity = findModuleIdentity(tcb, major);
    if (!identity) fail("TDX module identity not supported");
    const moduleLevel = objectArray(identity!.tcbLevels, "TCB info malformed")
      .find((candidate) => teeTcbSvn[TDX_MODULE_MINOR]! >= nestedNumber(candidate, "tcb", "isvsvn"));
    if (!moduleLevel) fail("TDX module TCB not supported");
    components.push(levelStatus(moduleLevel, TDX_MODULE_STATUSES));
  }
  components.push(input.qe);
  return {
    status: convergeTcbStatuses(platform.status, components.map((component) => component.status)),
    advisoryIds: mergeAdvisories(platform, ...components),
  };
}

/**
 * Intel QVL checkTcbLevel (TcbLevelCheck.cpp, 4.1.2.5.19-20): evaluate TEE_TCB_SVN; for a TD 1.5 body (v5 quote,
 * body type 3) also evaluate TEE_TCB_SVN2, which reflects the TDX module now running, and advise a relaunch when the
 * module the TD launched under is out of date but the current one is not (checkForRelaunch). The status is the launch
 * status after that adjustment; the advisories are those of both evaluations.
 */
export function evaluateTdxQuoteTcb(
  tcb: Record<string, unknown>,
  input: TdxTcbInput,
  td: { teeTcbSvn: Uint8Array; teeTcbSvn2?: Uint8Array },
  bodyType: number,
): TcbLevelStatus {
  const launch = evaluateTdxTcb(tcb, input, td.teeTcbSvn);
  if (bodyType < 3) return launch;
  if (!td.teeTcbSvn2) fail("TCB info malformed");
  const current = evaluateTdxTcb(tcb, input, td.teeTcbSvn2!);
  return { status: checkForRelaunch(launch.status, current.status), advisoryIds: mergeAdvisories(launch, current) };
}

/**
 * Intel QVL convergeTcbStatuses (EvaluateTcb.cpp): the platform status, except that any OutOfDate component turns
 * UpToDate or SWHardeningNeeded into OutOfDate and ConfigurationNeeded or ConfigurationAndSWHardeningNeeded into
 * OutOfDateConfigurationNeeded, and any Revoked component makes the result Revoked. Other component statuses do not
 * change the platform status.
 */
export function convergeTcbStatuses(platform: string, components: readonly string[]): string {
  if (!TCB_INFO_STATUSES.has(platform) || components.some((status) => !TCB_INFO_STATUSES.has(status))) fail("unknown TCB status");
  let status = platform;
  if (components.includes("OutOfDate")) {
    if (platform === "UpToDate" || platform === "SWHardeningNeeded") status = "OutOfDate";
    if (platform === "ConfigurationNeeded" || platform === "ConfigurationAndSWHardeningNeeded") status = "OutOfDateConfigurationNeeded";
  }
  if (components.includes("Revoked")) status = "Revoked";
  return status;
}

/** convergeTcbStatuses for a single component status. */
export function convergeTcbStatus(platform: string, component: string): string {
  return convergeTcbStatuses(platform, [component]);
}

const CONFIGURATION_NEEDED: ReadonlySet<string> = new Set([
  "ConfigurationNeeded", "OutOfDateConfigurationNeeded", "ConfigurationAndSWHardeningNeeded", "TDRelaunchAdvisedConfigurationNeeded",
]);

/** Intel QVL checkForRelaunch (TDRelaunchCheck.cpp). */
export function checkForRelaunch(launch: string, current: string): string {
  if ((launch === "OutOfDate" || launch === "OutOfDateConfigurationNeeded")
    && ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"].includes(current)) {
    return CONFIGURATION_NEEDED.has(launch) || CONFIGURATION_NEEDED.has(current)
      ? "TDRelaunchAdvisedConfigurationNeeded"
      : "TDRelaunchAdvised";
  }
  return launch;
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

function mergeAdvisories(...levels: Level[]): string[] {
  return [...new Set(levels.flatMap((level) => level.advisoryIds))].sort();
}

function levelStatus(value: unknown, allowed: ReadonlySet<string>): Level {
  const levelValue = asObject(value, "TCB info malformed");
  const status = String(levelValue.tcbStatus);
  if (!allowed.has(status)) fail("unknown TCB status");
  const advisoryIds = Array.isArray(levelValue.advisoryIDs) ? levelValue.advisoryIDs.map(String) : [];
  return { status, advisoryIds };
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

/**
 * Verify the quote evidence, collateral signatures, QE identity and Intel TCB levels. `collateralGraceSec` (default 0)
 * accepts TCB info, QE identity and CRLs up to that long past their nextUpdate; only a collateral source serving a cached
 * copy through a PCS outage sets it (see PcsCollateralSource and staleCollateralGraceSec).
 */
export function verifyTdxQuote(
  rawQuote: Uint8Array,
  collateral: TdxCollateral,
  now: number,
  options: { trustedRootDer?: Uint8Array; collateralGraceSec?: number } = {},
): TdxVerification {
  try {
    const rootDer = options.trustedRootDer ?? INTEL_SGX_ROOT_CA_DER;
    const graceSec = Number.isFinite(options.collateralGraceSec) ? Math.max(0, options.collateralGraceSec!) : 0;
    // Intel's quote verification starts by authenticating the PCK chain, the QE report and the quote signature.
    const evidence = verifyTdxQuoteEvidence(rawQuote, now, { trustedRootDer: rootDer });
    const context = verifyCrls(collateral, evidence, now, rootDer, graceSec);
    // Intel's TCB info and QE identity signatures cover their complete supplied body text.
    const tcb = verifyTcbInfo(collateral, context, now, graceSec);
    const qeIdentity = verifyQeIdentity(collateral, context, now, graceSec);
    const qe = verifyQeIdentityMatch(context.quote, qeIdentity);
    // Intel checks the TDX module identity (MRSIGNERSEAM, SEAMATTRIBUTES) before rating TCB levels.
    verifyModuleIdentity(tcb, context.quote);
    // Intel's TCB levels: platform (SGX components, PCESVN, TDX components), TDX module and QE; a TD 1.5 body also rates
    // TEE_TCB_SVN2 and may be advised to relaunch.
    const sgx = context.pck.sgx!.tcb;
    const merged = evaluateTdxQuoteTcb(tcb, { sgxTcbComponents: sgx.compSvn, pceSvn: sgx.pceSvn, qe: qe.status }, context.quote.td, context.quote.bodyType);
    return {
      status: merged.status,
      advisoryIds: merged.advisoryIds,
      fmspc: evidence.fmspc,
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
