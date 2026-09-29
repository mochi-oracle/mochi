import {test,expect} from 'bun:test';
import {brotliCompressSync,brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {runtimeBootstrap,RUNTIME_SERVICES} from './phala-production-runtime.ts';
async function extract(extra:Record<string,string>={},wrongDigest=false){
 const files=Object.fromEntries(RUNTIME_SERVICES.map(x=>[`services/${x}.mjs`,'export {};']));
 Object.assign(files,{'migrations/0001_init.sql':'SELECT 1;'},extra);
 const bytes=brotliCompressSync(Buffer.from(JSON.stringify({format:'mochi-runtime-artifact-v1',files})));
 const digest=createHash('sha256').update(bytes).digest('hex'),writes:string[]=[];
 const run=new Function('fetch','createHash','brotliDecompressSync','Bun',`return (async()=>{${runtimeBootstrap('a'.repeat(40),wrongDigest?'0'.repeat(64):digest)}})()`);
 await run(async()=>new Response(bytes),createHash,brotliDecompressSync,{write:async(path:string)=>{writes.push(path)}});
 return writes;
}
test('runtime archive extracts only known service and migration paths',async()=>{
 const writes=await extract();expect(writes).toHaveLength(RUNTIME_SERVICES.length+1);expect(RUNTIME_SERVICES).toContain('juror-pool');expect(writes.every(x=>x.startsWith('/tmp/mochi-runtime/'))).toBe(true);
 await expect(extract({'../outside':'bad'})).rejects.toThrow('Invalid runtime file');
 await expect(extract({},true)).rejects.toThrow('Runtime digest mismatch');
 expect(()=>runtimeBootstrap('main','a'.repeat(64))).toThrow('immutable');
});
