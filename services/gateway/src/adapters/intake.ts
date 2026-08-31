import type { IntakeClient } from "../ports.ts";

export function createIntakeClient(baseUrl: string, timeoutMs: number): IntakeClient {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(path, baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Intake request failed (${response.status})`);
    return response.json();
  };
  return { request, attestation: () => request("/v1/attestation") };
}
