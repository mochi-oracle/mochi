import { expect, test } from 'bun:test';
import { isCrossOriginPost, publicOrigin } from '../src/origin.ts';

const post = (url: string, headers: Record<string, string> = {}) => new Request(url, { method: 'POST', headers, body: '{}' });

test('public origin takes the scheme from the TLS-terminating proxy and the host from the request', () => {
  expect(publicOrigin(post('http://mochioracle.com/api/claims/research'))).toBe('http://mochioracle.com');
  expect(publicOrigin(post('http://mochioracle.com/api/claims/research', { 'x-forwarded-proto': 'https' }))).toBe('https://mochioracle.com');
  expect(publicOrigin(post('http://mochioracle.com/x', { 'x-forwarded-proto': 'HTTPS, http' }))).toBe('https://mochioracle.com');
  expect(publicOrigin(post('http://mochioracle.com/x', { 'x-forwarded-proto': 'javascript' }))).toBe('http://mochioracle.com');
});

test('browser POSTs from the site pass behind the proxy; other origins are refused', () => {
  const site = { 'x-forwarded-proto': 'https', origin: 'https://mochioracle.com' };
  expect(isCrossOriginPost(post('http://mochioracle.com/rpc', site))).toBe(false);
  expect(isCrossOriginPost(post('http://www.mochioracle.com/rpc', { ...site, origin: 'https://www.mochioracle.com' }))).toBe(false);
  expect(isCrossOriginPost(post('http://mochioracle.com/rpc', { ...site, origin: 'https://evil.example' }))).toBe(true);
  expect(isCrossOriginPost(post('http://mochioracle.com/rpc', { ...site, origin: 'https://www.mochioracle.com' }))).toBe(true);
  expect(isCrossOriginPost(post('http://mochioracle.com/rpc', { ...site, origin: 'null' }))).toBe(true);
  // Without the proxy header the scheme must match the request itself.
  expect(isCrossOriginPost(post('http://mochioracle.com/rpc', { origin: 'https://mochioracle.com' }))).toBe(true);
  expect(isCrossOriginPost(post('https://mochioracle.com/rpc', { origin: 'https://mochioracle.com' }))).toBe(false);
  // Non-browser clients send no Origin; GETs are never refused here.
  expect(isCrossOriginPost(post('http://mochioracle.com/rpc'))).toBe(false);
  expect(isCrossOriginPost(new Request('http://mochioracle.com/rpc', { headers: { origin: 'https://evil.example' } }))).toBe(false);
});
