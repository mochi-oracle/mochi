const API = '/api/claims';

export function isSafeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/i.test(host)) return false;
    const octets = host.split('.');
    if (octets.length === 4 && octets.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255)) {
      const [a, b] = octets.map(Number);
      if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224) return false;
    }
    return true;
  } catch { return false; }
}

export function safeSourceHref(value) {
  return isSafeSourceUrl(value) ? value : null;
}

export function shareUrl(shareId) {
  return `/check/?share=${encodeURIComponent(shareId)}`;
}

export function publicError(status, code = '') {
  if (status === 401) return 'That pilot access token was not accepted. Check it and try again.';
  if (status === 410 || code === 'EXPIRED') return 'This evidence session expired. Research the claim again to create a fresh session.';
  if (code === 'DAILY_LIMIT') return 'The pilot has reached today’s research or review limit. Please try again tomorrow.';
  if (status === 429) return 'The pilot is at capacity. Wait a moment and try again.';
  if (status === 400) return 'The request could not be accepted. Review the claim and source URLs.';
  if (status === 502 || status === 504) return 'A research provider did not respond in time. You can try again.';
  if (status === 503) return 'Claim checking is not configured for this deployment yet.';
  return 'The request could not be completed. Please try again later.';
}

async function request(path, { token, reviewToken, signal, ...options } = {}) {
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (token) headers['x-mochi-access-token'] = token;
  if (reviewToken) headers['x-mochi-review-token'] = reviewToken;
  const response = await fetch(`${API}${path}`, { ...options, headers, signal, cache: 'no-store' });
  if (!response.ok) { let code = ''; try { code = (await response.json())?.error?.code || ''; } catch {} throw new Error(publicError(response.status, code)); }
  return response.json();
}

export const claimsApi = {
  config: ({ signal } = {}) => request('/config', { signal }),
  research: (body, { token, signal } = {}) => request('/research', { method: 'POST', body: JSON.stringify(body), token, signal }),
  review: (body, { token, signal } = {}) => request('/reviews', { method: 'POST', body: JSON.stringify(body), token, signal }),
  share: (id, body, { token, reviewToken, signal } = {}) => request(`/reviews/${encodeURIComponent(id)}/share`, { method: 'POST', body: JSON.stringify(body), token, reviewToken, signal }),
  shared: (id, { signal } = {}) => request(`/shared/${encodeURIComponent(id)}`, { signal }),
};
