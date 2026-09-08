import { Hono } from "hono";
import { encodePacked, fromHex, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { evaluatorKeyDigest, DispatchPanelResSchema, type DispatchPanelReq } from "@mochi/protocol";
import { ZERO32 } from "@mochi/core";
import { z } from "zod";
import type { PanelDeps } from "./ports.ts";
import { log } from "./log.ts";

const materialsBody = z.object({ evaluator: z.string().regex(/^0x[0-9a-f]{40}$/), encryptionPubKey: z.string().regex(/^0x[0-9a-f]{64}$/), keySig: z.string().regex(/^0x([0-9a-f]{2})+$/) });
const payloadBody = z.object({ evaluator: z.string().regex(/^0x[0-9a-f]{40}$/), panelIndex: z.union([z.literal(0), z.literal(1)]), payload: z.string().regex(/^0x([0-9a-f]{2})+$/), answerJson: z.string().min(1), sig: z.string().regex(/^0x([0-9a-f]{2})+$/) });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const asHex = (value: string) => value.toLowerCase() as Hex;

export function createPanelDeskApp(deps: PanelDeps) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/panel/:caseId", async (c) => {
    if (!/^0x[0-9a-f]{64}$/.test(c.req.param("caseId"))) return c.json({ error: { code: "BAD_CASE_ID", message: "Invalid case id" } }, 400);
    try {
      const item = await deps.chain.getCase(asHex(c.req.param("caseId")));
      if (item.status === 0) return c.json({ error: { code: "NOT_FOUND", message: "Panel case was not found" } }, 404);
      return c.json({ caseId: c.req.param("caseId"), queryId: item.queryId, status: item.status, panelIndex: item.panelIndex,
        sealBlock: item.sealBlock.toString(), commitDeadline: item.commitDeadline.toString(), revealDeadline: item.revealDeadline.toString(),
        appealDeadline: item.appealDeadline.toString(), payer: item.payer.toLowerCase(), fee: item.fee.toString(),
        outcomeAnswerHash: item.outcomeAnswerHash, outcomePayloadHash: item.outcomePayloadHash });
    } catch { return c.json({ error: { code: "CHAIN_UNAVAILABLE", message: "Could not read panel case" } }, 502); }
  });

  app.post("/v1/panel/:caseId/materials", async (c) => {
    const parsed = materialsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !/^0x[0-9a-f]{64}$/.test(c.req.param("caseId"))) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid materials request" } }, 400);
    const caseId = asHex(c.req.param("caseId"));
    try {
      const item = await deps.chain.getCase(caseId);
      if (item.status === 0 || item.status === 7) return c.json({ error: { code: "CASE_CLOSED", message: "Panel case is not open" } }, 409);
      const evaluator = parsed.data.evaluator as Address;
      const panel = await deps.chain.panelOf(caseId, item.panelIndex);
      if (!panel.some((member) => same(member, evaluator))) return c.json({ error: { code: "NOT_PANELIST", message: "Evaluator is not on the current panel" } }, 403);
      const query = await deps.chain.getQuery(item.queryId);
      const dispatchReq: DispatchPanelReq = { queryId: item.queryId, panelIndex: item.panelIndex as 0 | 1, evaluators: [{ address: evaluator, encryptionPubKey: parsed.data.encryptionPubKey as Hex, keySig: parsed.data.keySig as Hex }] };
      const response = DispatchPanelResSchema.parse(await deps.intake.dispatchPanel(dispatchReq));
      const envelope = response.evaluators.find((x) => same(x.address, evaluator))?.docEnvelope;
      if (!envelope) throw new Error("intake omitted evaluator envelope");
      let jurorSummary: unknown = null;
      if (query.isPublic) {
        const latestId = await deps.chain.latestVerdictOf(item.queryId);
        if (!same(latestId, ZERO32)) {
          const record = await deps.store.getVerdict(latestId);
          if (record?.verdict.isPublic && record.publicPart) jurorSummary = { dissent: record.publicPart.dissent, agreement: record.publicPart.fieldAgreement };
        }
      }
      return c.json({ caseId, queryId: item.queryId, panelIndex: item.panelIndex, evaluator, schemaId: query.schemaId, schemaVersion: query.schemaVersion, docEnvelope: envelope, jurorSummary });
    } catch (error) {
      log("warn", "panel_materials_failed", { caseId, code: error instanceof Error && "code" in error ? String(error.code) : "UPSTREAM_ERROR" });
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 502;
      return c.json({ error: { code: status < 500 ? "MATERIALS_REJECTED" : "INTAKE_UNAVAILABLE", message: status < 500 ? "Materials request was rejected" : "Could not dispatch evaluator materials" } }, status as 400);
    }
  });

  app.post("/v1/panel/:caseId/payload", async (c) => {
    const parsed = payloadBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !/^0x[0-9a-f]{64}$/.test(c.req.param("caseId"))) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid payload submission" } }, 400);
    const caseId = asHex(c.req.param("caseId"));
    try {
      const item = await deps.chain.getCase(caseId);
      if (parsed.data.panelIndex !== item.panelIndex) return c.json({ error: { code: "WRONG_PANEL", message: "Submission is for a different panel" } }, 409);
      const evaluator = parsed.data.evaluator as Address;
      if (!(await deps.chain.panelOf(caseId, item.panelIndex)).some((member) => same(member, evaluator))) return c.json({ error: { code: "NOT_PANELIST", message: "Evaluator is not on the current panel" } }, 403);
      const payload = asHex(parsed.data.payload);
      const payloadHash = keccak256(payload);
      const digest = keccak256(encodePacked(["string", "bytes32", "uint8", "bytes32"], ["mochi/panel-payload/v1", caseId, parsed.data.panelIndex, payloadHash]));
      let signer: Address;
      try { signer = await recoverMessageAddress({ message: { raw: digest }, signature: parsed.data.sig as Hex }); }
      catch { return c.json({ error: { code: "BAD_SIGNATURE", message: "Payload signature is invalid" } }, 403); }
      if (!same(signer, evaluator)) return c.json({ error: { code: "BAD_SIGNATURE", message: "Payload signature is invalid" } }, 403);
      const query = await deps.chain.getQuery(item.queryId);
      // Private answers can contain private field values. They are used to form the signed commitment but never kept by the relay.
      if (query.isPublic) await deps.store.insertPanelPayload({ caseId, panelIndex: item.panelIndex, evaluator, payloadHash, payload: fromHex(payload, "bytes"), answerJson: parsed.data.answerJson });
      return c.json({ caseId, panelIndex: item.panelIndex, evaluator, payloadHash }, 201);
    } catch {
      return c.json({ error: { code: "PAYLOAD_FAILED", message: "Could not accept payload" } }, 500);
    }
  });
  return { app };
}
