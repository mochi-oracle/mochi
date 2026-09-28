import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertLocalRoundDependencies, renderRemoteRoundCompose } from './phala-round-rehearsal.ts';
import { scanEntry } from './identity-guard.ts';
import { REAL_MODELS } from '../deploy/phala/round-rehearsal/real-mode.ts';
const ROOT = resolve(import.meta.dir, '..');
const ARTIFACT = 'deploy/phala/claims-service/assets/claims-service.br';
export function renderClaimsCompose(revision: string, digest: string) {
  const compose = Bun.YAML.parse(renderRemoteRoundCompose(revision, digest)) as any;
  const service = compose.services['confidential-round-rehearsal'];
  service.command[2] = service.command[2].replace('deploy/phala/round-rehearsal/assets/round-service.br', ARTIFACT).replaceAll('/tmp/mochi-round.mjs', '/tmp/mochi-claims.mjs');
  service.restart = 'unless-stopped';
  service.volumes = ['claims-data:/data'];
  service.environment = {
    MOCHI_CLAIMS_MODE: 'pilot', MOCHI_CLAIMS_DATABASE: '/data/claims.sqlite', MOCHI_CLAIMS_DAILY_ACTIONS: '40',
    MOCHI_CLAIMS_ACCESS_TOKEN: '${MOCHI_CLAIMS_ACCESS_TOKEN:?protected invitation token required}',
    PHALA_API_KEY: '${PHALA_API_KEY:?protected provider key required}',
    MOCHI_CLAIMS_JURORS: JSON.stringify(REAL_MODELS.map((model, i) => ({ id: `juror-${i+1}`, model, transport: 'phala-aci', baseUrl: 'https://inference.phala.com/v1', apiKeyEnv: 'PHALA_API_KEY' }))),
  };
  // Named storage persists on the existing CVM disk; private source sessions remain in memory.
  service.healthcheck = { test: ['CMD', 'bun', '-e', 'if(!(await fetch("http://localhost:8080/health")).ok)process.exit(1)'], interval: '30s', timeout: '5s', retries: 3 };
  compose.services = { 'claims-research': service };
  compose.volumes = { 'claims-data': { name: 'mochi-claims-data' } };
  return Bun.YAML.stringify(compose, null, 2) + '\n';
}
export async function buildClaimsArtifact() {
  assertLocalRoundDependencies();
  const build = await Bun.build({ entrypoints: [resolve(ROOT, 'deploy/phala/claims-service/server.ts')], target: 'bun', minify: true, sourcemap: 'none' });
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
  } else if (args.length === 6 && args[0] === '--revision' && args[2] === '--sha256' && args[4] === '--out') {
    writeFileSync(resolve(args[5]!), renderClaimsCompose(args[1]!, args[3]!), { mode: 0o600 }); console.log('Rendered pinned invitation research service compose');
  } else throw new Error('Use --build-artifact or --revision <sha> --sha256 <digest> --out <file>');
}
