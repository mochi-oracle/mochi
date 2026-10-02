import {test,expect} from 'bun:test';
import {connect} from 'node:net';
import {createProductionProxy,createEnrollmentEndpoint,publicProxySettings,DEFAULT_PUBLIC_QUOTAS} from './public-proxy.ts';
import {visitorKey} from '../../services/claims/src/visitor-key.ts';
test('standby and private administration never reach a protocol service',async()=>{
 let calls=0;const proxy=createProductionProxy({ready:()=>false,gatewayPort:8086,indexerPort:8087,fetcher:(async()=>{calls++;return Response.json({})}) as typeof fetch});
 expect((await proxy(new Request('https://public.example/v1/intake/attestation'))).status).toBe(503);
 expect((await proxy(new Request('https://public.example/v1/admin'))).status).toBe(404);
 expect(calls).toBe(0);
});
test('public proxy pins loopback services, strips caller headers, rejects cross-origin writes',async()=>{
 const requests:{url:string;headers:unknown}[]=[];
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,fetcher:(async(url,init)=>{requests.push({url:String(url),headers:init?.headers});return Response.json({ok:true})}) as typeof fetch});
 expect((await proxy(new Request('https://public.example/v1/intake/attestation',{headers:{authorization:'caller-token',cookie:'session=private','x-mochi-client':'chosen-by-caller','x-mochi-visitor':'v1.forged','x-forwarded-for':'198.51.100.1'}}))).status).toBe(200);
 // Only the proxy's own client key reaches the gateway; a caller's copy of that header is replaced.
 expect(requests[0]).toEqual({url:'http://127.0.0.1:8086/v1/intake/attestation',headers:{'content-type':'application/json','x-mochi-client':'unknown'}});
 const id='0x'+'11'.repeat(32);await proxy(new Request('https://public.example/v1/receipts/'+id));expect(requests[1]).toEqual({url:'http://127.0.0.1:8087/v1/receipts/'+id,headers:{'content-type':'application/json'}});
 expect((await proxy(new Request('https://public.example/v1/query',{method:'POST',headers:{origin:'https://other.example'},body:'{}'}))).status).toBe(403);expect(requests).toHaveLength(2);
 const tls=await proxy(new Request('http://public.example/v1/query',{method:'POST',headers:{origin:'https://public.example','x-forwarded-proto':'https'},body:'{}'}));expect(tls.status).not.toBe(403);expect(requests).toHaveLength(3);
});

test('enrollment endpoint only fetches nine fixed operator-bound proof routes',async()=>{
 const ports=Array.from({length:9},(_,i)=>3100+i), urls:string[]=[];
 let ready=false;
 const endpoint=createEnrollmentEndpoint({ready:()=>ready,jurorPorts:ports,fetcher:(async(url)=>{urls.push(String(url));return Response.json({signature:'test'})}) as typeof fetch});
 expect((await endpoint(new Request('https://public.example/production/enrollment'))).status).toBe(503);expect(urls).toHaveLength(0);
 ready=true;
 expect((await endpoint(new Request('https://public.example/production/enrollment',{method:'POST'}))).status).toBe(405);
 const response=await endpoint(new Request('https://public.example/production/enrollment?operator=untrusted'));
 expect((await response.json()).proofs).toHaveLength(9);
 expect(urls).toEqual(ports.map(p=>`http://127.0.0.1:${p}/v1/enrollment`));
});

