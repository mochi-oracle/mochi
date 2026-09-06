import { loadConfig } from "./config.ts";
import { createAnonymaSettleApp } from "./app.ts";
import { createRuntimePorts } from "./adapters/runtime.ts";
import { nextSettlement, previousWeek, runSettlement } from "./settle.ts";
import { log } from "./log.ts";

const config = loadConfig();
const runtime = createRuntimePorts(config);
const { app } = createAnonymaSettleApp({ ports: runtime.ports, adminToken: config.ADMIN_TOKEN, hmacSecret: config.STATEMENT_HMAC_SECRET, targetFloat: BigInt(config.TARGET_FLOAT) });
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.PORT, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
log("info", "anonyma_settle_started", { port: config.PORT });
async function scheduledLoop() {
  for (;;) {
    const when = nextSettlement(new Date(), config.SETTLE_WEEKDAY, config.SETTLE_UTC_HOUR);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, when.getTime() - Date.now())));
    const period = previousWeek(new Date(when.getTime() + 1000));
    try {
      const result = await runSettlement(period.start, period.end, runtime.ports, { targetFloat: BigInt(config.TARGET_FLOAT), hmacSecret: config.STATEMENT_HMAC_SECRET });
      log("info", "anonyma_settlement_completed", { periodEnd: period.end.toISOString(), clean: result.reconciliation.clean, voucherCount: result.statement.vouchers.length });
    } catch (error) { log("error", "anonyma_settlement_failed", { message: error instanceof Error ? error.message : "unknown error" }); }
  }
}
void scheduledLoop();
process.on("SIGINT", () => { void runtime.close().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void runtime.close().then(() => process.exit(0)); });
