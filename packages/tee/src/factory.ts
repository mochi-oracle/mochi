import { resolve } from "node:path";
import type { Address, Hex, LocalAccount } from "viem";
import { parseTdxQuote } from "./dcap/quote.ts";
import { PcsCollateralSource, sharedPcsCollateralSource } from "./dcap/pcs.ts";
import type { CollateralSource } from "./dcap/collateral.ts";
import { dstackConfigMeasurement, tdxMeasurement, type MeasurementScheme } from "./tdx-common.ts";
import { TdxTeeProvider, type QuoteSource, type TsmPort } from "./tdx-provider.ts";
import { DstackKeySource, DstackQuoteSource } from "./dstack.ts";
import { MockTeeProvider, type TeeProvider } from "./provider.ts";
import { DcapQuoteVerifier, MockQuoteVerifier, type QuoteVerifier } from "./verifier.ts";

export type Env = Record<string, string | undefined>;

const TCB_STATUSES = [
  "UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded",
  "OutOfDate", "OutOfDateConfigurationNeeded", "Revoked",
] as const;

/** bytes32 on-chain measurement of a raw TDX quote: tdxMeasurement(MRTD, RTMR0..3) of the parsed TD report. */
export function tdxQuoteMeasurement(rawQuote: Uint8Array, scheme?: MeasurementScheme): Hex {
  const { td } = parseTdxQuote(rawQuote);
  if (scheme === "dstack-config-v1") return dstackConfigMeasurement({ mrtd: td.mrTd, mrConfigId: td.mrConfigId, rtmr: td.rtmr });
  if (scheme !== undefined) throw new Error(`unsupported TDX measurement scheme: ${String(scheme)}`);
  return tdxMeasurement({ mrtd: td.mrTd, rtmr: td.rtmr });
}

function measurementSchemeFromEnv(env: Env, mode: string): MeasurementScheme | undefined {
  const selected = env.TEE_MEASUREMENT;
  if (selected === undefined) return undefined; // retain legacy MRTD + RTMR0..3 measurement
  if (selected === "dstack-config-v1" && mode === "dstack") return selected;
  throw new Error("TEE_MEASUREMENT supports dstack-config-v1 only when TEE_MODE=dstack");
}

/**
 * Intel TDX acceptance policy, from the existing settings TDX_ALLOWED_TCB_STATUSES (default "UpToDate"),
 * TDX_REJECT_ADVISORIES (default none) and TDX_ALLOW_DEBUG (default "0"). One policy serves both DCAP paths: MOCHI's
 * own enclave quotes (attestor, consensus, juror) and the Phala ACI gateway quotes that jurors verify.
 *
 * Trade-off: the strict default accepts only platforms Intel rates UpToDate. At each Intel TCB recovery, PCS rates every
 * platform that has not yet installed the new microcode or TDX module OutOfDate (or SWHardeningNeeded) until the
 * provider patches it, so the attestor lets every MOCHI attestation lapse and jurors refuse the ACI gateway: a full
 * outage, by design, rather than trusting a platform with a published, unpatched vulnerability. Allowing more statuses
 * keeps the service up through such a window at the cost of accepting those platforms; pair it with
 * TDX_REJECT_ADVISORIES for advisories that matter to MOCHI. "Revoked" is never accepted.
 */
export function tdxPolicyFromEnv(env: Env): { allowedStatuses: string[]; rejectAdvisories: string[]; allowDebug: boolean } {
  const allowedStatuses = parseCsv(env.TDX_ALLOWED_TCB_STATUSES ?? "UpToDate", "TDX_ALLOWED_TCB_STATUSES");
  for (const status of allowedStatuses) {
    if (!(TCB_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`TDX_ALLOWED_TCB_STATUSES contains unsupported status: ${status}`);
    }
    if (status === "Revoked") throw new Error("TDX_ALLOWED_TCB_STATUSES must not include Revoked");
  }
  const rejectAdvisories = parseCsv(env.TDX_REJECT_ADVISORIES ?? "", "TDX_REJECT_ADVISORIES", true);
  const debug = env.TDX_ALLOW_DEBUG;
  if (debug !== undefined && debug !== "0" && debug !== "1") {
    throw new Error('TDX_ALLOW_DEBUG must be "0" or "1"');
  }
  return { allowedStatuses, rejectAdvisories, allowDebug: debug === "1" };
}

/**
 * Where the PCS collateral cache persists: `dcap-collateral` beside the service's SEALED_STORE_DIR, so every service on
 * the host (each with its own sealed store under one state directory) shares one cache. The files hold only public,
 * Intel-signed collateral, which is re-verified on every use. Without SEALED_STORE_DIR the cache is in memory only.
 */
export function collateralCacheDirFromEnv(env: Env): string | undefined {
  const sealed = env.SEALED_STORE_DIR?.trim();
  return sealed ? resolve(sealed, "..", "dcap-collateral") : undefined;
}