const upstream=(calls:{n:number})=>(async()=>{calls.n++;return Response.json({ok:true})}) as unknown as typeof fetch;
const post=(path:string,body:string,ip:string,extra:Record<string,string>={})=>new Request(`https://public.example${path}`,{method:'POST',headers:{'x-forwarded-for':`198.51.100.250, ${ip}`,...extra},body});
test('behind a trusted ingress, per-client upload quotas use the proxy-appended address and reject before reaching intake',async()=>{
 const calls={n:0};let now=1_000;
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,trustForwardedFor:true,fetcher:upstream(calls),now:()=>now,quotas:{upload:[
  {scope:'client',unit:'requests',limit:2,windowSec:3600},{scope:'global',unit:'requests',limit:5,windowSec:3600},
 ]}});
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.1'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.1'))).status).toBe(200);
 const limited=await proxy(post('/v1/intake/upload','{}','203.0.113.1'));
 expect(limited.status).toBe(429);expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
 // A caller-supplied left-most X-Forwarded-For entry does not change the client identity.
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.1',{'x-forwarded-for':'10.9.9.9, 203.0.113.1'}))).status).toBe(429);
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.2'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.3'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.4'))).status).toBe(200);
 // The global request budget (5/hour) is now spent for every client.
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.5'))).status).toBe(429);
 expect(calls.n).toBe(5);
 now+=3600;
 expect((await proxy(post('/v1/intake/upload','{}','203.0.113.1'))).status).toBe(200);
});
test('global upload byte budget bounds disk growth and IPv6 clients share their /64',async()=>{
 const calls={n:0};
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,trustForwardedFor:true,fetcher:upstream(calls),now:()=>0,quotas:{upload:[
  {scope:'client',unit:'bytes',limit:2500,windowSec:3600},{scope:'global',unit:'bytes',limit:4000,windowSec:86400},
 ]}});
 const doc='x'.repeat(1000);
 expect((await proxy(post('/v1/intake/upload',doc,'2001:db8:1:2::1'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload',doc,'2001:db8:1:2:ffff::9'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload',doc,'2001:0db8:0001:0002:0:0:0:abcd'))).status).toBe(429);
 expect((await proxy(post('/v1/intake/upload',doc,'198.51.100.7'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload',doc,'198.51.100.8'))).status).toBe(200);
 expect((await proxy(post('/v1/intake/upload',doc,'198.51.100.9'))).status).toBe(429);
 expect(calls.n).toBe(4);
 expect((await proxy(post('/v1/intake/upload','x'.repeat(1_048_577),'198.51.100.10'))).status).toBe(413);
 expect(calls.n).toBe(4);
});
test('query writes are rate limited separately and uploads are bounded in flight',async()=>{
 const calls={n:0};
 const queries=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,trustForwardedFor:true,fetcher:upstream(calls),now:()=>0,quotas:{query:[{scope:'client',unit:'requests',limit:1,windowSec:3600}]}});
 expect((await queries(post('/v1/query','{}','192.0.2.1'))).status).toBe(200);
 expect((await queries(post('/v1/query','{}','192.0.2.1'))).status).toBe(429);
 expect((await queries(post('/v1/intake/upload','{}','192.0.2.1'))).status).toBe(200);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const slow=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,trustForwardedFor:true,quotas:{maxConcurrentUploads:1},fetcher:(async()=>{await gate;return Response.json({ok:true})}) as unknown as typeof fetch});
 const first=slow(post('/v1/intake/upload','{}','192.0.2.2'));
 await Bun.sleep(5);
 const busy=await slow(post('/v1/intake/upload','{}','192.0.2.3'));
 expect(busy.status).toBe(503);
 release();expect((await first).status).toBe(200);
 expect((await slow(post('/v1/intake/upload','{}','192.0.2.3'))).status).toBe(200);
});
test('every public protocol response carries strict security headers',async()=>{
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,fetcher:upstream({n:0})});
 for(const response of [await proxy(new Request('https://public.example/v1/stats')),await proxy(new Request('https://public.example/v1/admin'))]) {
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(response.headers.get('strict-transport-security')).toContain('max-age=');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
 }
});

