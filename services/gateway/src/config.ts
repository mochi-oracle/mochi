import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  MOCHI_DEPLOYMENT: z.string().default("../../deployments/local.json"),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/mochi"),
  INTAKE_URL: z.string().url().default("http://localhost:3001"),
  RELAYER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  RELAY_RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(20),
  RELAY_RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().positive().default(0.5),
  RELAY_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  ANONYMA_HMAC_SECRET: z.string().optional(),
  MCP_VOUCHER_MODE: z.enum(["true", "false"]).default("false"),
  INTERNAL_PAYERS: z.string().default(""),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  return ConfigSchema.parse(env);
}
