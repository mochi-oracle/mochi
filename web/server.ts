import { join, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PcsCollateralSource } from '../packages/tee/src/dcap/pcs.ts';
import { createClaimsProxy } from './claims-proxy.ts';
import { createRevenueStatusReader, type PublicRevenueStatus } from '../services/claims/src/public-revenue-status.ts';
import { createClaimsRuntime } from '../services/claims/src/runtime.ts';
import { isCrossOriginPost } from '../services/claims/src/origin.ts';
import { loadWebDeployment, validateWebDeployment } from './deployment-config.ts';
import { applySecurityHeaders } from '../services/claims/src/security-headers.ts';
import { QuotaLimiter, tooManyRequests, type QuotaRule } from '../services/claims/src/quota.ts';
import { forwardedClient, forwardingFacts, keyTagger } from '../services/claims/src/client-address.ts';
import { VISITOR_HEADER, visitorKey } from '../services/claims/src/visitor-key.ts';
import { BodyReadError, readBoundedBody } from '../services/claims/src/bounded-body.ts';

const decodeAttribute = (value: string) => value.replace(/&(quot|#34|apos|#39|lt|#60|gt|#62|amp|#38);/g, (_m, entity: string) => (({ quot: '"', '#34': '"', apos: "'", '#39': "'", lt: '<', '#60': '<', gt: '>', '#62': '>', amp: '&', '#38': '&' }) as Record<string, string>)[entity]!);
const sha256Source = (value: string) => `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`;
/**
 * Content-Security-Policy for the built site. Scripts load only from this origin; the few inline event handlers and
 * inline scripts the build emits are allowed by hash (computed from the deployed HTML at startup, so markup injected
 * at runtime still cannot run). Inline style attributes are part of the site's layout, so styles allow them.
 */
export function siteContentSecurityPolicy(dist: string): string {
  const handlers = new Set<string>(), scripts = new Set<string>();
  const visit = (dir: string) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        const html = readFileSync(path, 'utf8');
        for (const match of html.matchAll(/\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) handlers.add(sha256Source(decodeAttribute(match[1] ?? match[2] ?? '')));
        for (const match of html.matchAll(/<script\b([^>]*)>([^<]*(?:<(?!\/script)[^<]*)*)<\/script\s*>/gi)) if (!/\ssrc\s*=/i.test(match[1]!) && match[2]!.trim()) scripts.add(sha256Source(match[2]!));
      }
    }
  };
  visit(dist);
  const inline = [...(handlers.size ? ["'unsafe-hashes'", ...handlers] : []), ...scripts];
  return [
    "default-src 'self'", `script-src 'self'${inline.length ? ' ' + inline.join(' ') : ''}`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:", "manifest-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-src 'none'", "frame-ancestors 'none'",
  ].join('; ');
}

const MiB = 1024 * 1024, MINUTE = 60, HOUR = 3600;
/**
 * Per-visitor limits on the website's protocol writes. They sit at or below the CVM's per-client limits (uploads 30/h
 * and 16 MiB/h, queries 300/h and 8 MiB/h), which the CVM applies to each visitor through the signed X-Mochi-Visitor
 * header, so a visitor meets the website's limit first; the CVM's global limits bound all visitors together.
 */
export const WEBSITE_WRITE_QUOTAS: Record<'/v1/intake/upload' | '/v1/query', QuotaRule[]> = {
  '/v1/intake/upload': [{ scope: 'client', unit: 'requests', limit: 20, windowSec: HOUR }, { scope: 'client', unit: 'bytes', limit: 16 * MiB, windowSec: HOUR }],
  '/v1/query': [{ scope: 'client', unit: 'requests', limit: 120, windowSec: HOUR }, { scope: 'client', unit: 'bytes', limit: 8 * MiB, windowSec: HOUR }],
};
/**
 * Read-only RPC, counted per JSON-RPC call (a batch of 20 is 20). One visitor polling a query reads about 1.3 calls a
 * second for up to three minutes; the global limit bounds what all visitors together cost the RPC provider.
 */
