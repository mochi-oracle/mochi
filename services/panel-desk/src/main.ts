import { createDb } from "@mochi/db";
import { loadConfig } from "./config.ts";
import { createPanelChain } from "./adapters/chain.ts";
import { createIntakeClient } from "./adapters/intake.ts";
import { createPanelStore } from "./adapters/store.ts";
import { createPanelDeskApp } from "./app.ts";
import { PanelKeeper } from "./keeper.ts";
import { log } from "./log.ts";
import { DrandClient, DRAND_QUICKNET, loadDeployment } from "@mochi/chain";

const config = loadConfig();
const database = createDb(config.databaseUrl);
const chain = createPanelChain({ deploymentPath: config.deploymentPath, rpcUrl: config.rpcUrl, keeperKey: config.keeperKey as `0x${string}`, confirmations: config.confirmations });
const store = createPanelStore(database.db);
const dep = loadDeployment(config.deploymentPath);
const deps = { chain, ...(dep.randomness?.kind === "drand" ? { drand: new DrandClient({ relays: config.drandRelays ?? dep.randomness.relays, chainHash: dep.randomness.chainHash, info: { ...DRAND_QUICKNET, ...dep.randomness }, currentTime: () => chain.timestamp().then(Number) }) } : {}), intake: createIntakeClient(config.intakeUrl), store, clock: { sleep: (ms: number) => Bun.sleep(ms) }, config };
const { app } = createPanelDeskApp(deps);
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.port, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
log("info", "panel_desk_started", { port: config.port, pollMs: config.pollMs });
void new PanelKeeper(deps).run();

process.on("SIGINT", async () => { await database.close(); process.exit(0); });
process.on("SIGTERM", async () => { await database.close(); process.exit(0); });
