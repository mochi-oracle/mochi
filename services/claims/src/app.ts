import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ClaimReview, EvidenceBundle, Researcher } from './types.ts';
import type { PublicClaimStore } from './store.ts';

const key = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest();
const matches = (actual: string, expected: string) => timingSafeEqual(digest(actual), digest(expected));
const matchesHash = (actual: string, expectedHex: string) => /^[a-f0-9]{64}$/.test(expectedHex) && timingSafeEqual(digest(actual), Buffer.from(expectedHex, 'hex'));
const researchSchema = z.object({ claim: z.string().trim().min(8).max(4000), sourceUrls: z.array(z.string().url().max(2048)).max(5).default([]), consent: z.literal(true) }).strict();
const reviewSchema = z.object({ researchToken: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict();
const shareSchema = z.object({ consent: z.literal(true) }).strict();
const correctionSchema = z.object({ note: z.string().trim().min(1).max(1000), consent: z.literal(true) }).strict();
const TOKEN_TTL = 30 * 60_000;
const RESULT_TTL = 60 * 60_000;
interface ReviewEntry { review: ClaimReview; reviewToken: string; expires: number; shareId?: string }
interface ResearchEntry { bundle: EvidenceBundle; expires: number; pending?: Promise<ReviewEntry>; result?: ReviewEntry }
export interface ClaimsOptions {
  researcher?: Researcher;
  reviewer?: (bundle: EvidenceBundle) => Promise<ClaimReview>;
  store: PublicClaimStore;
  accessToken?: string;
  now?: () => Date;
  maxActionsPerDay?: number;
  maxConcurrent?: number;
}

/** Private bundles/results are ephemeral. Publishing is a separate consented action. */
export function createClaimsHandler(options: ClaimsOptions) {
  const now = () => (options.now?.() ?? new Date()).getTime();
  const enabled = Boolean(options.researcher && options.reviewer && options.accessToken && options.accessToken.length >= 24);
  const research = new Map<string, ResearchEntry>();
  const reviews = new Map<string, ReviewEntry>();
  let active = 0;
  const fail = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });
  const configuredLimit = options.maxActionsPerDay ?? 100;
  const dailyLimit = Number.isInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 1000 ? configuredLimit : 100;
  const concurrency = Math.max(1, Math.min(4, options.maxConcurrent ?? 2));
  const clean = () => {
    const time = now();
    for (const [token, entry] of research) if (entry.expires <= time && !entry.pending) research.delete(token);
    for (const [id, entry] of reviews) if (entry.expires <= time) reviews.delete(id);
  };
  const reserve = () => options.store.reserve(new Date(now()).toISOString().slice(0, 10), dailyLimit);
  async function json(request: Request): Promise<unknown> {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('body');
    if (Number(request.headers.get('content-length') ?? 0) > 20_000) throw new Error('body');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('body');
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 20_000) { await reader.cancel(); throw new Error('body'); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const fullReview = (entry: ReviewEntry) => Response.json({ review: entry.review, reviewToken: entry.reviewToken });
  return async (request: Request): Promise<Response> => {
    clean();
    const url = new URL(request.url);
    const path = url.pathname;
    let response: Response;
    try {
      if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return fail('ORIGIN', 'Cross-origin request refused.', 403);
      if (path === '/api/claims/config' && request.method === 'GET') {
        return Response.json({ enabled, mode: 'research-preview', jurySize: 3, price: { amountUsd: '0.00', label: 'No payment collected' }, requiresAccessToken: true, limits: { claimChars: 4000, sourceCount: 5 }, ...(!enabled ? { reason: 'Claim research is awaiting provider configuration. Paid reviews are not open.' } : {}) });
      }
      const shared = /^\/api\/claims\/shared\/([a-f0-9]{64})$/.exec(path);
      if (shared && request.method === 'GET') {
        const review = options.store.shared(shared[1]!);
        return review ? Response.json(review) : fail('NOT_FOUND', 'Shared review not found.', 404);
      }
      const ownerAction = /^\/api\/claims\/shared\/([a-f0-9]{64})\/(corrections|unpublish)$/.exec(path);
      if (!['/api/claims/research', '/api/claims/reviews'].includes(path) && !/^\/api\/claims\/reviews\/[^/]+\/share$/.test(path) && !ownerAction) return fail('NOT_FOUND', 'Not found.', 404);
      if (request.method !== 'POST') return fail('METHOD', 'Method not allowed.', 405);
      if (!enabled) return fail('UNAVAILABLE', 'Claim research is not configured yet.', 503);
      if (!matches(request.headers.get('x-mochi-access-token') ?? '', options.accessToken!)) return fail('ACCESS', 'Enter a valid pilot access token.', 401);
      let value: unknown;
      try { value = await json(request); } catch { return fail('INVALID_REQUEST', 'Submit a valid, bounded JSON request.', 400); }
      if (path === '/api/claims/research') {
        const parsed = researchSchema.safeParse(value);
        if (!parsed.success) return fail('INVALID_REQUEST', 'Provide a claim, up to five source URLs, and research consent.', 400);
        if (active >= concurrency || research.size >= 100) return fail('BUSY', 'The pilot is busy. Try again shortly.', 429);
        if (!reserve()) return fail('DAILY_LIMIT', 'The pilot has reached its daily research limit.', 429);
        active++;
        try {
          const bundle = await options.researcher!({ claim: parsed.data.claim, sourceUrls: parsed.data.sourceUrls });
          const token = key(), expires = now() + TOKEN_TTL;
          research.set(token, { bundle, expires });
          response = Response.json({ bundle, researchToken: token, expiresAt: new Date(expires).toISOString() });
        } finally { active--; }
      } else if (path === '/api/claims/reviews') {
        const parsed = reviewSchema.safeParse(value);
        if (!parsed.success) return fail('INVALID_REQUEST', 'Approve the researched evidence before running a review.', 400);
        const entry = research.get(parsed.data.researchToken);
        if (!entry || entry.expires <= now()) return fail('EXPIRED', 'The evidence session expired. Research the claim again.', 410);
        if (entry.result) return fullReview(entry.result);
        if (entry.pending) return fullReview(await entry.pending);
        if (active >= concurrency) return fail('BUSY', 'The pilot is busy. Try again shortly.', 429);
        if (!reserve()) return fail('DAILY_LIMIT', 'The pilot has reached its daily review limit.', 429);
        active++;
        const pending = (async () => {
          const review = await options.reviewer!(entry.bundle);
          const result = { review, reviewToken: key(), expires: now() + RESULT_TTL };
          reviews.set(review.id, result); entry.result = result;
          return result;
        })();
        entry.pending = pending;
        try { response = fullReview(await pending); }
        finally { active--; entry.pending = undefined; }
      } else if (ownerAction) {
        const id = ownerAction[1]!;
        const supplied = request.headers.get('x-mochi-review-token') ?? '';
        const savedHash = options.store.ownerHash(id);
        if (!savedHash || !/^[a-f0-9]{64}$/.test(supplied) || !matchesHash(supplied, savedHash)) return fail('NOT_FOUND', 'Published review not found or owner token invalid.', 404);
        if (ownerAction[2] === 'corrections') {
          const parsed = correctionSchema.safeParse(value);
          if (!parsed.success) return fail('INVALID_REQUEST', 'Provide correction consent and a note of at most 1,000 characters.', 400);
          if (!options.store.correct(id, { note: parsed.data.note, createdAt: new Date(now()).toISOString() })) return fail('CORRECTION_LIMIT', 'The published review is unavailable or has reached its correction limit.', 409);
          response = Response.json(options.store.shared(id));
        } else {
          if (!z.object({ confirm: z.literal(true) }).strict().safeParse(value).success) return fail('CONFIRMATION', 'Confirm that the public review should be unpublished.', 400);
          if (!options.store.unpublish(id)) return fail('NOT_FOUND', 'Published review not found.', 404);
          for (const entry of reviews.values()) if (entry.shareId === id) entry.shareId = undefined;
          response = Response.json({ unpublished: true });
        }
      } else {
        if (!shareSchema.safeParse(value).success) return fail('CONSENT', 'Explicit consent is required to publish a review.', 400);
        const id = /^\/api\/claims\/reviews\/([^/]+)\/share$/.exec(path)![1]!;
        const entry = reviews.get(id);
        if (!entry || !matches(request.headers.get('x-mochi-review-token') ?? '', entry.reviewToken)) return fail('NOT_FOUND', 'Review not found or recovery token invalid.', 404);
        if (!entry.shareId) {
          const shareId = key();
          // Source text is private research material. Publish only the passages cited by jurors.
          const publishable: ClaimReview = { ...entry.review, sources: entry.review.sources.map(source => ({ ...source, text: '' })) };
          options.store.publish(shareId, publishable, digest(entry.reviewToken).toString('hex')); entry.shareId = shareId;
        }
        response = Response.json({ shareId: entry.shareId, url: `/check/?share=${entry.shareId}` });
      }
    } catch { response = fail('RESEARCH_FAILED', 'Research could not be completed. No payment was collected.', 502); }
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
