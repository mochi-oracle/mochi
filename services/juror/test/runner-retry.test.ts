import { expect, test } from "bun:test";
import { PhalaAciRunner, RunnerError } from "../src/runner.ts";

const input = { system: "s", user: "u", document: "private document text", jsonSchema: { type: "object" }, maxTokens: 64 };
const ok = { json: { choices: [{ message: { content: "{\"fields\":{}}" } }] }, receipt: { receiptId: "r", sessionId: "s", workloadId: "w", modelId: "provider/model" }, established: { workloadId: "w", tcbStatus: "UpToDate" } };
const httpError = (httpStatus: number, code = "inference_http") => Object.assign(new Error("provider body and private prompt must stay hidden"), { code, httpStatus });
const instant = { sleep: async () => {}, random: () => 0 };

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
