import { describe, expect, test } from "bun:test";
import { classifyProviderError, ProviderCallAborted, ProviderRetryError, withProviderRetries } from "../src/retry.ts";

const httpError = (httpStatus: number, retryAfterMs?: number, code = "inference_http") =>
  Object.assign(new Error("provider body must stay hidden"), { code, httpStatus, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });

// Deterministic clock: sleeping advances time instantly and records the waits.
function fakeClock() {
  let t = 0;
  const waits: number[] = [];
  return { waits, advance: (ms: number) => { t += ms; }, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, random: () => 0.5 };
}

describe("classifyProviderError", () => {
  test("retries rate limits, gateway errors, dropped connections and stalled attempts only", () => {
    for (const status of [429, 500, 502, 503, 504]) expect(classifyProviderError(httpError(status), false).retry).toBe(true);
    expect(classifyProviderError(httpError(503, undefined, "attestation_http"), false).retry).toBe(true);
    for (const status of [400, 401, 403, 404, 413, 422]) expect(classifyProviderError(httpError(status), false).retry).toBe(false);
    expect(classifyProviderError(new TypeError("fetch failed"), false)).toEqual({ retry: true, code: "network" });
    expect(classifyProviderError(new Error("anything"), true)).toEqual({ retry: true, code: "timeout" });
    for (const code of ["receipt_binding", "receipt_signature", "receipt_model", "tcb_status", "response_json", "inference_redirect", "request_confidentiality"]) {
      expect(classifyProviderError(Object.assign(new Error("x"), { code }), false)).toEqual({ retry: false, code });
    }
    expect(classifyProviderError(httpError(429, 2000), false)).toEqual({ retry: true, code: "inference_http", httpStatus: 429, retryAfterMs: 2000 });
  });
});

