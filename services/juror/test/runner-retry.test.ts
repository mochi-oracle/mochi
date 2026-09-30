import { expect, test } from "bun:test";
import { PhalaAciRunner, RunnerError } from "../src/runner.ts";
import { loadConfig } from "../src/config.ts";
import { productionTiming } from "../../../deploy/production/timing.ts";

const input = { system: "s", user: "u", document: "private document text", jsonSchema: { type: "object" }, maxTokens: 64 };
const ok = { json: { choices: [{ message: { content: "{\"fields\":{}}" } }] }, receipt: { receiptId: "r", sessionId: "s", workloadId: "w", modelId: "provider/model" }, established: { workloadId: "w", tcbStatus: "UpToDate" } };
const httpError = (httpStatus: number, code = "inference_http") => Object.assign(new Error("provider body and private prompt must stay hidden"), { code, httpStatus });
const instant = { sleep: async () => {}, random: () => 0 };

test("juror defaults mirror production's 75-second cap and at most three attempts", () => {
  const config = loadConfig({});
  expect(config.MODEL_ATTEMPT_CAP_MS).toBe(Number(productionTiming().MODEL_ATTEMPT_CAP_MS));
  expect(config.MODEL_MAX_ATTEMPTS).toBe(3);
  for (const limit of [4, 5]) expect(() => loadConfig({ MODEL_MAX_ATTEMPTS: String(limit) })).toThrow();
});

test("a 60-second provider completes; a still-running provider aborts at 75 seconds without a hopeless retry", async () => {
  const timing = productionTiming();
  const options = { model: "qwen/qwen3.6-35b-a3b", timeoutMs: Number(timing.MODEL_TIMEOUT_MS), attemptCapMs: Number(timing.MODEL_ATTEMPT_CAP_MS), maxAttempts: Number(timing.MODEL_MAX_ATTEMPTS), retry: instant };
  const events: Array<{ elapsedMs: number; remainingBudgetMs: number; code: string }> = [];
  let slowSignal: AbortSignal | undefined;
  let stalledSignal: AbortSignal | undefined;
  let stalledCalls = 0;
  const slow = new PhalaAciRunner({ ...options, client: { chat: async (_body: unknown, { signal }: { signal: AbortSignal }) => {
    slowSignal = signal;
    await new Promise(resolve => setTimeout(resolve, 60_000));
    return ok as never;
  } } as never });
  const stalled = new PhalaAciRunner({ ...options, client: { chat: async (_body: unknown, { signal }: { signal: AbortSignal }) => {
    stalledCalls++; stalledSignal = signal;
    return new Promise(() => {});
  } } as never });
  // A round has at most 110 seconds of model time, less dispatch/check overhead.
  const start = Date.now();
  const budget = { signal: new AbortController().signal, remainingMs: () => 109_697 - (Date.now() - start) };
  const [value, failure] = await Promise.all([
    slow.run(input, budget),
    stalled.run(input, { ...budget, onAttempt: event => events.push(event) }).catch(error => error),
  ]);
  expect(value).toEqual({ fields: {} });
  expect(slow.lastAttempts).toBe(1);
  expect(slowSignal?.aborted).toBe(false);
  expect(failure).toBeInstanceOf(RunnerError);
  expect((failure as RunnerError).diagnosticCode).toBe("timeout");
  expect(stalledSignal?.aborted).toBe(true);
  expect(stalledCalls).toBe(1);
  expect(events).toHaveLength(1);
  expect(events[0]!.code).toBe("timeout");
  expect(events[0]!.elapsedMs).toBeGreaterThanOrEqual(75_000);
  expect(events[0]!.elapsedMs).toBeLessThan(77_000);
  expect(events[0]!.remainingBudgetMs).toBeLessThan(35_000);
}, 80_000);

test("a fast 503 at 2 seconds retries and can finish a 60-second provider call", async () => {
  let now = 0; let calls = 0;
  const runner = new PhalaAciRunner({ client: { chat: async () => {
    calls++; now += calls === 1 ? 2_000 : 60_000;
    if (calls === 1) throw httpError(503);
    return ok as never;
  } } as never, model: "m", timeoutMs: 125_000, retry: { ...instant, now: () => now } });
  expect(await runner.run(input, { signal: new AbortController().signal, remainingMs: () => 109_697 - now })).toEqual({ fields: {} });
  expect(calls).toBe(2);
  expect(runner.lastAttempts).toBe(2);
});

