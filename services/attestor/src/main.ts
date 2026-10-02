import { quoteVerifierFromEnv } from "@mochi/tee";
import { createDb } from "@mochi/db";
import { loadDeployment } from "@mochi/chain";
import { createAttestorApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createChainAdapter } from "./adapters/chain.ts";
import { createEnclaveHttp } from "./adapters/enclave-http.ts";
import { createStore } from "./adapters/store.ts";
import { startAttestationChecks } from "./scheduler.ts";
import { log } from "./log.ts";

const config = loadConfig();
const deployment = loadDeployment(config.MOCHI_DEPLOYMENT);
const db = createDb(config.DATABASE_URL);
const verifier = quoteVerifierFromEnv(process.env, { rootAddress: config.MOCK_ROOT_ADDRESS as `0x${string}` | undefined });
const { app, attestor } = createAttestorApp({
  chain: createChainAdapter(deployment, config.ATTESTOR_KEY as `0x${string}` | undefined),
  http: createEnclaveHttp(config.HTTP_TIMEOUT_MS),
  store: createStore(db.db),
  quoteVerifier: verifier,
  clock: { nowSeconds: () => Math.floor(Date.now() / 1_000), nowDate: () => new Date() },
  startBlock: BigInt(deployment.startBlock),
  validitySec: config.VALIDITY_SEC,
  maxQuoteAgeSec: config.MAX_QUOTE_AGE_SEC,
  adminToken: config.ADMIN_TOKEN,
  dissenterExcludedLineages: config.DISSENTER_EXCLUDED_LINEAGES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
});

const server = Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.PORT, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
log("info", "attestor_started", { port: server.port, intervalMs: config.INTERVAL_MS });
// Each key is checked on its own schedule: every INTERVAL_MS while it passes, and after a failure with a backoff bounded
// by its own remaining validity (see scheduler.ts), so one failing key never delays the others.
const runCheck = async (isDue: (key: string) => boolean) => {
  try {
    const results = await attestor.checkAll(isDue);
    log("info", "attestation_check_complete", { checked: results.length, passing: results.filter((row) => row.ok).length });
    return results.map((row) => ({ key: row.address, ok: row.ok, attestedUntilSec: attestor.attestedUntil(row.address) }));
  } catch (error) {
    log("error", "attestation_check_failed", { error: error instanceof Error ? error.message : "unknown" });
    throw error;
  }
};
startAttestationChecks(runCheck, config.INTERVAL_MS);
