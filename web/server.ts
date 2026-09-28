import { resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { PcsCollateralSource } from '../packages/tee/src/dcap/pcs.ts';
import { createClaimsProxy } from './claims-proxy.ts';
import { createRevenueStatusReader, type PublicRevenueStatus } from '../services/claims/src/public-revenue-status.ts';
import { createClaimsRuntime } from '../services/claims/src/runtime.ts';
import { loadWebDeployment, validateWebDeployment } from './deployment-config.ts';

// Only this reviewed public shape reaches the browser. Service URLs and RPC credentials stay server-side.
export function publicConfig(input: any) {
  return validateWebDeployment(input);
}
const readMethods = new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getBlockByNumber','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getCode','eth_getBalance','eth_getLogs','eth_feeHistory','eth_gasPrice','eth_maxPriorityFeePerGas','eth_estimateGas']);
const gatewayGet = /^\/v1\/(?:intake\/attestation|stats|queries\/0x[0-9a-f]{64}|verdict\/0x[0-9a-f]{64}|feeds\/[^/]+\/[^/]+|disagreement(?:\/models)?)$/;
const gatewayPost = /^\/v1\/(?:intake\/upload|query)$/;
export function createWebHandler(options: {config?: unknown; dist: string; revenue?: () => Promise<PublicRevenueStatus>; gateway?: string; indexer?: string; rpc?: string; fetcher?: typeof fetch; claims?: (request:Request)=>Promise<Response>; collateral?: {get(fmspc:string,ca:'platform'|'processor'):Promise<unknown>}}) {
  const config = publicConfig(options.config);
  const fetcher = options.fetcher ?? fetch;
  const collateral = options.collateral ?? new PcsCollateralSource({fetch:(url,init)=>fetcher(url,{...init,signal:AbortSignal.timeout(15000)})});
  const dist=resolve(options.dist);
  const error=(message:string,status=400)=>Response.json({error:message},{status});
  async function body(request:Request) {
    if(Number(request.headers.get('content-length')??0)>1_048_576) throw new Error('body too large');
    const reader=request.body?.getReader(); if(!reader)return '';
    const chunks:Uint8Array[]=[];let length=0;
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1_048_576){await reader.cancel();throw new Error('body too large')}chunks.push(value)}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return new TextDecoder().decode(bytes);
  }
  async function proxy(base:string|undefined,path:string,request:Request,raw?:string) {
    if(!base)return error('Service is not configured',503);
    const url=new URL(base); url.pathname=path.split('?')[0]!;url.search=path.includes('?')?path.slice(path.indexOf('?')):'';
    // Never forward browser cookies, wallet headers or caller-selected destinations.
    const response=await fetcher(url,{method:request.method,headers:{'content-type':'application/json'},body:raw,redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)return error('Upstream service request failed',response.status>=400&&response.status<600?response.status:502);
    return new Response(response.body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }
  return async(request:Request):Promise<Response>=>{
    let response:Response;
    let cacheControl='no-store';
    try {
      const url=new URL(request.url), path=url.pathname;
      const origin=request.headers.get('origin');
      if(request.method==='POST'&&origin&&origin!==url.origin)return error('Cross-origin request refused',403);
      if(path==='/mochi-config.json'&&request.method==='GET')response=Response.json(config);
      else if(path==='/api/tokenomics/report'&&request.method==='GET')response=Response.json(await (options.revenue??createRevenueStatusReader())());
      else if(path.startsWith('/api/claims/'))response=options.claims?await options.claims(request):Response.json({error:{code:'UNAVAILABLE',message:'Claim research is not configured.'}},{status:503});
      else if(path==='/health'&&request.method==='GET')response=Response.json({ok:true,configured:config.enabled});
      else if(path.startsWith('/api/v1/attestation/collateral/')&&request.method==='GET') {
        const match=/^\/api\/v1\/attestation\/collateral\/([0-9a-fA-F]{12})\/(platform|processor)$/.exec(path);
        response=match?Response.json(await collateral.get(match[1]!,match[2] as 'platform'|'processor')):error('Invalid collateral selector');
      } else if(path==='/rpc'&&request.method==='POST') {
        const raw=await body(request), value=JSON.parse(raw), calls=Array.isArray(value)?value:[value];
        if(!calls.length||calls.length>20||calls.some(c=>!c||c.jsonrpc!=='2.0'||!readMethods.has(c.method)))response=error('Only read-only RPC methods are allowed',403);
        else response=await proxy(options.rpc,new URL(options.rpc??'http://localhost').pathname+new URL(options.rpc??'http://localhost').search,request,raw);
      } else if(path.startsWith('/api/')) {
        const route=path.slice(4);
        if(request.method==='GET'&&gatewayGet.test(route))response=await proxy(options.gateway,route+url.search,request);
        else if(request.method==='POST'&&gatewayPost.test(route))response=await proxy(options.gateway,route+url.search,request,await body(request));
        else response=error('Not found',404);
      } else if(/^\/indexer\/v1\/receipts\/0x[0-9a-f]{64}$/.test(path)&&request.method==='GET')response=await proxy(options.indexer,path.slice(8),request);
      else if(request.method==='GET'||request.method==='HEAD') {
        const decoded=decodeURIComponent(path);
        if(decoded.includes('\0')||decoded.split('/').some(s=>s.startsWith('.')))return error('Not found',404);
        const candidate=resolve(dist,'.'+decoded+(decoded.endsWith('/')?'index.html':''));
        const actual=await realpath(candidate).catch(()=>null);
        if(!actual||!actual.startsWith(dist+sep))response=error('Not found',404);
        else if((await stat(actual)).isDirectory()) {
          url.pathname=path+'/';
          response=new Response(null,{status:308,headers:{location:url.pathname+url.search}});
        } else {
          const file=Bun.file(actual);
          // Only public static assets may be cached; HTML, APIs and errors remain no-store.
          if(/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(decoded))cacheControl='public, max-age=31536000, immutable';
          else if(decoded.startsWith('/assets/'))cacheControl='public, max-age=86400';
          response=new Response(request.method==='HEAD'?null:file,{headers:{'content-type':file.type}});
        }
      } else response=error('Method not allowed',405);
    } catch {response=error('Request could not be completed',502)}
    response.headers.set('Cache-Control',cacheControl);
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('X-Frame-Options','DENY');
    return response;
  };
}
if(import.meta.main) {
  const config=loadWebDeployment(process.env);
  const handler=createWebHandler({config,revenue:createRevenueStatusReader({reportPath:process.env.MOCHI_REVENUE_REPORT_FILE,upstream:process.env.MOCHI_CLAIMS_UPSTREAM,tokenConfigured:process.env.MOCHI_TOKEN_CONFIRMED==='true'}),dist:new URL('./site/dist',import.meta.url).pathname,
    gateway:process.env.MOCHI_GATEWAY_URL,indexer:process.env.MOCHI_INDEXER_URL,rpc:process.env.RPC_URL,claims:process.env.MOCHI_CLAIMS_UPSTREAM?createClaimsProxy(process.env.MOCHI_CLAIMS_UPSTREAM):createClaimsRuntime()});
  const server=Bun.serve({hostname:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4321),idleTimeout:60,fetch:handler});
  console.log(`Mochi website listening on port ${server.port}; deployment ${publicConfig(config).enabled?'configured':'pending'}`);
}
