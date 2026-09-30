import { getEndpoint, createDb } from "@mochi/db";
import { createHttpClients } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { createChainAdapter } from "./adapters/chain.ts";
import { createDbAdapter } from "./adapters/db.ts";
import { createOrchestratorApp } from "./app.ts";
import { Orchestrator } from "./pipeline.ts";
import { log } from "./log.ts";
import { DrandClient, DRAND_QUICKNET } from "@mochi/chain";

const config = loadConfig();
const connection = createDb(config.DATABASE_URL);
const chain = createChainAdapter(config.deployment, config.ORCHESTRATOR_KEY as `0x${string}`, config.FEED_RUNNER_KEY as `0x${string}`);
const store = createDbAdapter(connection.db);
const clients = createHttpClients(60_000, config.JUROR_TIMEOUT_MS);
const orchestrator = new Orchestrator({
  chain, ...(config.deployment.randomness?.kind === "drand" ? { drand: new DrandClient({ relays: config.drandRelays ?? config.deployment.randomness.relays, chainHash: config.deployment.randomness.chainHash, info: { ...DRAND_QUICKNET, ...config.deployment.randomness }, currentTime: () => chain.latestTimestamp().then(Number) }) } : {}), ...clients,
  directory: { async urlOf(address) { return (await getEndpoint(connection.db, address.toLowerCase()))?.url; } },
  store, clock: { now: () => Date.now(), sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)) },
  config: { intakeUrl: config.INTAKE_URL, consensusUrl: config.CONSENSUS_URL, jurorTimeoutMs: config.JUROR_TIMEOUT_MS, closeMaxWaitMs: config.ROUND_CLOSE_MAX_WAIT_MS, maxParallelQueries: config.MAX_PARALLEL_QUERIES, feedRunnerKey: config.FEED_RUNNER_KEY as `0x${string}` },
});
const { app } = createOrchestratorApp({ orchestrator, store });
const port = Number(process.env.PORT ?? 8084);
const server = Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
log("info", "orchestrator.started", { port });
let stopping = false;
let wakePoll: (() => void) | undefined;
const stop = () => { stopping = true; wakePoll?.(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
while (!stopping) {
  try { await orchestrator.tick(); }
  catch { log("error", "orchestrator.tick_failed"); }
  if (!stopping) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { wakePoll = undefined; resolve(); }, config.POLL_MS);
    wakePoll = () => { clearTimeout(timer); wakePoll = undefined; resolve(); };
  });
}
const drained = await orchestrator.shutdown();
if (!drained) log("warn", "orchestrator.shutdown_timeout");
await server.stop(true);
await connection.close();
process.exit(drained ? 0 : 1);
