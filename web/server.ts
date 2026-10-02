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
import { MAX_FORWARDED_HOPS, clientPrefix, forwardedAddress, forwardedHops, forwardingDiagnostics, keyTagger, type ForwardingPolicy, type Ipv6Grouping } from '../services/claims/src/client-address.ts';
import { KEY_CHECK_HEADER, VISITOR_HEADER, visitorKey, visitorSecretFromEnv } from '../services/claims/src/visitor-key.ts';
import { BodyReadError, abandonedBodyResponse, closeAbandonedConnection, readBoundedBody } from '../services/claims/src/bounded-body.ts';

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

const KiB = 1024, MiB = 1024 * KiB, MINUTE = 60, HOUR = 3600;
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
 * Request bodies. Each route reads at most its own cap (the CVM proxy and the gateway apply the same ones: a 1 MiB
 * upload envelope, a 64 KiB query), and all bodies this process is reading or holding stay under maxBufferedBytes
 * together; past it a new body is refused with 503 and Retry-After instead of being buffered.
 */
export const WEBSITE_BODY_LIMITS = { upload: MiB, query: 64 * KiB, rpc: 64 * KiB, maxBufferedBytes: 32 * MiB };
/**
 * Read-only RPC, counted per JSON-RPC call (a batch of 20 is 20) and keyed per IPv4 address or IPv6 /56. One call is
 * charged before the body is read, the rest once the batch is parsed.
 *
 * One paid check costs at most about 120 calls (web/site/src/live-client.js):
 *   prepare   6   chain id, paused, intake active, query id, quote, decimals
 *   submit  <=22  chain id, quote, allowance, simulation, and up to three transactions (allowance reset, approval,
 *                 payment) whose receipts are polled every 4 s, about 6 calls each on a chain with sub-second blocks
 *   wait    <=90  one batched read of the query and its verdict (2 calls) every 4 s for at most 180 s: 30 calls/min
 *   verify   1-3  the verdict (and, on the dashboard, the receipt anchor)
 * so a visitor peaks at about 30 calls a minute, with bursts of about 10 in a second.
 *
 * Per visitor, 120/min and 3000/h: four checks waiting at once from one address (a household or office behind NAT)
 * before any of them slows, and about 25 checks an hour. A visitor over the limit is slowed, not failed: the client
 * waits for Retry-After and polls on. In total, 6000/min and 180000/h: about 200 checks waiting at once in a burst and
 * 100 sustained. Spending the global budget takes at least 50 addresses (or IPv6 /56s), each at its own limit, and the
 * hourly limit holds the cost of all visitors together to an average of 50 calls a second at the RPC provider.
 */
export const WEBSITE_RPC_QUOTAS: QuotaRule[] = [
  { scope: 'client', unit: 'requests', limit: 120, windowSec: MINUTE },
  { scope: 'client', unit: 'requests', limit: 3000, windowSec: HOUR },
  { scope: 'global', unit: 'requests', limit: 6000, windowSec: MINUTE },
  { scope: 'global', unit: 'requests', limit: 180_000, windowSec: HOUR },
];
/**
 * Intel PCS collateral, keyed per IPv4 address or IPv6 /48. Real platforms (FMSPCs) are few. Once PCS has served an
 * FMSPC/CA pair, the PCS source caches it and refreshes it in the background with its own backoff, so further requests
 * for that pair cost PCS nothing and are never charged a miss again. Only a pair never served before (a miss) can
 * cost PCS requests on demand, so misses have small per-visitor and global budgets, and a pair that failed is refused
 * for failedSec. An attacker who spends the miss budget on made-up FMSPCs therefore delays only platforms nobody has
 * used yet. `pinned` FMSPCs are never charged a miss, even before their first fetch: the platforms of the verified
 * production identity reports (the live CVM's is 20A06F000000), replaced by MOCHI_WEB_PINNED_FMSPCS when it is set.
 */
