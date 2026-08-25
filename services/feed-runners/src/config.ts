import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Address, Hex } from "viem";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as Address);
const corpConfig = z.object({ tokens: z.array(z.object({ ticker: z.string().min(1), token: address, noticeUrls: z.array(z.object({ url: z.string().url(), kind: z.enum(["EX_DIVIDEND", "SPLIT"]) })) })) });
const consensusCompany = z.object({ ticker: z.string().min(1), cik: z.string().regex(/^\d{1,10}$/), consensus_eps: z.string().optional(), consensus_revenue: z.string().optional(), consensus_eps_basis: z.enum(["GAAP", "NON_GAAP"]).optional() });
const earningsConfig = z.object({ releases: z.array(z.object({ ticker: z.string().min(1), releaseAt: z.string().datetime({ offset: true }), url: z.string().url(), consensus_eps: z.string().optional(), consensus_revenue: z.string().optional(), consensus_eps_basis: z.enum(["GAAP", "NON_GAAP"]).optional() })).default([]), edgar: z.object({ userAgent: z.string().min(1), companies: z.array(consensusCompany) }).optional() });
const attestationsConfig = z.object({ reserves: z.array(z.object({ assetSymbol: z.string().min(1), url: z.string().url() })), navs: z.array(z.object({ fundId: z.string().min(1), url: z.string().url() })) });
export const FeedsConfigSchema = z.object({ "corp-actions": corpConfig, earnings: earningsConfig, attestations: attestationsConfig });
export type FeedsConfig = z.infer<typeof FeedsConfigSchema>;

export const ServiceEnvSchema = z.object({
  FEEDS_CONFIG: z.string().default("feeds.json"), STATE_DIR: z.string().default("./state"), PORT: z.coerce.number().int().min(1).max(65535).default(8091),
  ADMIN_TOKEN: z.string().min(1), INTAKE_URL: z.string().url().default("http://127.0.0.1:8090"), FEED_RUNNER_ADDRESS: address,
  FEED_REFUND_TO: address.optional(), FEED_RUNNER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex),
  CORP_ACTIONS_UTC_HOUR: z.coerce.number().int().min(0).max(23).default(13), ATTESTATIONS_WEEKDAY: z.coerce.number().int().min(0).max(6).default(1),
  AUTO_FUND: z.enum(["0", "1"]).default("0"), FEED_BUDGET_MIN: z.coerce.bigint().default(0n), FEED_BUDGET_TARGET: z.coerce.bigint().default(0n),
  DATABASE_URL: z.string().default("postgres://mochi:mochi@127.0.0.1:55432/mochi"), MOCHI_DEPLOYMENT: z.string().default("deployments/local.json"),
  INTAKE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000), HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MULTIPLIER_POLL_MS: z.coerce.number().int().min(10_000).default(60_000), EDGAR_POLL_MS: z.coerce.number().int().min(10_000).default(60_000),
  TX_CONFIRMATIONS: z.coerce.number().int().positive().default(1),
  MOCK_QUOTE_ROOT: address.optional(), QUOTE_VERIFIER: z.enum(["mock", "dcap"]).default("mock"),
});
export type ServiceConfig = z.infer<typeof ServiceEnvSchema> & { feeds: FeedsConfig; refundTo: Address; stateFile: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const parsed = ServiceEnvSchema.parse(env);
  // Inline FEEDS_CONFIG_JSON (Phala compose) takes precedence over the FEEDS_CONFIG file.
  const feeds = FeedsConfigSchema.parse(JSON.parse(process.env.FEEDS_CONFIG_JSON ?? readFileSync(parsed.FEEDS_CONFIG, "utf8")));
  if (parsed.FEED_BUDGET_TARGET < parsed.FEED_BUDGET_MIN) throw new Error("FEED_BUDGET_TARGET must be >= FEED_BUDGET_MIN");
  return { ...parsed, feeds, refundTo: parsed.FEED_REFUND_TO ?? parsed.FEED_RUNNER_ADDRESS, stateFile: `${parsed.STATE_DIR}/feed-runners.json` };
}
