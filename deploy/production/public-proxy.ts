import { isCrossOriginPost } from '../../services/claims/src/origin.ts';
import { QuotaLimiter, tooManyRequests, type QuotaRule } from '../../services/claims/src/quota.ts';
import { TRUSTED_CLIENT_HEADER, forwardedClient, forwardingFacts, keyTagger } from '../../services/claims/src/client-address.ts';
import { KEY_CHECK_HEADER, VISITOR_HEADER, visitorKey } from '../../services/claims/src/visitor-key.ts';
import { BODY_READ_DEADLINE_MS, BodyReadError, abandonedBodyResponse, readBoundedBody } from '../../services/claims/src/bounded-body.ts';
import { withSecurityHeaders } from '../../services/claims/src/security-headers.ts';

const gatewayGet = /^\/v1\/(?:intake\/attestation|stats|queries\/0x[0-9a-f]{64}|verdict\/0x[0-9a-f]{64}|feeds\/[^/]+\/[^/]+|disagreement(?:\/models)?)$/;
const gatewayPost = /^\/v1\/(?:intake\/upload|query)$/;
const indexerGet = /^\/v1\/receipts\/0x[0-9a-f]{64}$/;
const KiB = 1024, MiB = 1024 * KiB, HOUR = 3600, DAY = 86_400;
/** Largest body read per route: an upload envelope, or a query (the gateway's own query cap is 64 KiB). */
export const PUBLIC_BODY_LIMITS = { '/v1/intake/upload': MiB, '/v1/query': 64 * KiB } as const;
/** Operator key checks (X-Mochi-Key-Check on /production/status): each is one online guess at the visitor secret. */
const KEY_CHECK_QUOTAS: QuotaRule[] = [{ scope: 'client', unit: 'requests', limit: 10, windowSec: HOUR }, { scope: 'global', unit: 'requests', limit: 60, windowSec: HOUR }];

/**
 * Public write quotas. Every upload is stored on the CVM disk shared with Postgres and the research pilot (about 1.75
 * bytes on disk per uploaded byte until the intake TTL purges it), so the global byte limits are the real bound. Each
 * per-client limit is 5-6.25% of the matching global one, so at least 16 separate clients are needed to spend a global
 * budget:
 *
 *   uploads  per client 30 requests/h, 16 MiB/h, 64 MiB/day  |  global 600 requests/h, 256 MiB/h, 1 GiB/day
 *   queries  per client 300 requests/h, 8 MiB/h              |  global 6000 requests/h, 128 MiB/h
 *
 * A client is a website visitor (the website's signed X-Mochi-Visitor header), else the proxy-appended
 * X-Forwarded-For entry when `trustForwardedFor` is set, else the transport peer. Callers that reach the CVM through an
 * ingress that hides their address share one client, and so one client's share of the budget.
 *
 * Uploads: a body must arrive whole within BODY_READ_DEADLINE_MS (12 s) before it takes an intake slot; then at most 2
 * per client and 8 in total are processed at once. A body being read holds no slot (a caller that sends one byte a
 * second only spends its own request quota), and at most 64 MiB of request bodies are held in memory at once. Bodies
 * are capped per route (PUBLIC_BODY_LIMITS): 1 MiB for an upload, 64 KiB for a query.
 */
export const DEFAULT_PUBLIC_QUOTAS: { upload: QuotaRule[]; query: QuotaRule[]; maxConcurrentUploads: number; maxUploadsPerClient: number; maxBufferedBytes: number } = {
  upload: [
    { scope: 'client', unit: 'requests', limit: 30, windowSec: HOUR },
    { scope: 'client', unit: 'bytes', limit: 16 * MiB, windowSec: HOUR },
    { scope: 'client', unit: 'bytes', limit: 64 * MiB, windowSec: DAY },
    { scope: 'global', unit: 'requests', limit: 600, windowSec: HOUR },
    { scope: 'global', unit: 'bytes', limit: 256 * MiB, windowSec: HOUR },
    { scope: 'global', unit: 'bytes', limit: 1024 * MiB, windowSec: DAY },
  ],
  query: [
    { scope: 'client', unit: 'requests', limit: 300, windowSec: HOUR },
    { scope: 'client', unit: 'bytes', limit: 8 * MiB, windowSec: HOUR },
    { scope: 'global', unit: 'requests', limit: 6000, windowSec: HOUR },
    { scope: 'global', unit: 'bytes', limit: 128 * MiB, windowSec: HOUR },
  ],
  maxConcurrentUploads: 8,
  maxUploadsPerClient: 2,
  maxBufferedBytes: 64 * MiB,
};