test('per-client limits are a small fraction of the global ones',()=>{
 for(const rules of [DEFAULT_PUBLIC_QUOTAS.upload,DEFAULT_PUBLIC_QUOTAS.query]) for(const client of rules.filter(r=>r.scope==='client')) {
  const global=rules.find(r=>r.scope==='global'&&r.unit===client.unit&&r.windowSec===client.windowSec)!;
  expect(client.limit/global.limit).toBeLessThanOrEqual(1/16);
 }
 expect(DEFAULT_PUBLIC_QUOTAS.maxUploadsPerClient).toBeLessThan(DEFAULT_PUBLIC_QUOTAS.maxConcurrentUploads);
});

const TOKEN='test-invitation-token-at-least-24-characters';
const forwarded=(seen:Array<Record<string,string>>)=>(async(_url:string,init:RequestInit)=>{seen.push(init.headers as Record<string,string>);return Response.json({ok:true})}) as unknown as typeof fetch;
test('without a trusted ingress, X-Forwarded-For is caller-chosen and ignored: the transport peer is the client',async()=>{
 const seen:Array<Record<string,string>>=[];
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,fetcher:forwarded(seen),now:()=>0,quotas:{query:[{scope:'client',unit:'requests',limit:1,windowSec:3600}]}});
 const query=(xff:string,peer?:string)=>proxy(new Request('https://public.example/v1/query',{method:'POST',headers:{'x-forwarded-for':xff},body:'{}'}),peer);
 expect((await query('203.0.113.1','10.4.0.2')).status).toBe(200);
 // A fresh X-Forwarded-For value does not buy a fresh bucket.
 expect((await query('203.0.113.2','10.4.0.2')).status).toBe(429);
 expect((await query('203.0.113.3','10.4.0.3')).status).toBe(200);
 expect(seen.map(h=>h['x-mochi-client'])).toEqual(['10.4.0.2','10.4.0.3']);
});
test('website visitors are keyed by the signed visitor header; bad or stale headers fall back to the peer',async()=>{
 const seen:Array<Record<string,string>>=[];let now=1_700_000_000;
 const site=visitorKey(TOKEN)!;
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,visitorSecret:TOKEN,fetcher:forwarded(seen),now:()=>now,quotas:{upload:[{scope:'client',unit:'requests',limit:1,windowSec:3600}]}});
 const upload=(visitor?:string)=>proxy(new Request('https://public.example/v1/intake/upload',{method:'POST',headers:visitor?{'x-mochi-visitor':visitor}:{},body:'{}'}),'198.51.100.200');
 expect((await upload(site.sign('203.0.113.1',now))).status).toBe(200);
 expect((await upload(site.sign('203.0.113.1',now))).status).toBe(429);
 expect((await upload(site.sign('203.0.113.2',now))).status).toBe(200);
 expect(seen[0]!['x-mochi-client']).toMatch(/^visitor:[A-Za-z0-9_-]{22}$/);
 expect(seen[1]!['x-mochi-client']).not.toBe(seen[0]!['x-mochi-client']);
 // Forged, stale or foreign headers do not select a bucket: they share the transport peer's.
 expect((await upload(visitorKey('another-invitation-token-of-24-chars')!.sign('203.0.113.3',now))).status).toBe(200);
 expect((await upload(site.sign('203.0.113.4',now-600))).status).toBe(429);
 expect((await upload('v1.forged')).status).toBe(429);
 expect(seen.at(-1)!['x-mochi-client']).toBe('198.51.100.200');
 // Without the token configured the header is ignored entirely.
 const unconfigured=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,fetcher:forwarded(seen),now:()=>now});
 await unconfigured(new Request('https://public.example/v1/query',{method:'POST',headers:{'x-mochi-visitor':site.sign('203.0.113.1',now)},body:'{}'}),'198.51.100.200');
 expect(seen.at(-1)!['x-mochi-client']).toBe('198.51.100.200');
});

