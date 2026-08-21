import { Hono } from "hono";
import type { Orchestrator } from "./pipeline.ts";
import type { Store } from "./ports.ts";

export function createOrchestratorApp(deps: { orchestrator: Orchestrator; store: Store }) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/status", async (c) => c.json({ counts: await deps.store.statusCounts(), lastBlockProcessed: deps.orchestrator.lastBlockProcessed }));
  return { app };
}