export const WEBSITE_RPC_QUOTAS: QuotaRule[] = [
  { scope: 'client', unit: 'requests', limit: 120, windowSec: MINUTE },
  { scope: 'client', unit: 'requests', limit: 2400, windowSec: HOUR },
  { scope: 'global', unit: 'requests', limit: 3000, windowSec: MINUTE },
];
/**
 * Intel PCS collateral. Real FMSPCs are few and cached; an FMSPC not yet fetched (a cache miss) costs PCS requests from
 * the website's address, so misses have their own small per-visitor and global budgets, and failures are remembered.
 */
export const WEBSITE_COLLATERAL_QUOTAS: { requests: QuotaRule[]; misses: QuotaRule[]; goodSec: number; failedSec: number; maxKeys: number } = {
  requests: [{ scope: 'client', unit: 'requests', limit: 120, windowSec: HOUR }],
  misses: [{ scope: 'client', unit: 'requests', limit: 6, windowSec: HOUR }, { scope: 'global', unit: 'requests', limit: 60, windowSec: HOUR }],
  goodSec: HOUR, failedSec: 5 * MINUTE, maxKeys: 256,
};

type Collateral = { get(fmspc: string, ca: 'platform' | 'processor'): Promise<unknown> };
/**
 * Remembers which FMSPC/CA pairs succeeded (served without a miss charge) or failed (refused without asking PCS again)
 * and joins concurrent fetches of one pair. Values stay in the source, which caches them until their own expiry.
 */
function guardCollateral(source: Collateral, now: () => number, limits: typeof WEBSITE_COLLATERAL_QUOTAS) {
  const seen = new Map<string, { ok: boolean; until: number }>();
  const pending = new Map<string, Promise<unknown>>();
  const remember = (key: string, ok: boolean) => {
    seen.delete(key);
    while (seen.size >= limits.maxKeys) seen.delete(seen.keys().next().value!);
    seen.set(key, { ok, until: now() + (ok ? limits.goodSec : limits.failedSec) });
  };
  return {
    /** "good" and "failed" need no PCS request; "unknown" is a miss. */
    state(fmspc: string, ca: string): 'good' | 'failed' | 'pending' | 'unknown' {
      const key = `${fmspc}:${ca}`, entry = seen.get(key);
      if (entry && entry.until > now()) return entry.ok ? 'good' : 'failed';
      return pending.has(key) ? 'pending' : 'unknown';
    },
    get(fmspc: string, ca: 'platform' | 'processor'): Promise<unknown> {
      const key = `${fmspc}:${ca}`;
      const running = pending.get(key);
      if (running) return running;
      const fetching = source.get(fmspc, ca)
        .then(value => { remember(key, true); return value; }, error => { remember(key, false); throw error; })
        .finally(() => pending.delete(key));
      pending.set(key, fetching);
      return fetching;
    },
  };
}

// Used only if the build has no dist/404.html: still HTML, still a way back to Home and the claim check.
const NOT_FOUND_FALLBACK='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found | MOCHI</title><style>body{margin:0;padding:48px 24px;background:#cfb3d4;color:#111;font:500 18px/1.5 system-ui,sans-serif;border-top:12px solid #e94f0b}h1{font-size:44px;line-height:1;letter-spacing:-.04em;margin:16px 0}a{display:inline-block;margin:8px 12px 0 0;padding:12px 18px;border:1px solid #111;color:#111;background:#fff;text-decoration:none}</style></head><body><p>MOCHI · ERROR 404</p><h1>This page is not on the record.</h1><p>The address may be mistyped, or the page may have moved.</p><a href="/">Home</a><a href="/check/">Check a claim</a></body></html>';

