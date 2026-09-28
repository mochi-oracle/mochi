import { runRevenueWorkerManifest } from '../../../services/claims/src/revenue-worker-runtime.ts';
import { createRevenueStatusReader } from '../../../services/claims/src/public-revenue-status.ts';
import { createClaimsRuntime } from '../../../services/claims/src/runtime.ts';
const handler = createClaimsRuntime();
const readiness = await handler(new Request('http://localhost/api/claims/config'));
if (!(await readiness.json() as { enabled: boolean }).enabled) throw new Error('Claims service requires complete protected pilot configuration');
const revenue = createRevenueStatusReader({ reportPath: process.env.MOCHI_REVENUE_REPORT_FILE, tokenConfigured: process.env.MOCHI_TOKEN_CONFIRMED === 'true' });
const server = Bun.serve({
  hostname: '0.0.0.0', port: 8080, idleTimeout: 120, maxRequestBodySize: 20_000,
  fetch: async request => new URL(request.url).pathname === '/api/tokenomics/report' && request.method === 'GET'
    ? Response.json(await revenue(), { headers: { 'cache-control': 'no-store' } })
    : new URL(request.url).pathname === '/health' && request.method === 'GET'
    ? Response.json({ ok: true, service: 'claims-research', mode: 'invitation-pilot', payments: false, publicSourcesOnly: true })
    : handler(request),
});
// Optional worker shares the existing persistent volume; absent config performs no chain or wallet work.
const workerManifest = process.env.MOCHI_REVENUE_WORKER_MANIFEST;
let workerBusy = false;
const tickRevenue = async () => {
  if (!workerManifest || workerBusy) return;
  workerBusy = true;
  try { await runRevenueWorkerManifest(workerManifest); }
  catch { console.error('Revenue cycle stopped by a configuration, accounting or execution check; inspect privately.'); }
  finally { workerBusy = false; }
};
const workerTimer = workerManifest ? setInterval(() => { void tickRevenue(); }, 60_000) : undefined;
if (workerManifest) void tickRevenue();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { if (workerTimer) clearInterval(workerTimer); server.stop(); process.exit(0); });
console.info('Mochi invitation research service ready; payments disabled');