export const WEBSITE_COLLATERAL_QUOTAS: { requests: QuotaRule[]; misses: QuotaRule[]; failedSec: number; maxFailed: number; maxKnown: number; pinned: readonly string[] } = {
  requests: [{ scope: 'client', unit: 'requests', limit: 120, windowSec: HOUR }],
  misses: [{ scope: 'client', unit: 'requests', limit: 6, windowSec: HOUR }, { scope: 'global', unit: 'requests', limit: 60, windowSec: HOUR }],
  failedSec: 5 * MINUTE, maxFailed: 256, maxKnown: 64,
  pinned: ['20A06F000000'],
};
const FMSPC = /^[0-9a-fA-F]{12}$/;
/** MOCHI_WEB_PINNED_FMSPCS: comma-separated FMSPCs replacing the pinned list (empty pins none); unset keeps the default. */
export function pinnedFmspcsFromEnv(env: Record<string, string | undefined>): string[] | undefined {
  const value = env.MOCHI_WEB_PINNED_FMSPCS;
  if (value === undefined) return undefined;
  const list = value.split(',').map(item => item.trim()).filter(Boolean);
  if (list.some(item => !FMSPC.test(item))) throw new Error('MOCHI_WEB_PINNED_FMSPCS must list 12-hex-digit FMSPCs.');
  return list.map(item => item.toUpperCase());
}
const onRailway = (env: Record<string, string | undefined>) => ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT_ID'].some(name => Boolean(env[name]));
/**
 * Whether the website keys visitors on X-Forwarded-For. MOCHI_WEB_TRUST_FORWARDED_FOR ("1" or "0") decides when it is
 * set; otherwise only on Railway (RAILWAY_ENVIRONMENT, RAILWAY_ENVIRONMENT_NAME or RAILWAY_ENVIRONMENT_ID is set), whose
 * edge writes the visitor's address. Anywhere else the header is whatever the caller sent, so visitors are keyed on the
 * transport peer. Which entry, and why that is safe: forwardedAddress in client-address.ts.
 */
export function websiteTrustsForwardedFor(env: Record<string, string | undefined>): boolean {
  const explicit = env.MOCHI_WEB_TRUST_FORWARDED_FOR;
  if (explicit !== undefined && explicit !== '') {
    if (explicit === '1' || explicit === '0') return explicit === '1';
    throw new Error('MOCHI_WEB_TRUST_FORWARDED_FOR must be 1 or 0.');
  }
  return onRailway(env);
}
/**
 * Railway's edge writes two X-Forwarded-For entries, `<visitor>, <edge node>`, and rewrites a caller's header rather
 * than appending to it (measured 2026-10-02 with Railway's CDN off). The visitor is the second entry from the right.
 */
export const RAILWAY_FORWARDED_HOPS = 2;
/**
 * How many X-Forwarded-For entries, counted from the right, the website's trusted proxies write: the visitor is the entry
 * at `len - hops`. MOCHI_WEB_FORWARDED_HOPS (1 to 4) decides when it is set; otherwise RAILWAY_FORWARDED_HOPS on Railway
 * and 1 (one appending proxy) elsewhere. It matters only while websiteTrustsForwardedFor is true. The activation check
 * (deploy/production/WEBSITE-ACTIVATION.md) confirms it against the live edge.
 */
export function websiteForwardedHops(env: Record<string, string | undefined>): number {
  const explicit = env.MOCHI_WEB_FORWARDED_HOPS;
  if (explicit !== undefined && explicit !== '') {
    const hops = Number(explicit);
    if (!/^\d$/.test(explicit) || hops < 1 || hops > MAX_FORWARDED_HOPS) throw new Error(`MOCHI_WEB_FORWARDED_HOPS must be a whole number from 1 to ${MAX_FORWARDED_HOPS}.`);
    return hops;
  }
  return onRailway(env) ? RAILWAY_FORWARDED_HOPS : 1;
}
/** The website's forwarding policy from its environment; a bad setting fails startup. */
export function websiteForwardingPolicy(env: Record<string, string | undefined>): Required<ForwardingPolicy> {
  return { trustForwardedFor: websiteTrustsForwardedFor(env), forwardedForHops: websiteForwardedHops(env) };
}
/** Operator key checks (X-Mochi-Key-Check on /health): each is one online guess at the visitor secret, so few. */
const KEY_CHECK_QUOTAS: QuotaRule[] = [{ scope: 'client', unit: 'requests', limit: 10, windowSec: HOUR }, { scope: 'global', unit: 'requests', limit: 60, windowSec: HOUR }];

