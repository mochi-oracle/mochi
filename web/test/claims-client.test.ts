import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { claimsApi, isSafeSourceUrl, publicError, safeSourceHref, shareUrl } from '../site/src/claims-client.js';

describe('claim client helpers', () => {
  test('accepts only HTTPS source links', () => {
    expect(isSafeSourceUrl('https://example.com/a')).toBe(true);
    expect(isSafeSourceUrl('https://user:pass@example.com/a')).toBe(false);
    expect(isSafeSourceUrl('https://example.com:8443/a')).toBe(false);
    expect(isSafeSourceUrl('https://localhost/a')).toBe(false);
    expect(isSafeSourceUrl('https://service.local/a')).toBe(false);
    expect(isSafeSourceUrl('https://127.0.0.1/a')).toBe(false);
    expect(isSafeSourceUrl('https://10.2.3.4/a')).toBe(false);
    expect(isSafeSourceUrl('https://[::1]/a')).toBe(false);
    expect(safeSourceHref('javascript:alert(1)')).toBeNull();
    expect(safeSourceHref('http://example.com')).toBeNull();
  });
  test('share links contain only the share id, never credentials', () => {
    expect(shareUrl('abc')).toBe('/check/?share=abc');
    expect(shareUrl('a b')).toBe('/check/?share=a%20b');
  });
  test('maps service failures to safe user-facing messages', () => {
    for (const status of [400, 401, 410, 429, 502, 503, 504]) expect(publicError(status)).not.toMatch(/private diagnostic|PROVIDER_SECRET|stack trace/i);
    expect(publicError(503)).toMatch(/not configured/i);
    expect(publicError(410)).toMatch(/expired/i);
    expect(publicError(429, 'DAILY_LIMIT')).toMatch(/tomorrow/i);
    expect(publicError(429, 'BUSY')).toMatch(/capacity/i);
  });
});

describe('claims endpoints', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any; });
  test('research uses its endpoint and sends consent with optional access header', async () => {
    await claimsApi.research({ claim: 'Claim', sourceUrls: [], consent: true }, { token: 'pilot-secret' });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/claims/research', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-mochi-access-token': 'pilot-secret' }), body: JSON.stringify({ claim: 'Claim', sourceUrls: [], consent: true }) }));
  });
  test('review and share use scoped paths and review token header', async () => {
    await claimsApi.review({ researchToken: 'r', consent: true });
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/claims/reviews', expect.anything());
    await claimsApi.share('id/1', { consent: true }, { reviewToken: 'owner' });
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/claims/reviews/id%2F1/share', expect.objectContaining({ headers: expect.objectContaining({ 'x-mochi-review-token': 'owner' }) }));
    await claimsApi.shared('public-id');
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/claims/shared/public-id', expect.anything());
  });
  test('converts HTTP errors without exposing provider payload', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { code: 'PROVIDER_SECRET', message: 'private diagnostic' } }), { status: 502 })) as any;
    await expect(claimsApi.config()).rejects.toThrow('did not respond in time');
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: { code: 'DAILY_LIMIT', message: 'private diagnostic' } }), { status: 429 })) as any;
    await expect(claimsApi.config()).rejects.toThrow('try again tomorrow');
    globalThis.fetch = originalFetch;
  });
});