test("juror retries require at least 35 seconds remaining, including after backoff", async () => {
  for (const [elapsed, oversleep, expectedCalls] of [[75_001, 0, 1], [75_000, 0, 2], [74_999, 2, 1]]) {
    let now = 0; let calls = 0;
    const runner = new PhalaAciRunner({ client: { chat: async () => {
      calls++; if (calls === 1) { now += elapsed!; throw httpError(503); }
      return ok as never;
    } } as never, model: "m", timeoutMs: 125_000, retry: { now: () => now, random: () => 0, sleep: async () => { now += oversleep!; } } });
    const result = await runner.run(input, { signal: new AbortController().signal, remainingMs: () => 110_000 - now }).catch(error => error);
    expect(calls).toBe(expectedCalls!);
    if (expectedCalls === 2) expect(result).toEqual({ fields: {} });
    else expect(result).toBeInstanceOf(RunnerError);
  }
});

test("a rate-limited juror call is retried with the byte-identical request and succeeds", async () => {
  const bodies: string[] = [];
  const runner = new PhalaAciRunner({ client: { chat: async (body: unknown) => { bodies.push(JSON.stringify(body)); if (bodies.length === 1) throw httpError(429); return ok as never; } } as never, model: "provider/model", timeoutMs: 60_000, retry: instant });
  expect(await runner.run(input)).toEqual({ fields: {} });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]!);
  expect(runner.lastAttempts).toBe(2);
  expect(runner.lastFailure).toBeUndefined();
  expect(runner.lastReceipt?.receiptId).toBe("r");
});

test("gateway errors are retried up to the attempt limit, then reported without provider text", async () => {
  let calls = 0;
  const runner = new PhalaAciRunner({ client: { chat: async () => { calls++; throw httpError(503); } } as never, model: "m", timeoutMs: 60_000, retry: instant });
  await expect(runner.run(input)).rejects.toBeInstanceOf(RunnerError);
  expect(calls).toBe(3);
  expect(runner.lastFailure).toEqual({ causeCode: "inference_http", httpStatus: 503, attempts: 3, attemptFailures: [{ code: "inference_http", httpStatus: 503 }, { code: "inference_http", httpStatus: 503 }, { code: "inference_http", httpStatus: 503 }] });
  expect(JSON.stringify(runner.lastFailure)).not.toContain("private");
});

test("verification failures are never retried", async () => {
  for (const code of ["receipt_binding", "receipt_signature", "receipt_model", "tcb_status"]) {
    let calls = 0;
    const runner = new PhalaAciRunner({ client: { chat: async () => { calls++; throw Object.assign(new Error("x"), { code }); } } as never, model: "m", timeoutMs: 60_000, retry: instant });
    await expect(runner.run(input)).rejects.toBeInstanceOf(RunnerError);
    expect(calls).toBe(1);
    expect(runner.lastFailure).toEqual({ causeCode: code });
  }
});

test("MODEL_MAX_ATTEMPTS=1 keeps single-attempt behaviour", async () => {
  let calls = 0;
  const runner = new PhalaAciRunner({ client: { chat: async () => { calls++; throw httpError(503); } } as never, model: "m", timeoutMs: 60_000, maxAttempts: 1, retry: instant });
  await expect(runner.run(input)).rejects.toBeInstanceOf(RunnerError);
  expect(calls).toBe(1);
  expect(runner.lastFailure).toEqual({ causeCode: "inference_http", httpStatus: 503 });
});

test("a stalled attempt is cut and retried; the whole call stays inside the model timeout", async () => {
  let calls = 0;
  const runner = new PhalaAciRunner({ client: { chat: async (_body: unknown, options: { signal?: AbortSignal }) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "aborted" })), { once: true }));
    return ok as never;
  } } as never, model: "m", timeoutMs: 400, attemptCapMs: 80, retry: { random: () => 0, minAttemptMs: 10 } });
  const started = Date.now();
  expect(await runner.run(input)).toEqual({ fields: {} });
  expect(Date.now() - started).toBeLessThan(400);
  expect(runner.lastAttempts).toBe(2);
});

test("when every attempt stalls the failure is a timeout", async () => {
  const runner = new PhalaAciRunner({ client: { chat: async (_body: unknown, options: { signal?: AbortSignal }) => new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "aborted" })), { once: true })) } as never, model: "m", timeoutMs: 150, attemptCapMs: 40, retry: { random: () => 0, minAttemptMs: 10 } });
  const error = await runner.run(input).catch((e) => e);
  expect(error).toBeInstanceOf(RunnerError);
  expect((error as RunnerError).diagnosticCode).toBe("timeout");
  expect(runner.lastFailure?.causeCode).toBe("timeout");
});
