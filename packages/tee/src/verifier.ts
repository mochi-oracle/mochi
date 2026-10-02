import { decodeAbiParameters, encodeAbiParameters, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import type { Quote } from "./provider.ts";
import { hexToBytes } from "viem";
import { dstackConfigMeasurement, parseTdxReportData, tdxMeasurement } from "./tdx-common.ts";
import { verifyTdxQuote, verifyTdxQuoteEvidence, type TdxQuoteEvidence, type TdxVerification } from "./dcap/verify.ts";
import { staleCollateralGraceSec, type CollateralSource } from "./dcap/collateral.ts";
export type TcbStatus = string;

export interface QuoteVerifier {
  verify(quote: Quote, expected?: { measurement?: Hex; reportData?: Hex; maxAgeSec?: number; signal?: AbortSignal }): Promise<{ ok: boolean; reason?: string; measurement?: Hex; reportData?: Hex }>;
}
export class MockQuoteVerifier implements QuoteVerifier {
  constructor(private readonly options: { mockRootAddress: Address }) {}
  async verify(quote: Quote, expected: { measurement?: Hex; reportData?: Hex; maxAgeSec?: number; signal?: AbortSignal } = {}) {
    try {
      if (quote.kind !== "mock") return { ok: false, reason: "wrong quote kind" };
      const [tag, measurement, reportData, issuedAtBig, rootSig] = decodeAbiParameters(
        [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], quote.raw,
      );
      if (tag !== "MOCHI_MOCK_QUOTE_V1") return { ok: false, reason: "invalid quote tag" };
      if (quote.measurement !== measurement) return { ok: false, reason: "measurement field mismatch" };
      if (quote.reportData !== reportData) return { ok: false, reason: "reportData field mismatch" };
      const issuedAt = Number(issuedAtBig);
      if (!Number.isSafeInteger(issuedAt) || issuedAt !== quote.issuedAt) return { ok: false, reason: "issuedAt field mismatch" };
      if (expected.measurement !== undefined && expected.measurement !== measurement) return { ok: false, reason: "unexpected measurement" };
      if (expected.reportData !== undefined && expected.reportData !== reportData) return { ok: false, reason: "unexpected reportData" };
      if (expected.maxAgeSec !== undefined) {
        const age = Math.floor(Date.now() / 1000) - issuedAt;
        if (age < 0 || age > expected.maxAgeSec) return { ok: false, reason: "quote expired or issued in the future" };
      }
      const hash = keccak256(encodeAbiParameters(
        [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
        [tag, measurement, reportData, issuedAtBig],
      ));
      const signer = await recoverMessageAddress({ message: { raw: hash }, signature: rootSig });
      if (signer.toLowerCase() !== this.options.mockRootAddress.toLowerCase()) return { ok: false, reason: "invalid mock root signature" };
      return { ok: true, measurement, reportData };
    } catch { return { ok: false, reason: "malformed mock quote" }; }
  }
}

/** TODO: integrate an NVIDIA GPU attestation (NRAS) verifier. Validate the NRAS token signature/chain, confirm NVIDIA CC mode is enabled, enforce the GPU measurement policy and freshness, and check token report data against keyBinding(enclave signer address, X25519 public key). */
export class NrasQuoteVerifier implements QuoteVerifier {
  async verify(_quote: Quote) { return { ok: false as const, reason: "NOT_IMPLEMENTED: integrate an NVIDIA NRAS verifier" }; }
}
export class DcapQuoteVerifier implements QuoteVerifier {
  private readonly now: () => number;
  private readonly policy: {
    allowedStatuses: TcbStatus[];
    rejectAdvisories: string[];
    allowDebug: boolean;
    maxClockSkewSec: number;
  };
  private readonly verifyDcap: typeof verifyTdxQuote;

  constructor(private readonly options: {
    collateral?: CollateralSource;
    now?: () => number;
    policy?: {
      allowedStatuses?: TcbStatus[];
      rejectAdvisories?: string[];
      allowDebug?: boolean;
      maxClockSkewSec?: number;
    };
    verifyDcap?: typeof verifyTdxQuote;
  } = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.verifyDcap = options.verifyDcap ?? verifyTdxQuote;
    this.policy = {
      allowedStatuses: options.policy?.allowedStatuses ?? ["UpToDate"],
      rejectAdvisories: options.policy?.rejectAdvisories ?? [],
      allowDebug: options.policy?.allowDebug ?? false,
      maxClockSkewSec: options.policy?.maxClockSkewSec ?? 60,
    };
  }

  async verify(
    quote: Quote,
    expected: { measurement?: Hex; reportData?: Hex; maxAgeSec?: number; signal?: AbortSignal } = {},
  ) {
    if (quote.kind !== "tdx") return { ok: false as const, reason: "wrong quote kind" };
    if (!this.options.collateral) {
      return { ok: false as const, reason: "dcap: collateral source required" };
    }

    const now = this.now();
    let raw: Uint8Array;
    let evidence: TdxQuoteEvidence;
    try {
      raw = hexToBytes(quote.raw);
      // The PCK chain, QE report and quote signatures need no collateral. Checking them first means a forged chain or a
      // bogus FMSPC is reported as forged evidence, and collateral is only ever fetched for an Intel-signed FMSPC.
      evidence = verifyTdxQuoteEvidence(raw, now);
    } catch (error) {
      return { ok: false as const, reason: `dcap: ${dcapCode(error)}` };
    }

    let collateral;
    try {
      collateral = await this.options.collateral.get(evidence.fmspc, evidence.ca, expected.signal);
    } catch {
      return { ok: false as const, reason: "dcap: collateral unavailable" };
    }

    let result: TdxVerification;
    try {
      result = this.verifyDcap(raw, collateral, now, { collateralGraceSec: staleCollateralGraceSec(collateral) });
    } catch (error) {
      return { ok: false as const, reason: `dcap: ${dcapCode(error)}` };
    }

    // Evidence about this enclave (debug mode, measurement and key binding) is checked before the platform TCB policy,
    // so a genuine quote that misrepresents the enclave is reported as such even on an out-of-date platform.
    if (!this.policy.allowDebug && (result.td.tdAttributes[0]! & 1) !== 0) {
      return { ok: false as const, reason: "debug TD" };
    }

    let measurement: Hex;
    try {
      const scheme = (quote as Quote & { measurementScheme?: unknown }).measurementScheme;
      if (scheme === undefined) {
        measurement = tdxMeasurement({ mrtd: result.td.mrTd, rtmr: result.td.rtmr });
      } else if (scheme === "dstack-config-v1") {
        measurement = dstackConfigMeasurement({ mrtd: result.td.mrTd, mrConfigId: result.td.mrConfigId, rtmr: result.td.rtmr });
      } else {
        return { ok: false as const, reason: "unknown measurement scheme" };
      }
    } catch {
      return { ok: false as const, reason: "invalid measurement profile" };
    }
    if (quote.measurement.toLowerCase() !== measurement.toLowerCase()) {
      return { ok: false as const, reason: "measurement field mismatch" };
    }
    if (expected.measurement !== undefined && expected.measurement.toLowerCase() !== measurement.toLowerCase()) {
      return { ok: false as const, reason: "unexpected measurement" };
    }

    const report = parseTdxReportData(result.td.reportData);
    if (!report) return { ok: false as const, reason: "reportData layout" };
    if (quote.reportData.toLowerCase() !== report.keyBinding.toLowerCase()) {
      return { ok: false as const, reason: "reportData field mismatch" };
    }
    if (expected.reportData !== undefined && expected.reportData.toLowerCase() !== report.keyBinding.toLowerCase()) {
      return { ok: false as const, reason: "unexpected reportData" };
    }
    if (quote.issuedAt !== report.issuedAt) return { ok: false as const, reason: "issuedAt field mismatch" };
    if (
      expected.maxAgeSec !== undefined
      && (now - report.issuedAt > expected.maxAgeSec || report.issuedAt > now + this.policy.maxClockSkewSec)
    ) {
      return { ok: false as const, reason: "quote expired or issued in the future" };
    }

    if (!this.policy.allowedStatuses.includes(result.status)) {
      return { ok: false as const, reason: `tcb status ${result.status}` };
    }
    if (result.advisoryIds.some((id) => this.policy.rejectAdvisories.includes(id))) {
      return { ok: false as const, reason: "rejected advisory" };
    }

    return {
      ok: true as const,
      measurement,
      reportData: report.keyBinding,
      tcbStatus: result.status,
      advisoryIds: result.advisoryIds,
    };
  }
}

function dcapCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error ? error.message : "invalid quote";
}
