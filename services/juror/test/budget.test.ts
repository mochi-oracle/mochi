import { expect, test } from "bun:test";
import { AnswerBudget } from "../src/budget.ts";
import { warmupModel } from "../src/warmup.ts";
import { PhalaAciRunner } from "../src/runner.ts";

test("stalled inference aborts at shared model deadline, preserving delivery reserve", async () => {
  const budget = new AnswerBudget(Date.now() + 100, 40);
  let signal: AbortSignal | undefined;
  const runner = new PhalaAciRunner({ client: { chat: async (_body: unknown, options: { signal: AbortSignal }) => { signal = options.signal; return new Promise(() => {}); } } as never, model: "provider/model", timeoutMs: 125_000, attemptCapMs: 40_000 });
  try {
    const start = Date.now();
    await expect(runner.run({ system: "", user: "", document: "", jsonSchema: {}, maxTokens: 10 }, { signal: budget.modelSignal, remainingMs: () => budget.remaining(true) })).rejects.toThrow();
    expect(signal?.aborted).toBe(true); expect(Date.now() - start).toBeLessThan(90); expect(budget.signal.aborted).toBe(false);
  } finally { budget.dispose(); }
});

test("warmup failure is nonfatal, retried, and never calls inference", async () => {
  let attempts = 0; const events: unknown[] = []; const waits: number[] = [];
  await expect(warmupModel({ attest: async () => { attempts++; throw new Error("private provider error"); } }, "provider/model", new AbortController().signal, event => events.push(event), { sleep: async ms => { waits.push(ms); } })).resolves.toBeUndefined();
  expect(attempts).toBe(3); expect(waits).toEqual([15000, 15000]); expect(JSON.stringify(events)).not.toContain("private");
});

test("warmup recovers after failure and requires UpToDate", async () => {
  let attempts = 0; const codes: string[] = [];
  await warmupModel({ attest: async () => ({ tcbStatus: ++attempts === 1 ? "OutOfDate" : "UpToDate" }) }, "provider/model", new AbortController().signal, event => codes.push(event.causeCode), { sleep: async () => {} });
  expect(codes).toEqual(["warmup_failed", "warmup_ok"]);
});
