/**
 * In-memory token-bucket quotas for public endpoints. A rule allows `limit` units (requests or body bytes) per
 * `windowSec`, refilled continuously, either per client or across all clients. Admission is all-or-nothing: a request
 * that any bucket rejects consumes nothing.
 */
export type QuotaUnit = 'requests' | 'bytes';
export interface QuotaRule { scope: 'client' | 'global'; unit: QuotaUnit; limit: number; windowSec: number }
export type QuotaDecision = { ok: true } | { ok: false; retryAfterSec: number };

interface Bucket { tokens: number; updated: number }

export class QuotaLimiter {
  private readonly clients = new Map<string, Bucket[]>();
  private readonly global: Bucket[];
  private readonly clientRules: QuotaRule[];
  private readonly globalRules: QuotaRule[];
  private readonly maxClients: number;
  private readonly now: () => number;

  constructor(rules: QuotaRule[], options: { maxClients?: number; now?: () => number } = {}) {
    for (const rule of rules) {
      if (!Number.isFinite(rule.limit) || rule.limit <= 0 || !Number.isFinite(rule.windowSec) || rule.windowSec <= 0) throw new RangeError('quota limits and windows must be positive');
    }
    this.clientRules = rules.filter(rule => rule.scope === 'client');
    this.globalRules = rules.filter(rule => rule.scope === 'global');
    this.now = options.now ?? (() => Date.now() / 1000);
    this.maxClients = options.maxClients ?? 10_000;
    this.global = this.globalRules.map(rule => ({ tokens: rule.limit, updated: this.now() }));
  }

  /** Charges `amount` of `unit` to `client` and the global buckets, or reports when to retry. */
  take(client: string, unit: QuotaUnit, amount = 1): QuotaDecision {
    if (!(amount > 0)) return { ok: true };
    const now = this.now();
    const pairs: Array<[QuotaRule, Bucket]> = [];
    const own = this.clientRules.length ? this.bucketsFor(client, now) : [];
    this.clientRules.forEach((rule, i) => { if (rule.unit === unit) pairs.push([rule, own[i]!]); });
    this.globalRules.forEach((rule, i) => { if (rule.unit === unit) pairs.push([rule, this.global[i]!]); });
    let retryAfterSec = 0;
    for (const [rule, bucket] of pairs) {
      const rate = rule.limit / rule.windowSec;
      bucket.tokens = Math.min(rule.limit, bucket.tokens + Math.max(0, now - bucket.updated) * rate);
      bucket.updated = now;
      if (bucket.tokens < amount) retryAfterSec = Math.max(retryAfterSec, amount > rule.limit ? rule.windowSec : (amount - bucket.tokens) / rate);
    }
    if (retryAfterSec > 0) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)) };
    for (const [, bucket] of pairs) bucket.tokens -= amount;
    return { ok: true };
  }

  /**
   * Seconds until `amount` could be charged to `client` (0 if it could be now), without charging anything. For a
   * request charged in parts (one unit before its body is read, the rest after), so its Retry-After covers the whole
   * charge rather than only the refused part.
   */
  retryAfter(client: string, unit: QuotaUnit, amount: number): number {
    const now = this.now();
    const own = this.clients.get(client);
    let wait = 0;
    const check = (rule: QuotaRule, bucket: Bucket | undefined) => {
      if (rule.unit !== unit) return;
      const rate = rule.limit / rule.windowSec;
      const tokens = bucket ? Math.min(rule.limit, bucket.tokens + Math.max(0, now - bucket.updated) * rate) : rule.limit;
      if (tokens < amount) wait = Math.max(wait, amount > rule.limit ? rule.windowSec : (amount - tokens) / rate);
    };
    this.clientRules.forEach((rule, i) => check(rule, own?.[i]));
    this.globalRules.forEach((rule, i) => check(rule, this.global[i]));
    return wait > 0 ? Math.max(1, Math.ceil(wait)) : 0;
  }

  private bucketsFor(client: string, now: number): Bucket[] {
    const existing = this.clients.get(client);
    if (existing) return existing;
    if (this.clients.size >= this.maxClients) this.prune(now);
    const created = this.clientRules.map(rule => ({ tokens: rule.limit, updated: now }));
    this.clients.set(client, created);
    return created;
  }

  /** Drops clients whose buckets have refilled (indistinguishable from new); otherwise evicts the oldest entries. */
  private prune(now: number): void {
    for (const [key, buckets] of this.clients) {
      const full = buckets.every((bucket, i) => {
        const rule = this.clientRules[i]!;
        return bucket.tokens + Math.max(0, now - bucket.updated) * (rule.limit / rule.windowSec) >= rule.limit;
      });
      if (full) this.clients.delete(key);
    }
    for (const key of this.clients.keys()) {
      if (this.clients.size < this.maxClients) break;
      this.clients.delete(key);
    }
  }
}

/** Client identity is shared with the gateway and the website; see client-address.ts. */
export { clientPrefix, forwardedAddress, forwardedClient } from './client-address.ts';

export function tooManyRequests(retryAfterSec: number, headers: Record<string, string> = {}): Response {
  return Response.json({ error: 'Rate limit exceeded; try again later' }, { status: 429, headers: { ...headers, 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' } });
}
