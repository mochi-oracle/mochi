import {test,expect} from 'bun:test';
import {createWebHandler,publicConfig,WEBSITE_WRITE_QUOTAS} from '../server.ts';
import {createProductionProxy,DEFAULT_PUBLIC_QUOTAS} from '../../deploy/production/public-proxy.ts';
import {visitorKey} from '../../services/claims/src/visitor-key.ts';
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
test('same-site browser POSTs pass behind a TLS-terminating proxy; other origins are still refused',async()=>{
 let calls=0;const handler=createWebHandler({dist,rpc:'https://rpc.example/',fetcher:async()=>{calls++;return Response.json({jsonrpc:'2.0',id:1,result:'0x1237'})}});
 const send=(origin:string)=>handler(new Request('http://mochioracle.com/rpc',{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https',origin},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId'})}));
 expect((await send('https://mochioracle.com')).status).toBe(200);expect(calls).toBe(1);
 expect((await send('https://evil.example')).status).toBe(403);
 expect((await send('http://mochioracle.com')).status).toBe(403);expect(calls).toBe(1);
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
test('every response carries a strict CSP, HSTS, frame denial, nosniff and no-referrer; inline handlers are hash-pinned',async()=>{
 const fixture=await realpath(await mkdtemp(join(tmpdir(),'mochi-csp-')));
 try {
  await mkdir(join(fixture,'check'),{recursive:true});
  await writeFile(join(fixture,'index.html'),`<a onclick="location.href='/check/'" role="link">x</a><script type="module" src="/assets/a.js"></script><script>window.boot=1</script>`);
  await writeFile(join(fixture,'check/index.html'),'<button onclick="location.href=&#39;/check/&#39;">y</button>');
  const handler=createWebHandler({dist:fixture,claims:async()=>Response.json({ok:true}),fetcher:async()=>Response.json({})});
  const sha=(value:string)=>`'sha256-${new Bun.CryptoHasher('sha256').update(value).digest('base64')}'`;
  for(const path of ['/','/check/','/api/claims/config','/mochi-config.json','/missing','/api/v1/admin']) {
   const response=await handler(new Request('http://localhost'+path));
   const csp=response.headers.get('content-security-policy')!;
   expect(csp).toContain("default-src 'self'");expect(csp).toContain("frame-ancestors 'none'");expect(csp).toContain("object-src 'none'");
   expect(csp).toContain("base-uri 'none'");expect(csp).toContain("connect-src 'self'");expect(csp).not.toContain("'unsafe-eval'");
   expect(csp).toMatch(/script-src 'self' 'unsafe-hashes' /);expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
   expect(csp).toContain(sha("location.href='/check/'"));expect(csp).toContain(sha('window.boot=1'));
   expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
   expect(response.headers.get('x-frame-options')).toBe('DENY');
   expect(response.headers.get('x-content-type-options')).toBe('nosniff');
   expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }
 } finally {await rm(fixture,{recursive:true,force:true})}
});
test('the built site CSP allows exactly its inline handlers and nothing inline beyond them',async()=>{
 const csp=(await createWebHandler({dist})(new Request('http://localhost/'))).headers.get('content-security-policy')!;
 const scriptSrc=csp.split('; ').find(part=>part.startsWith('script-src'))!;
 expect(scriptSrc.split(' ').filter(token=>token.startsWith("'sha256-")).length).toBeGreaterThan(0);
 expect(scriptSrc.split(' ').every(token=>token==='script-src'||token==="'self'"||token==="'unsafe-hashes'"||/^'sha256-[A-Za-z0-9+/=]+'$/.test(token))).toBe(true);
});
test('website protocol writes are rate limited per visitor before reaching the protocol',async()=>{
 let calls=0;let now=0;
 const handler=createWebHandler({dist,gateway:'https://gateway.example/',now:()=>now,fetcher:async()=>{calls++;return Response.json({ok:true})},quotas:{'/v1/intake/upload':[{scope:'client',unit:'requests',limit:2,windowSec:3600}],'/v1/query':[{scope:'client',unit:'bytes',limit:10,windowSec:3600}]}});
 const send=(path:string,ip:string,body='{}')=>handler(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':`10.0.0.1, ${ip}`},body}));
 expect((await send('/api/v1/intake/upload','203.0.113.7')).status).toBe(200);
 expect((await send('/api/v1/intake/upload','203.0.113.7')).status).toBe(200);
 const limited=await send('/api/v1/intake/upload','203.0.113.7');
 expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).not.toBeNull();expect(limited.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
 expect((await send('/api/v1/intake/upload','203.0.113.8')).status).toBe(200);
 expect((await send('/api/v1/query','203.0.113.7','{"a":"0123456789"}')).status).toBe(429);
 expect(calls).toBe(3);
 now+=3600;expect((await send('/api/v1/intake/upload','203.0.113.7')).status).toBe(200);
});
test('unknown pages get the branded HTML 404 with Home and Check links; API paths keep JSON errors',async()=>{
 const fixture=await realpath(await mkdtemp(join(tmpdir(),'mochi-404-')));
 try {
  await writeFile(join(fixture,'index.html'),'home');
  const handler=createWebHandler({dist:fixture});
  // No dist/404.html: the built-in fallback page is still HTML with both links.
  for(const path of ['/no-such-page','/no-such-page/','/.git/config','/.env','/%E0%A4%A','/assets/missing.js']) {
   const response=await handler(new Request('http://localhost'+path));
   expect(response.status).toBe(404);
   expect(response.headers.get('content-type')).toContain('text/html');
   expect(response.headers.get('cache-control')).toBe('no-store');
   expect(response.headers.get('x-frame-options')).toBe('DENY');
   expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
   expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
   const html=await response.text();
   expect(html).toContain('href="/"');expect(html).toContain('href="/check/"');
  }
  const head=await handler(new Request('http://localhost/no-such-page',{method:'HEAD'}));
  expect(head.status).toBe(404);expect(await head.text()).toBe('');
  for(const path of ['/api','/api/v1/admin','/api/tokenomics/missing']) {
   const response=await handler(new Request('http://localhost'+path));
   expect(response.status).toBe(404);expect(response.headers.get('content-type')).toContain('application/json');
   expect(await response.json()).toEqual({error:'Not found'});
  }
  expect((await handler(new Request('http://localhost/no-such-page',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status).toBe(405);
  // With a built 404 page, that page is served.
  await writeFile(join(fixture,'404.html'),'<!doctype html><title>Page not found | MOCHI</title><a href="/">Home</a><a href="/check/">Check a claim</a>');
  const built=await createWebHandler({dist:fixture})(new Request('http://localhost/missing/deeper'));
  expect(built.status).toBe(404);expect(await built.text()).toContain('<title>Page not found | MOCHI</title>');
 } finally {await rm(fixture,{recursive:true,force:true})}
});
test('the production build ships the branded 404 page',async()=>{
 const response=await createWebHandler({dist})(new Request('http://localhost/this-page-does-not-exist'));
 expect(response.status).toBe(404);
 const html=await response.text();
 expect(html).toContain('Page not found | MOCHI');expect(html).toContain('href="/check/"');expect(html).toMatch(/href="\/assets\/[^"]+\.css"/);
});
test('robots.txt points to a sitemap of public pages, each with a matching canonical tag',async()=>{
 const handler=createWebHandler({dist});
 const robots=await (await handler(new Request('http://localhost/robots.txt'))).text();
 expect(robots).toContain('Sitemap: https://mochioracle.com/sitemap.xml');expect(robots).toContain('Disallow: /api/');
 const sitemap=await (await handler(new Request('http://localhost/sitemap.xml'))).text();
 const pages=[...sitemap.matchAll(/<loc>https:\/\/mochioracle\.com(\/[^<]*)<\/loc>/g)].map(m=>m[1]!);
 expect(pages).toContain('/');expect(pages).toContain('/check/');
 expect(pages.some(p=>/terms|privacy/.test(p))).toBe(false);
 for(const page of pages) {
  const response=await handler(new Request('http://localhost'+page));
  expect(response.status).toBe(200);
  // nosemgrep: html-in-template-string -- expected markup in an assertion
  expect(await response.text()).toContain(`<link rel="canonical" href="https://mochioracle.com${page}"/>`);
 }
});
test('every public page links the favicon and touch icon, and /favicon.ico is served',async()=>{
 const handler=createWebHandler({dist});
 const icon=await handler(new Request('http://localhost/favicon.ico'));
 expect(icon.status).toBe(200);expect((await icon.arrayBuffer()).byteLength).toBeGreaterThan(0);
 for(const page of ['/','/about/','/how-it-works/','/case-study/','/roadmap/','/docs/','/whitepaper/','/dashboard/','/check/','/guide/','/tokenomics/']) {
  const html=await (await handler(new Request('http://localhost'+page))).text();
  expect(html).toContain('href="/favicon.ico"');
  expect(html).toContain('href="/assets/brand/apple-touch-icon.png"');
 }
});

const TOKEN='test-invitation-token-at-least-24-characters';
test('requests to the protocol gateway carry a signed per-visitor key; nothing else does, and a caller copy is never forwarded',async()=>{
 const sent:Array<{url:string;headers:Record<string,string>}>=[];
 const fetcher=(async(url:URL,init:RequestInit)=>{sent.push({url:String(url),headers:init.headers as Record<string,string>});return Response.json({jsonrpc:'2.0',id:1,result:'0x1'})}) as unknown as typeof fetch;
 const handler=createWebHandler({dist,gateway:'https://cvm.example/',indexer:'https://indexer.example/',rpc:'https://rpc.example/key',fetcher,visitorSecret:TOKEN,now:()=>1_700_000_000});
 const headers={'content-type':'application/json','x-forwarded-for':'10.0.0.1, 203.0.113.7','x-mochi-visitor':'v1.chosen-by-caller','x-mochi-client':'chosen'};
 await handler(new Request('http://localhost/api/v1/query',{method:'POST',headers,body:'{}'}));
 await handler(new Request('http://localhost/api/v1/stats',{headers}));
 await handler(new Request('http://localhost/rpc',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId'})}));
 await handler(new Request('http://localhost/indexer/v1/receipts/0x'+'11'.repeat(32),{headers}));
 const cvm=visitorKey(TOKEN)!;
 const [query,stats,rpc,indexer]=sent;
 for(const call of [query!,stats!]) {
  expect(Object.keys(call.headers).sort()).toEqual(['content-type','x-mochi-visitor']);
  expect(cvm.verify(call.headers['x-mochi-visitor'],1_700_000_000).status).toBe('valid');
  expect(call.headers['x-mochi-visitor']).not.toContain('203.0.113');
 }
 expect(query!.headers['x-mochi-visitor']!.split('.')[1]).toBe(stats!.headers['x-mochi-visitor']!.split('.')[1]);
 for(const call of [rpc!,indexer!])expect(call.headers).toEqual({'content-type':'application/json'});
 // Without the token configured the website sends no visitor header.
 sent.length=0;
 await createWebHandler({dist,gateway:'https://cvm.example/',fetcher})(new Request('http://localhost/api/v1/query',{method:'POST',headers,body:'{}'}));
 expect(sent[0]!.headers).toEqual({'content-type':'application/json'});
});
test('end to end: website visitors get separate CVM-side buckets; one visitor cannot lock out the rest',async()=>{
 const keys:string[]=[];
 const cvm=createProductionProxy({ready:()=>true,gatewayPort:3200,indexerPort:3201,visitorSecret:TOKEN,quotas:{upload:[{scope:'client',unit:'requests',limit:5,windowSec:3600}]},
  fetcher:(async(_url:string,init:RequestInit)=>{keys.push((init.headers as Record<string,string>)['x-mochi-client']!);return Response.json({ok:true})}) as unknown as typeof fetch});
 // The Phala hop: every website request reaches the CVM from the website's one egress address.
 const fetcher=(async(url:URL,init:RequestInit)=>cvm(new Request(url,init),'69.46.46.200')) as unknown as typeof fetch;
 const web=createWebHandler({dist,gateway:'https://cvm.example',fetcher,visitorSecret:TOKEN,quotas:{'/v1/intake/upload':[{scope:'client',unit:'requests',limit:5,windowSec:3600}]}});
 const upload=(visitor:string)=>web(new Request('https://mochioracle.com/api/v1/intake/upload',{method:'POST',headers:{'x-forwarded-for':visitor,'content-type':'application/json'},body:'{}'}));
 for(let i=0;i<5;i++)expect((await upload('198.51.100.66')).status).toBe(200);
 expect((await upload('198.51.100.66')).status).toBe(429);
 for(const visitor of ['192.0.2.10','192.0.2.11','2001:db8:5:6::1'])expect((await upload(visitor)).status).toBe(200);
 expect(new Set(keys).size).toBe(4);
 expect(keys.every(key=>/^visitor:[A-Za-z0-9_-]{22}$/.test(key))).toBe(true);
 // The website's per-visitor limits sit at or below the CVM's per-client ones.
 const limit=(rules:typeof DEFAULT_PUBLIC_QUOTAS.upload,unit:string)=>rules.find(r=>r.scope==='client'&&r.unit===unit&&r.windowSec===3600)!.limit;
 for(const [site,proxy] of [[WEBSITE_WRITE_QUOTAS['/v1/intake/upload'],DEFAULT_PUBLIC_QUOTAS.upload],[WEBSITE_WRITE_QUOTAS['/v1/query'],DEFAULT_PUBLIC_QUOTAS.query]] as const)
  for(const unit of ['requests','bytes'])expect(limit(site,unit)).toBeLessThanOrEqual(limit(proxy,unit));
});
test('read-only RPC is limited per visitor by call count, and in total',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,rpc:'https://rpc.example/',now:()=>0,fetcher:async()=>{calls++;return Response.json([])},
  rpcQuotas:[{scope:'client',unit:'requests',limit:25,windowSec:60},{scope:'global',unit:'requests',limit:40,windowSec:60}]});
 const rpc=(ip:string,n:number)=>handler(new Request('http://localhost/rpc',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':ip},body:JSON.stringify(Array.from({length:n},(_,id)=>({jsonrpc:'2.0',id,method:'eth_call'})))}));
 expect((await rpc('203.0.113.1',20)).status).toBe(200);
 const limited=await rpc('203.0.113.1',20);
 expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).not.toBeNull();
 expect((await rpc('203.0.113.1',5)).status).toBe(200);
 expect((await rpc('203.0.113.2',15)).status).toBe(200);
 // 40 calls in total: every visitor waits now.
 expect((await rpc('203.0.113.3',1)).status).toBe(429);
 expect(calls).toBe(3);
});
test('collateral: misses are limited per visitor and in total, failures are remembered, and concurrent fetches are joined',async()=>{
 const fetched:string[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 // Like PcsCollateralSource: successes are cached by the source; `fetched` counts PCS round trips.
 const cache=new Map<string,unknown>();
 const collateral={get:async(fmspc:string,ca:string)=>{
  const key=`${fmspc}:${ca}`;if(cache.has(key))return cache.get(key);
  fetched.push(key);if(fmspc==='00606A000000')await gate;if(fmspc.startsWith('FF'))throw new Error('PCS HTTP 404');
  cache.set(key,{fmspc});return {fmspc};
 }};
 let now=0;
 const handler=createWebHandler({dist,collateral,now:()=>now,collateralQuotas:{misses:[{scope:'client',unit:'requests',limit:3,windowSec:3600},{scope:'global',unit:'requests',limit:5,windowSec:3600}]}});
 const get=(fmspc:string,ip='203.0.113.1',ca='platform')=>handler(new Request(`http://localhost/api/v1/attestation/collateral/${fmspc}/${ca}`,{headers:{'x-forwarded-for':ip}}));
 // Concurrent requests for one FMSPC share one PCS fetch and one miss.
 const joined=[get('00606a000000'),get('00606A000000'),get('00606A000000','203.0.113.2')];
 await Bun.sleep(5);release();
 for(const response of await Promise.all(joined))expect(response.status).toBe(200);
 expect(fetched).toEqual(['00606A000000:platform']);
 // A cached FMSPC is served again without a miss charge.
 for(let i=0;i<10;i++)expect((await get('00606A000000')).status).toBe(200);
 // Random FMSPCs fail at PCS; each failure is remembered and not fetched again.
 expect((await get('FF0000000001')).status).toBe(502);
 expect((await get('FF0000000001')).status).toBe(503);
 expect((await get('FF0000000002')).status).toBe(502);
 // Visitor 203.0.113.1 has spent its three misses.
 expect((await get('FF0000000003')).status).toBe(429);
 expect((await get('FF0000000003','203.0.113.3')).status).toBe(502);
 expect((await get('FF0000000004','203.0.113.4')).status).toBe(502);
 // Five misses in total: nobody causes another PCS fetch this hour, but cached platforms still work.
 expect((await get('FF0000000005','203.0.113.5')).status).toBe(429);
 expect((await get('00606A000000','203.0.113.5')).status).toBe(200);
 expect(fetched).toHaveLength(5);
 // Failures are retried after their short negative-cache time.
 now+=301;now+=3600;
 expect((await get('FF0000000001','203.0.113.6')).status).toBe(502);
 expect(fetched).toHaveLength(6);
});
test('website request bodies must arrive within the read deadline',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,gateway:'https://cvm.example/',rpc:'https://rpc.example/',bodyDeadlineMs:100,fetcher:async()=>{calls++;return Response.json({})}});
 for(const path of ['/api/v1/intake/upload','/rpc']) {
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}});
  const response=await handler(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.1'},body,duplex:'half'} as RequestInit));
  expect(response.status).toBe(408);
 }
 expect((await handler(new Request('http://localhost/api/v1/query',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(1_048_577)}))).status).toBe(413);
 expect(calls).toBe(0);
});
test('/health reports how the visitor is keyed and the visitor-key fingerprint, never an address or the token',async()=>{
 const handler=createWebHandler({dist,visitorSecret:TOKEN});
 const health=async(headers:Record<string,string>,peer?:string)=>(await handler(new Request('http://localhost/health',{headers}),peer)).json() as Promise<any>;
 const a=await health({'x-forwarded-for':'10.0.0.1, 203.0.113.7'},'100.64.0.2');
 expect(a).toMatchObject({ok:true,client:{keySource:'forwarded',forwardedFor:{entries:2,last:'public'},peer:'private',visitorKeyId:visitorKey(TOKEN)!.id}});
 expect(a.client.forwardedFor.lastTag).toBe(a.client.keyTag);expect(a.client.peerTag).not.toBe(a.client.keyTag);
 expect((await health({'x-forwarded-for':'198.51.100.1, 203.0.113.7'},'100.64.0.3')).client.keyTag).toBe(a.client.keyTag);
 expect((await health({'x-forwarded-for':'203.0.113.8'},'100.64.0.2')).client.keyTag).not.toBe(a.client.keyTag);
 const text=JSON.stringify(a);
 for(const value of ['203.0.113','100.64.0.2',TOKEN])expect(text).not.toContain(value);
 expect((await (await createWebHandler({dist})(new Request('http://localhost/health'))).json() as any).client).toMatchObject({keySource:'none',visitorKeyId:null});
});
