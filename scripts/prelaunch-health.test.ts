import {test,expect} from 'bun:test';
import {checkPrelaunchHealth} from './prelaunch-health.ts';
const good=(path:string)=>path==='/health'?{ok:true}:path==='/api/claims/config'?{enabled:true,mode:'research-preview',requiresAccessToken:true,price:{amountUsd:'0.00'}}:{status:'awaiting_token'};
test('prelaunch monitor validates invitation mode and pre-token state without provider calls',async()=>{
 const paths:string[]=[];const result=await checkPrelaunchHealth('https://mochi.invalid',async(url,init)=>{const path=new URL(String(url)).pathname;paths.push(path);expect(init?.redirect).toBe('error');expect(init?.headers).toEqual({accept:'application/json'});return Response.json(good(path));});
 expect(result.ok).toBe(true);expect(paths).toHaveLength(3);
});
test('monitor flags stale reports, unintended paid/open mode and failures without leaking errors',async()=>{
 for(const bad of [{status:'stale'},{status:'unavailable'}])expect((await checkPrelaunchHealth('https://mochi.invalid',async(url)=>{const path=new URL(String(url)).pathname;return Response.json(path.endsWith('/report')?bad:good(path));})).ok).toBe(false);
 expect((await checkPrelaunchHealth('https://mochi.invalid',async(url)=>{const path=new URL(String(url)).pathname;return Response.json(path.endsWith('/config')?{...good(path),requiresAccessToken:false}:good(path));})).ok).toBe(false);
 const result=await checkPrelaunchHealth('https://mochi.invalid',async()=>{throw new Error('private provider detail');});expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('private');
 await expect(checkPrelaunchHealth('http://mochi.invalid')).rejects.toThrow();
});
