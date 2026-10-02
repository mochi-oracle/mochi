import {test,expect} from 'bun:test';
import {createWebHandler,publicConfig,pinnedFmspcsFromEnv,websiteForwardedHops,websiteForwardingPolicy,websiteTrustsForwardedFor,RAILWAY_FORWARDED_HOPS,WEBSITE_COLLATERAL_QUOTAS,WEBSITE_RPC_QUOTAS,WEBSITE_WRITE_QUOTAS} from '../server.ts';
import {createProductionProxy,DEFAULT_PUBLIC_QUOTAS} from '../../deploy/production/public-proxy.ts';
import {keyCheckHeader,visitorKey} from '../../services/claims/src/visitor-key.ts';
import {closeAbandonedConnection} from '../../services/claims/src/bounded-body.ts';
import {connect} from 'node:net';
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
 const handler=createWebHandler({dist,gateway:'https://gateway.example/',now:()=>now,trustForwardedFor:true,fetcher:async()=>{calls++;return Response.json({ok:true})},quotas:{'/v1/intake/upload':[{scope:'client',unit:'requests',limit:2,windowSec:3600}],'/v1/query':[{scope:'client',unit:'bytes',limit:10,windowSec:3600}]}});
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
 const handler=createWebHandler({dist,gateway:'https://cvm.example/',indexer:'https://indexer.example/',rpc:'https://rpc.example/key',fetcher,visitorSecret:TOKEN,trustForwardedFor:true,now:()=>1_700_000_000});
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
 const web=createWebHandler({dist,gateway:'https://cvm.example',fetcher,visitorSecret:TOKEN,trustForwardedFor:true,quotas:{'/v1/intake/upload':[{scope:'client',unit:'requests',limit:5,windowSec:3600}]}});
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
test('read-only RPC is limited per visitor by call count, and in total; one call is charged before the body is read',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,rpc:'https://rpc.example/',now:()=>0,trustForwardedFor:true,fetcher:async()=>{calls++;return Response.json([])},
  rpcQuotas:[{scope:'client',unit:'requests',limit:25,windowSec:60},{scope:'global',unit:'requests',limit:40,windowSec:60}]});
 const rpc=(ip:string,n:number)=>handler(new Request('http://localhost/rpc',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':ip},body:JSON.stringify(Array.from({length:n},(_,id)=>({jsonrpc:'2.0',id,method:'eth_call'})))}));
 expect((await rpc('203.0.113.1',20)).status).toBe(200);
 // 5 left: the batch of 20 is refused after its first call was charged (4 left).
 const limited=await rpc('203.0.113.1',20);
 expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).not.toBeNull();
 expect((await rpc('203.0.113.1',4)).status).toBe(200);
 expect((await rpc('203.0.113.1',1)).status).toBe(429);
 expect((await rpc('203.0.113.2',15)).status).toBe(200);
 // 40 calls in total: every visitor waits now.
 expect((await rpc('203.0.113.3',1)).status).toBe(429);
 expect(calls).toBe(3);
});
test('a refused RPC batch asks for long enough to get the whole batch through, so retrying per Retry-After cannot livelock',async()=>{
 let calls=0,now=0;
 const handler=createWebHandler({dist,rpc:'https://rpc.example/',now:()=>now,trustForwardedFor:true,fetcher:async()=>{calls++;return Response.json([])},
  rpcQuotas:[{scope:'client',unit:'requests',limit:4,windowSec:4}]});
 const batch=()=>handler(new Request('http://localhost/rpc',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.9'},body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'eth_call'},{jsonrpc:'2.0',id:2,method:'eth_blockNumber'}])}));
 expect((await batch()).status).toBe(200);expect((await batch()).status).toBe(200);
 // Empty: refused before the body is read; one call a second refills.
 const empty=await batch();expect(empty.status).toBe(429);expect(empty.headers.get('retry-after')).toBe('1');
 now+=1;
 // One call is back: it is charged before the read, the second is refused, and Retry-After covers both.
 const partial=await batch();expect(partial.status).toBe(429);expect(partial.headers.get('retry-after')).toBe('2');
 now+=2;
 expect((await batch()).status).toBe(200);
 expect(calls).toBe(3);
});
test('read-only RPC groups IPv6 visitors by /56 and refuses a body over 64 KiB before reading it',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,rpc:'https://rpc.example/',now:()=>0,trustForwardedFor:true,fetcher:async()=>{calls++;return Response.json({jsonrpc:'2.0',id:1,result:'0x1'})},
  rpcQuotas:[{scope:'client',unit:'requests',limit:2,windowSec:60}]});
 const rpc=(ip:string,body=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber'}))=>handler(new Request('http://localhost/rpc',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':ip},body}));
 expect((await rpc('2001:db8:1:200::1')).status).toBe(200);
 expect((await rpc('2001:db8:1:2ff:ffff::9')).status).toBe(200);
 expect((await rpc('2001:db8:1:2aa::1')).status).toBe(429);
 expect((await rpc('2001:db8:1:300::1')).status).toBe(200);
 const large=await rpc('198.51.100.1',JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:['x'.repeat(65_536)]}));
 expect(large.status).toBe(413);expect(large.headers.get('connection')).toBe('close');
 expect((await rpc('198.51.100.2','not json')).status).toBe(400);
 expect(calls).toBe(3);
});
test('a normal paid check fits the default RPC limits with room for several visitors behind one address',()=>{
 const rule=(scope:string,windowSec:number)=>WEBSITE_RPC_QUOTAS.find(r=>r.scope===scope&&r.windowSec===windowSec)!.limit;
 // At most about 120 calls per check, peaking at 30 a minute while waiting (live-client.js POLL_INTERVAL_MS).
 const perCheck=120, peakPerMinute=30;
 expect(rule('client',60)/peakPerMinute).toBeGreaterThanOrEqual(4);
 expect(rule('client',3600)/perCheck).toBeGreaterThanOrEqual(20);
 // Spending the global budget takes many addresses, each at its own limit.
 expect(rule('global',60)/rule('client',60)).toBeGreaterThanOrEqual(50);
 expect(rule('global',3600)/rule('client',3600)).toBeGreaterThanOrEqual(50);
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
 const handler=createWebHandler({dist,collateral,now:()=>now,trustForwardedFor:true,collateralQuotas:{pinned:[],misses:[{scope:'client',unit:'requests',limit:3,windowSec:3600},{scope:'global',unit:'requests',limit:5,windowSec:3600}]}});
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
test('collateral: an attacker who drains the miss budget long after a platform was first served cannot lock visitors out of it',async()=>{
 const fetched:string[]=[];
 const collateral={get:async(fmspc:string,ca:string)=>{fetched.push(`${fmspc}:${ca}`);if(fmspc.startsWith('FF'))throw new Error('PCS HTTP 404');return {fmspc};}};
 let now=0;
 const handler=createWebHandler({dist,collateral,now:()=>now,trustForwardedFor:true,collateralQuotas:{misses:[{scope:'client',unit:'requests',limit:6,windowSec:3600},{scope:'global',unit:'requests',limit:60,windowSec:3600}]}});
 const get=(fmspc:string,ip:string,ca='platform')=>handler(new Request(`http://localhost/api/v1/attestation/collateral/${fmspc}/${ca}`,{headers:{'x-forwarded-for':ip}}));
 // A visitor's prepare fetches the real platform once.
 expect((await get('00806F050000','198.51.100.10')).status).toBe(200);
 // Hours later (well past the old one-hour "good" window) an attacker spends misses on made-up FMSPCs. Addresses
 // inside one IPv6 /48 share one budget of six.
 now+=5*3600;
 let n=0;
 const bogus=()=>`FF${String(++n).padStart(10,'0')}`;
 for(let j=0;j<6;j++)expect((await get(bogus(),`2001:db8:7:${j}::1`)).status).toBe(502);
 expect((await get(bogus(),'2001:db8:7:ffff::1')).status).toBe(429);
 // Rotating IPv4 addresses, six misses each, the attacker then spends the rest of the global budget (60 an hour).
 for(let i=0;i<9;i++)for(let j=0;j<6;j++)expect((await get(bogus(),`203.0.113.${i}`)).status).toBe(502);
 expect((await get(bogus(),'203.0.113.200')).status).toBe(429);
 expect(fetched.filter(key=>key.startsWith('FF'))).toHaveLength(60);
 // Every visitor still gets the platform that was served before, and the pinned production platform, even on the
 // first fetch: neither is a miss.
 for(const ip of ['198.51.100.11','192.0.2.7','2001:db8:9::1'])expect((await get('00806F050000',ip)).status).toBe(200);
 expect(WEBSITE_COLLATERAL_QUOTAS.pinned).toContain('20A06F000000');
 for(const ca of ['platform','processor'])expect((await get('20a06f000000','192.0.2.8',ca)).status).toBe(200);
 // A platform nobody has used yet waits for the miss budget to refill.
 expect((await get('00906ED50000','192.0.2.9')).status).toBe(429);
});
test('pinned FMSPCs and X-Forwarded-For trust come from explicit settings, with safe defaults',()=>{
 expect(pinnedFmspcsFromEnv({})).toBeUndefined();
 expect(pinnedFmspcsFromEnv({MOCHI_WEB_PINNED_FMSPCS:'20a06f000000, 00806F050000'})).toEqual(['20A06F000000','00806F050000']);
 expect(pinnedFmspcsFromEnv({MOCHI_WEB_PINNED_FMSPCS:''})).toEqual([]);
 expect(()=>pinnedFmspcsFromEnv({MOCHI_WEB_PINNED_FMSPCS:'20A06F'})).toThrow('12-hex-digit');
 // Railway's edge appends the visitor's address; anywhere else X-Forwarded-For is caller-chosen.
 expect(websiteTrustsForwardedFor({})).toBe(false);
 expect(websiteTrustsForwardedFor({HOST:'0.0.0.0'})).toBe(false);
 for(const name of ['RAILWAY_ENVIRONMENT','RAILWAY_ENVIRONMENT_NAME','RAILWAY_ENVIRONMENT_ID'])expect(websiteTrustsForwardedFor({[name]:'production'})).toBe(true);
 expect(websiteTrustsForwardedFor({RAILWAY_ENVIRONMENT:'production',MOCHI_WEB_TRUST_FORWARDED_FOR:'0'})).toBe(false);
 expect(websiteTrustsForwardedFor({MOCHI_WEB_TRUST_FORWARDED_FOR:'1'})).toBe(true);
 expect(()=>websiteTrustsForwardedFor({MOCHI_WEB_TRUST_FORWARDED_FOR:'yes'})).toThrow('1 or 0');
});
test('the hop count is 2 on Railway, 1 elsewhere, and MOCHI_WEB_FORWARDED_HOPS overrides it within 1 to 4',()=>{
 expect(RAILWAY_FORWARDED_HOPS).toBe(2);
 expect(websiteForwardingPolicy({})).toEqual({trustForwardedFor:false,forwardedForHops:1});
 expect(websiteForwardingPolicy({HOST:'0.0.0.0',MOCHI_WEB_FORWARDED_HOPS:''})).toEqual({trustForwardedFor:false,forwardedForHops:1});
 for(const name of ['RAILWAY_ENVIRONMENT','RAILWAY_ENVIRONMENT_NAME','RAILWAY_ENVIRONMENT_ID'])expect(websiteForwardingPolicy({[name]:'production'})).toEqual({trustForwardedFor:true,forwardedForHops:2});
 for(const hops of [1,2,3,4]) {
  expect(websiteForwardedHops({RAILWAY_ENVIRONMENT:'production',MOCHI_WEB_FORWARDED_HOPS:String(hops)})).toBe(hops);
  expect(websiteForwardedHops({MOCHI_WEB_FORWARDED_HOPS:String(hops)})).toBe(hops);
 }
 // Off Railway an explicit trust keeps one appending proxy unless the hop count is set too.
 expect(websiteForwardingPolicy({MOCHI_WEB_TRUST_FORWARDED_FOR:'1'})).toEqual({trustForwardedFor:true,forwardedForHops:1});
 // The kill switch still wins on Railway; a bad hop count fails startup even then.
 expect(websiteForwardingPolicy({RAILWAY_ENVIRONMENT:'production',MOCHI_WEB_TRUST_FORWARDED_FOR:'0'})).toEqual({trustForwardedFor:false,forwardedForHops:2});
 for(const bad of ['0','5','9','10','-1','2.0','02',' 2','2 ','two','1e0','0x2']) {
  expect(()=>websiteForwardedHops({RAILWAY_ENVIRONMENT:'production',MOCHI_WEB_FORWARDED_HOPS:bad})).toThrow('MOCHI_WEB_FORWARDED_HOPS must be a whole number from 1 to 4.');
  expect(()=>websiteForwardingPolicy({MOCHI_WEB_TRUST_FORWARDED_FOR:'0',MOCHI_WEB_FORWARDED_HOPS:bad})).toThrow('MOCHI_WEB_FORWARDED_HOPS');
 }
 for(const forwardedForHops of [0,5,1.5])expect(()=>createWebHandler({dist,trustForwardedFor:true,forwardedForHops})).toThrow(RangeError);
});
test('behind Railway\'s edge (hops 2) a visitor keeps one budget across edge nodes, and visitors behind one edge node do not share it',async()=>{
 const make=(forwardedForHops?:number)=>{
  let calls=0;
  const handler=createWebHandler({dist,gateway:'https://gateway.example/',now:()=>0,trustForwardedFor:true,forwardedForHops,fetcher:async()=>{calls++;return Response.json({ok:true})},quotas:{'/v1/intake/upload':[{scope:'client',unit:'requests',limit:1,windowSec:3600}]}});
  const upload=(xff:string)=>handler(new Request('http://localhost/api/v1/intake/upload',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':xff},body:'{}'}),'100.64.0.2').then(r=>r.status);
  return {upload,calls:()=>calls};
 };
 const railway=make(2);
 expect(await railway.upload('203.0.113.7, 10.1.0.3')).toBe(200);
 // The same visitor through another edge node, or with its own header appended or rewritten away, is still limited.
 for(const xff of ['203.0.113.7, 10.1.0.4','192.0.2.1, 203.0.113.7, 10.1.0.5','198.51.100.1, 192.0.2.1, 203.0.113.7, 10.1.0.3'])expect(await railway.upload(xff)).toBe(429);
 // Another visitor through the same edge node has its own budget.
 expect(await railway.upload('203.0.113.8, 10.1.0.3')).toBe(200);
 // A header with fewer entries than hops shares the one "invalid" budget, whatever the caller puts in it.
 expect(await railway.upload('198.51.100.50')).toBe(200);
 expect(await railway.upload('198.51.100.51')).toBe(429);
 expect(railway.calls()).toBe(3);
 // The old right-most keying (hops 1) put the second visitor into the edge node's bucket: the bug this fixes.
 const old=make();
 expect(await old.upload('203.0.113.7, 10.1.0.3')).toBe(200);
 expect(await old.upload('203.0.113.8, 10.1.0.3')).toBe(429);
});
test('without trusted forwarding, a caller-chosen X-Forwarded-For buys no fresh bucket',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,gateway:'https://gateway.example/',fetcher:async()=>{calls++;return Response.json({ok:true})},quotas:{'/v1/intake/upload':[{scope:'client',unit:'requests',limit:1,windowSec:3600}]}});
 const upload=(xff:string)=>handler(new Request('http://localhost/api/v1/intake/upload',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':xff},body:'{}'}),'198.51.100.200');
 expect((await upload('203.0.113.1')).status).toBe(200);
 expect((await upload('203.0.113.2')).status).toBe(429);
 expect(calls).toBe(1);
});
test('website request bodies must arrive within the read deadline and fit their route; refusals close the connection',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,gateway:'https://cvm.example/',rpc:'https://rpc.example/',bodyDeadlineMs:100,fetcher:async()=>{calls++;return Response.json({})}});
 for(const path of ['/api/v1/intake/upload','/rpc']) {
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}});
  const response=await handler(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.1'},body,duplex:'half'} as RequestInit));
  expect(response.status).toBe(408);expect(response.headers.get('connection')).toBe('close');
 }
 expect((await handler(new Request('http://localhost/api/v1/intake/upload',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(1_048_577)}))).status).toBe(413);
 // A query is at most 64 KiB, as at the CVM and the gateway.
 expect((await handler(new Request('http://localhost/api/v1/query',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(65_537)}))).status).toBe(413);
 expect(calls).toBe(0);
 expect((await handler(new Request('http://localhost/api/v1/query',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(65_536)}))).status).toBe(200);
});
test('request bodies held in memory are bounded across all routes and visitors',async()=>{
 let calls=0;
 const handler=createWebHandler({dist,gateway:'https://cvm.example/',rpc:'https://rpc.example/',bodyDeadlineMs:200,trustForwardedFor:true,bodyLimits:{maxBufferedBytes:1500},fetcher:async()=>{calls++;return Response.json({})}});
 const partial=(path:string,ip:string)=>handler(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':ip},body:new ReadableStream({start(c){c.enqueue(new Uint8Array(1000));}}),duplex:'half'} as RequestInit));
 const first=partial('/api/v1/intake/upload','198.51.100.1');
 await Bun.sleep(20);
 for(const path of ['/rpc','/api/v1/query']) {
  const busy=await partial(path,'198.51.100.2');
  expect(busy.status).toBe(503);expect(busy.headers.get('retry-after')).toBe('5');expect(busy.headers.get('connection')).toBe('close');
 }
 expect((await first).status).toBe(408);
 // Released: a complete body is accepted again.
 expect((await handler(new Request('http://localhost/api/v1/query',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'198.51.100.3'},body:'x'.repeat(1000)}))).status).toBe(200);
 expect(calls).toBe(1);
});
test('a real server on loopback closes the connection of an abandoned body within seconds, not at idleTimeout',async()=>{
 const handler=createWebHandler({dist,gateway:'https://cvm.example/',bodyDeadlineMs:300,fetcher:async()=>Response.json({})});
 // Port 0: the OS picks a free ephemeral port.
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:60,fetch:async(request,bun)=>closeAbandonedConnection(bun,request,await handler(request,bun.requestIP(request)?.address))});
 expect(server.port).not.toBe(18545);
 const started=Date.now();
 const socket=connect(server.port!,'127.0.0.1');let reply='';
 socket.on('error',()=>{});socket.on('data',data=>{reply+=String(data);});
 const closed=new Promise<number>(resolve=>socket.on('close',()=>resolve(Date.now()-started)));
 socket.write('POST /api/v1/intake/upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{');
 // The caller keeps sending: before the fix the socket stayed open for the whole idleTimeout (60 s here).
 const drip=setInterval(()=>{try{socket.write(' ')}catch{}},250);
 try {
  const elapsed=await Promise.race([closed,Bun.sleep(9000).then(()=>-1)]);
  expect(reply.split('\r\n')[0]).toContain(' 408 ');
  expect(reply.toLowerCase()).toContain('connection: close');
  expect(elapsed).toBeGreaterThan(0);expect(elapsed).toBeLessThan(9000);
 } finally {clearInterval(drip);socket.destroy();server.stop(true);}
},15_000);
test('/health reports how the visitor is keyed and checks an operator key proof, never an address, the token or anything derived from it',async()=>{
 const handler=createWebHandler({dist,visitorSecret:TOKEN,trustForwardedFor:true});
 const health=async(headers:Record<string,string>,peer?:string)=>(await handler(new Request('http://localhost/health',{headers}),peer)).json() as Promise<any>;
 const a=await health({'x-forwarded-for':'10.0.0.1, 203.0.113.7'},'100.64.0.2');
 expect(a).toMatchObject({ok:true,client:{trustForwardedFor:true,keySource:'forwarded',forwardedFor:{entries:2,last:'public'},peer:'private',visitorKeyCheck:'absent'}});
 expect(a.client.visitorKeyId).toBeUndefined();
 expect(a.client.forwardedFor.lastTag).toBe(a.client.keyTag);expect(a.client.peerTag).not.toBe(a.client.keyTag);
 expect((await health({'x-forwarded-for':'198.51.100.1, 203.0.113.7'},'100.64.0.3')).client.keyTag).toBe(a.client.keyTag);
 expect((await health({'x-forwarded-for':'203.0.113.8'},'100.64.0.2')).client.keyTag).not.toBe(a.client.keyTag);
 // With one appending proxy (hops 1): one entry without a caller header, and a caller-supplied entry does not move the key.
 const alone=await health({'x-forwarded-for':'203.0.113.7'},'100.64.0.2');
 expect(alone.client).toMatchObject({keySource:'forwarded',forwardedFor:{entries:1,last:'public'}});
 expect(alone.client.keyTag).toBe(a.client.keyTag);
 // Key check: a fresh proof from the same secret matches, another secret's does not; the response holds no secret material.
 expect((await health({'x-mochi-key-check':keyCheckHeader(TOKEN)})).client.visitorKeyCheck).toBe('match');
 expect((await health({'x-mochi-key-check':keyCheckHeader('another-invitation-token-of-24-chars')})).client.visitorKeyCheck).toBe('mismatch');
 expect((await health({'x-mochi-key-check':'v1.guess'})).client.visitorKeyCheck).toBe('invalid');
 const text=JSON.stringify(a);
 for(const value of ['203.0.113','100.64.0.2',TOKEN])expect(text).not.toContain(value);
 expect((await (await createWebHandler({dist})(new Request('http://localhost/health'))).json() as any).client).toMatchObject({trustForwardedFor:false,keySource:'none',visitorKeyCheck:'unconfigured'});
 // Without trusted forwarding the header is reported but the peer keys the visitor.
 expect((await (await createWebHandler({dist})(new Request('http://localhost/health',{headers:{'x-forwarded-for':'203.0.113.7'}}),'100.64.0.2')).json() as any).client).toMatchObject({keySource:'peer',forwardedFor:{entries:1}});
});
test('/health behind Railway\'s edge (hops 2): keyTag follows the visitor, not the edge node, and the body holds no address',async()=>{
 const handler=createWebHandler({dist,trustForwardedFor:true,forwardedForHops:2});
 const health=async(headers:Record<string,string>,peer='100.64.0.2')=>{
  const response=await handler(new Request('http://localhost/health',{headers}),peer);
  const text=await response.text();
  // Content-free: no address from the request, IPv4 or IPv6, in any form.
  for(const value of [...Object.values(headers).flatMap(v=>v.split(/[\s,\[\]]+/)).filter(Boolean),peer])expect(text).not.toContain(value);
  expect(text).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  expect(text.toLowerCase()).not.toMatch(/2001:|db8|::|[0-9a-f]{1,4}:[0-9a-f]{1,4}:/);
  return (JSON.parse(text) as any).client;
 };
 // a. No caller header: Railway writes `<visitor>, <edge node>`; the edge node varies, the key does not.
 const first=await health({'x-forwarded-for':'203.0.113.7, 10.1.0.3','x-real-ip':'203.0.113.7'});
 expect(first).toMatchObject({trustForwardedFor:true,keySource:'forwarded',forwardedFor:{entries:2,hops:2,last:'private'},realIpHeader:true,realIp:'public'});
 expect(first.forwardedFor.fromRight).toHaveLength(2);
 expect(first.forwardedFor.fromRight[1]).toEqual({class:'public',tag:first.keyTag});
 // d. X-Real-IP, when the edge sets it to the visitor, has the key's tag; it is reported, never used.
 expect(first.realIpTag).toBe(first.keyTag);
 const edgeTags=new Set<string>();
 for(const edge of ['10.1.0.3','10.1.0.4','10.1.0.5','10.1.0.6','10.1.0.3','10.1.0.4']) {
  const c=await health({'x-forwarded-for':`203.0.113.7, ${edge}`});
  expect(c.keyTag).toBe(first.keyTag);expect(c.forwardedFor.entries).toBe(2);
  edgeTags.add(c.forwardedFor.fromRight[0].tag);
 }
 expect(edgeTags.size).toBe(4);
 // b. The caller's own header: rewritten (still 2 entries) or appended (3); either way the same key, at hops - 1.
 const appended=await health({'x-forwarded-for':'192.0.2.1, 203.0.113.7, 10.1.0.5'});
 expect(appended.forwardedFor).toMatchObject({entries:3,hops:2});
 expect(appended.keyTag).toBe(first.keyTag);
 expect(appended.forwardedFor.fromRight[1].tag).toBe(first.keyTag);
 expect(appended.forwardedFor.fromRight[2].tag).not.toBe(first.keyTag);
 // X-Real-IP never moves the key, whatever it says.
 const spoofedRealIp=await health({'x-forwarded-for':'203.0.113.7, 10.1.0.3','x-real-ip':'192.0.2.1'});
 expect(spoofedRealIp.keyTag).toBe(first.keyTag);expect(spoofedRealIp.realIpTag).not.toBe(first.keyTag);
 // c. Another network: another key.
 expect((await health({'x-forwarded-for':'198.51.100.20, 10.1.0.3'})).keyTag).not.toBe(first.keyTag);
 // IPv6 visitors are tagged by their /64, as they are keyed.
 const v6=await health({'x-forwarded-for':'2001:db8:1:2::9, [2001:db8:ffff::1]:443','x-real-ip':'2001:db8:1:2::abcd'});
 expect(v6.forwardedFor.fromRight.map((e:any)=>e.class)).toEqual(['public','public']);
 expect(v6.realIpTag).toBe(v6.keyTag);expect(v6.forwardedFor.fromRight[1].tag).toBe(v6.keyTag);
 // Fewer entries than hops: keyed as "invalid", the same key for any such caller, not the entry or X-Real-IP.
 const short=await health({'x-forwarded-for':'203.0.113.7','x-real-ip':'203.0.113.7'});
 expect(short).toMatchObject({keySource:'forwarded',forwardedFor:{entries:1,hops:2}});
 expect(short.keyTag).not.toBe(first.keyTag);
 expect((await health({'x-forwarded-for':'198.51.100.20'})).keyTag).toBe(short.keyTag);
});
test('operator key checks are rate limited: each is one online guess at the visitor secret',async()=>{
 const handler=createWebHandler({dist,visitorSecret:TOKEN,now:()=>0});
 const check=async(peer:string)=>((await (await handler(new Request('http://localhost/health',{headers:{'x-mochi-key-check':keyCheckHeader('wrong-guess-of-at-least-24-chars')}}),peer)).json()) as any).client.visitorKeyCheck;
 for(let i=0;i<10;i++)expect(await check('198.51.100.1')).toBe('mismatch');
 expect(await check('198.51.100.1')).toBe('rate_limited');
 expect(await check('198.51.100.2')).toBe('mismatch');
});
