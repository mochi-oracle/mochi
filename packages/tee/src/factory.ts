import type { Address, Hex, LocalAccount } from "viem";
import { parseTdxQuote } from "./dcap/quote.ts";
import { PcsCollateralSource } from "./dcap/pcs.ts";
import { tdxMeasurement } from "./tdx-common.ts";
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
export function tdxQuoteMeasurement(rawQuote: Uint8Array): Hex {
  const { td } = parseTdxQuote(rawQuote);
  return tdxMeasurement({ mrtd: td.mrTd, rtmr: td.rtmr });
}

/** QUOTE_VERIFIER = "mock" (default) | "dcap". */
export function quoteVerifierFromEnv(
  env: Env,
  mock?: { rootAddress?: Address },
  deps?: { fetch?: typeof fetch; now?: () => number },
): QuoteVerifier {
  const mode = env.QUOTE_VERIFIER ?? "mock";
  if (mode === "mock") {
    if (!mock?.rootAddress) throw new Error("mock root address is required when QUOTE_VERIFIER=mock");
    return new MockQuoteVerifier({ mockRootAddress: mock.rootAddress });
  }
  if (mode !== "dcap") throw new Error(`unsupported QUOTE_VERIFIER=${mode}; expected mock or dcap`);

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
  const now = deps?.now;
  return new DcapQuoteVerifier({
    collateral: new PcsCollateralSource({
      baseUrl: env.PCS_BASE_URL,
      rootCaCrlUrl: env.PCS_ROOT_CA_CRL_URL,
      fetch: deps?.fetch,
      now,
    }),
    now,
    policy: { allowedStatuses, rejectAdvisories, allowDebug: debug === "1" },
  });
}

/** TEE_MODE = "mock" (default) | "tdx" (configfs-tsm) | "dstack" (dstack guest agent, e.g. Phala Cloud CVMs). */
export async function teeProviderFromEnv(
  env: Env,
  mock: { seed: Hex; measurement: Hex; mockRoot: LocalAccount },
  deps?: { tsm?: TsmPort; quoteSource?: QuoteSource; keySource?: DstackKeySource; role?: "intake" | "juror" | "consensus" },
): Promise<TeeProvider> {
  const mode = env.TEE_MODE ?? "mock";
  const keysMode = env.TEE_KEYS ?? (mode === "dstack" ? "kms" : "ephemeral");
  if (keysMode !== "kms" && keysMode !== "ephemeral") throw new Error('TEE_KEYS must be "kms" or "ephemeral"');
  if (mode === "mock") return new MockTeeProvider(mock);
  if (mode === "tdx") {
    if (keysMode !== "ephemeral") throw new Error("TEE_MODE=tdx has no KMS; TEE_KEYS must be ephemeral");
    return TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, tsmRoot: env.TSM_ROOT, tsm: deps?.tsm });
  }
  if (mode === "dstack") {
    const quoteSource = deps?.quoteSource ?? new DstackQuoteSource({ socketPath: env.DSTACK_SOCKET });
    if (keysMode === "ephemeral") return TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, quoteSource });
    if (!deps?.role) throw new Error("TEE role is required when TEE_MODE=dstack and TEE_KEYS=kms");
    const label = env.TEE_KEY_LABEL ?? "default";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(label)) throw new Error("TEE_KEY_LABEL must be 1-64 safe label characters");
    const source = deps.keySource ?? new DstackKeySource({ socketPath: env.DSTACK_SOCKET });
    const prefix = `mochi/${deps.role}/${label}`;
    const [signing, encryption] = await Promise.all([
      source.derive(`${prefix}/sign`, "mochi signing key", "mochi/dstack-kms/secp256k1/v1"),
      source.derive(`${prefix}/x25519`, "mochi encryption key", "mochi/dstack-kms/x25519/v1"),
    ]);
    return TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, quoteSource,
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
