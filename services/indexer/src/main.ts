import { createReceiptSigner } from "@mochi/receipts";
import { createStoreAdapter } from "./adapters/store.ts";
import { fetchAlerts } from "./adapters/alert.ts";
import { loadChainAdapter } from "./adapters/chain.ts";
import { createIndexerApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createIndexerLoops } from "./loops/index.ts";
import { log } from "./log.ts";

const config = loadConfig();
const chain = loadChainAdapter(config.MOCHI_DEPLOYMENT, config.ANCHORER_KEY as `0x${string}` | undefined);
const database = createStoreAdapter(config.DATABASE_URL);
const signer = createReceiptSigner(config.RECEIPT_SIGNING_KEY
  ? { pkcs8DerBase64: config.RECEIPT_SIGNING_KEY }
  : {});
const dependencies = {
  chain,
  store: database.store,
  signer,
  alert: fetchAlerts,
  alertUrl: config.ALERT_WEBHOOK_URL,
};
const { app } = createIndexerApp(dependencies);
const loops = createIndexerLoops(dependencies);
const server = Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.PORT, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
const stopLoops = loops.start(config.POLL_MS, config.PURGE_INTERVAL_MS);

log("info", "indexer_started", {
  port: config.PORT,
  pollMs: config.POLL_MS,
  purgeIntervalMs: config.PURGE_INTERVAL_MS,
  keyId: signer.keyId,
});

/** Stop the HTTP server and close the database pool. */
async function shutdown(): Promise<void> {
  stopLoops();
  server.stop();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
