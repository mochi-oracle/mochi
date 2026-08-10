import { Hono } from "hono";
import { z } from "zod";
import { address } from "@mochi/protocol";
import { createAttestor } from "./attestor.ts";
import type { AttestorDeps } from "./ports.ts";

const EndpointRegistrationSchema = z.object({
  address,
  role: z.enum(["JUROR", "INTAKE", "CONSENSUS"]),
  url: z.string().url(),
}).strict();
const roleNumber = { JUROR: 1, INTAKE: 2, CONSENSUS: 3 } as const;

export function createAttestorApp(deps: AttestorDeps) {
  const attestor = createAttestor(deps);
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/attestations", (c) => c.json({ attestations: attestor.listChecks() }));
  app.post("/v1/endpoints", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${deps.adminToken}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Admin bearer token required" } }, 401);
    }
    let parsed: z.infer<typeof EndpointRegistrationSchema>;
    try { parsed = EndpointRegistrationSchema.parse(await c.req.json()); }
    catch { return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid endpoint registration" } }, 400); }
    try {
      await attestor.registerEndpoint(parsed.address as `0x${string}`, roleNumber[parsed.role], parsed.url);
      return c.json({ ok: true }, 201);
    } catch (error) {
      const mismatch = error instanceof Error && error.message.includes("does not match");
      return c.json({
        error: {
          code: mismatch ? "ATTESTATION_MISMATCH" : "ENDPOINT_UNAVAILABLE",
          message: mismatch ? "Attestation identity does not match registration" : "Unable to retrieve a valid endpoint attestation",
        },
      }, mismatch ? 400 : 502);
    }
  });
  return { app, attestor };
}
