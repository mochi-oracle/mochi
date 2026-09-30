import type { SubmitAnswerReq } from "@mochi/protocol";
import type { HttpPoster } from "../ports.ts";

export class FetchHttpPoster implements HttpPoster {
  async post(url: string, body: SubmitAnswerReq, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        throw Object.assign(new Error("consensus delivery failed"), { httpStatus: response.status, late: result?.error?.code === "ROUND_CLOSED" });
      }
    } finally { clearTimeout(timeout); }
  }
}
