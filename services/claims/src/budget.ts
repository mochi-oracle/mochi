/**
 * Local per-day model budget for the research pilot, independent of the provider-side cap. Every provider attempt
 * (retries included) reserves one call and a pessimistic token estimate before it is sent; reported usage settles the
 * reservation afterwards, an attempt without reported usage keeps the estimate, and an attempt that provably never sent
 * its request is released in full. Counters persist with the pilot's SQLite store, so a restart does not reset the day.
 */
export interface ProviderBudgetStore {
  reserveProvider(day: string, key: string, tokens: number, limits: { calls: number; tokens: number }): boolean;
  settleProvider(day: string, key: string, tokenDelta: number): void;
  /** Returns one reserved call and its reserved tokens. */
  releaseProvider(day: string, key: string, tokens: number): void;
  providerUsage(day: string, key: string): { calls: number; tokens: number };
}
export interface ProviderBudgetLimits { dailyCalls: number; dailyTokens: number }
/**
 * One reserved attempt. The first of `settle` or `release` wins; later calls are ignored. `settle` keeps the call
 * charged (with reported usage, or the estimate); `release` refunds the call and the estimate and must only be used
 * when the request provably never left the process.
 */
export interface BudgetReservation { settle(actualTokens?: number): void; release(): void }

export const DEFAULT_DAILY_TOKENS_PER_JUROR = 1_500_000;
const MAX_DAILY_CALLS = 10_000;
const MAX_DAILY_TOKENS = 100_000_000;

export class ProviderBudgetExceeded extends Error {
  readonly code = 'budget_exhausted';
  constructor() { super('Daily model budget exhausted'); this.name = 'ProviderBudgetExceeded'; }
}

export function validBudgetLimits(limits: ProviderBudgetLimits): boolean {
  return Number.isInteger(limits.dailyCalls) && limits.dailyCalls >= 1 && limits.dailyCalls <= MAX_DAILY_CALLS
    && Number.isInteger(limits.dailyTokens) && limits.dailyTokens >= 1_000 && limits.dailyTokens <= MAX_DAILY_TOKENS;
}

/** Default daily call limit: every allowed action may use all of its provider attempts, capped at the call maximum. */
export function defaultDailyCallLimit(dailyActions: number, attemptsPerAction: number): number {
  return Math.min(MAX_DAILY_CALLS, dailyActions * attemptsPerAction);
}

const encoder = new TextEncoder();

/**
 * Conservative token estimate for one attempt: the request's tokens plus the output limit. Many tokenizers emit one
 * token per digit, so every ASCII digit counts as a full token; every other UTF-8 byte counts as a third of one.
 */
export function estimateCallTokens(request: string | Uint8Array, maxOutputTokens: number): number {
  const bytes = typeof request === 'string' ? encoder.encode(request) : request;
  let digits = 0;
  // UTF-8 multi-byte sequences only use bytes >= 0x80, so 0x30..0x39 are always ASCII digits.
  for (let i = 0; i < bytes.length; i++) { const byte = bytes[i]!; if (byte >= 0x30 && byte <= 0x39) digits++; }
  return digits + Math.ceil((bytes.length - digits) / 3) + Math.max(0, maxOutputTokens);
}

export class ProviderBudget {
  constructor(
    private readonly store: ProviderBudgetStore,
    private readonly key: string,
    private readonly limits: ProviderBudgetLimits,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!validBudgetLimits(limits)) throw new RangeError('Invalid provider budget limits');
  }
  private day(): string { return this.now().toISOString().slice(0, 10); }
  /** Whether one more attempt of `estimate` tokens fits today's budget (no reservation). */
  available(estimate = 0): boolean {
    const used = this.store.providerUsage(this.day(), this.key);
    return used.calls < this.limits.dailyCalls && used.tokens + estimate <= this.limits.dailyTokens;
  }
  /** Reserves one attempt, or returns null when the day's call or token budget would be exceeded. */
  reserve(estimate: number): BudgetReservation | null {
    const day = this.day();
    const tokens = Math.max(0, Math.ceil(estimate));
    if (!this.store.reserveProvider(day, this.key, tokens, { calls: this.limits.dailyCalls, tokens: this.limits.dailyTokens })) return null;
    let closed = false;
    return {
      settle: (actual?: number) => {
        if (closed) return;
        closed = true;
        if (actual === undefined || !Number.isSafeInteger(actual) || actual < 0) return;
        try { this.store.settleProvider(day, this.key, actual - tokens); } catch { /* the estimate stays charged */ }
      },
      release: () => {
        if (closed) return;
        closed = true;
        try { this.store.releaseProvider(day, this.key, tokens); } catch { /* the reservation stays charged */ }
      },
    };
  }
}

/** Total tokens from provider-reported usage, when present. */
export function reportedTotalTokens(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.promptTokens !== undefined && usage.completionTokens !== undefined) return usage.promptTokens + usage.completionTokens;
  return undefined;
}