describe("withProviderRetries", () => {
  const base = { maxAttempts: 3, totalMs: 120_000, attemptCapMs: 60_000 };

  test("429 then success returns the value and counts both attempts", async () => {
    const clock = fakeClock();
    let calls = 0;
    const out = await withProviderRetries({ ...base, ...clock }, async () => { if (calls++ === 0) throw httpError(429); return "ok"; });
    expect(out).toEqual({ value: "ok", attempts: 2, failures: [{ code: "inference_http", httpStatus: 429 }] });
    expect(clock.waits).toEqual([250]); // full jitter: 0.5 × min(8000, 500 × 2^0)
  });

  test("two 503s then success; backoff grows", async () => {
    const clock = fakeClock();
    let calls = 0;
    const out = await withProviderRetries({ ...base, ...clock }, async () => { if (calls++ < 2) throw httpError(503); return 7; });
    expect(out.attempts).toBe(3);
    expect(clock.waits).toEqual([250, 500]);
  });

  test("Retry-After is honoured when it fits the budget", async () => {
    const clock = fakeClock();
    let calls = 0;
    await withProviderRetries({ ...base, ...clock }, async () => { if (calls++ === 0) throw httpError(429, 4000); return true; });
    expect(clock.waits).toEqual([4000]);
  });

  test("Retry-After longer than the remaining budget fails at once with the original error", async () => {
    const clock = fakeClock();
    const original = httpError(429, 200_000);
    let calls = 0;
    const error = await withProviderRetries({ ...base, ...clock }, async () => { calls++; throw original; }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderRetryError);
    expect((error as ProviderRetryError).lastError).toBe(original);
    expect((error as ProviderRetryError).failures).toEqual([{ code: "inference_http", httpStatus: 429 }]);
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("non-retryable failures are attempted exactly once", async () => {
    for (const failure of [Object.assign(new Error("x"), { code: "receipt_binding" }), Object.assign(new Error("x"), { code: "tcb_status" }), httpError(400), Object.assign(new Error("x"), { code: "response_json" })]) {
      let calls = 0;
      const error = await withProviderRetries({ ...base, ...fakeClock() }, async () => { calls++; throw failure; }).catch(e => e);
      expect(error).toBeInstanceOf(ProviderRetryError);
      expect(calls).toBe(1);
    }
  });

  test("a stalled attempt is cut at the attempt cap and retried", async () => {
    let calls = 0;
    const out = await withProviderRetries({ maxAttempts: 3, totalMs: 400, attemptCapMs: 60, minAttemptMs: 10, random: () => 0 }, (signal) => {
      calls++;
      if (calls === 1) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return Promise.resolve("second");
    });
    expect(out).toEqual({ value: "second", attempts: 2, failures: [{ code: "timeout" }] });
  });

  test("budget exhausted by stalled attempts reports a timeout on the last attempt", async () => {
    let calls = 0;
    const error = await withProviderRetries({ maxAttempts: 2, totalMs: 120, attemptCapMs: 50, minAttemptMs: 10, random: () => 0 }, (signal) => {
      calls++;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderRetryError);
    expect((error as ProviderRetryError).attemptTimedOut).toBe(true);
    expect((error as ProviderRetryError).failures).toEqual([{ code: "timeout" }, { code: "timeout" }]);
    expect(calls).toBe(2);
  });

  test("no attempt starts with less than the minimum time left", async () => {
    const clock = fakeClock();
    let calls = 0;
    const error = await withProviderRetries({ maxAttempts: 3, totalMs: 10_000, attemptCapMs: 10_000, ...clock, random: () => 1 }, async () => { calls++; clock.advance(7_000); throw httpError(503); }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderRetryError);
    expect(calls).toBe(1); // 3 s left minus a 500 ms wait < 3 s minimum
  });

  test("a parent abort during backoff stops immediately and reports what ran", async () => {
    const parent = new AbortController();
    let calls = 0;
    const error = await withProviderRetries({ ...base, signal: parent.signal, random: () => 1, sleep: (_ms, signal) => new Promise((_, reject) => { parent.abort(); signal?.aborted && reject(new Error("aborted")); }) }, async () => { calls++; throw httpError(503); }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderCallAborted);
    expect((error as ProviderCallAborted).attemptsStarted).toBe(1);
    expect((error as ProviderCallAborted).failures).toEqual([{ code: "inference_http", httpStatus: 503 }]);
    expect(calls).toBe(1);
  });

  test("an already-aborted parent never calls the provider", async () => {
    const parent = new AbortController(); parent.abort();
    let calls = 0;
    await expect(withProviderRetries({ ...base, signal: parent.signal }, async () => { calls++; return 1; })).rejects.toBeInstanceOf(ProviderCallAborted);
    expect(calls).toBe(0);
  });

  test("maxAttempts 1 keeps the single-attempt behaviour", async () => {
    let calls = 0;
    const error = await withProviderRetries({ ...base, maxAttempts: 1, ...fakeClock() }, async () => { calls++; throw httpError(503); }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderRetryError);
    expect(calls).toBe(1);
  });

  test("failure records carry codes and statuses only, never provider text", async () => {
    const error = await withProviderRetries({ ...base, ...fakeClock() }, async () => { throw httpError(503); }).catch(e => e) as ProviderRetryError;
    expect(JSON.stringify(error.failures)).not.toContain("hidden");
    expect(error.failures).toHaveLength(3);
  });

  test("rejects invalid limits", async () => {
    await expect(withProviderRetries({ ...base, maxAttempts: 0 }, async () => 1)).rejects.toBeInstanceOf(RangeError);
    await expect(withProviderRetries({ ...base, maxAttempts: 6 }, async () => 1)).rejects.toBeInstanceOf(RangeError);
    await expect(withProviderRetries({ ...base, totalMs: 0 }, async () => 1)).rejects.toBeInstanceOf(RangeError);
  });
});

test("final attempt respects cap and shared remaining budget even with uncooperative provider", async () => {
  const start = Date.now(); let signal: AbortSignal | undefined;
  await expect(withProviderRetries({ maxAttempts: 1, totalMs: 200, attemptCapMs: 30 }, async current => { signal = current; return new Promise(() => {}); })).rejects.toBeInstanceOf(ProviderRetryError);
  expect(signal?.aborted).toBe(true); expect(Date.now() - start).toBeLessThan(150);
  const clock = fakeClock(); let calls = 0;
  await expect(withProviderRetries({ maxAttempts: 2, totalMs: 60, attemptCapMs: 40, minAttemptMs: 1, random: () => 0, now: clock.now, sleep: clock.sleep }, async current => {
    calls++; if (calls === 1) { clock.advance(50); throw httpError(503); }
    signal = current; return new Promise(() => {});
  })).rejects.toBeInstanceOf(ProviderRetryError);
  expect(calls).toBe(2); expect(signal?.aborted).toBe(true);
});
