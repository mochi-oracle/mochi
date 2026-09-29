import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8093),
  HOST: z.string().default("127.0.0.1"),
  MOCHI_DEPLOYMENT: z.string().default("deployments/local.json"),
  JUROR_OPERATOR: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v), "operator must not be zero").optional(),
  JUROR_CLASS: z.coerce.number().int().min(0).max(4).default(0),
  MODEL_BASE_URL: z.string().url().default("http://127.0.0.1:8000"),
  MODEL_ID: z.string().min(1).default("stub-model"),
  MODEL_LINEAGE: z.string().min(1).max(64).default("stub"),
  MODEL_WEIGHTS_SHA256: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  MODEL_WEIGHTS_DIR: z.string().min(1).optional(),
  MODEL_OPEN_WEIGHTS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MODEL_PROVIDER: z.string().min(1).default("openai"),
  ZDR: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MODEL_API_KEY: z.string().optional(),
  PHALA_ACI_BASE_URL: z.string().url().default("https://inference.phala.com/v1"),
  PHALA_AI_API_KEY: z.string().optional(),
  PHALA_ACI_MODEL: z.string().min(1).optional(),
  PHALA_ACI_ALLOWED_WORKLOADS: z.string().optional(),
  RUNNER: z.enum(["openai", "stub", "phala-aci"]).default("stub"),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MODEL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  TEE_MODE: z.enum(["mock", "tdx", "dstack"]).default("mock"),
  TEE_KEYS: z.enum(["kms", "ephemeral"]).optional(),
  TEE_KEY_LABEL: z.string().min(1).max(64).default("default"),
  QUOTE_VERIFIER: z.enum(["mock", "dcap"]).default("mock"),
  TEE_MOCK_SEED: z.string().regex(/^0x([0-9a-fA-F]{2})+$/).default(`0x${"11".repeat(32)}`),
  TEE_MOCK_MEASUREMENT: z.string().regex(/^0x[0-9a-fA-F]{64}$/).default(`0x${"22".repeat(32)}`),
  TEE_MOCK_ROOT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).default(`0x${"33".repeat(32)}`),
  SEALED_STORE_DIR: z.string().default("./data/juror-sealed"),
  MAX_TOKENS: z.coerce.number().int().positive().default(4096),
});

export type JurorConfig = z.infer<typeof ConfigSchema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): JurorConfig {
  const config = ConfigSchema.parse(env);
  if (config.RUNNER === "openai" && !env.MODEL_ID) throw new Error("MODEL_ID is required when RUNNER=openai");
  if (config.RUNNER === "openai" && !config.MODEL_WEIGHTS_SHA256 && !config.MODEL_WEIGHTS_DIR) {
    throw new Error("MODEL_WEIGHTS_SHA256 or MODEL_WEIGHTS_DIR is required when RUNNER=openai");
  }
  if (config.MODEL_WEIGHTS_SHA256 && config.MODEL_WEIGHTS_DIR) throw new Error("set only one of MODEL_WEIGHTS_SHA256 or MODEL_WEIGHTS_DIR");
  if (config.RUNNER === "phala-aci" && config.MODEL_PROVIDER !== "phala-aci") throw new Error("RUNNER=phala-aci requires MODEL_PROVIDER=phala-aci");
  if (config.MODEL_PROVIDER === "phala-aci" && config.RUNNER !== "phala-aci") throw new Error("MODEL_PROVIDER=phala-aci requires RUNNER=phala-aci");
  if (config.MODEL_PROVIDER === "phala-aci" && (!config.PHALA_AI_API_KEY || !config.PHALA_ACI_MODEL)) throw new Error("PHALA_AI_API_KEY and PHALA_ACI_MODEL are required when MODEL_PROVIDER=phala-aci");
  return config;
}