type Collateral = { get(fmspc: string, ca: 'platform' | 'processor'): Promise<unknown> };
/**
 * Remembers which FMSPC/CA pairs PCS has served ("known": never charged a miss again) and which unknown pairs failed
 * (refused without asking PCS again until failedSec passes), and joins concurrent fetches of one pair. Values stay in
 * the source, which caches them until their own expiry and refreshes them with its own backoff.
 */
function guardCollateral(source: Collateral, now: () => number, limits: typeof WEBSITE_COLLATERAL_QUOTAS) {
  const pinned = new Set(limits.pinned.map(fmspc => fmspc.toUpperCase()));
  const known = new Set<string>();
  const failed = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  const isKnown = (fmspc: string, key: string) => pinned.has(fmspc) || known.has(key);
  return {
    /** "known" and "failed" need no miss; "pending" joins a running fetch; "unknown" is a miss. */
    state(fmspc: string, ca: string): 'known' | 'failed' | 'pending' | 'unknown' {
      const key = `${fmspc}:${ca}`;
      if (isKnown(fmspc, key)) return 'known';
      if ((failed.get(key) ?? 0) > now()) return 'failed';
      return pending.has(key) ? 'pending' : 'unknown';
    },
    get(fmspc: string, ca: 'platform' | 'processor'): Promise<unknown> {
      const key = `${fmspc}:${ca}`;
      const running = pending.get(key);
      if (running) return running;
      const fetching = source.get(fmspc, ca)
        .then(value => {
          failed.delete(key);
          if (!known.has(key) && known.size < limits.maxKnown) known.add(key);
          return value;
        }, error => {
          if (!isKnown(fmspc, key)) {
            failed.delete(key);
            while (failed.size >= limits.maxFailed) failed.delete(failed.keys().next().value!);
            failed.set(key, now() + limits.failedSec);
          }
          throw error;
        })
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
  quotas?: Partial<typeof WEBSITE_WRITE_QUOTAS>; rpcQuotas?: QuotaRule[]; collateralQuotas?: Partial<typeof WEBSITE_COLLATERAL_QUOTAS>;
  bodyLimits?: Partial<typeof WEBSITE_BODY_LIMITS>; now?: () => number;
  /** The visitor secret (visitorSecretFromEnv): signs the per-visitor X-Mochi-Visitor header on requests to the CVM. */
  visitorSecret?: string;
  /**
   * Key visitors on X-Forwarded-For, which Railway's edge writes. Default false (the transport peer); the server sets it
   * from websiteForwardingPolicy, which trusts it on Railway.
   */
  trustForwardedFor?: boolean;
  /**
   * With trustForwardedFor, the visitor is the entry at `len - forwardedForHops` (the right-most counts as 1). Default 1;
   * the server sets it from websiteForwardingPolicy, which gives RAILWAY_FORWARDED_HOPS on Railway. 1 to 4.
   */
  forwardedForHops?: number;
  bodyDeadlineMs?: number;
};
export function createWebHandler(options: WebHandlerOptions) {
  const config = publicConfig(options.config, { allowRehearsal: options.allowRehearsal === true });
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => Date.now() / 1000);
  const collateralQuotas={...WEBSITE_COLLATERAL_QUOTAS,...options.collateralQuotas};
  const collateral = guardCollateral(options.collateral ?? new PcsCollateralSource({fetch:((url:string,init?:RequestInit)=>fetcher(url,{...init,signal:AbortSignal.timeout(15000)})) as typeof fetch}), now, collateralQuotas);
  const dist=resolve(options.dist);
  const contentSecurityPolicy=siteContentSecurityPolicy(dist);
  const quotas={...WEBSITE_WRITE_QUOTAS,...options.quotas};
  const limits={...WEBSITE_BODY_LIMITS,...options.bodyLimits};
  const limiters={'/v1/intake/upload':new QuotaLimiter(quotas['/v1/intake/upload'],{now}),'/v1/query':new QuotaLimiter(quotas['/v1/query'],{now})};
  const rpcLimiter=new QuotaLimiter(options.rpcQuotas??WEBSITE_RPC_QUOTAS,{now});
  const collateralLimiter=new QuotaLimiter(collateralQuotas.requests,{now}), collateralMisses=new QuotaLimiter(collateralQuotas.misses,{now});
  const keyChecks=new QuotaLimiter(KEY_CHECK_QUOTAS,{now});
  const visitors=visitorKey(options.visitorSecret);
  const policy:Required<ForwardingPolicy>={trustForwardedFor:options.trustForwardedFor===true,forwardedForHops:options.forwardedForHops??1};
  forwardedHops(policy); // A bad hop count fails here, at startup, not on each request.
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
  /**
   * Reads a body of at most `maxBytes` that must arrive whole within the read deadline, counting it against the bytes
   * all requests hold together; `release` returns them once the body has been passed upstream.
   */
  let bufferedBytes=0;
  async function readBody(request:Request,maxBytes:number):Promise<{text:string;bytes:number;release():void}> {
    let held=0;
    const release=()=>{bufferedBytes-=held;held=0;};
    try {
      const bytes=await readBoundedBody(request,{maxBytes,deadlineMs:options.bodyDeadlineMs,onChunk:size=>{
        if(bufferedBytes+size>limits.maxBufferedBytes)throw new BodyReadError(503,'The website is busy; try again shortly');
        bufferedBytes+=size;held+=size;
      }});
      return {text:new TextDecoder().decode(bytes),bytes:bytes.byteLength,release};
    } catch(caught) {release();throw caught;}
  }
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
      // The visitor: with trustForwardedFor, the X-Forwarded-For entry at len - forwardedForHops, which Railway's edge
      // wrote; else the transport peer.
      // Writes and the CVM's visitor key group IPv6 by /64, RPC reads by /56 and Intel collateral by /48.
      const address=forwardedAddress(request,peer,policy);
      const keyOf=(bits:Ipv6Grouping)=>address===undefined?'unknown':clientPrefix(address,bits);
      const client=keyOf(64);
      if(isCrossOriginPost(request))return error('Cross-origin request refused',403);
      if(path==='/mochi-config.json'&&request.method==='GET')response=Response.json(config);
      else if(path==='/api/tokenomics/report'&&request.method==='GET')response=Response.json(await (options.revenue??createRevenueStatusReader())());
      else if(path.startsWith('/api/claims/'))response=options.claims?await options.claims(request):Response.json({error:{code:'UNAVAILABLE',message:'Claim research is not configured.'}},{status:503});
      else if(path==='/health'&&request.method==='GET') {
        // Content-free, for the activation check: how this visitor is keyed (a per-process tag, never the address), the
        // hop count, and the class and tag of each X-Forwarded-For entry (right-most first) and of X-Real-IP, which is
        // shown for comparison only. With an operator's X-Mochi-Key-Check proof, also whether this server holds the same
        // visitor secret; nothing derived from the secret is ever shown.
        const proof=request.headers.get(KEY_CHECK_HEADER);
        const visitorKeyCheck=!visitors?'unconfigured':proof&&!keyChecks.take(client,'requests').ok?'rate_limited':visitors.checkKey(proof);
        response=Response.json({ok:true,configured:config.enabled,
          client:{trustForwardedFor:policy.trustForwardedFor,keySource:policy.trustForwardedFor&&request.headers.has('x-forwarded-for')?'forwarded':client==='unknown'?'none':'peer',keyTag:tag(client),...forwardingDiagnostics(request,peer,policy,tag),visitorKeyCheck}});
      }
      else if(path.startsWith('/api/v1/attestation/collateral/')&&request.method==='GET') {
        const match=/^\/api\/v1\/attestation\/collateral\/([0-9a-fA-F]{12})\/(platform|processor)$/.exec(path);
        if(!match)response=error('Invalid collateral selector');
        else {
          const fmspc=match[1]!.toUpperCase(), ca=match[2] as 'platform'|'processor', state=collateral.state(fmspc,ca), site=keyOf(48);
          const admitted=collateralLimiter.take(site,'requests');
          const miss=admitted.ok&&state==='unknown'?collateralMisses.take(site,'requests'):{ok:true as const};
          if(!admitted.ok)response=tooManyRequests(admitted.retryAfterSec);
          else if(!miss.ok)response=tooManyRequests(miss.retryAfterSec);
          else if(state==='failed')response=error('Collateral is temporarily unavailable for this platform',503);
          else response=Response.json(await collateral.get(fmspc,ca));
        }
      } else if(path==='/rpc'&&request.method==='POST') {
        // One call is charged before the body is read, so a slow or unreadable body still costs its sender; the rest of
        // a batch is charged once it is parsed.
        const rpcClient=keyOf(56), first=rpcLimiter.take(rpcClient,'requests');
        if(!first.ok)response=tooManyRequests(first.retryAfterSec);
        else {
          const body=await readBody(request,limits.rpc);
          try {
            let value:unknown;
            try{value=JSON.parse(body.text)}catch{value=undefined}
            const calls:any[]=Array.isArray(value)?value:[value];
            if(value===undefined)response=error('Invalid JSON-RPC request');
            else if(!calls.length||calls.length>20||calls.some(c=>!c||c.jsonrpc!=='2.0'||!readMethods.has(c.method)))response=error('Only read-only RPC methods are allowed',403);
            else {
              // A refused batch's Retry-After covers the whole batch, first call included, so a client that waits
              // exactly that long gets through instead of spending its first call again on every retry.
              const rest=calls.length>1?rpcLimiter.take(rpcClient,'requests',calls.length-1):{ok:true as const};
              response=rest.ok?await proxy(options.rpc,new URL(options.rpc??'http://localhost').pathname+new URL(options.rpc??'http://localhost').search,request,body.text)
                :tooManyRequests(Math.max(rest.retryAfterSec,rpcLimiter.retryAfter(rpcClient,'requests',calls.length)));
            }
          } finally {body.release();}
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
            const body=await readBody(request,route==='/v1/query'?limits.query:limits.upload);
            try {
              const charged=limiter.take(client,'bytes',body.bytes);
              response=charged.ok?await proxy(options.gateway,route+url.search,request,body.text,client):tooManyRequests(charged.retryAfterSec);
            } finally {body.release();}
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
    } catch(caught) {
      // A body that was not read to the end: the connection is closed rather than kept (see closeAbandonedConnection).
      if(caught instanceof BodyReadError)response=abandonedBodyResponse(Response.json({error:caught.message},{status:caught.status,headers:caught.status===503?{'retry-after':'5'}:{}}));
      else response=error('Request could not be completed',502);
    }
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
  const visitorSecret=visitorSecretFromEnv(process.env), forwarding=websiteForwardingPolicy(process.env), pinned=pinnedFmspcsFromEnv(process.env);
  const handler=createWebHandler({config,allowRehearsal:rehearsal,revenue:createRevenueStatusReader({reportPath:process.env.MOCHI_REVENUE_REPORT_FILE,upstream:process.env.MOCHI_CLAIMS_UPSTREAM,tokenConfigured:process.env.MOCHI_TOKEN_CONFIRMED==='true'}),dist:new URL('./site/dist',import.meta.url).pathname,
    gateway:process.env.MOCHI_GATEWAY_URL,indexer:process.env.MOCHI_INDEXER_URL,rpc:process.env.RPC_URL,claims:process.env.MOCHI_CLAIMS_UPSTREAM?createClaimsProxy(process.env.MOCHI_CLAIMS_UPSTREAM):createClaimsRuntime(),
    // Only an HMAC key derived from the visitor secret is used, to sign per-visitor keys.
    visitorSecret,...forwarding,...(pinned?{collateralQuotas:{pinned}}:{})});
  const server=Bun.serve({hostname:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4321),idleTimeout:60,maxRequestBodySize:WEBSITE_BODY_LIMITS.upload,
    fetch:async(request,bun)=>closeAbandonedConnection(bun,request,await handler(request,bun.requestIP(request)?.address))});
  console.log(`Mochi website listening on port ${server.port}; deployment ${publicConfig(config,{allowRehearsal:rehearsal}).enabled?'configured':'pending'}${rehearsal?' (TESTNET REHEARSAL)':''}; visitors keyed on ${forwarding.trustForwardedFor?`X-Forwarded-For entry ${forwarding.forwardedForHops} from the right`:'the transport peer'}`);
  if(process.env.MOCHI_GATEWAY_URL&&!visitorKey(visitorSecret))console.warn('Per-visitor protocol limits are off: the visitor secret is not configured, so the CVM keys every website request as one client.');
}
