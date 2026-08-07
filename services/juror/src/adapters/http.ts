import type { SubmitAnswerReq } from "@mochi/protocol";
import type { HttpPoster } from "../ports.ts";

export class FetchHttpPoster implements HttpPoster {
  async post(url: string, body: SubmitAnswerReq, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`consensus returned HTTP ${response.status}`);
    } finally { clearTimeout(timeout); }
  }
}
