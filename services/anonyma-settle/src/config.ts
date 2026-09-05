import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8098),
  ADMIN_TOKEN: z.string().min(1).default("development-admin-token"),
  STATEMENT_HMAC_SECRET: z.string().min(1).default("development-statement-secret"),
  ANONYMA_LEDGER_URL: z.string().url().optional(),
  ANONYMA_LEDGER_FILE: z.string().min(1).optional(),
  ANONYMA_LEDGER_HMAC_SECRET: z.string().min(1).optional(),
  STATEMENTS_DIR: z.string().min(1).default("./statements"),
  TARGET_FLOAT: z.string().regex(/^\d+$/).default("1000000000"),
  SETTLE_WEEKDAY: z.coerce.number().int().min(0).max(6).default(1),
  SETTLE_UTC_HOUR: z.coerce.number().int().min(0).max(23).default(0),
  MOCHI_DEPLOYMENT: z.string().min(1).default("../../deployments/local.json"),
  START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
});

export type SettleConfig = z.infer<typeof envSchema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): SettleConfig {
  const config = envSchema.parse(env);
  if (config.ANONYMA_LEDGER_URL && !config.ANONYMA_LEDGER_HMAC_SECRET) throw new Error("ANONYMA_LEDGER_HMAC_SECRET is required with ANONYMA_LEDGER_URL");
  if (config.ANONYMA_LEDGER_FILE && (config.ANONYMA_LEDGER_URL || config.ANONYMA_LEDGER_HMAC_SECRET)) throw new Error("Configure either ANONYMA_LEDGER_FILE or the URL/HMAC pair");
  return config;
}
