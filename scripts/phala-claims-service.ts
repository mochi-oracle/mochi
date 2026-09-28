import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertLocalRoundDependencies, renderRemoteRoundCompose } from './phala-round-rehearsal.ts';
import { scanEntry } from './identity-guard.ts';
import { REAL_MODELS } from '../deploy/phala/round-rehearsal/real-mode.ts';
import { runtimeBootstrap } from './phala-production-runtime.ts';
const ROOT = resolve(import.meta.dir, '..');
const ARTIFACT = 'deploy/phala/claims-service/assets/claims-service.br';
export function renderClaimsCompose(revision: string, digest: string, runtimeDigest?: string) {
  const compose = Bun.YAML.parse(renderRemoteRoundCompose(revision, digest)) as any;
  const service = compose.services['confidential-round-rehearsal'];
  service.command[2] = service.command[2].replace('deploy/phala/round-rehearsal/assets/round-service.br', ARTIFACT).replaceAll('/tmp/mochi-round.mjs', '/tmp/mochi-claims.mjs');
  service.restart = 'unless-stopped';
  service.volumes = ['claims-data:/data', '/var/run/dstack.sock:/var/run/dstack.sock'];
  service.environment = {
    TEE_MODE:'dstack', TEE_KEYS:'kms', QUOTE_VERIFIER:'dcap', DSTACK_SOCKET:'/var/run/dstack.sock',
    MOCHI_CLAIMS_MODE: 'pilot', MOCHI_CLAIMS_DATABASE: '/data/claims.sqlite', MOCHI_CLAIMS_DAILY_ACTIONS: '40',
    MOCHI_CLAIMS_ACCESS_TOKEN: '${MOCHI_CLAIMS_ACCESS_TOKEN:?protected invitation token required}',
    MOCHI_REVENUE_WORKER_MANIFEST: '${MOCHI_REVENUE_WORKER_MANIFEST:-}',
    MOCHI_REVENUE_REPORT_FILE: '${MOCHI_REVENUE_REPORT_FILE:-}',
    MOCHI_TOKEN_CONFIRMED: '${MOCHI_TOKEN_CONFIRMED:-false}',
    PHALA_API_KEY: '${PHALA_API_KEY:?protected provider key required}',
    MOCHI_CLAIMS_JURORS: JSON.stringify(REAL_MODELS.map((model, i) => ({ id: `juror-${i+1}`, model, transport: 'phala-aci', baseUrl: 'https://inference.phala.com/v1', apiKeyEnv: 'PHALA_API_KEY' }))),
  };
  // Named storage persists on the existing CVM disk; private source sessions remain in memory.
  service.healthcheck = { test: ['CMD', 'bun', '-e', 'if(!(await fetch("http://localhost:8080/health")).ok)process.exit(1)'], interval: '30s', timeout: '5s', retries: 3 };
  compose.services = { 'claims-research': service };
  compose.volumes = { 'claims-data': { name: 'mochi-claims-data' } };
  if(runtimeDigest) {
    service.command[2] = service.command[2].replace('await import("/tmp/mochi-claims.mjs");',runtimeBootstrap(revision,runtimeDigest)+' await import("/tmp/mochi-claims.mjs");');
    service.environment.MOCHI_PRODUCTION_CONFIG_JSON='${MOCHI_PRODUCTION_CONFIG_JSON:-}';
    service.environment.MOCHI_PRODUCTION_RUNTIME_DIR='/tmp/mochi-runtime';
    service.environment.MOCHI_PRODUCTION_DATABASE_URL='postgres://mochi:${MOCHI_PRODUCTION_POSTGRES_PASSWORD:?protected database password required}@production-db:5432/mochi';
    service.environment.MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN='${MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN:?protected administrator token required}';
    service.mem_limit='1400m';service.pids_limit=384;
    service.depends_on={'production-db':{condition:'service_healthy'}};
    compose.services['production-db']={
      image:'timescale/timescaledb@sha256:0c853e27cc28d0d797e83ceea27d650d1d9afc650ea6d6f3698103b2b7b6885f',
      restart:'unless-stopped',mem_limit:'384m',cpus:'0.5',pids_limit:96,
      environment:{POSTGRES_USER:'mochi',POSTGRES_DB:'mochi',POSTGRES_PASSWORD:'${MOCHI_PRODUCTION_POSTGRES_PASSWORD:?protected database password required}',NO_TS_TUNE:'true'},
      volumes:['production-db:/var/lib/postgresql/data'],
      command:['postgres','-c','shared_buffers=64MB','-c','work_mem=2MB','-c','max_connections=60','-c','max_worker_processes=8','-c','timescaledb.max_background_workers=4'],
      healthcheck:{test:['CMD-SHELL','pg_isready -U mochi -d mochi'],interval:'10s',timeout:'5s',retries:12},
    };
    compose.volumes['production-db']={name:'mochi-production-db'};
  }
  return Bun.YAML.stringify(compose, null, 2) + '\n';
}
export async function buildClaimsArtifact() {
  assertLocalRoundDependencies();
  const build = await Bun.build({ entrypoints: [resolve(ROOT, 'deploy/phala/claims-service/server.ts')], target: 'bun', minify: true, sourcemap: 'none', env:'disable' });
  if (!build.success || build.outputs.length !== 1) throw new Error('Claims build failed');
  const bytes = new Uint8Array(await build.outputs[0]!.arrayBuffer());
  if (bytes.length > 2*1024*1024) throw new Error('Claims bundle too large');
  const r = spawnSync('git', ['rev-parse', '--git-path', 'info/identity-denylist'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Identity policy unavailable');
  const path = resolve(ROOT, r.stdout.trim());
  const deny = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/u).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')) : [];
  if (scanEntry({ path: 'deploy/phala/claims-service/claims-service.mjs', data: bytes }, deny).length) throw new Error('Decoded artifact identity check failed');
  const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  if (compressed.length > 512*1024) throw new Error('Compressed claims bundle too large');
  return { compressed, expandedBytes: bytes.length, sha256: createHash('sha256').update(compressed).digest('hex') };
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && args[0] === '--build-artifact') {
    const a = await buildClaimsArtifact(); mkdirSync(dirname(resolve(ROOT, ARTIFACT)), { recursive: true }); writeFileSync(resolve(ROOT, ARTIFACT), a.compressed);
    console.log(JSON.stringify({ path: ARTIFACT, compressedBytes: a.compressed.length, expandedBytes: a.expandedBytes, sha256: a.sha256 }));
  } else if ((args.length === 6 || args.length === 8 && args[6] === '--runtime-sha256') && args[0] === '--revision' && args[2] === '--sha256' && args[4] === '--out') {
    writeFileSync(resolve(args[5]!), renderClaimsCompose(args[1]!, args[3]!,args[7]), { mode: 0o600 }); console.log('Rendered pinned claims and optional production runtime compose');
  } else throw new Error('Use --build-artifact or --revision <sha> --sha256 <digest> --out <file>');
}
