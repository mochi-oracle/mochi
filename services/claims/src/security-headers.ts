/** Strict response headers shared by the website, the research pilot and the public protocol proxy. */
export const HSTS = 'max-age=31536000; includeSubDomains';
/** JSON APIs never render, embed or load anything. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function applySecurityHeaders(headers: Headers, contentSecurityPolicy: string = API_CSP): Headers {
  headers.set('Content-Security-Policy', contentSecurityPolicy);
  headers.set('Strict-Transport-Security', HSTS);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  return headers;
}

/** Returns the response with security headers, copying it when its headers are immutable (e.g. from fetch). */
export function withSecurityHeaders(response: Response, contentSecurityPolicy: string = API_CSP): Response {
  try { applySecurityHeaders(response.headers, contentSecurityPolicy); return response; }
  catch {
    const copy = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    applySecurityHeaders(copy.headers, contentSecurityPolicy);
    return copy;
  }
}
