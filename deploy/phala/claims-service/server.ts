import { runRevenueWorkerManifest } from '../../../services/claims/src/revenue-worker-runtime.ts';
import { createRevenueStatusReader } from '../../../services/claims/src/public-revenue-status.ts';
import { createClaimsRuntime } from '../../../services/claims/src/runtime.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { createProductionIdentityReadiness } from '../production-identities/identities.ts';
import { createIdentityEndpoint } from '../production-identities/http.ts';
import { DstackKeySource } from '@mochi/tee';
import { startProductionRuntime, startupFailureReason, PRODUCTION_PORTS } from '../../production/runtime.ts';
import { createProductionProxy, createEnrollmentEndpoint, publicProxySettings } from '../../production/public-proxy.ts';
import { createFrontHandler } from './front.ts';
const identities = createIdentityEndpoint(() => createProductionIdentityReadiness({
  env:process.env,
  // Required only by the shared factory signature; dstack+kms is enforced before use.
  mock:{seed:`0x${'11'.repeat(32)}`,measurement:`0x${'22'.repeat(32)}`,mockRoot:privateKeyToAccount(`0x${'33'.repeat(32)}`)},
}));
const handler = createClaimsRuntime();
const readiness = await handler(new Request('http://localhost/api/claims/config'));
if (!(await readiness.json() as { enabled: boolean }).enabled) throw new Error('Claims service requires complete protected pilot configuration');
const revenue = createRevenueStatusReader({ reportPath: process.env.MOCHI_REVENUE_REPORT_FILE, tokenConfigured: process.env.MOCHI_TOKEN_CONFIRMED === 'true' });
const launchConfig = process.env.MOCHI_PRODUCTION_CONFIG_JSON || undefined;
const production = await startProductionRuntime(launchConfig, {
  keySource: new DstackKeySource({ socketPath: process.env.DSTACK_SOCKET }),
  artifactDir: process.env.MOCHI_PRODUCTION_RUNTIME_DIR || '/tmp/mochi-runtime',
  log: message => console.info(message),
  onFatal: () => { console.error('Production service stopped unexpectedly; restarting supervised runtime.'); process.exit(1); },
}).catch((error) => { console.error(`Production startup failed: ${startupFailureReason(error)}`); throw new Error('Production startup failed a protected configuration or readiness check.'); });
const productionMode = launchConfig ? JSON.parse(launchConfig).mode : 'standby';
const productionReady = () => production.status === 'running' && productionMode === 'active'
  && Object.keys(production.childhealth).length > 0 && Object.values(production.childhealth).every(status => status === 'healthy');
// Per-client keys: the website's signed per-visitor header (same invitation token as the website), else the transport
// peer; X-Forwarded-For only if the launch config's publicProxy.trustForwardedFor says the ingress appends it.
const protocol = createProductionProxy({
  ready: productionReady, gatewayPort: PRODUCTION_PORTS.gateway, indexerPort: PRODUCTION_PORTS.indexer,
  visitorSecret: process.env.MOCHI_CLAIMS_ACCESS_TOKEN, ...publicProxySettings(launchConfig),
});
const enrollment = createEnrollmentEndpoint({ready:()=>production.status === 'running',jurorPorts:PRODUCTION_PORTS.jurors});
const front = createFrontHandler({
  enrollment, protocol, claims: handler, revenue, clientDiagnostics: protocol.clientDiagnostics,
  // The identity endpoint's Response is typed from Node's fetch types; at runtime it is the same Bun Response.
  identities: request => identities(request) as Promise<Response>,
  productionStatus: () => ({ status: production.status, mode: productionMode, payments: productionReady(), services: production.childhealth }),
});
const server = Bun.serve({
  hostname: '0.0.0.0', port: 8080, idleTimeout: 120, maxRequestBodySize: 1_048_576,
  fetch: (request, bun) => front(request, bun.requestIP(request)?.address),
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
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { if (workerTimer) clearInterval(workerTimer); await production.stop(); server.stop(); process.exit(0); });
console.info('Mochi research service ready; production mode: ' + productionMode);
