import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { TimingEventSchema } from "@mochi/protocol";
import { forwardTimingEvents, productionTiming } from "./timing.ts";

const event = { queryId: `0x${"11".repeat(32)}`, round: 0, seat: 0, modelId: "qwen/qwen3.6-35b-a3b", call: "initial", attempt: 1, elapsedMs: 40000, remainingBudgetMs: 69000, causeCode: "timeout" };
test("every emitted public record rejects every non-allowlisted field", () => {
  for (const field of ["prompt", "document", "claims", "evidence", "answer", "spans", "key", "env", "error", "unknown"]) {
    expect(TimingEventSchema.safeParse({ ...event, [field]: "private" }).success).toBe(false);
  }
  expect(TimingEventSchema.safeParse({ ...event, causeCode: "private" }).success).toBe(false);
  const stream = new PassThrough(); const lines: string[] = [];
  forwardTimingEvents(stream, line => lines.push(line));
  stream.write("arbitrary private child output\n");
  stream.write(JSON.stringify({ ...event, prompt: "private" }) + "\n");
  stream.write("x".repeat(3000) + "\n");
  stream.write(JSON.stringify(event).slice(0, 100)); stream.write(JSON.stringify(event).slice(100) + "\n");
  expect(lines).toEqual([JSON.stringify(event) + "\n"]);
  expect(TimingEventSchema.parse(JSON.parse(lines[0]!))).toEqual(event);
});

test("production passes fixed validated timeouts explicitly to isolated children", () => {
  expect(productionTiming()).toEqual({ ROUND_TIMEOUT_MS: "120000", JUROR_TIMEOUT_MS: "125000", MODEL_TIMEOUT_MS: "125000", MODEL_ATTEMPT_CAP_MS: "40000", MODEL_MAX_ATTEMPTS: "3", DELIVERY_RESERVE_MS: "10000", ROUND_CLOSE_MAX_WAIT_MS: "125000" });
});
