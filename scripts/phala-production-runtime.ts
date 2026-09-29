import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanEntry } from './identity-guard.ts';
import { assertLocalRoundDependencies } from './phala-round-rehearsal.ts';

export const RUNTIME_ARTIFACT = 'deploy/production/assets/runtime.br';
export const RUNTIME_SERVICES = ['intake','consensus','juror','juror-pool','gateway','indexer','attestor','orchestrator','postman'] as const;
const ROOT=resolve(import.meta.dir,'..');
export async function buildProductionRuntimeArtifact() {
  assertLocalRoundDependencies();
  const out=mkdtempSync(join(tmpdir(),'mochi-runtime-build-'));
  try {
    const built=spawnSync('bun',['scripts/build-production-runtime.ts','--out',out],{cwd:ROOT,encoding:'utf8',timeout:120_000});
    if(built.status!==0)throw new Error('Production runtime build failed; inspect service build locally');
    const policyPath=spawnSync('git',['rev-parse','--git-path','info/identity-denylist'],{cwd:ROOT,encoding:'utf8'});
    if(policyPath.status!==0)throw new Error('Identity policy unavailable');
    const policy=resolve(ROOT,policyPath.stdout.trim());
    const deny=existsSync(policy)?readFileSync(policy,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')):[];
    const files: Record<string,string>={};
    for(const service of RUNTIME_SERVICES)files[`services/${service}.mjs`]=readFileSync(join(out,'services',`${service}.mjs`),'utf8');
    for(const name of readdirSync(join(out,'migrations')).sort()) {
      if(!/^\d{4}_[a-z0-9_]+\.sql$/.test(name))throw new Error('Unexpected migration name');
      files[`migrations/${name}`]=readFileSync(join(out,'migrations',name),'utf8');
    }
    for(const [path,content] of Object.entries(files))if(scanEntry({path:`deploy/production/runtime/${path}`,data:Buffer.from(content)},deny).length)throw new Error(`Runtime artifact identity scan failed: ${path}`);
    const expanded=Buffer.from(JSON.stringify({format:'mochi-runtime-artifact-v1',files}));
    if(expanded.length>32*1024*1024)throw new Error('Runtime exceeds expanded size limit');
    const compressed=brotliCompressSync(expanded,{params:{[constants.BROTLI_PARAM_QUALITY]:11}});
    if(compressed.length>4*1024*1024)throw new Error('Runtime exceeds compressed size limit');
    return {compressed,expandedBytes:expanded.length,fileCount:Object.keys(files).length,sha256:createHash('sha256').update(compressed).digest('hex')};
  } finally {rmSync(out,{recursive:true,force:true})}
}

/** Measured bootstrap: pinned revision, digest and a closed path allowlist. */
export function runtimeBootstrap(revision:string,digest:string) {
  if(!/^[a-f0-9]{40}$/.test(revision)||!/^[a-f0-9]{64}$/.test(digest))throw new Error('Runtime requires immutable revision and SHA256');
  return [
    'const runtimeResponse=await fetch('+JSON.stringify(`https://raw.githubusercontent.com/mochi-oracle/mochi/${revision}/${RUNTIME_ARTIFACT}`)+',{redirect:"error",signal:AbortSignal.timeout(30000)});',
    'if(!runtimeResponse.ok||!runtimeResponse.body)throw new Error("Runtime download failed");',
    'const runtimeReader=runtimeResponse.body.getReader();const runtimeChunks=[];let runtimeSize=0;',
    'for(;;){const {value,done}=await runtimeReader.read();if(done)break;runtimeSize+=value.length;if(runtimeSize>4194304){await runtimeReader.cancel();throw new Error("Runtime too large");}runtimeChunks.push(value);}',
    'const runtimeBytes=Buffer.concat(runtimeChunks);',
    'if(createHash("sha256").update(runtimeBytes).digest("hex")!=='+JSON.stringify(digest)+')throw new Error("Runtime digest mismatch");',
    'const runtime=JSON.parse(brotliDecompressSync(runtimeBytes,{maxOutputLength:33554432}));',
    'if(runtime.format!=="mochi-runtime-artifact-v1"||!runtime.files||typeof runtime.files!=="object")throw new Error("Invalid runtime format");',
    'const required='+JSON.stringify(RUNTIME_SERVICES.map(x=>`services/${x}.mjs`))+';',
    'if(required.some(p=>typeof runtime.files[p]!=="string")||Object.keys(runtime.files).length>64)throw new Error("Incomplete runtime");',
    'for(const [path,content] of Object.entries(runtime.files)){if(typeof content!=="string"||!(required.includes(path)||/^migrations\\/[0-9]{4}_[a-z0-9_]+\\.sql$/.test(path)))throw new Error("Invalid runtime file");await Bun.write("/tmp/mochi-runtime/"+path,content);}',
  ].join(' ');
}

if(import.meta.main) {
  if(Bun.argv.length!==3||Bun.argv[2]!=='--build-artifact')throw new Error('Use --build-artifact');
  const result=await buildProductionRuntimeArtifact();mkdirSync(resolve(ROOT,'deploy/production/assets'),{recursive:true});writeFileSync(resolve(ROOT,RUNTIME_ARTIFACT),result.compressed);
  console.log(JSON.stringify({path:RUNTIME_ARTIFACT,compressedBytes:result.compressed.length,expandedBytes:result.expandedBytes,fileCount:result.fileCount,sha256:result.sha256}));
}
