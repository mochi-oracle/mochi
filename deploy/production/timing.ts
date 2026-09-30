import { TimingEventSchema } from "@mochi/protocol";
import type { Readable } from "node:stream";

/** Drop every non-timing line, unknown field and oversized record before public logging. */
export function forwardTimingEvents(stream: Readable | null, write: (line: string) => void = line => process.stdout.write(line)): void {
  if (!stream) return;
  let pending = "";
  let dropping = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) pending += part;
      if (pending.length > 2048) { pending = ""; dropping = true; }
      if (part.endsWith("\n")) {
        if (!dropping) {
          try { const event = TimingEventSchema.safeParse(JSON.parse(pending)); if (event.success) write(JSON.stringify(event.data) + "\n"); } catch { /* never forward arbitrary logs */ }
        }
        pending = ""; dropping = false;
      }
    }
  });
}

/** Fixed, validated launch values; children receive them explicitly rather than inheriting VM variables. */
export function productionTiming() {
  const values = { ROUND_TIMEOUT_MS: 120_000, JUROR_TIMEOUT_MS: 125_000, MODEL_TIMEOUT_MS: 125_000, MODEL_ATTEMPT_CAP_MS: 75_000, MODEL_MAX_ATTEMPTS: 3, DELIVERY_RESERVE_MS: 10_000, ROUND_CLOSE_MAX_WAIT_MS: 125_000, POLL_MS: 1000, MAX_PARALLEL_QUERIES: 8 };
  for (const value of Object.values(values)) if (!Number.isSafeInteger(value) || value <= 0 || value > 125_000) throw new Error("invalid production timing");
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)]));
}