// Only this reviewed public shape reaches the browser. Service URLs and RPC credentials stay server-side.
export function publicConfig(input: any, options: { allowRehearsal?: boolean } = {}) {
  return validateWebDeployment(input, options);
}
const readMethods = new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getBlockByNumber','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getCode','eth_getBalance','eth_getLogs','eth_feeHistory','eth_gasPrice','eth_maxPriorityFeePerGas','eth_estimateGas']);
const gatewayGet = /^\/v1\/(?:intake\/attestation|stats|queries\/0x[0-9a-f]{64}|verdict\/0x[0-9a-f]{64}|feeds\/[^/]+\/[^/]+|disagreement(?:\/models)?)$/;
const gatewayPost = /^\/v1\/(?:intake\/upload|query)$/;
export type WebHandlerOptions = {
  config?: unknown; allowRehearsal?: boolean; dist: string; revenue?: () => Promise<PublicRevenueStatus>; gateway?: string; indexer?: string; rpc?: string;
  fetcher?: typeof fetch; claims?: (request:Request)=>Promise<Response>; collateral?: Collateral;
  quotas?: Partial<typeof WEBSITE_WRITE_QUOTAS>; rpcQuotas?: QuotaRule[]; collateralQuotas?: Partial<typeof WEBSITE_COLLATERAL_QUOTAS>; now?: () => number;
  /** MOCHI_CLAIMS_ACCESS_TOKEN: signs the per-visitor X-Mochi-Visitor header on requests to the protocol gateway (the CVM). */
  visitorSecret?: string;
  /** Railway's edge appends the visitor address to X-Forwarded-For; false keys visitors on the transport peer. */
  trustForwardedFor?: boolean;
  bodyDeadlineMs?: number;
};
export function createWebHandler(options: WebHandlerOptions) {
  const config = publicConfig(options.config, { allowRehearsal: options.allowRehearsal === true });
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => Date.now() / 1000);
  const collateralQuotas={...WEBSITE_COLLATERAL_QUOTAS,...options.collateralQuotas};
  const collateral = guardCollateral(options.collateral ?? new PcsCollateralSource({fetch:(url,init)=>fetcher(url,{...init,signal:AbortSignal.timeout(15000)})}), now, collateralQuotas);
  const dist=resolve(options.dist);
  const contentSecurityPolicy=siteContentSecurityPolicy(dist);
  const quotas={...WEBSITE_WRITE_QUOTAS,...options.quotas};
  const limiters={'/v1/intake/upload':new QuotaLimiter(quotas['/v1/intake/upload'],{now}),'/v1/query':new QuotaLimiter(quotas['/v1/query'],{now})};
  const rpcLimiter=new QuotaLimiter(options.rpcQuotas??WEBSITE_RPC_QUOTAS,{now});
  const collateralLimiter=new QuotaLimiter(collateralQuotas.requests,{now}), collateralMisses=new QuotaLimiter(collateralQuotas.misses,{now});
  const visitors=visitorKey(options.visitorSecret);
  const policy={trustForwardedFor:options.trustForwardedFor!==false};
  const tag=keyTagger();
  const error=(message:string,status=400)=>Response.json({error:message},{status});
  // Unknown pages get the branded HTML page from the build (dist/404.html); API paths keep JSON errors.
  let notFoundPage:Promise<string>|undefined;
  async function notFound(request:Request,path:string) {
    if(path==='/api'||path.startsWith('/api/'))return error('Not found',404);
    notFoundPage??=Bun.file(resolve(dist,'404.html')).text().catch(()=>NOT_FOUND_FALLBACK);
    const html=await notFoundPage;
    return new Response(request.method==='HEAD'?null:html,{status:404,headers:{'content-type':'text/html;charset=utf-8'}});
  }
  // The whole body (at most 1 MiB) must arrive within the read deadline.
  const body=async(request:Request)=>new TextDecoder().decode(await readBoundedBody(request,{maxBytes:1_048_576,deadlineMs:options.bodyDeadlineMs}));
  async function proxy(base:string|undefined,path:string,request:Request,raw?:string,visitor?:string) {
    if(!base)return error('Service is not configured',503);
    const url=new URL(base); url.pathname=path.split('?')[0]!;url.search=path.includes('?')?path.slice(path.indexOf('?')):'';
    // Never forward browser cookies, wallet headers or caller-selected destinations. The only other header is the
    // website's own signed visitor key, sent to the protocol gateway (never to the RPC provider); a caller's copy of it
    // is never forwarded.
    const headers:Record<string,string>={'content-type':'application/json'};
    if(visitor&&visitors)headers[VISITOR_HEADER]=visitors.sign(visitor,now());
    const response=await fetcher(url,{method:request.method,headers,body:raw,redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)return error('Upstream service request failed',response.status>=400&&response.status<600?response.status:502);
    return new Response(response.body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }
  return async(request:Request,peer?:string):Promise<Response>=>{
    let response:Response;
    let cacheControl='no-store';
    try {
      const url=new URL(request.url), path=url.pathname;
      // The visitor: Railway appends the visitor address to X-Forwarded-For (IPv6 grouped by /64).
      const client=forwardedClient(request,peer,policy);
      if(isCrossOriginPost(request))return error('Cross-origin request refused',403);
      if(path==='/mochi-config.json'&&request.method==='GET')response=Response.json(config);
      else if(path==='/api/tokenomics/report'&&request.method==='GET')response=Response.json(await (options.revenue??createRevenueStatusReader())());
      else if(path.startsWith('/api/claims/'))response=options.claims?await options.claims(request):Response.json({error:{code:'UNAVAILABLE',message:'Claim research is not configured.'}},{status:503});
      else if(path==='/health'&&request.method==='GET')response=Response.json({ok:true,configured:config.enabled,
        // Content-free, for the rehearsal: how this visitor is keyed (a per-process tag, never the address) and the
        // fingerprint of the visitor-signing key, which must equal the CVM's visitorKeyId.
        client:{keySource:policy.trustForwardedFor&&request.headers.has('x-forwarded-for')?'forwarded':client==='unknown'?'none':'peer',keyTag:tag(client),...forwardingFacts(request,peer,tag),visitorKeyId:visitors?.id??null}});
      else if(path.startsWith('/api/v1/attestation/collateral/')&&request.method==='GET') {
        const match=/^\/api\/v1\/attestation\/collateral\/([0-9a-fA-F]{12})\/(platform|processor)$/.exec(path);
        if(!match)response=error('Invalid collateral selector');
        else {
          const fmspc=match[1]!.toUpperCase(), ca=match[2] as 'platform'|'processor', state=collateral.state(fmspc,ca);
          const admitted=collateralLimiter.take(client,'requests');
          const miss=admitted.ok&&state==='unknown'?collateralMisses.take(client,'requests'):{ok:true as const};
          if(!admitted.ok)response=tooManyRequests(admitted.retryAfterSec);
          else if(!miss.ok)response=tooManyRequests(miss.retryAfterSec);
          else if(state==='failed')response=error('Collateral is temporarily unavailable for this platform',503);
          else response=Response.json(await collateral.get(fmspc,ca));
        }
      } else if(path==='/rpc'&&request.method==='POST') {
        const raw=await body(request), value=JSON.parse(raw), calls=Array.isArray(value)?value:[value];
        if(!calls.length||calls.length>20||calls.some(c=>!c||c.jsonrpc!=='2.0'||!readMethods.has(c.method)))response=error('Only read-only RPC methods are allowed',403);
        else {
          const admitted=rpcLimiter.take(client,'requests',calls.length);
          response=admitted.ok?await proxy(options.rpc,new URL(options.rpc??'http://localhost').pathname+new URL(options.rpc??'http://localhost').search,request,raw):tooManyRequests(admitted.retryAfterSec);
        }
      } else if(path.startsWith('/api/')) {
        const route=path.slice(4);
        if(request.method==='GET'&&gatewayGet.test(route))response=await proxy(options.gateway,route+url.search,request,undefined,client);
        else if(request.method==='POST'&&gatewayPost.test(route)) {
          // Per-visitor write quotas, then the same visitor is named to the CVM so its per-client limits apply per visitor.
          const limiter=limiters[route as keyof typeof limiters];
          const admitted=limiter.take(client,'requests');
          if(!admitted.ok)response=tooManyRequests(admitted.retryAfterSec);
          else {
            const raw=await body(request), charged=limiter.take(client,'bytes',Buffer.byteLength(raw));
            response=charged.ok?await proxy(options.gateway,route+url.search,request,raw,client):tooManyRequests(charged.retryAfterSec);
          }
        }
        else response=error('Not found',404);
      } else if(/^\/indexer\/v1\/receipts\/0x[0-9a-f]{64}$/.test(path)&&request.method==='GET')response=await proxy(options.indexer,path.slice(8),request);
      else if(request.method==='GET'||request.method==='HEAD') {
        let decoded:string|null=null;
        try{decoded=decodeURIComponent(path)}catch{}
        // Malformed escapes, NUL bytes and dot segments (/.git, /.env) are never looked up.
        const candidate=decoded===null||decoded.includes('\0')||decoded.split('/').some(s=>s.startsWith('.'))?null:resolve(dist,'.'+decoded+(decoded.endsWith('/')?'index.html':''));
        const actual=candidate&&await realpath(candidate).catch(()=>null);
        if(!actual||!decoded||!actual.startsWith(dist+sep))response=await notFound(request,path);
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
    } catch(caught) {response=caught instanceof BodyReadError?error(caught.message,caught.status):error('Request could not be completed',502)}
    try { response.headers.set('Cache-Control',cacheControl); }
    catch { response=new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers}); response.headers.set('Cache-Control',cacheControl); }
    // CSP (site policy), HSTS, frame-ancestors none, X-Frame-Options DENY, nosniff and no-referrer on every response.
    applySecurityHeaders(response.headers,contentSecurityPolicy);
    return response;
  };
}
if(import.meta.main) {
  const config=loadWebDeployment(process.env);
  const rehearsal=process.env.MOCHI_WEB_REHEARSAL==='1';
  const handler=createWebHandler({config,allowRehearsal:rehearsal,revenue:createRevenueStatusReader({reportPath:process.env.MOCHI_REVENUE_REPORT_FILE,upstream:process.env.MOCHI_CLAIMS_UPSTREAM,tokenConfigured:process.env.MOCHI_TOKEN_CONFIRMED==='true'}),dist:new URL('./site/dist',import.meta.url).pathname,
    gateway:process.env.MOCHI_GATEWAY_URL,indexer:process.env.MOCHI_INDEXER_URL,rpc:process.env.RPC_URL,claims:process.env.MOCHI_CLAIMS_UPSTREAM?createClaimsProxy(process.env.MOCHI_CLAIMS_UPSTREAM):createClaimsRuntime(),
    // The invitation token the CVM also holds; only an HMAC key derived from it is used, to sign per-visitor keys.
    visitorSecret:process.env.MOCHI_CLAIMS_ACCESS_TOKEN});
  const server=Bun.serve({hostname:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4321),idleTimeout:60,fetch:(request,bun)=>handler(request,bun.requestIP(request)?.address)});
  console.log(`Mochi website listening on port ${server.port}; deployment ${publicConfig(config,{allowRehearsal:rehearsal}).enabled?'configured':'pending'}${rehearsal?' (TESTNET REHEARSAL)':''}`);
  if(process.env.MOCHI_GATEWAY_URL&&!visitorKey(process.env.MOCHI_CLAIMS_ACCESS_TOKEN))console.warn('Per-visitor protocol limits are off: the invitation token is not configured, so the CVM keys every website request as one client.');
}