/** The process-wide PCS collateral source for this environment (see sharedPcsCollateralSource). */
export function collateralSourceFromEnv(env: Env): PcsCollateralSource {
  return sharedPcsCollateralSource({ baseUrl: env.PCS_BASE_URL, rootCaCrlUrl: env.PCS_ROOT_CA_CRL_URL, cacheDir: collateralCacheDirFromEnv(env) });
}

/**
 * QUOTE_VERIFIER = "dcap" | "mock", required. There is no default: a service that forgets the setting must fail to
 * start rather than silently accept mock quotes that any key holder can forge. "mock" is for local development only.
 * DCAP verifiers share the process-wide, persisted PCS collateral cache unless a test injects `fetch`, `now` or
 * `collateral`.
 */
export function quoteVerifierFromEnv(
  env: Env,
  mock?: { rootAddress?: Address },
  deps?: { fetch?: typeof fetch; now?: () => number; collateral?: CollateralSource },
): QuoteVerifier {
  const mode = env.QUOTE_VERIFIER;
  if (mode === undefined || mode.trim() === "") throw new Error("QUOTE_VERIFIER must be set explicitly: dcap (or mock for local development only)");
  if (mode === "mock") {
    if (!mock?.rootAddress) throw new Error("mock root address is required when QUOTE_VERIFIER=mock");
    return new MockQuoteVerifier({ mockRootAddress: mock.rootAddress });
  }
  if (mode !== "dcap") throw new Error(`unsupported QUOTE_VERIFIER=${mode}; expected mock or dcap`);

  const policy = tdxPolicyFromEnv(env);
  const now = deps?.now;
  const collateral = deps?.collateral ?? (deps?.fetch || now
    ? new PcsCollateralSource({ baseUrl: env.PCS_BASE_URL, rootCaCrlUrl: env.PCS_ROOT_CA_CRL_URL, fetch: deps?.fetch, now })
    : collateralSourceFromEnv(env));
  return new DcapQuoteVerifier({ collateral, now, policy });
}

/** TEE_MODE = "mock" (default) | "tdx" (configfs-tsm) | "dstack" (dstack guest agent, e.g. Phala Cloud CVMs). */
export async function teeProviderFromEnv(
  env: Env,
  mock: { seed: Hex; measurement: Hex; mockRoot: LocalAccount },
  deps?: { tsm?: TsmPort; quoteSource?: QuoteSource; keySource?: DstackKeySource; role?: "intake" | "juror" | "consensus" },
): Promise<TeeProvider> {
  const mode = env.TEE_MODE ?? "mock";
  const measurementScheme = measurementSchemeFromEnv(env, mode);
  const measurementOf = (raw: Uint8Array) => tdxQuoteMeasurement(raw, measurementScheme);
  const keysMode = env.TEE_KEYS ?? (mode === "dstack" ? "kms" : "ephemeral");
  if (keysMode !== "kms" && keysMode !== "ephemeral") throw new Error('TEE_KEYS must be "kms" or "ephemeral"');
  if (mode === "mock") return new MockTeeProvider(mock);
  if (mode === "tdx") {
    if (keysMode !== "ephemeral") throw new Error("TEE_MODE=tdx has no KMS; TEE_KEYS must be ephemeral");
    return TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, tsmRoot: env.TSM_ROOT, tsm: deps?.tsm });
  }
  if (mode === "dstack") {
    const quoteSource = deps?.quoteSource ?? new DstackQuoteSource({ socketPath: env.DSTACK_SOCKET });
    if (keysMode === "ephemeral") return TdxTeeProvider.create({ measurementOf, measurementScheme, quoteSource });
    if (!deps?.role) throw new Error("TEE role is required when TEE_MODE=dstack and TEE_KEYS=kms");
    const label = env.TEE_KEY_LABEL ?? "default";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(label)) throw new Error("TEE_KEY_LABEL must be 1-64 safe label characters");
    const source = deps.keySource ?? new DstackKeySource({ socketPath: env.DSTACK_SOCKET });
    const prefix = `mochi/${deps.role}/${label}`;
    const [signing, encryption] = await Promise.all([
      source.derive(`${prefix}/sign`, "mochi signing key", "mochi/dstack-kms/secp256k1/v1"),
      source.derive(`${prefix}/x25519`, "mochi encryption key", "mochi/dstack-kms/x25519/v1"),
    ]);
    return TdxTeeProvider.create({ measurementOf, measurementScheme, quoteSource,
      keys: { secp256k1: signing.key, x25519: encryption.key }, kmsSignatureChain: signing.signatureChain,
      kmsEncryptionSignatureChain: encryption.signatureChain });
  }
  throw new Error(`unsupported TEE_MODE=${mode}; expected mock, tdx or dstack`);
}

function parseCsv(value: string, name: string, allowEmpty = false): string[] {
  if (allowEmpty && value.trim() === "") return [];
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => item.length === 0)) throw new Error(`${name} must be a comma-separated list without empty values`);
  return values;
}
