import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderCompose } from './phala-rehearsal.ts';
import { scanEntry } from './identity-guard.ts';

const ROOT=resolve(import.meta.dir,'..');
const ARTIFACT='deploy/phala/round-rehearsal/assets/round-service.br';
export async function buildRoundArtifact() {
  const build=await Bun.build({entrypoints:[resolve(ROOT,'deploy/phala/round-rehearsal/server.ts')],target:'bun',minify:true,sourcemap:'none'});
  if(!build.success || build.outputs.length!==1)throw new Error('Could not bundle the confidential round rehearsal.');
  const expanded=new Uint8Array(await build.outputs[0]!.arrayBuffer());
  if(expanded.byteLength>2*1024*1024)throw new Error('Rehearsal bundle exceeds 2 MiB.');
  // Check the decoded artifact as well as the tracked compressed bytes before publication.
  const gitPath=spawnSync('git',['rev-parse','--git-path','info/identity-denylist'],{cwd:ROOT,encoding:'utf8'});
  if(gitPath.status!==0)throw new Error('Cannot locate local identity policy.');
  const denyPath=resolve(ROOT,gitPath.stdout.trim());
  const deny=existsSync(denyPath)?readFileSync(denyPath,'utf8').split(/\r?\n/u).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')):[];
  const findings=scanEntry({path:'deploy/phala/round-rehearsal/round-service.mjs',data:expanded},deny);
  if(findings.length)throw new Error(`Decoded artifact identity scan failed (${findings.length} findings).`);
  const compressed=brotliCompressSync(expanded,{params:{[constants.BROTLI_PARAM_QUALITY]:11}});
  return {compressed,expandedBytes:expanded.byteLength,sha256:createHash('sha256').update(compressed).digest('hex')};
}

export function renderRemoteRoundCompose(revision:string,sha256:string,mode:'synthetic-only'|'real-phala-aci'='synthetic-only') {
  if(!/^[0-9a-f]{40}$/u.test(revision)||!/^[0-9a-f]{64}$/u.test(sha256))throw new Error('Full immutable Git revision and SHA-256 are required.');
  if(mode!=='synthetic-only'&&mode!=='real-phala-aci')throw new Error('Unsupported rehearsal mode.');
  const url=`https://raw.githubusercontent.com/mochi-oracle/mochi/${revision}/${ARTIFACT}`;
  const parsed=Bun.YAML.parse(renderCompose(Buffer.from('placeholder').toString('base64'))) as any;
  const service=parsed.services['hardware-rehearsal'];
  service.environment={HOST:'0.0.0.0',PORT:'8080',TEE_MODE:'dstack',TEE_KEYS:'ephemeral',DSTACK_SOCKET:'/var/run/dstack.sock',SEALED_STORE_DIR:'/tmp/round',MOCHI_ROUND_MODE:mode,...(mode==='real-phala-aci'?{PHALA_API_KEY:'${PHALA_API_KEY:?set PHALA_API_KEY in the protected compose environment}',MOCHI_ROUND_AUTH_SECRET:'${MOCHI_ROUND_AUTH_SECRET:?set MOCHI_ROUND_AUTH_SECRET in the protected compose environment}'}:{})};
  // URL and expected digest are measured compose literals. No branch URL or mutable version is accepted.
  const bootstrap=[
    'import { brotliDecompressSync } from "node:zlib";',
    'import { createHash } from "node:crypto";',
    `const response=await fetch(${JSON.stringify(url)},{redirect:"error",signal:AbortSignal.timeout(20000)});`,
    'if(!response.ok||!response.body)throw new Error("Artifact download failed");',
    'const reader=response.body.getReader();const chunks=[];let size=0;',
    'for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>524288){await reader.cancel();throw new Error("Artifact too large");}chunks.push(value);}',
    'const compressed=Buffer.concat(chunks);',
    `if(createHash("sha256").update(compressed).digest("hex")!==${JSON.stringify(sha256)})throw new Error("Artifact digest mismatch");`,
    'const code=brotliDecompressSync(compressed,{maxOutputLength:2097152});',
    'await Bun.write("/tmp/mochi-round.mjs",code);await import("/tmp/mochi-round.mjs");',
  ].join(' ');
  service.command=['bun','-e',bootstrap];
  parsed.services={'confidential-round-rehearsal':service};
  const compose=Bun.YAML.stringify(parsed,null,2)+'\n';
  if(Buffer.byteLength(compose)>190*1024)throw new Error('Compose exceeds the existing safety budget.');
  return compose;
}
if(import.meta.main){
 const args=Bun.argv.slice(2);
 if(args.length===1&&args[0]==='--build-artifact'){
  const artifact=await buildRoundArtifact();const path=resolve(ROOT,ARTIFACT);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,artifact.compressed);
  console.info(JSON.stringify({path:ARTIFACT,compressedBytes:artifact.compressed.length,expandedBytes:artifact.expandedBytes,sha256:artifact.sha256}));
 }else if((args.length===6||args.length===8)&&args[0]==='--revision'&&args[2]==='--sha256'&&args[4]==='--out'){
  let mode:'synthetic-only'|'real-phala-aci'='synthetic-only';
  if(args.length===8){if(args[6]!=='--mode'||args[7]!=='real-aci')throw new Error('--mode only accepts real-aci.');mode='real-phala-aci';}
  const compose=renderRemoteRoundCompose(args[1]!,args[3]!,mode);const path=resolve(args[5]!);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,compose,{mode:0o600});console.info(`Rendered pinned ${mode} round compose: ${Buffer.byteLength(compose)} bytes`);
}else throw new Error('Use --build-artifact, or --revision <commit> --sha256 <digest> --out <path> [--mode real-aci].');
}
