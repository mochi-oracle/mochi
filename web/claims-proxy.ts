/** Fixed-destination proxy: invitation and review-owner tokens only, no browser cookies. */
export function createClaimsProxy(base: string, fetcher: typeof fetch = fetch) {
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Claims upstream must be an HTTPS origin');
  const allowed = (path: string, method: string) => method === 'GET'
    ? path === '/api/claims/config' || /^\/api\/claims\/shared\/[a-f0-9]{64}$/.test(path)
    : method === 'POST' && (['/api/claims/research', '/api/claims/reviews'].includes(path) || /^\/api\/claims\/reviews\/[a-f0-9-]{1,80}\/share$/.test(path) || /^\/api\/claims\/shared\/[a-f0-9]{64}\/(?:corrections|unpublish)$/.test(path));
  const fail = (status: number) => Response.json({ error: { code: 'UNAVAILABLE', message: 'Research service is unavailable. No payment was collected.' } }, { status, headers: { 'cache-control': 'no-store' } });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!allowed(url.pathname, request.method) || url.search) return fail(404);
    if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return fail(403);
    try {
      const headers = new Headers({ 'content-type': 'application/json' });
      for (const name of ['x-mochi-access-token', 'x-mochi-review-token']) {
        const value = request.headers.get(name);
        if (value && value.length > 256) return fail(400);
        if (value) headers.set(name, value);
      }
      let body: Uint8Array | undefined;
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return fail(400);
        body = await boundedBody(request, 20_000);
      }
      const response = await fetcher(new URL(url.pathname, origin), { method: request.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(90_000) });
      if (!response.headers.get('content-type')?.includes('application/json')) return fail(502);
      const bytes = await boundedBody(response, 2 * 1024 * 1024);
      return new Response(bytes, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch { return fail(502); }
  };
}
async function boundedBody(message: Request | Response, limit: number): Promise<Uint8Array> {
  if (Number(message.headers.get('content-length') ?? 0) > limit) throw new Error('Body limit');
  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('Body limit'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
