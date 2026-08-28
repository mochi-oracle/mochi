import { z } from "zod";

const Environment = z.object({
  MOCHI_DEPLOYMENT: z.string().default("../../deployments/local.json"),
  DATABASE_URL: z.string().default("postgres://mochi:mochi@127.0.0.1:55432/mochi"),
  POLL_MS: z.coerce.number().int().positive().default(2_000),
  PURGE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  RECEIPT_SIGNING_KEY: z.string().optional(),
  ANCHORER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_087),
});

export type IndexerConfig = z.infer<typeof Environment>;

/** Parse and validate indexer environment settings. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): IndexerConfig {
  return Environment.parse(env);
}
