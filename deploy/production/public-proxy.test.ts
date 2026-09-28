import {test,expect} from 'bun:test';
import {createProductionProxy,createEnrollmentEndpoint} from './public-proxy.ts';
test('standby and private administration never reach a protocol service',async()=>{
 let calls=0;const proxy=createProductionProxy({ready:()=>false,gatewayPort:8086,indexerPort:8087,fetcher:(async()=>{calls++;return Response.json({})}) as typeof fetch});
 expect((await proxy(new Request('https://public.example/v1/intake/attestation'))).status).toBe(503);
 expect((await proxy(new Request('https://public.example/v1/admin'))).status).toBe(404);
 expect(calls).toBe(0);
});
test('public proxy pins loopback services, strips caller headers, rejects cross-origin writes',async()=>{
 const requests:{url:string;headers:unknown}[]=[];
 const proxy=createProductionProxy({ready:()=>true,gatewayPort:8086,indexerPort:8087,fetcher:(async(url,init)=>{requests.push({url:String(url),headers:init?.headers});return Response.json({ok:true})}) as typeof fetch});
 expect((await proxy(new Request('https://public.example/v1/intake/attestation',{headers:{authorization:'caller-token',cookie:'session=private'}}))).status).toBe(200);
 expect(requests[0]).toEqual({url:'http://127.0.0.1:8086/v1/intake/attestation',headers:{'content-type':'application/json'}});
 const id='0x'+'11'.repeat(32);await proxy(new Request('https://public.example/v1/receipts/'+id));expect(requests[1]?.url).toBe('http://127.0.0.1:8087/v1/receipts/'+id);
 expect((await proxy(new Request('https://public.example/v1/query',{method:'POST',headers:{origin:'https://other.example'},body:'{}'}))).status).toBe(403);expect(requests).toHaveLength(2);
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
