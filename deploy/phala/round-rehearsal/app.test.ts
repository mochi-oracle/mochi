import {test,expect} from 'bun:test';
import {createRoundHandler} from './app.ts';
const input={envelope:{v:1,epk:`0x${'01'.repeat(32)}`,nonce:'0x01',ct:'0x01'},payerResultPubKey:`0x${'02'.repeat(32)}`};
const request=(body:unknown=input)=>new Request('http://localhost/v1/rehearsal/round',{method:'POST',body:JSON.stringify(body)});
test('finite attempt budget, no production routes and no exception leakage',async()=>{
 let calls=0;
 const handler=createRoundHandler({attestations:async()=>({identities:5}),run:async()=>{calls++;throw new Error('private source / provider secret')}});
 const health=await handler(new Request('http://localhost/health'));
 expect(await health.json()).toMatchObject({fixtureOnly:true,payments:false,models:'synthetic'});
 expect(health.headers.get('cache-control')).toBe('no-store');
 expect((await handler(new Request('http://localhost/api/claims/reviews',{method:'POST'}))).status).toBe(404);
 expect((await handler(request({}))).status).toBe(400);
 expect(await (await handler(request())).json()).toEqual({error:'ROUND_REJECTED'});
 expect((await handler(request())).status).toBe(400);
 expect((await handler(request())).status).toBe(429);
 expect(calls).toBe(2);
});
test('one active round at a time and bounded streamed body',async()=>{
 let finish!:(value:unknown)=>void;
 const handler=createRoundHandler({attestations:async()=>({}),run:()=>new Promise(resolve=>{finish=resolve})});
 const pending=handler(request());
 await new Promise(resolve=>setTimeout(resolve,0));
 expect((await handler(request())).status).toBe(429);
 finish({ciphertext:true});expect((await pending).status).toBe(200);
 expect((await handler(request('x'.repeat(25*1024)))).status).toBe(413);
});
test('attestation attempts are bounded and failures reveal no details',async()=>{
 const handler=createRoundHandler({attestations:async()=>{throw new Error('private')},run:async()=>({})});
 for(let i=0;i<30;i++)expect((await handler(new Request('http://localhost/v1/attestations'))).status).toBe(503);
 expect((await handler(new Request('http://localhost/v1/attestations'))).status).toBe(429);
});
test('real ACI mode reports fixture chain honestly and authorizes the single paid round',async()=>{
 let calls=0;
 const handler=createRoundHandler({attestations:async()=>({}),run:async()=>{calls++;return {ok:true}}},{mode:'real-aci',roundAuthSecret:'x'.repeat(40)});
 expect(await (await handler(new Request('http://localhost/health'))).json()).toMatchObject({chain:'fixture',models:'real-phala-aci',fixtureOnly:true,payments:false});
 expect((await handler(request())).status).toBe(401);
 expect((await handler(new Request('http://localhost/v1/rehearsal/round',{method:'POST',headers:{authorization:`Bearer ${'y'.repeat(40)}`},body:JSON.stringify(input)}))).status).toBe(401);
 const authorized=()=>new Request('http://localhost/v1/rehearsal/round',{method:'POST',headers:{authorization:`Bearer ${'x'.repeat(40)}`},body:JSON.stringify(input)});
 expect((await handler(authorized())).status).toBe(200);
 expect((await handler(authorized())).status).toBe(429);
 expect(calls).toBe(1);
});
