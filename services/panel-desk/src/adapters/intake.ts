import { DispatchPanelResSchema, type DispatchPanelReq } from "@mochi/protocol";
import type { IntakeClient } from "../ports.ts";

export function createIntakeClient(baseUrl: string, timeoutMs = 15_000): IntakeClient {
  return {
    async dispatchPanel(req: DispatchPanelReq) {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/dispatch-panel`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw Object.assign(new Error("intake returned an error"), { status: response.status });
      return DispatchPanelResSchema.parse(await response.json());
    },
  };
}
