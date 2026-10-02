import { expect, test } from 'bun:test';
import { SERVICE_SOURCES, applyServiceStatus, serviceAvailable } from '../site/src/service-status.js';

const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a service is available only for a 2xx response that reports enabled:true', async () => {
  expect(await serviceAvailable('research', { fetcher: respond({ enabled: true, mode: 'research-preview' }) })).toBe(true);
  expect(await serviceAvailable('research', { fetcher: respond({ enabled: false, reason: 'Claim research is awaiting provider configuration.' }) })).toBe(false);
  expect(await serviceAvailable('research', { fetcher: respond({ enabled: 'true' }) })).toBe(false);
  expect(await serviceAvailable('research', { fetcher: respond({ error: { code: 'UNAVAILABLE' } }, 503) })).toBe(false);
  expect(await serviceAvailable('research', { fetcher: respond({ enabled: true }, 503) })).toBe(false);
  expect(await serviceAvailable('research', { fetcher: async () => new Response('<html>', { status: 200 }) })).toBe(false);
  expect(await serviceAvailable('research', { fetcher: async () => { throw new TypeError('network down'); } })).toBe(false);
  expect(await serviceAvailable('unknown', { fetcher: respond({ enabled: true }) })).toBe(false);
});

test('a hanging health check times out as unavailable', async () => {
  const hanging = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  const started = Date.now();
  expect(await serviceAvailable('research', { fetcher: hanging as typeof fetch, timeoutMs: 30 })).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('labels settle from one request per source and read only the configured endpoints', async () => {
  const requested: string[] = [];
  const fetcher = async (url: string) => { requested.push(url); return Response.json({ enabled: url === SERVICE_SOURCES.research }); };
  const label = (source: string) => ({ dataset: { serviceStatus: source, available: `${source} available`, unavailable: `${source} unavailable` } as Record<string, string>, textContent: 'Checking…' });
  const labels = [label('research'), label('paid'), label('research')];
  const root = { querySelectorAll: (selector: string) => (selector === '[data-service-status]' ? labels : []) };
  expect(await applyServiceStatus(root as unknown as Document, { fetcher: fetcher as unknown as typeof fetch })).toEqual({ research: true, paid: false });
  expect(requested.sort()).toEqual(['/api/claims/config', '/mochi-config.json']);
  expect(labels.map(l => [l.textContent, l.dataset.state])).toEqual([
    ['research available', 'available'],
    ['paid unavailable', 'unavailable'],
    ['research available', 'available'],
  ]);
});
