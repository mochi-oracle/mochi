import { DispatchPanelResSchema, type DispatchPanelReq } from "@mochi/protocol";
import type { IntakeClient } from "../ports.ts";

export function createIntakeClient(baseUrl: string, timeoutMs = 15_000): IntakeClient {
  return {
    async dispatchPanel(req: DispatchPanelReq) {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/dispatch-panel`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Only the error code is kept (the app passes a few through with its own fixed messages).
        const code = await response.json().then((body: unknown) => {
          const value = (body as { error?: { code?: unknown } } | null)?.error?.code;
          return typeof value === "string" && /^[A-Z_]{1,64}$/.test(value) ? value : undefined;
        }, () => undefined);
        throw Object.assign(new Error("intake returned an error"), { status: response.status, ...(code ? { code } : {}) });
      }
      return DispatchPanelResSchema.parse(await response.json());
    },
  };
}
