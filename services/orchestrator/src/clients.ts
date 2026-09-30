import { AnswerResSchema, AttestationDocSchema, DecisionResSchema, DispatchReqSchema, DispatchResSchema, RoundOpenReqSchema } from "@mochi/protocol";
import { z } from "zod";
import type { IntakeClient, JurorClient, ConsensusClient } from "./ports.ts";

async function request<T>(url: string, init: RequestInit, timeoutMs: number, parse: (value: unknown) => T): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal, headers: { "content-type": "application/json", ...init.headers } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`service returned ${response.status}`), { status: response.status, body });
    return parse(body);
  } finally { clearTimeout(timer); }
}
const json = (body: unknown) => JSON.stringify(body);
export function createHttpClients(timeoutMs: number, jurorTimeoutMs = 125_000): { intake: IntakeClient; juror: JurorClient; consensus: ConsensusClient } {
  const attestation = (base: string) => request(`${base}/v1/attestation`, { method: "GET" }, timeoutMs, (x) => AttestationDocSchema.parse(x));
  return {
    intake: {
      attestation,
      dispatch: (base, req) => request(`${base}/v1/dispatch`, { method: "POST", body: json(DispatchReqSchema.parse(req)) }, timeoutMs, (x) => DispatchResSchema.parse(x)),
    },
    juror: { attestation, answer: (base, req, signal) => request(`${base}/v1/answer`, { method: "POST", signal, body: json(req) }, Math.max(1, Math.min(jurorTimeoutMs, req.deadlineMs + 5000 - Date.now())), (x) => AnswerResSchema.parse(x)) },
    consensus: {
      attestation,
      open: (base, req) => request(`${base}/v1/rounds`, { method: "POST", body: json(RoundOpenReqSchema.parse(req)) }, timeoutMs, (x) => z.object({ deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).parse(x)),
      close: (base, id, remainingMs) => request(`${base}/v1/rounds/${id}/close`, { method: "POST" }, Math.max(1, Math.min(timeoutMs, remainingMs ?? timeoutMs)), (x) => DecisionResSchema.parse(x)),
    },
  };
}