const stalled=()=>new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}});
test('slow upload bodies hold no intake slot, even for callers who share one key, and are cut off at the read deadline',async()=>{
 const calls={n:0};
 // Default keying with one ingress peer for everybody: attacker and honest caller are the same client.
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,bodyDeadlineMs:200,fetcher:upstream(calls)});
 const slow=()=>proxy(new Request('https://public.example/v1/intake/upload',{method:'POST',body:stalled(),duplex:'half'} as RequestInit),'10.2.0.7');
 const held=Array.from({length:10},slow);
 await Bun.sleep(20);
 expect((await proxy(new Request('https://public.example/v1/intake/upload',{method:'POST',body:'{}'}),'10.2.0.7')).status).toBe(200);
 for(const response of await Promise.all(held)) {expect(response.status).toBe(408);expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");}
 expect(calls.n).toBe(1);
 // Each slow body still cost its client one request: the per-client request quota bounds how many it can open.
 const limited=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,bodyDeadlineMs:100,fetcher:upstream(calls),quotas:{upload:[{scope:'client',unit:'requests',limit:3,windowSec:3600}]}});
 const statuses=await Promise.all(Array.from({length:5},()=>limited(new Request('https://public.example/v1/intake/upload',{method:'POST',body:stalled(),duplex:'half'} as RequestInit),'10.2.0.8').then(r=>r.status)));
 expect(statuses.sort()).toEqual([408,408,408,429,429]);
});
test('uploads being processed are capped per client and in total',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,trustForwardedFor:true,quotas:{maxConcurrentUploads:3},fetcher:(async()=>{await gate;return Response.json({ok:true})}) as unknown as typeof fetch});
 const first=[proxy(post('/v1/intake/upload','{}','198.51.100.9')),proxy(post('/v1/intake/upload','{}','198.51.100.9'))];
 await Bun.sleep(5);
 const third=await proxy(post('/v1/intake/upload','{}','198.51.100.9'));
 expect(third.status).toBe(429);expect(third.headers.get('retry-after')).toBe('5');
 const other=proxy(post('/v1/intake/upload','{}','192.0.2.1'));
 await Bun.sleep(5);
 expect((await proxy(post('/v1/intake/upload','{}','192.0.2.2'))).status).toBe(503);
 release();
 for(const response of await Promise.all([...first,other]))expect(response.status).toBe(200);
 expect((await proxy(post('/v1/intake/upload','{}','198.51.100.9'))).status).toBe(200);
});
test('request bodies held in memory are bounded across all clients',async()=>{
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,trustForwardedFor:true,bodyDeadlineMs:200,quotas:{maxBufferedBytes:1500},fetcher:upstream({n:0})});
 const partial=(xff:string)=>proxy(new Request('https://public.example/v1/query',{method:'POST',headers:{'x-forwarded-for':xff},body:new ReadableStream({start(c){c.enqueue(new Uint8Array(1000));}}),duplex:'half'} as RequestInit));
 const first=partial('198.51.100.1');
 await Bun.sleep(20);
 const busy=await partial('198.51.100.2');
 expect(busy.status).toBe(503);
 expect((await first).status).toBe(408);
 expect((await proxy(post('/v1/query','x'.repeat(1000),'198.51.100.3'))).status).toBe(200);
});
test('a real server on loopback: slow bodies (1 byte/s) neither block other uploads nor outlive the deadline',async()=>{
 // Default keying: over loopback every connection has the same peer, so attacker and honest caller share one key.
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,bodyDeadlineMs:1500,fetcher:upstream({n:0})});
 // Port 0: the OS picks a free ephemeral port.
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:120,maxRequestBodySize:1_048_576,fetch:(request,bun)=>proxy(request,bun.requestIP(request)?.address)});
 expect(server.port).not.toBe(18545);
 const replies:string[]=[];const sockets=Array.from({length:8},(_,i)=>{
  const socket=connect(server.port!,'127.0.0.1');socket.on('error',()=>{});socket.on('data',data=>replies.push(String(data).split('\r\n')[0]!));
  socket.write(`POST /v1/intake/upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Forwarded-For: 198.51.100.${10+i}\r\nContent-Length: 100000\r\n\r\n{`);
  return socket;
 });
 const drip=setInterval(()=>sockets.forEach(socket=>socket.write(' ')),250);
 try {
  await Bun.sleep(200);
  const upload=()=>fetch(`http://127.0.0.1:${server.port}/v1/intake/upload`,{method:'POST',body:'{}',headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.1'}});
  expect((await upload()).status).toBe(200);
  await Bun.sleep(1800);
  expect(replies).toHaveLength(8);
  expect(replies.every(line=>line.includes(' 408 '))).toBe(true);
  expect((await upload()).status).toBe(200);
 } finally {clearInterval(drip);sockets.forEach(socket=>socket.destroy());server.stop(true);}
});
test('client diagnostics describe the keying without addresses or secrets',async()=>{
 const site=visitorKey(TOKEN)!;
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,visitorSecret:TOKEN,fetcher:upstream({n:0})});
 const status=(headers:Record<string,string>,peer?:string)=>proxy.clientDiagnostics(new Request('https://public.example/production/status',{headers}),peer);
 const direct=status({'x-forwarded-for':'203.0.113.5','x-real-ip':'203.0.113.6'},'10.2.0.7');
 expect(direct).toMatchObject({keySource:'peer',trustForwardedFor:false,forwardedFor:{entries:1,last:'public'},realIpHeader:true,peer:'private',visitor:'absent',visitorKeyId:site.id});
 expect(direct.keyTag).toMatch(/^[0-9a-f]{8}$/);
 // Same peer, different caller-chosen X-Forwarded-For: same key. Different peer: different key.
 const spoofed=status({'x-forwarded-for':'198.51.100.1'},'10.2.0.7');
 expect(spoofed.keyTag).toBe(direct.keyTag);
 expect(status({},'10.2.0.8').keyTag).not.toBe(direct.keyTag);
 // The last X-Forwarded-For entry and the peer are tagged too, so two networks can be compared without addresses.
 expect(direct.peerTag).toBe(direct.keyTag);
 expect(direct.forwardedFor.lastTag).toMatch(/^[0-9a-f]{8}$/);
 expect(spoofed.forwardedFor.lastTag).not.toBe(direct.forwardedFor.lastTag);
 expect(status({'x-forwarded-for':'10.0.0.1, 203.0.113.5'},'10.2.0.7').forwardedFor.lastTag).toBe(direct.forwardedFor.lastTag);
 expect(status({}).forwardedFor).toEqual({entries:0,last:'absent',lastTag:null});
 expect(status({'x-mochi-visitor':site.sign('203.0.113.5',Date.now()/1000)},'10.2.0.7')).toMatchObject({keySource:'visitor',visitor:'valid'});
 expect(status({'x-mochi-visitor':'v1.forged'})).toMatchObject({keySource:'none',visitor:'invalid',peer:'absent'});
 const text=JSON.stringify(direct);
 for(const secret of ['203.0.113','10.2.0.7',TOKEN])expect(text).not.toContain(secret);
 expect(createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087}).clientDiagnostics(new Request('https://public.example/'))).toMatchObject({visitor:'unconfigured',visitorKeyId:null,keySource:'none'});
});
test('only an explicit launch-config setting trusts X-Forwarded-For',()=>{
 expect(publicProxySettings(undefined)).toEqual({trustForwardedFor:false});
 expect(publicProxySettings('')).toEqual({trustForwardedFor:false});
 expect(publicProxySettings('not json')).toEqual({trustForwardedFor:false});
 expect(publicProxySettings(JSON.stringify({mode:'active'}))).toEqual({trustForwardedFor:false});
 expect(publicProxySettings(JSON.stringify({publicProxy:{trustForwardedFor:'true'}}))).toEqual({trustForwardedFor:false});
 expect(publicProxySettings(JSON.stringify({publicProxy:{trustForwardedFor:true}}))).toEqual({trustForwardedFor:true});
});
