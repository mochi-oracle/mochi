import { Hono } from "hono";
import { z } from "zod";
import type { FeedScheduler } from "./scheduler.ts";
import type { RunnerName } from "./ports.ts";

const RunnerSchema = z.enum(["corp-actions", "earnings", "attestations"]);
export function createFeedRunnersApp(deps: { scheduler: FeedScheduler; adminToken: string }) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/feed-runners/status", (c) => c.json(deps.scheduler.status()));
  app.post("/v1/feed-runners/run/:runner", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${deps.adminToken}`) return c.json({ error: { code: "UNAUTHORIZED", message: "Admin token required" } }, 401);
    const parsed = RunnerSchema.safeParse(c.req.param("runner"));
    if (!parsed.success) return c.json({ error: { code: "INVALID_RUNNER", message: "Unknown runner" } }, 400);
    // Accept and run in the background (a 200-ticker run takes minutes); progress via GET /v1/feed-runners/status.
    void deps.scheduler.run(parsed.data as RunnerName, true).catch(() => undefined);
    return c.json({ accepted: true, runner: parsed.data }, 202);
  });
  return { app };
}
