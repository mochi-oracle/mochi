// Verifies the Intel TDX quote inside a Phala Confidential AI attestation report against Intel PCS collateral.
// Used by the juror (MODEL_PROVIDER=phala-aci), the claims pilot and scripts/prepare-production-launch.ts.
import type { DcapResult } from "@mochi/aci";
import {
  collateralSourceFromEnv, staleCollateralGraceSec, tdxPolicyFromEnv, verifyTdxQuote, verifyTdxQuoteEvidence,
  type CollateralSource, type Env, type TdReport,
} from "@mochi/tee";

/**
 * DCAP for ACI gateway quotes. The PCK chain, QE report and quote signatures are checked before any collateral is
 * fetched (so the FMSPC is Intel-signed), and collateral comes from the process-wide PCS cache that MOCHI's own quote
 * checks use: persisted beside SEALED_STORE_DIR, refreshed ahead of expiry, and served through a PCS outage only within
 * the bounded grace. Advisory and debug policy follow TDX_REJECT_ADVISORIES and TDX_ALLOW_DEBUG; the TCB status is
 * returned and enforced by the caller against TDX_ALLOWED_TCB_STATUSES.
 */
export function createPhalaDcap(options: { env?: Env; collateral?: CollateralSource; now?: () => number } = {}) {
  return async (raw: Uint8Array, signal?: AbortSignal): Promise<DcapResult & { tdReport?: TdReport }> => {
    const env = options.env ?? process.env;
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    let evidence;
    try {
      evidence = verifyTdxQuoteEvidence(raw, now);
    } catch {
      return { ok: false, status: "Invalid", reportData: new Uint8Array() };
    }
    const policy = tdxPolicyFromEnv(env);
    const collateral = await (options.collateral ?? collateralSourceFromEnv(env)).get(evidence.fmspc, evidence.ca, signal);
    const verified = verifyTdxQuote(raw, collateral, now, { collateralGraceSec: staleCollateralGraceSec(collateral) });
    const debug = (verified.td.tdAttributes[0]! & 1) !== 0;
    return {
      ok: !verified.advisoryIds.some((id) => policy.rejectAdvisories.includes(id)) && (!debug || policy.allowDebug),
      status: verified.status,
      reportType: "tdx",
      reportData: verified.td.reportData,
      tdReport: verified.td,
    };
  };
}

/** Reads the process environment at call time. */
export const phalaDcap = createPhalaDcap();
