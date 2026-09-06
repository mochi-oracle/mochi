import { Hono } from "hono";
import { z } from "zod";
import type { SettlePorts } from "./ports.ts";
import { runSettlement, verifySignature, previousWeek, type Statement } from "./settle.ts";

export interface AppOptions { ports: SettlePorts; adminToken: string; hmacSecret: string; targetFloat: bigint }
export function createAnonymaSettleApp(options: AppOptions) {
  const app = new Hono();
  const auth = (header: string | undefined) => header === `Bearer ${options.adminToken}`;
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/anonyma/statements/:periodEnd", async (c) => {
    if (!auth(c.req.header("authorization"))) return c.json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } }, 401);
    const periodEnd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(c.req.param("periodEnd"));
    if (!periodEnd.success) return c.json({ error: { code: "INVALID_PERIOD", message: "periodEnd must be YYYY-MM-DD" } }, 400);
    const body = await options.ports.files.readStatement(periodEnd.data);
    if (!body) return c.json({ error: { code: "NOT_FOUND", message: "Statement not found" } }, 404);
    const signature = await options.ports.files.readStatement(`${periodEnd.data}.sig`);
    if (!signature || !verifySignature(options.hmacSecret, body, signature.trim())) return c.json({ error: { code: "INVALID_SIGNATURE", message: "Stored statement signature is missing or invalid" } }, 500);
    try { return c.json({ statement: JSON.parse(body) as Statement, signature: signature.trim() }); }
    catch { return c.json({ error: { code: "INVALID_STATEMENT", message: "Stored statement is not valid JSON" } }, 500); }
  });
  app.post("/v1/anonyma/settle", async (c) => {
    if (!auth(c.req.header("authorization"))) return c.json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } }, 401);
    const bodySchema = z.object({ periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional() }).strict();
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: { code: "INVALID_JSON", message: "Body must be valid JSON" } }, 400); }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success || Boolean(parsed.data.periodStart) !== Boolean(parsed.data.periodEnd)) return c.json({ error: { code: "INVALID_BODY", message: "Provide both periodStart and periodEnd as ISO timestamps, or neither" } }, 400);
    const period = parsed.data.periodStart ? { start: new Date(parsed.data.periodStart!), end: new Date(parsed.data.periodEnd!) } : previousWeek(options.ports.clock.now());
    try {
      const result = await runSettlement(period.start, period.end, options.ports, { targetFloat: options.targetFloat, hmacSecret: options.hmacSecret });
      return c.json(result);
    } catch (error) { return c.json({ error: { code: "SETTLEMENT_FAILED", message: error instanceof Error ? error.message : "Settlement failed" } }, 500); }
  });
  return { app };
}
