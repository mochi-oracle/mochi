// Bounded retries for transient AI-provider failures (rate limits, gateway errors, dropped connections,
// stalled attempts). Every attempt re-sends the identical request to the same attested route; callers
// must never switch models between attempts. The whole call, waits included, stays inside one budget.

export type ProviderAttemptFailure = { code: string; httpStatus?: number };
export type ProviderRetryClass = { retry: boolean; code: string; httpStatus?: number; retryAfterMs?: number };

export interface ProviderRetryOptions {
  /** Attempts including the first, 1..5. */
  maxAttempts: number;
  /** Budget for the whole call including backoff waits. */
  totalMs: number;
  /** Upper bound for every attempt, including the final one. */
  attemptCapMs: number;
  /** Never start an attempt with less time than this left. */
  minAttemptMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onAttempt?: (event: { attempt: number; elapsedMs: number; remainingBudgetMs: number; code: string; httpStatus?: number }) => void;
  classify?: (error: unknown, attemptTimedOut: boolean) => ProviderRetryClass;
}

/** Thrown when the parent signal aborts; never retried. */
export class ProviderCallAborted extends Error {
  constructor(readonly failures: ProviderAttemptFailure[] = [], readonly attemptsStarted = 0) { super("provider call aborted"); this.name = "ProviderCallAborted"; }
}

/** The final failure, with the (content-free) code of every failed attempt attached. */
export class ProviderRetryError extends Error {
  constructor(readonly lastError: unknown, readonly failures: ProviderAttemptFailure[], readonly attemptTimedOut: boolean) {
    super("provider call failed"); this.name = "ProviderRetryError";
  }
}

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const HTTP_CODES = new Set(["inference_http", "attestation_http"]);
const MIN_ATTEMPT_MS = 3_000;
const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 500;

/** Retry only failures that happened before any provider response was accepted. */
export function classifyProviderError(error: unknown, attemptTimedOut: boolean): ProviderRetryClass {
  if (attemptTimedOut) return { retry: true, code: "timeout" };
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; httpStatus?: unknown; retryAfterMs?: unknown };
  const code = typeof e.code === "string" && /^[a-z_]+$/u.test(e.code) ? e.code : undefined;
  const httpStatus = typeof e.httpStatus === "number" && Number.isInteger(e.httpStatus) ? e.httpStatus : undefined;
  const retryAfterMs = typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0 ? e.retryAfterMs : undefined;
  if (code && HTTP_CODES.has(code) && httpStatus !== undefined) {
    return { retry: RETRYABLE_HTTP.has(httpStatus), code, httpStatus, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  // fetch() rejects with a TypeError when the connection fails before any response.
  if (!code && error instanceof TypeError) return { retry: true, code: "network" };
  return { retry: false, code: code ?? "provider_error", ...(httpStatus === undefined ? {} : { httpStatus }) };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ProviderCallAborted()); return; }
    const onAbort = () => { clearTimeout(timer); reject(new ProviderCallAborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withProviderRetries<T>(
  options: ProviderRetryOptions,
  attempt: (signal: AbortSignal, index: number) => Promise<T>,
): Promise<{ value: T; attempts: number; failures: ProviderAttemptFailure[] }> {
  const maxAttempts = options.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError("maxAttempts must be an integer from 1 to 5");
  if (!Number.isFinite(options.totalMs) || options.totalMs <= 0 || !Number.isFinite(options.attemptCapMs) || options.attemptCapMs <= 0) throw new RangeError("retry budgets must be positive");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const classify = options.classify ?? classifyProviderError;
  const minAttemptMs = options.minAttemptMs ?? MIN_ATTEMPT_MS;
  const parent = options.signal;
  const start = now();
  const failures: ProviderAttemptFailure[] = [];
  for (let index = 0; ; index++) {
    if (parent?.aborted) throw new ProviderCallAborted(failures, index);
    const remaining = options.totalMs - (now() - start);
    const last = index === maxAttempts - 1;
    if (remaining <= 0) throw new ProviderCallAborted(failures, index);
    const budget = Math.min(remaining, options.attemptCapMs);
    const attemptStart = now();
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parent?.addEventListener("abort", onParentAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, budget));
    try {
      const value = await abortableProviderCall(attempt(controller.signal, index), controller.signal);
      controller.signal.throwIfAborted();
      options.onAttempt?.({ attempt: index + 1, elapsedMs: Math.max(0, now() - attemptStart), remainingBudgetMs: Math.max(0, options.totalMs - (now() - start)), code: "ok" });
      return { value, attempts: index + 1, failures };
    } catch (error) {
      const verdict = parent?.aborted ? { retry: false, code: "timeout" } : classify(error, timedOut);
      options.onAttempt?.({ attempt: index + 1, elapsedMs: Math.max(0, now() - attemptStart), remainingBudgetMs: Math.max(0, options.totalMs - (now() - start)), code: verdict.code, ...(verdict.httpStatus === undefined ? {} : { httpStatus: verdict.httpStatus }) });
      if (parent?.aborted) throw new ProviderCallAborted(failures, index + 1);
      failures.push({ code: verdict.code, ...(verdict.httpStatus === undefined ? {} : { httpStatus: verdict.httpStatus }) });
      if (!verdict.retry || last) throw new ProviderRetryError(error, failures, timedOut);
      const left = options.totalMs - (now() - start);
      const wait = verdict.retryAfterMs ?? Math.floor(random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** index));
      if (left - wait < minAttemptMs) throw new ProviderRetryError(error, failures, timedOut);
      try { await sleep(wait, parent); } catch { throw new ProviderCallAborted(failures, index + 1); }
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }
}

/** Bound waiting even if an adapter fails to cooperate; native fetch still receives cancellation. */
export async function abortableProviderCall<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
  let onAbort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { onAbort = () => reject(new ProviderCallAborted()); signal.addEventListener("abort", onAbort, { once: true }); })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
