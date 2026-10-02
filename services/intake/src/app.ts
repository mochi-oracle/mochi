import { Hono } from "hono";
import { ZodError } from "zod";
import { DispatchReqSchema, DispatchPanelReqSchema, IntakeReqSchema } from "@mochi/protocol";
import { IntakeEnclave, IntakeError } from "./intake.ts";
import { FetchError } from "./fetcher.ts";
import { EmptyDocument } from "./extract.ts";
import { SealedStoreFullError, type Envelope } from "@mochi/tee";

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
/** Seconds a client should wait before retrying when the store is full (one retention sweep). */
const STORE_FULL_RETRY_AFTER = 600;
async function run(c: { req: { json(): Promise<unknown> }; json(body: unknown, status?: number, headers?: Record<string, string>): Response }, action: (body: unknown) => Promise<unknown>) {
  try { return c.json(await action(await c.req.json())); }
  catch (error) {
    // Capacity, not a fault: the sealed store refuses new uploads until expired ones are swept.
    if (error instanceof SealedStoreFullError) {
      return c.json({ error: { code: "STORE_FULL", message: "Intake storage is temporarily full; retry later" } }, 503, { "retry-after": String(STORE_FULL_RETRY_AFTER) });
    }
    const known = error instanceof IntakeError || error instanceof FetchError || error instanceof EmptyDocument;
    const status = known ? error.status : error instanceof SyntaxError || error instanceof ZodError ? 400 : 500;
    const code = known ? error.code : status === 400 ? "BAD_REQUEST" : "INTERNAL";
    const message = known ? error.message : status === 400 ? "Request body is invalid" : "Internal service error";
    // Internal errors: log the error message only (never bodies — they carry sealed documents, params, salts).
    if (status >= 500) console.error(JSON.stringify({ level: "error", event: "intake_internal_error", code, error: String((error as Error)?.message ?? error).slice(0, 300) }));
    return c.json({ error: { code, message } }, status as 400);
  }
}