export type ProductionProxyOptions = {
  ready(): boolean; gatewayPort: number; indexerPort: number; fetcher?: typeof fetch;
  quotas?: Partial<typeof DEFAULT_PUBLIC_QUOTAS>;
  /**
   * Key clients on the right-most X-Forwarded-For entry. Set only when the rehearsal has shown that the CVM's ingress
   * appends the caller's address to every request; otherwise the header is caller-chosen and the peer is used.
   */
  trustForwardedFor?: boolean;
  /** The visitor secret (visitorSecretFromEnv): checks the website's X-Mochi-Visitor header. Without it the header is ignored. */
  visitorSecret?: string;
  /** Client identity override for tests; by default visitor header, then forwarded address (if trusted), then peer. */
  clientKey?: (request: Request, peer?: string) => string;
  now?: () => number;
  bodyDeadlineMs?: number;
};

/** The launch config's optional `publicProxy` settings; anything other than exactly `true` keeps the safe default. */
export function publicProxySettings(launchConfig: string | undefined): { trustForwardedFor: boolean } {
  try { return { trustForwardedFor: JSON.parse(launchConfig ?? 'null')?.publicProxy?.trustForwardedFor === true }; }
  catch { return { trustForwardedFor: false }; }
}

/** Route only the existing public protocol surface; never expose attestor/admin/internal ports. */
export function createProductionProxy(options: ProductionProxyOptions) {
  for (const port of [options.gatewayPort,options.indexerPort]) if (!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid internal protocol port');
  const quotas = { ...DEFAULT_PUBLIC_QUOTAS, ...options.quotas };
  const now = options.now ?? (() => Date.now() / 1000);
  const limiters = {
    '/v1/intake/upload': new QuotaLimiter(quotas.upload, { now }),
    '/v1/query': new QuotaLimiter(quotas.query, { now }),
  } as const;
  const visitors = visitorKey(options.visitorSecret);
  const policy = { trustForwardedFor: options.trustForwardedFor === true };
  const identify = (request: Request, peer?: string): { key: string; source: 'visitor' | 'forwarded' | 'peer' | 'none' } => {
    const visitor = visitors?.verify(request.headers.get(VISITOR_HEADER), now());
    if (visitor?.status === 'valid') return { key: `visitor:${visitor.visitor}`, source: 'visitor' };
    const key = forwardedClient(request, peer, policy);
    return { key, source: policy.trustForwardedFor && request.headers.has('x-forwarded-for') ? 'forwarded' : key === 'unknown' ? 'none' : 'peer' };
  };
  const clientKey = options.clientKey ?? ((request: Request, peer?: string) => identify(request, peer).key);
  const tag = keyTagger();
  const keyChecks = new QuotaLimiter(KEY_CHECK_QUOTAS, { now });
  const uploadsByClient = new Map<string, number>();
  let uploadsInFlight = 0, bufferedBytes = 0;
  const handle = async (request: Request, peer?: string): Promise<Response> => {
    const url=new URL(request.url), path=url.pathname;
    const gateway=request.method==='GET'&&gatewayGet.test(path)||request.method==='POST'&&gatewayPost.test(path);
    const indexer=request.method==='GET'&&indexerGet.test(path);
    const error=(status:number,message:string,headers:Record<string,string>={})=>Response.json({error:message},{status,headers:{...headers,'cache-control':'no-store'}});
    if (!gateway&&!indexer) return error(404,'Not found');
    if (!options.ready()) return error(503,'Production protocol is not active');
    if(isCrossOriginPost(request)) return error(403,'Cross-origin request refused');
    const upload = request.method==='POST'&&path==='/v1/intake/upload';
    const client = clientKey(request, peer);
    let heldByClient = false, heldSlot = false, buffered = 0;
    try {
      let body: Uint8Array | undefined;
      if(request.method==='POST') {
        const limiter=limiters[path as keyof typeof limiters];
        const maxBytes=PUBLIC_BODY_LIMITS[path as keyof typeof PUBLIC_BODY_LIMITS];
        const declared=Number(request.headers.get('content-length')??0);
        if(declared>maxBytes) return abandonedBodyResponse(error(413,'Request too large'));
        const clientBusy=()=>upload&&(uploadsByClient.get(client)??0)>=quotas.maxUploadsPerClient;
        if(clientBusy()) return error(429,'Too many uploads in progress; try again shortly',{'retry-after':'5'});
        // Charged before the read, so each slow or abandoned body still costs its caller a request.
        const admission=limiter.take(client,'requests');
        if(!admission.ok) return tooManyRequests(admission.retryAfterSec);
        // The whole body arrives within the deadline before it is charged or takes an intake slot. A body being read
        // holds no slot, so callers who cannot be told apart do not block each other by sending slowly.
        body=await readBoundedBody(request,{maxBytes,deadlineMs:options.bodyDeadlineMs??BODY_READ_DEADLINE_MS,onChunk:bytes=>{
          if(bufferedBytes+bytes>quotas.maxBufferedBytes) throw new BodyReadError(503,'Upload capacity is busy; try again shortly');
          bufferedBytes+=bytes; buffered+=bytes;
        }});
        const byteAdmission=limiter.take(client,'bytes',body.byteLength);
        if(!byteAdmission.ok) return tooManyRequests(byteAdmission.retryAfterSec);
        if(upload) {
          if(clientBusy()) return error(429,'Too many uploads in progress; try again shortly',{'retry-after':'5'});
          if(uploadsInFlight>=quotas.maxConcurrentUploads) return error(503,'Upload capacity is busy; try again shortly',{'retry-after':'5'});
          uploadsByClient.set(client,(uploadsByClient.get(client)??0)+1); heldByClient=true;
          uploadsInFlight++; heldSlot=true;
        }
      }
      // Fresh headers: no caller header reaches a protocol service. The gateway keys /v1/query on this client key,
      // which it accepts only over loopback.
      const headers:Record<string,string>={'content-type':'application/json'};
      if(gateway) headers[TRUSTED_CLIENT_HEADER]=client;
      const response=await (options.fetcher??fetch)(`http://127.0.0.1:${indexer?options.indexerPort:options.gatewayPort}${path}${url.search}`,{
        method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(30_000),
      });
      if(!response.ok)return error(response.status>=400?response.status:502,'Protocol request failed');
      // Uploads hold their slot until the response body is delivered.
      const payload=upload?new Uint8Array(await response.arrayBuffer()):response.body;
      return new Response(payload,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    } catch (caught) {
      // A body that was not read to the end: the connection is closed rather than kept (see closeAbandonedConnection).
      if(caught instanceof BodyReadError) return abandonedBodyResponse(error(caught.status,caught.message,caught.status===503?{'retry-after':'5'}:{}));
      return error(502,'Protocol service unavailable');
    } finally {
      if(heldSlot) uploadsInFlight--;
      if(heldByClient) { const left=(uploadsByClient.get(client)??1)-1; if(left>0) uploadsByClient.set(client,left); else uploadsByClient.delete(client); }
      bufferedBytes-=buffered;
    }
  };
  const proxy = async (request: Request, peer?: string): Promise<Response> => withSecurityHeaders(await handle(request, peer));
  /**
   * Content-free description of how this caller is keyed, for GET /production/status: where the key came from, a
   * per-process tag of it (equal for two callers exactly when they share limits), what arrived in X-Forwarded-For and
   * the class of the transport peer, with tags of both. With an operator's X-Mochi-Key-Check proof, also whether this
   * server holds the same visitor secret as the sender ("match" or "mismatch"). No address, header value, secret or
   * anything derived from the secret.
   */
  const clientDiagnostics = (request: Request, peer?: string) => {
    const identity = identify(request, peer);
    const proof = request.headers.get(KEY_CHECK_HEADER);
    return {
      keySource: identity.source,
      keyTag: tag(identity.key),
      trustForwardedFor: policy.trustForwardedFor,
      ...forwardingFacts(request, peer, tag),
      visitor: visitors ? visitors.verify(request.headers.get(VISITOR_HEADER), now()).status : 'unconfigured',
      visitorKeyCheck: !visitors ? 'unconfigured' : proof && !keyChecks.take(identity.key, 'requests').ok ? 'rate_limited' : visitors.checkKey(proof),
    };
  };
  return Object.assign(proxy, { clientDiagnostics });
}

/** Public possession proofs are bound by each juror to its configured operator and registry. */
export function createEnrollmentEndpoint(options: {ready():boolean;jurorPorts:readonly number[];fetcher?:typeof fetch}) {
  if(options.jurorPorts.length!==9||options.jurorPorts.some((p,i)=>p!==3100+i))throw new Error('Enrollment requires fixed juror ports');
  const handle = async(request:Request)=>{
    const headers={'cache-control':'no-store'};
    if(request.method!=='GET')return new Response(null,{status:405,headers:{...headers,Allow:'GET'}});
    if(!options.ready())return Response.json({error:'Production enrollment is not prepared'},{status:503,headers});
    try {
      const proofs=await Promise.all(options.jurorPorts.map(async port=>{
        const response=await(options.fetcher??fetch)(`http://127.0.0.1:${port}/v1/enrollment`,{redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('Proof unavailable');
        return response.json();
      }));
      return Response.json({proofs},{headers});
    } catch {return Response.json({error:'Enrollment proofs unavailable'},{status:503,headers})}
  };
  return async(request:Request)=>withSecurityHeaders(await handle(request));
}
