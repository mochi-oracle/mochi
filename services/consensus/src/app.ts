import { Hono } from "hono";
import { RoundOpenReqSchema, SubmitAnswerReqSchema, hex32 } from "@mochi/protocol";
import type { ConsensusEnclave } from "./rounds.ts";
import { ConsensusError } from "./rounds.ts";
import type { Hex } from "viem";

export function createConsensusApp(enclave: ConsensusEnclave) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/attestation", async (c) => {
    try { return c.json(await enclave.attestation()); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/rounds", async (c) => {
    const body = await readBody(c, RoundOpenReqSchema);
    if (!body.ok) return body.response;
    try { return c.json(await enclave.openRound(body.value), 200); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/rounds/:queryId/answers", async (c) => {
    const queryId = hex32.safeParse(c.req.param("queryId"));
    if (!queryId.success) return c.json({ error: { code: "INVALID_QUERY_ID", message: "queryId must be lowercase bytes32" } }, 400);
    const body = await readBody(c, SubmitAnswerReqSchema);
    if (!body.ok) return body.response;
    if (body.value.queryId !== queryId.data) return c.json({ error: { code: "QUERY_ID_MISMATCH", message: "path and body queryId differ" } }, 400);
    try { return c.json(await enclave.submitAnswer(body.value)); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/rounds/:queryId/close", async (c) => {
    const queryId = hex32.safeParse(c.req.param("queryId"));
    if (!queryId.success) return c.json({ error: { code: "INVALID_QUERY_ID", message: "queryId must be lowercase bytes32" } }, 400);
    try { return c.json(await enclave.closeRound(queryId.data as Hex)); }
    catch (error) { return errorResponse(c, error); }
  });
  return { app, enclave };
}

async function readBody<T extends { parse: (input: unknown) => unknown }>(c: { req: { json: () => Promise<unknown> }; json: (value: unknown, status?: number) => Response }, schema: T): Promise<{ ok: true; value: ReturnType<T["parse"]> } | { ok: false; response: Response }> {
  try { return { ok: true, value: schema.parse(await c.req.json()) as ReturnType<T["parse"]> }; }
  catch { return { ok: false, response: c.json({ error: { code: "INVALID_REQUEST", message: "request body failed validation" } }, 400) }; }
}

function errorResponse(c: { json: (value: unknown, status?: number) => Response }, error: unknown) {
  if (error instanceof ConsensusError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  return c.json({ error: { code: "INTERNAL", message: "internal enclave error" } }, 500);
}
