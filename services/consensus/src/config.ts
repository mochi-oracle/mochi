import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3203),
  HOST: z.string().default("127.0.0.1"),
  MOCHI_DEPLOYMENT: z.string().default("deployments/local.json"),
  ROUND_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TEE_MODE: z.enum(["mock", "tdx", "dstack"]).default("mock"),
  TEE_KEYS: z.enum(["kms", "ephemeral"]).optional(),
  TEE_KEY_LABEL: z.string().min(1).max(64).default("default"),
  QUOTE_VERIFIER: z.enum(["mock", "dcap"]).default("mock"),
  TEE_MOCK_SEED: z.string().default("0x" + "11".repeat(32)),
  TEE_MOCK_MEASUREMENT: z.string().regex(/^0x[0-9a-f]{64}$/).default("0x" + "22".repeat(32)),
  TEE_MOCK_ROOT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-f]{64}$/).default("0x" + "33".repeat(32)),
  SEALED_STORE_DIR: z.string().default(".sealed-consensus"),
});

export type ConsensusConfig = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConsensusConfig { return schema.parse(env); }
