import { Hono } from "hono";
import { AnswerReqSchema } from "@mochi/protocol";
import type { JurorEnclave } from "./juror.ts";
import { JurorError } from "./juror.ts";
import { log } from "./log.ts";

export function createJurorApp(juror: JurorEnclave, enrollment?: () => Promise<unknown>) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/attestation", async (c) => c.json(await juror.attestation()));
  app.get("/v1/enrollment", async (c) => enrollment
    ? c.json(await enrollment())
    : c.json({ error: { code: "NOT_CONFIGURED", message: "Juror operator is not configured" } }, 503));
  app.post("/v1/answer", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: { code: "INVALID_JSON", message: "request body must be JSON" } }, 400); }
    const parsed = AnswerReqSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "INVALID_REQUEST", message: "request body is invalid" } }, 400);
    try {
      return c.json(await juror.answer(parsed.data, c.req.raw.signal));
    } catch (error) {
      if (error instanceof JurorError) {
        log(error.status >= 500 ? "error" : "warn", "juror.answer.rejected", { queryId: parsed.data.queryId, seat: parsed.data.seat, code: error.code });
        return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
      }
      log("error", "juror.answer.failed", { queryId: parsed.data.queryId, seat: parsed.data.seat, code: "INTERNAL" });
      return c.json({ error: { code: "INTERNAL", message: "request failed" } }, 500);
    }
  });
  return { app, juror };
}
