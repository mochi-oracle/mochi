import { createClaimsRuntime } from '../../../services/claims/src/runtime.ts';
const handler = createClaimsRuntime();
const readiness = await handler(new Request('http://localhost/api/claims/config'));
if (!(await readiness.json() as { enabled: boolean }).enabled) throw new Error('Claims service requires complete protected pilot configuration');
const server = Bun.serve({
  hostname: '0.0.0.0', port: 8080, idleTimeout: 120, maxRequestBodySize: 20_000,
  fetch: request => new URL(request.url).pathname === '/health' && request.method === 'GET'
    ? Response.json({ ok: true, service: 'claims-research', mode: 'invitation-pilot', payments: false, publicSourcesOnly: true })
    : handler(request),
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { server.stop(); process.exit(0); });
console.info('Mochi invitation research service ready; payments disabled');
