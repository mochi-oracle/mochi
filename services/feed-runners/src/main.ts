import { privateKeyToAccount } from "viem/accounts";
import { quoteVerifierFromEnv } from "@mochi/tee";
import { createDb } from "@mochi/db";
import { createFeedChain, createStockTokenReader } from "./adapters/chain.ts";
import { createFeedQueryRepo } from "./adapters/db.ts";
import { EdgarHttpClient, IntakeHttpClient } from "./adapters/http.ts";
import { loadConfig } from "./config.ts";
import { FeedQueryExecutor } from "./execute.ts";
import { createFeedRunnersApp } from "./app.ts";
import { FeedScheduler } from "./scheduler.ts";
import { log } from "./log.ts";

async function main() {
  const config = loadConfig();
  const account = privateKeyToAccount(config.FEED_RUNNER_KEY);
  if (account.address.toLowerCase() !== config.FEED_RUNNER_ADDRESS.toLowerCase()) throw new Error("FEED_RUNNER_KEY does not match FEED_RUNNER_ADDRESS");
  const db = createDb(config.DATABASE_URL);
  const verifier = quoteVerifierFromEnv(process.env, { rootAddress: config.MOCK_QUOTE_ROOT });
  const executor = new FeedQueryExecutor({ http: new IntakeHttpClient(), chain: createFeedChain(config.MOCHI_DEPLOYMENT, config.FEED_RUNNER_KEY, config.TX_CONFIRMATIONS), quoteVerifier: verifier, repo: createFeedQueryRepo(db.db), clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, intakeUrl: config.INTAKE_URL, feedRunnerAddress: config.FEED_RUNNER_ADDRESS, refundTo: config.refundTo, feedRunnerKey: config.FEED_RUNNER_KEY, autoFund: config.AUTO_FUND === "1", feedBudgetMin: config.FEED_BUDGET_MIN, feedBudgetTarget: config.FEED_BUDGET_TARGET, attestationTimeoutMs: config.HTTP_TIMEOUT_MS, intakeTimeoutMs: config.INTAKE_TIMEOUT_MS });
  const edgar = config.feeds.earnings.edgar ? new EdgarHttpClient(config.feeds.earnings.edgar.userAgent, config.HTTP_TIMEOUT_MS) : undefined;
  const scheduler = new FeedScheduler(config, executor, Date.now, (ms) => new Promise((resolve) => setTimeout(resolve, ms)), createStockTokenReader(config.MOCHI_DEPLOYMENT, config.FEED_RUNNER_KEY, config.TX_CONFIRMATIONS), edgar);
  await scheduler.init();
  const { app } = createFeedRunnersApp({ scheduler, adminToken: config.ADMIN_TOKEN });
  Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.PORT, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
  scheduler.start();
  log("info", "feed_runners_started", { port: config.PORT });
}
main().catch((error) => { log("error", "feed_runners_start_failed", { error: error instanceof Error ? error.message : "unknown error" }); process.exitCode = 1; });
