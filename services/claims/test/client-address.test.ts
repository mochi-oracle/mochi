import { expect, test } from 'bun:test';
import { addressClass, clientPrefix, forwardedAddress, forwardedClient, forwardingFacts, isLoopback, keyTagger, lastForwardedEntry, validTrustedClient } from '../src/client-address.ts';
import { forwardedClient as quotaForwardedClient } from '../src/quota.ts';
import { VISITOR_MAX_AGE_SEC, visitorKey } from '../src/visitor-key.ts';
import { BodyReadError, readBoundedBody } from '../src/bounded-body.ts';

const request = (headers: Record<string, string>) => new Request('https://public.example/v1/query', { headers });
const trusted = { trustForwardedFor: true };

test('behind a trusted proxy the right-most X-Forwarded-For entry identifies the caller; caller-supplied entries never do', () => {
  expect(forwardedClient(request({ 'x-forwarded-for': '10.9.9.9, 203.0.113.1' }), undefined, trusted)).toBe('203.0.113.1');
  expect(forwardedClient(request({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2, 203.0.113.1' }), undefined, trusted)).toBe('203.0.113.1');
  expect(forwardedClient(request({ 'x-forwarded-for': '203.0.113.1, ' }), undefined, trusted)).toBe('203.0.113.1');
  expect(forwardedClient(request({ 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '192.0.2.1' }), undefined, trusted)).toBe('203.0.113.1');
  // X-Real-IP and CF-Connecting-IP are caller-settable; they are never used, with or without a trusted proxy.
  expect(forwardedClient(request({ 'cf-connecting-ip': '192.0.2.1' }), undefined, trusted)).toBe('unknown');
  expect(forwardedClient(request({ 'x-real-ip': ' 198.51.100.9 ' }), undefined, trusted)).toBe('unknown');
  expect(forwardedClient(request({ 'x-real-ip': '198.51.100.9' }), '192.0.2.44', trusted)).toBe('192.0.2.44');
  expect(forwardedClient(request({}), '192.0.2.44', trusted)).toBe('192.0.2.44');
  expect(forwardedClient(request({}))).toBe('unknown');
  expect(forwardedAddress(request({ 'x-forwarded-for': '10.0.0.1, [2001:db8::1]:443' }), undefined, trusted)).toBe('[2001:db8::1]:443');
  // A present but unusable header keys as "invalid" and never falls back to the peer or another header.
  expect(forwardedClient(request({ 'x-forwarded-for': ' , ', 'x-real-ip': '198.51.100.9' }), '192.0.2.44', trusted)).toBe('invalid');
  expect(quotaForwardedClient).toBe(forwardedClient);
});

test('an over-long X-Forwarded-For is read from its tail: padding cannot select X-Real-IP or another entry', () => {
  const padded = `${'1.1.1.1, '.repeat(300)}203.0.113.1`;
  expect(padded.length).toBeGreaterThan(2048);
  for (const realIp of ['10.0.0.1', '10.0.0.2']) expect(forwardedClient(request({ 'x-forwarded-for': padded, 'x-real-ip': realIp }), undefined, trusted)).toBe('203.0.113.1');
  // One huge entry is not an address.
  expect(forwardedClient(request({ 'x-forwarded-for': `203.0.113.1${'0'.repeat(5000)}`, 'x-real-ip': '10.0.0.1' }), undefined, trusted)).toBe('invalid');
  expect(lastForwardedEntry(`${'x'.repeat(4000)},198.51.100.7`)).toBe('198.51.100.7');
  expect(lastForwardedEntry('')).toBeUndefined();
});

test('without a trusted proxy X-Forwarded-For is ignored and the transport peer identifies the caller', () => {
  for (const xff of ['203.0.113.1', '10.9.9.9, 203.0.113.2']) {
    expect(forwardedClient(request({ 'x-forwarded-for': xff }))).toBe('unknown');
    expect(forwardedClient(request({ 'x-forwarded-for': xff }), '192.0.2.44')).toBe('192.0.2.44');
  }
  expect(forwardedClient(request({}), '2001:db8:1:2::99')).toBe('2001:db8:1:2::/64');
});

test('IPv6 callers share their /64; mapped IPv4 and proxy-appended ports cannot vary the key', () => {
  for (const address of ['2001:db8:1:2::1', '2001:0db8:0001:0002:ffff::9', '[2001:db8:1:2::abcd]', '[2001:db8:1:2::abcd]:8443', '2001:DB8:1:2:0:0:0:1']) {
    expect(clientPrefix(address)).toBe('2001:db8:1:2::/64');
  }
  expect(clientPrefix('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  expect(clientPrefix('::1')).toBe('0:0:0:0::/64');
  for (const address of ['203.0.113.7', '::ffff:203.0.113.7', '0:0:0:0:0:ffff:203.0.113.7', '203.0.113.7:1234', '203.0.113.7:65535']) {
    expect(clientPrefix(address)).toBe('203.0.113.7');
  }
  for (const address of ['', 'unknown', 'example.com', '1.2.3', '1.2.3.4.5', '[::1', '2001:db8::1%eth0', 'x'.repeat(65), '203.0.113.7:123456', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::1', '1.2.3.4::1']) {
    expect(clientPrefix(address)).toBe('invalid');
  }
});

test('address classes are content-free and only true loopback counts as loopback', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '[::1]:3200', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) expect(isLoopback(address)).toBe(true);
  for (const address of [undefined, '', '10.0.0.1', '::2', '::', 'localhost', '203.0.113.1']) expect(isLoopback(address)).toBe(false);
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '169.254.1.1', 'fd00::1', 'fe80::1']) expect(addressClass(address)).toBe('private');
  for (const address of ['203.0.113.1', '172.32.0.1', '8.8.8.8', '2001:db8::1']) expect(addressClass(address)).toBe('public');
  expect(addressClass('not-an-address')).toBe('invalid');
});

test('forwarding facts and key tags reveal no address', () => {
  const facts = forwardingFacts(request({ 'x-forwarded-for': '198.51.100.1, 10.0.0.9', 'x-real-ip': '198.51.100.2' }), '172.18.0.1');
  expect(facts).toEqual({ forwardedFor: { entries: 2, last: 'private' }, realIpHeader: true, peer: 'private' });
  expect(JSON.stringify(facts)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  expect(forwardingFacts(request({}))).toEqual({ forwardedFor: { entries: 0, last: 'absent' }, realIpHeader: false, peer: 'absent' });
  const tag = keyTagger(), other = keyTagger();
  expect(tag('203.0.113.1')).toMatch(/^[0-9a-f]{8}$/);
  expect(tag('203.0.113.1')).toBe(tag('203.0.113.1'));
  expect(tag('203.0.113.1')).not.toBe(tag('203.0.113.2'));
  expect(other('203.0.113.1')).not.toBe(tag('203.0.113.1')); // salted per process
  expect(validTrustedClient('visitor:AbC_-012345678901234567')).toBe(true);
  expect(validTrustedClient('2001:db8:1:2::/64')).toBe(true);
  for (const value of [null, '', 'a b', 'x'.repeat(97), 'v\n1']) expect(validTrustedClient(value)).toBe(false);
});

test('visitor keys: signed by the website, checked by the CVM, short-lived, and opaque', () => {
  const token = 'test-invitation-token-at-least-24-characters';
  const website = visitorKey(token)!, cvm = visitorKey(token)!, other = visitorKey('another-invitation-token-of-24-chars')!;
  expect(visitorKey(undefined)).toBeUndefined();
  expect(visitorKey('too-short')).toBeUndefined();
  expect(website.id).toBe(cvm.id);
  expect(website.id).toMatch(/^[0-9a-f]{8}$/);
  expect(other.id).not.toBe(website.id);
  const now = 1_700_000_000;
  const header = website.sign('203.0.113.7', now);
  expect(header).not.toContain('203.0.113');
  expect(header).not.toContain(token);
  const check = cvm.verify(header, now + 5);
  expect(check.status).toBe('valid');
  // One stable pseudonym per visitor prefix.
  expect(cvm.verify(website.sign('203.0.113.7', now + 60), now + 60)).toEqual(check);
  expect((cvm.verify(website.sign('203.0.113.8', now), now) as { visitor: string }).visitor).not.toBe((check as { visitor: string }).visitor);
  expect(cvm.verify(header, now + VISITOR_MAX_AGE_SEC + 1).status).toBe('expired');
  expect(cvm.verify(header, now - VISITOR_MAX_AGE_SEC - 1).status).toBe('expired');
  expect(other.verify(header, now).status).toBe('invalid');
  const [v, visitor, ts, mac] = header.split('.');
  expect(cvm.verify([v, visitor, String(Number(ts) + 1), mac].join('.'), now).status).toBe('invalid');
  expect(cvm.verify([v, `${visitor!.slice(0, -1)}${visitor!.endsWith('A') ? 'B' : 'A'}`, ts, mac].join('.'), now).status).toBe('invalid');
  for (const bad of ['', 'v1', `${header}x`, header.replace('v1.', 'v2.'), 'v1.a.b.c']) expect(cvm.verify(bad, now).status).toBe(bad ? 'invalid' : 'absent');
  expect(cvm.verify(null, now).status).toBe('absent');
});

test('bounded body reads stop at the size cap and the deadline', async () => {
  const stream = (chunks: string[], close: boolean) => new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); if (close) c.close(); } });
  const post = (body: ReadableStream | string, headers: Record<string, string> = {}) => new Request('https://public.example/', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  expect(new TextDecoder().decode(await readBoundedBody(post(stream(['{"a":', '1}'], true)), { maxBytes: 100 }))).toBe('{"a":1}');
  await expect(readBoundedBody(post('x'.repeat(101)), { maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
  await expect(readBoundedBody(post(stream(['x'.repeat(60), 'x'.repeat(60)], true)), { maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
  const started = performance.now();
  const stalled = readBoundedBody(post(stream(['{'], false)), { maxBytes: 100, deadlineMs: 50 });
  await expect(stalled).rejects.toBeInstanceOf(BodyReadError);
  await expect(stalled).rejects.toMatchObject({ status: 408 });
  expect(performance.now() - started).toBeLessThan(1000);
  const seen: number[] = [];
  await expect(readBoundedBody(post(stream(['ab', 'cd'], true)), { maxBytes: 100, onChunk: bytes => { seen.push(bytes); if (seen.length > 1) throw new BodyReadError(503, 'busy'); } })).rejects.toMatchObject({ status: 503 });
  expect(seen).toEqual([2, 2]);
});
