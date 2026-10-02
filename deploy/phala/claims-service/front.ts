import { withSecurityHeaders } from '../../../services/claims/src/security-headers.ts';

type Handler = (request: Request) => Response | Promise<Response>;
/** `peer` is the transport peer address from the server (Bun's requestIP), when known. */
type PeerHandler = (request: Request, peer?: string) => Response | Promise<Response>;
export type FrontRoutes = {
  /** GET /production/enrollment: juror possession proofs. */
  enrollment: Handler;
  /** /v1/*: the public protocol proxy. */
  protocol: PeerHandler;
  /** /production/identities: the cached attestation report. */
  identities: Handler;
  /** Everything else: the invitation research pilot. */
  claims: Handler;
  /** GET /production/status body. */
  productionStatus(): unknown;
  /** Optional `client` field of GET /production/status: how the protocol proxy keys this caller (content-free). */
  clientDiagnostics?(request: Request, peer?: string): unknown;
  /** GET /api/tokenomics/report body. */
  revenue(): Promise<unknown>;
};

const HEALTH = { ok: true, service: 'claims-research', mode: 'invitation-pilot', payments: false, publicSourcesOnly: true } as const;

/**
 * Routing for the CVM's public port. Every response, including unexpected failures, carries the strict API security
 * headers (no-content CSP, HSTS, nosniff, no referrer, no framing): this server only returns JSON.
 */
export function createFrontHandler(routes: FrontRoutes) {
  const route = async (request: Request, peer?: string): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/production/enrollment') return routes.enrollment(request);
    if (path.startsWith('/v1/')) return routes.protocol(request, peer);
    if (path === '/production/status' && request.method === 'GET') {
      const status = routes.productionStatus();
      const body = routes.clientDiagnostics && status && typeof status === 'object' ? { ...status, client: routes.clientDiagnostics(request, peer) } : status;
      return Response.json(body, { headers: { 'cache-control': 'no-store' } });
    }
    if (path === '/production/identities') return routes.identities(request);
    if (path === '/api/tokenomics/report' && request.method === 'GET') return Response.json(await routes.revenue(), { headers: { 'cache-control': 'no-store' } });
    if (path === '/health' && request.method === 'GET') return Response.json(HEALTH);
    return routes.claims(request);
  };
  return async (request: Request, peer?: string): Promise<Response> => {
    let response: Response;
    // No error detail reaches the caller or the log: requests can carry claim text and tokens.
    try { response = await route(request, peer); }
    catch { response = Response.json({ error: 'Service unavailable' }, { status: 500, headers: { 'cache-control': 'no-store' } }); }
    return withSecurityHeaders(response);
  };
}
