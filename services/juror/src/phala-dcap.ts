// Verifies the Intel TDX quote inside a Phala Confidential AI attestation report against live Intel PCS collateral.
// Used by the juror (MODEL_PROVIDER=phala-aci) and by scripts/aci-live-check.ts.
import { PcsCollateralSource, parseTdxQuote, pemChain, verifyTdxQuote } from "@mochi/tee";

export const phalaDcap = async (raw: Uint8Array) => {
  const now = Math.floor(Date.now() / 1000);
  const parsed = parseTdxQuote(raw);
  const chain = pemChain(parsed.pckPem);
  const leaf = chain[0]; const intermediate = chain[1];
  if (!leaf?.sgx || !intermediate) return { ok: false, status: "Invalid", reportData: new Uint8Array() };
  const ca = intermediate.subjectCN === "Intel SGX PCK Platform CA" ? "platform"
    : intermediate.subjectCN === "Intel SGX PCK Processor CA" ? "processor" : undefined;
  if (!ca) return { ok: false, status: "Invalid", reportData: new Uint8Array() };
  const collateral = await new PcsCollateralSource({ baseUrl: process.env.PCS_BASE_URL, rootCaCrlUrl: process.env.PCS_ROOT_CA_CRL_URL }).get(
    Array.from(leaf.sgx.fmspc, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase(), ca,
  );
  const verified = verifyTdxQuote(raw, collateral, now);
  const advisories = (process.env.TDX_REJECT_ADVISORIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const debug = (verified.td.tdAttributes[0]! & 1) !== 0;
  return { ok: !verified.advisoryIds.some((id) => advisories.includes(id)) && (!debug || process.env.TDX_ALLOW_DEBUG === "1"), status: verified.status, reportType: "tdx", reportData: verified.td.reportData, tdReport: verified.td };
};
