import { Hono } from "hono";
import { ZodError } from "zod";
import { DispatchReqSchema, DispatchPanelReqSchema, IntakeReqSchema } from "@mochi/protocol";
import { IntakeEnclave, IntakeError } from "./intake.ts";
import { FetchError } from "./fetcher.ts";
import type { Envelope } from "@mochi/tee";

export function createIntakeApp(intake: IntakeEnclave) {
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: { code: "INTERNAL", message: "Internal service error" } }, 500));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/attestation", async (c) => c.json(await intake.attestation()));
  app.post("/v1/intake/upload", async (c) => run(c, async (body) => intake.intakeUpload(IntakeReqSchema.parse(body).envelope as unknown as Envelope)));
  app.post("/v1/intake/url", async (c) => run(c, async (body) => intake.intakeUrl(IntakeReqSchema.parse(body).envelope as unknown as Envelope)));
  app.post("/v1/dispatch", async (c) => run(c, async (body) => intake.dispatch(DispatchReqSchema.parse(body))));
  app.post("/v1/dispatch-panel", async (c) => run(c, async (body) => intake.dispatchPanel(DispatchPanelReqSchema.parse(body))));
  return { app, intake };
}
async function run(c: { req: { json(): Promise<unknown> }; json(body: unknown, status?: number): Response }, action: (body: unknown) => Promise<unknown>) {
  try { return c.json(await action(await c.req.json())); }
  catch (error) {
    const status = error instanceof IntakeError || error instanceof FetchError ? error.status : error instanceof SyntaxError || error instanceof ZodError ? 400 : 500;
    const code = error instanceof IntakeError || error instanceof FetchError ? error.code : status === 400 ? "BAD_REQUEST" : "INTERNAL";
    const message = error instanceof IntakeError || error instanceof FetchError ? error.message : status === 400 ? "Request body is invalid" : "Internal service error";
    // Internal errors: log the error message only (never bodies — they carry sealed documents, params, salts).
    if (status >= 500) console.error(JSON.stringify({ level: "error", event: "intake_internal_error", code, error: String((error as Error)?.message ?? error).slice(0, 300) }));
    return c.json({ error: { code, message } }, status as 400);
  }
}
