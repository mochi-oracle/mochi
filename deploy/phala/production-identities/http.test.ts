import {test,expect} from 'bun:test';
import {createIdentityEndpoint} from './http.ts';
const req = () => new Request('https://public.example/production/identities');
test('identity reads share in-flight work and expire cached quotes',async()=>{
  let time=0, reads=0, creates=0;
  const handler=createIdentityEndpoint(async()=>{creates++;return {read:async()=>{reads++;await Promise.resolve();return {ready:true};}}},()=>time);
  const responses=await Promise.all([handler(req()),handler(req()),handler(req())]);
  for(const response of responses) expect(await response.json()).toEqual({ready:true});
  expect(creates).toBe(1);expect(reads).toBe(1);
  expect((await handler(req())).headers.get('cache-control')).toBe('no-store');expect(reads).toBe(1);
  time=60_001;await handler(req());expect(reads).toBe(2);expect(creates).toBe(1);
});
test('KMS failures stay redacted, back off, and can recover without restart',async()=>{
  let time=0,creates=0;
  const handler=createIdentityEndpoint(async()=>{if(++creates===1)throw new Error('private internal detail');return {read:async()=>({ready:true})}},()=>time);
  const failure=await handler(req());expect(failure.status).toBe(503);expect(await failure.text()).not.toContain('private internal');
  await handler(req());expect(creates).toBe(1);time=10_001;
  expect((await handler(req())).status).toBe(200);expect(creates).toBe(2);
  expect((await handler(new Request(req(),{method:'POST'}))).status).toBe(405);expect(creates).toBe(2);
});
