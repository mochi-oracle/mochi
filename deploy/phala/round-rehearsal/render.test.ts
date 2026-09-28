import {test,expect} from 'bun:test';
import {brotliCompressSync} from 'node:zlib';
import {renderRemoteRoundCompose} from '../../../scripts/phala-round-rehearsal.ts';

test('compose binds an immutable artifact and keeps the bounded existing VM policy',()=>{
 expect(()=>renderRemoteRoundCompose('main','a'.repeat(64))).toThrow();
 expect(()=>renderRemoteRoundCompose('a'.repeat(40),'not-a-digest')).toThrow();
 const compose=renderRemoteRoundCompose('a'.repeat(40),'b'.repeat(64));
 const service=(Bun.YAML.parse(compose) as any).services['confidential-round-rehearsal'];
 expect(Buffer.byteLength(compose)).toBeLessThan(190*1024);
 expect(service.restart).toBe('no');expect(service.mem_limit).toBe('1g');
 expect(service.environment.MOCHI_ROUND_MODE).toBe('synthetic-only');
 expect(service.read_only).toBe(true);expect(service.cap_drop).toEqual(['ALL']);
 expect(service.command[2]).toContain(`/mochi/${'a'.repeat(40)}/`);
 expect(service.command[2]).toContain('redirect:"error"');
 expect(service.command[2]).not.toContain('${');
});
test('actual bootstrap rejects altered artifact bytes before writing or executing code',async()=>{
 const service=(Bun.YAML.parse(renderRemoteRoundCompose('a'.repeat(40),'b'.repeat(64))) as any).services['confidential-round-rehearsal'];
 const fake=brotliCompressSync(Buffer.from('throw new Error("MUST_NOT_EXECUTE")')).toString('base64');
 const prefix=`globalThis.fetch=async()=>new Response(Buffer.from('${fake}','base64'));Bun.write=async()=>{throw new Error('MUST_NOT_WRITE')};`;
 const child=Bun.spawn([process.execPath,'-e',prefix+service.command[2]],{stdout:'pipe',stderr:'pipe'});
 const code=await child.exited;const stderr=await new Response(child.stderr).text();
 expect(code).not.toBe(0);expect(stderr).toContain('error: Artifact digest mismatch');
 expect(stderr).not.toContain('error: MUST_NOT_EXECUTE');expect(stderr).not.toContain('error: MUST_NOT_WRITE');
});
test('real artifact round-trips and decoded source passes identity checks',async()=>{
 // Bun's in-process bundler resolver can retain workspace state from another build test.
 // Use a fresh process, as the actual artifact CLI does.
 const script=`import {buildRoundArtifact} from './scripts/phala-round-rehearsal.ts';import {brotliDecompressSync} from 'node:zlib';const a=await buildRoundArtifact();console.log(JSON.stringify({sha256:a.sha256,compressed:a.compressed.length,expanded:a.expandedBytes,decoded:brotliDecompressSync(a.compressed).length}));`;
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:new URL('../../../',import.meta.url).pathname,stdout:'pipe',stderr:'pipe'});
 const output=await new Response(child.stdout).text();
 const errors=await new Response(child.stderr).text();
 expect(await child.exited,errors).toBe(0);
 const artifact=JSON.parse(output);
 expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
 expect(artifact.compressed).toBeLessThan(512*1024);
 expect(artifact.decoded).toBe(artifact.expanded);
});
