import { z } from "zod";

const EnvSchema = z.object({
  MOCHI_DEPLOYMENT: z.string().min(1).default("deployments/local.json"),
  DATABASE_URL: z.string().min(1).default("postgres://mochi:mochi@127.0.0.1:55432/mochi"),
  ATTESTOR_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  VALIDITY_SEC: z.coerce.number().int().positive().default(1_200),
  MAX_QUOTE_AGE_SEC: z.coerce.number().int().positive().default(900),
  // Required: quote verification never defaults to mock.
  QUOTE_VERIFIER: z.enum(["mock", "dcap"]),
  MOCK_ROOT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ADMIN_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DISSENTER_EXCLUDED_LINEAGES: z.string().default("llama,qwen"),
  // Optional state location shared with the enclave services: the Intel PCS collateral cache persists beside it in
  // `dcap-collateral` (see collateralCacheDirFromEnv in @mochi/tee). The attestor itself seals nothing.
  SEALED_STORE_DIR: z.string().min(1).optional(),
});

export type AttestorConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AttestorConfig {
  const config = EnvSchema.parse(env);
  if (config.QUOTE_VERIFIER === "mock" && !config.MOCK_ROOT_ADDRESS) {
    throw new Error("MOCK_ROOT_ADDRESS is required when QUOTE_VERIFIER=mock");
  }
  config.DISSENTER_EXCLUDED_LINEAGES = config.DISSENTER_EXCLUDED_LINEAGES.split(",").map((lineage) => lineage.trim().toLowerCase()).filter(Boolean).join(",");
  return config;
}
