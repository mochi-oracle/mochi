import { expect, test } from 'bun:test';
import { createFrontHandler, type FrontRoutes } from './front.ts';
import { API_CSP, HSTS } from '../../../services/claims/src/security-headers.ts';

const expectSecurityHeaders = (response: Response) => {
  expect(response.headers.get('content-security-policy')).toBe(API_CSP);
  expect(API_CSP).toContain("default-src 'none'");
  expect(API_CSP).toContain("frame-ancestors 'none'");
  expect(response.headers.get('strict-transport-security')).toBe(HSTS);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
};

function immutable(response: Response): Response {
  const headers = new Headers(response.headers);
  Object.defineProperty(headers, 'set', { value: () => { throw new TypeError('immutable headers'); } });
  Object.defineProperty(response, 'headers', { get: () => headers });
  return response;
}

function front(overrides: Partial<FrontRoutes> = {}) {
  const seen: string[] = [];
  const handler = createFrontHandler({
    enrollment: () => { seen.push('enrollment'); return Response.json({ proofs: [] }); },
    // A response with immutable headers (as fetch returns per the Fetch standard) is copied rather than failing.
    protocol: async () => { seen.push('protocol'); return immutable(Response.json({ ok: true }, { status: 202, headers: { 'x-upstream': 'kept' } })); },
    identities: (request) => { seen.push('identities'); return request.method === 'GET' ? Response.json({ ready: false }) : new Response(null, { status: 405, headers: { Allow: 'GET' } }); },
    claims: () => { seen.push('claims'); return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }); },
    productionStatus: () => ({ status: 'standby', mode: 'standby', payments: false, services: {} }),
    revenue: async () => ({ status: 'awaiting_token' }),
    ...overrides,
  });
  return { handler, seen };
}

test('every CVM front route returns the strict API security headers', async () => {
  const { handler, seen } = front();
  const cases: Array<[string, RequestInit | undefined, number, string | undefined]> = [
    ['/health', undefined, 200, undefined],
    ['/production/status', undefined, 200, undefined],
    ['/production/identities', undefined, 200, 'identities'],
    ['/production/identities', { method: 'POST' }, 405, 'identities'],
    ['/production/enrollment', undefined, 200, 'enrollment'],
    ['/api/tokenomics/report', undefined, 200, undefined],
    ['/v1/stats', undefined, 202, 'protocol'],
    ['/api/claims/config', undefined, 404, 'claims'],
    ['/health', { method: 'POST' }, 404, 'claims'],
    ['/unknown', undefined, 404, 'claims'],
  ];
  for (const [path, init, status, route] of cases) {
    const before = seen.length;
    const response = await handler(new Request(`https://cvm.example${path}`, init));
    expect(response.status).toBe(status);
    expectSecurityHeaders(response);
    expect(seen.slice(before)).toEqual(route ? [route] : []);
  }
  expect((await handler(new Request('https://cvm.example/v1/stats'))).headers.get('x-upstream')).toBe('kept');
  const health = await handler(new Request('https://cvm.example/health'));
  expect(await health.json()).toEqual({ ok: true, service: 'claims-research', mode: 'invitation-pilot', payments: false, publicSourcesOnly: true });
  const status = await handler(new Request('https://cvm.example/production/status'));
  expect(status.headers.get('cache-control')).toBe('no-store');
  expect(await status.json()).toEqual({ status: 'standby', mode: 'standby', payments: false, services: {} });
  const report = await handler(new Request('https://cvm.example/api/tokenomics/report'));
  expect(report.headers.get('cache-control')).toBe('no-store');
  expect(await report.json()).toEqual({ status: 'awaiting_token' });
});

test('an unexpected route failure is a content-free 500 with security headers', async () => {
  const { handler } = front({
    revenue: async () => { throw new Error('private detail'); },
    claims: () => { throw new Error('claim text'); },
  });
  for (const path of ['/api/tokenomics/report', '/api/claims/research']) {
    const response = await handler(new Request(`https://cvm.example${path}`));
    expect(response.status).toBe(500);
    expectSecurityHeaders(response);
    const body = await response.text();
    expect(body).not.toContain('private detail');
    expect(body).not.toContain('claim text');
  }
});

test('the transport peer reaches the protocol proxy, and /production/status describes how this caller is keyed', async () => {
  const peers: Array<string | undefined> = [];
  const { handler } = front({
    protocol: (_request, peer) => { peers.push(peer); return Response.json({ ok: true }); },
    clientDiagnostics: (request, peer) => ({ keySource: peer ? 'peer' : 'none', forwarded: request.headers.has('x-forwarded-for') }),
  });
  await handler(new Request('https://cvm.example/v1/stats'), '10.2.0.7');
  await handler(new Request('https://cvm.example/v1/stats'));
  expect(peers).toEqual(['10.2.0.7', undefined]);
  const status = await handler(new Request('https://cvm.example/production/status', { headers: { 'x-forwarded-for': '203.0.113.5' } }), '10.2.0.7');
  expect(status.headers.get('cache-control')).toBe('no-store');
  expectSecurityHeaders(status);
  expect(await status.json()).toEqual({ status: 'standby', mode: 'standby', payments: false, services: {}, client: { keySource: 'peer', forwarded: true } });
});
