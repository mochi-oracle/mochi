import { z } from 'zod';
import { EnvelopeSchema } from '@mochi/protocol';
import { createHash, timingSafeEqual } from 'node:crypto';

const RequestSchema = z.object({
  envelope: EnvelopeSchema,
  payerResultPubKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
}).strict();
const MAX_BODY = 24 * 1024;

/** Bounded synthetic or real-ACI rehearsal surface; never a production review API. */
export function createRoundHandler(service: {
  attestations(): Promise<unknown>;
  run(input: z.infer<typeof RequestSchema>): Promise<unknown>;
}, options: { mode?: 'synthetic' | 'real-aci'; roundAuthSecret?: string } = {}) {
  const mode = options.mode ?? 'synthetic';
  let active = false;
  let attempts = 0;
  const attemptLimit = mode === 'real-aci' ? 1 : 3;
  let attestations = 0;
  const json = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return json({
      ok: true, service: 'confidential_round_rehearsal', fixtureOnly: true,
      chain: 'fixture', models: mode === 'synthetic' ? 'synthetic' : 'real-phala-aci', roles: 'co-resident', payments: false,
    });
    if (request.method === 'GET' && path === '/v1/attestations') {
      if (attestations++ >= 30) return json({ error: 'ATTESTATION_LIMIT' }, 429);
      try { return json(await service.attestations()); }
      catch { return json({ error: 'ATTESTATION_UNAVAILABLE' }, 503); }
    }
    if (request.method !== 'POST' || path !== '/v1/rehearsal/round') return json({ error: 'NOT_FOUND' }, 404);
    if (mode === 'real-aci') {
      const expected = options.roundAuthSecret;
      const supplied = request.headers.get('authorization') ?? '';
      const actual = supplied.startsWith('Bearer ') ? supplied.slice(7) : '';
      const suppliedHash = createHash('sha256').update(actual).digest();
      const expectedHash = createHash('sha256').update(expected ?? '').digest();
      if (!expected || !actual || !timingSafeEqual(suppliedHash, expectedHash)) return json({ error: 'UNAUTHORIZED' }, 401);
    }
    if (active) return json({ error: 'ROUND_BUSY' }, 429);
    if (attempts >= attemptLimit) return json({ error: 'ROUND_LIMIT' }, 429);
    // Reserve before any await: malformed/aborted requests also consume the finite budget.
    active = true;
    attempts++;
    const reader = request.body?.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const size = Number(request.headers.get('content-length') ?? '0');
      if (!Number.isFinite(size) || size > MAX_BODY) return json({ error: 'BODY_TOO_LARGE' }, 413);
      let expired = false;
      timer = setTimeout(() => { expired = true; void reader?.cancel().catch(() => {}); }, 10_000);
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (expired) return json({ error: 'REQUEST_TIMEOUT' }, 408);
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY) return json({ error: 'BODY_TOO_LARGE' }, 413);
        chunks.push(value);
      }
      clearTimeout(timer);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const input = RequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      return json(await service.run(input));
    } catch {
      // Never expose submitted plaintext, key material, provider data or exception messages.
      return json({ error: 'ROUND_REJECTED' }, 400);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      active = false;
    }
  };
}
