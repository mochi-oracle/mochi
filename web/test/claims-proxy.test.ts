import { test, expect } from 'bun:test';
import { createClaimsProxy } from '../claims-proxy.ts';
const req = (path='/api/claims/research', headers:Record<string,string>={}) => new Request(`https://site.example${path}`, { method:'POST', headers:{'content-type':'application/json','origin':'https://site.example','x-mochi-access-token':'invitation','x-mochi-review-token':'owner','cookie':'private=1','authorization':'Bearer private',...headers}, body:JSON.stringify({claim:'Example claim',consent:true}) });
test('fixed claims proxy retains invitation/owner auth and removes unrelated browser credentials',async()=>{
 let calls=0;
 const proxy=createClaimsProxy('https://service.example',async(input,init)=>{
  calls++;expect(String(input)).toBe('https://service.example/api/claims/research');
  const h=new Headers(init?.headers);expect(h.get('x-mochi-access-token')).toBe('invitation');expect(h.get('x-mochi-review-token')).toBe('owner');expect(h.has('cookie')).toBe(false);expect(h.has('authorization')).toBe(false);expect(h.has('origin')).toBe(false);expect(init?.redirect).toBe('error');
  return Response.json({researchToken:'safe'},{headers:{'set-cookie':'must-not-forward'}});
 });
 const result=await proxy(req());expect(result.status).toBe(200);expect(result.headers.has('set-cookie')).toBe(false);expect(result.headers.get('cache-control')).toBe('no-store');expect(calls).toBe(1);
 // Behind Railway's TLS proxy the request URL is http while the browser's Origin is https.
 const proxied=new Request('http://site.example/api/claims/research',{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https','origin':'https://site.example','x-mochi-access-token':'invitation','x-mochi-review-token':'owner'},body:JSON.stringify({claim:'Example claim',consent:true})});
 expect((await proxy(proxied)).status).toBe(200);expect(calls).toBe(2);
});
test('proxy blocks unapproved destinations/routes/origins and oversized bodies before upstream',async()=>{
 for(const base of ['http://service.example','https://user:pass@127.0.0.1','https://service.example/path','https://service.example/?secret=1'])expect(()=>createClaimsProxy(base)).toThrow();
 let calls=0;const proxy=createClaimsProxy('https://service.example',async()=>{calls++;return Response.json({});});
 expect((await proxy(req('/api/claims/research?url=https://elsewhere.example'))).status).toBe(404);
 expect((await proxy(req('/api/claims/admin'))).status).toBe(404);
 expect((await proxy(req('/api/claims/research',{origin:'https://evil.example'}))).status).toBe(403);
 expect((await proxy(new Request('http://site.example/api/claims/research',{method:'POST',headers:{'x-forwarded-proto':'https',origin:'https://evil.example'},body:'{}'}))).status).toBe(403);
 expect((await proxy(new Request('https://site.example/api/claims/research',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(20001)}))).status).toBe(502);
 expect(calls).toBe(0);
});
test('proxy bounds upstream data and suppresses non-JSON provider errors',async()=>{
 for(const upstream of [()=>new Response('private stack trace'),()=>Response.json({data:'x'.repeat(2*1024*1024)})]){
 const proxy=createClaimsProxy('https://service.example',async()=>upstream());const response=await proxy(req());expect(response.status).toBe(502);expect(await response.text()).not.toContain('private stack');}
});
test('publication controls use exact routes and retain owner authorization without browser credentials',async()=>{
 const share='a'.repeat(64);let calls=0;
 const proxy=createClaimsProxy('https://service.example',async(input,init)=>{
  calls++;expect(String(input)).toMatch(new RegExp(`/shared/${share}/(corrections|unpublish)$`));
  const h=new Headers(init?.headers);expect(h.get('x-mochi-review-token')).toBe('owner');expect(h.has('cookie')).toBe(false);
  return Response.json({ok:true});
 });
 for(const operation of ['corrections','unpublish'])expect((await proxy(req(`/api/claims/shared/${share}/${operation}`))).status).toBe(200);
 expect((await proxy(req(`/api/claims/shared/${share}/delete-all`))).status).toBe(404);
 expect((await proxy(req(`/api/claims/shared/${share}/unpublish?token=owner`))).status).toBe(404);
 expect(calls).toBe(2);
});
