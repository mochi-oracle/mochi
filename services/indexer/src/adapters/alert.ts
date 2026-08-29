import type { AlertPort } from "../ports.ts";

/** Send alerts as JSON and abort outbound requests at the supplied timeout. */
export const fetchAlerts: AlertPort = {
  async post(url, payload, timeoutMilliseconds) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  },
};
