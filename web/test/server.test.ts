import {test,expect} from 'bun:test';
import {createWebHandler,publicConfig} from '../server.ts';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dist=new URL('../site/dist',import.meta.url).pathname;
test('only successful public assets are cached; HTML and API responses stay private',async()=>{
 const fixture=await realpath(await mkdtemp(join(tmpdir(),'mochi-cache-')));
 try {
  await mkdir(join(fixture,'assets/brand'),{recursive:true});
  for(const path of ['index.html','assets/site-12345678.js','assets/brand/logo.webp'])await writeFile(join(fixture,path),'fixture');
  const handler=createWebHandler({dist:fixture,claims:async()=>Response.json({private:true},{headers:{'cache-control':'public'}})});
  for(const method of ['GET','HEAD']) {
   const response=await handler(new Request('http://localhost/assets/site-12345678.js',{method}));
   expect(response.status).toBe(200);
   expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  }
  expect((await handler(new Request('http://localhost/assets/brand/logo.webp'))).headers.get('cache-control')).toBe('public, max-age=86400');
  for(const path of ['/','/api/claims/config','/mochi-config.json','/assets/missing.js'])expect((await handler(new Request('http://localhost'+path))).headers.get('cache-control')).toBe('no-store');
  expect((await handler(new Request('http://localhost/assets/site-12345678.js',{method:'POST'}))).headers.get('cache-control')).toBe('no-store');
 } finally {await rm(fixture,{recursive:true,force:true})}
});
test('public config never forwards RPC or service secrets',()=>{
 const addr='0x'+'11'.repeat(20), key='0x'+'22'.repeat(32);
 const value=publicConfig({enabled:true,chainId:4663,contracts:{queryEscrow:addr,jurorRegistry:addr,verdicts:addr,usdg:addr,receiptAnchor:addr,privateKey:'secret'},intakeAddress:addr,intakeMeasurement:key,receiptPublicKey:key,rpcUrl:'https://private/key',apiKey:'secret',jurySizes:[3]});
 expect(JSON.stringify(value)).not.toContain('secret');expect(JSON.stringify(value)).not.toContain('private/key');expect(value.rpcUrl).toBe('/rpc');
});
test('claim routes use their own handler and inherit website security headers',async()=>{
 const handler=createWebHandler({dist,claims:async()=>Response.json({enabled:false})});
 const response=await handler(new Request('http://localhost/api/claims/config'));
 expect(response.status).toBe(200);expect(await response.json()).toEqual({enabled:false});
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('x-frame-options')).toBe('DENY');
});
test('proxy rejects writes, cross-origin requests, and arbitrary paths',async()=>{
 let calls=0;const handler=createWebHandler({dist,fetcher:async()=>{calls++;return Response.json({})}});
 const send=(path:string,body:unknown,origin?:string)=>handler(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)}));
 expect((await send('/rpc',{jsonrpc:'2.0',method:'eth_sendRawTransaction'})).status).toBe(403);
 expect((await send('/rpc',[{jsonrpc:'2.0',method:'eth_call'},{jsonrpc:'2.0',method:'personal_unlockAccount'}])).status).toBe(403);
 expect((await send('/api/v1/query',{},'https://evil.example')).status).toBe(403);
 expect((await handler(new Request('http://localhost/api/v1/admin'))).status).toBe(404);expect(calls).toBe(0);
});
test('collateral endpoint only accepts a bounded FMSPC and CA, with no caller URL',async()=>{
 const calls:unknown[]=[];const handler=createWebHandler({dist,collateral:{get:async(...args)=>{calls.push(args);return {signed:'intel'}}}});
 expect((await handler(new Request('http://localhost/api/v1/attestation/collateral/ABCDEF123456/platform'))).status).toBe(200);
 expect((await handler(new Request('http://localhost/api/v1/attestation/collateral/localhost/processor'))).status).toBe(400);expect(calls).toEqual([['ABCDEF123456','platform']]);
});
test('static server does not serve private source or follow symlinks outside dist',async()=>{
 const handler=createWebHandler({dist});
 for(const path of ['/../AGENTS.md','/.git/config','/src/live-client.js','/web/AGENTS.md'])expect((await handler(new Request('http://localhost'+path))).status).toBe(404);
 expect((await handler(new Request('http://localhost/dashboard/'))).status).toBe(200);
 const redirect=await handler(new Request('http://localhost/dashboard?mode=sample'));
 expect(redirect.status).toBe(308);expect(redirect.headers.get('location')).toBe('/dashboard/?mode=sample');
 expect((await handler(new Request('http://localhost/dashboard/',{method:'HEAD'}))).status).toBe(200);
});
