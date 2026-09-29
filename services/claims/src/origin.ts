/**
 * The site's public origin as the browser sees it. Behind a TLS-terminating proxy (Railway, the Phala gateway) the
 * request URL is plain http, so the scheme comes from X-Forwarded-Proto when the proxy sets it. The host always comes
 * from the request itself, so the header can never make another site's origin match.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return proto === 'https' || proto === 'http' ? `${proto}://${url.host}` : url.origin;
}

/** True for a browser POST whose Origin is not this site. Requests without an Origin header (non-browser) pass. */
export function isCrossOriginPost(request: Request): boolean {
  const origin = request.headers.get('origin');
  return request.method === 'POST' && origin !== null && origin !== publicOrigin(request);
}
